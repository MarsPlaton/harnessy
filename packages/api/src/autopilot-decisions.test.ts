import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AutopilotDecisionLedger,autopilotDecisionHash,autopilotDecisionId,type AutopilotDecisionBase} from '@harnessy/runtime';
import {call,fixture,sse,until,OWNER,deferred} from './test-helpers.ts';
import {promotionInput} from '../../runtime/src/test-helpers.ts';

const question={id:'journal:14',kind:'question',text:'Продолжать проверку?'};
const council={orchestrator:{seat:'lead',model:'claude-1',role:'orchestrator' as const},reviewer:{seat:'review',model:'codex-1',role:'reviewer' as const}};
function decision(project:string):AutopilotDecisionBase {
 const issueHash=autopilotDecisionHash({project,source:question,generation:3,revision:1}),parameters={pane:'worker',replyTo:14},capability={id:autopilotDecisionHash({operation:'answer_question',parameters}),operation:'answer_question',parameters};
 const proposal={requestHash:issueHash,capability:capability.id,answer:'Да, после проверки',reason:'Оба места подтвердили обратимость ответа'};
 return {decisionId:autopilotDecisionId(project,question,proposal,3),issueHash,proposalHash:autopilotDecisionHash(proposal),generation:3,operation:'answer_question',capability,proposal,round:1,question,council};
}
const unknownCost={currency:'USD' as const,amount:null,status:'unavailable' as const};
function effect(project:string,source:{id:string;kind:string;text:string},operation:string,parameters:Record<string,unknown>,answer:string|null):AutopilotDecisionBase {
 const issueHash=autopilotDecisionHash({project,source,generation:3,revision:1}),capability={id:autopilotDecisionHash({operation,parameters}),operation,parameters};
 const proposal={requestHash:issueHash,capability:capability.id,answer,reason:'Консилиум подтвердил решение'};
 return {decisionId:autopilotDecisionId(project,source,proposal,3),issueHash,proposalHash:autopilotDecisionHash(proposal),generation:3,operation,capability,proposal,round:1,question:source,council};
}
async function applied(h:Awaited<ReturnType<typeof fixture>>,base:AutopilotDecisionBase,receipt:{result:Record<string,unknown>;effectVersion:string}){
 const ledger=h.runtime.autopilotDecisionLedger();await ledger.intent({...base,cost:unknownCost});await ledger.applied({...base,cost:unknownCost,receipt});return ledger;
}

test('TS-38.3: intent precedes effect, receipt appends once, persists across restart and publishes owner event',async t=>{
 const h=await fixture(t),ledger=h.runtime.autopilotDecisionLedger(),base=decision(h.dir),stream=await sse(h.api,'owner');t.after(()=>stream.close());
 await assert.rejects(ledger.applied({...base,cost:unknownCost,receipt:{result:{ok:true},effectVersion:'v1'}}),{code:'decision_invalid'});
 await Promise.all([ledger.intent({...base,cost:unknownCost}),ledger.intent({...base,cost:unknownCost})]);
 await ledger.applied({...base,cost:{currency:'USD',amount:0.04,status:'measured'},receipt:{result:{ok:true},effectVersion:'v1'}});
 await ledger.applied({...base,cost:{currency:'USD',amount:0.04,status:'measured'},receipt:{result:{ok:true},effectVersion:'v1'}});
 const lines=readFileSync(ledger.path,'utf8').trim().split('\n');assert.equal(lines.length,2,'duplicate attempts do not append');
 const response=await call(h.api,'/api/autopilot/decisions');assert.equal(response.status,200);assert.equal(response.body.project,h.dir);assert.equal(response.body.decisions.length,1);assert.equal(response.body.decisions[0].entry.state,'applied');assert.equal(response.body.decisions[0].entry.question.id,question.id);assert.equal(response.body.decisions[0].entry.cost.amount,0.04);
 await until(()=>stream.frames.some(frame=>frame.type==='autopilotDecision'&&frame.state==='applied'&&frame.decisionId===base.decisionId));
 await h.runtime.openProject(h.dir);assert.equal(h.runtime.autopilotDecisionLedger().get(base.decisionId)?.state,'applied');
 await assert.rejects(h.runtime.autopilotDecisionLedger().applied({...base,cost:{currency:'USD',amount:1,status:'measured'},receipt:{result:{ok:true},effectVersion:'v2'}}),{code:'decision_invalid'});
});

test('TS-38.3: owner-only read and malformed cancel request leave the immutable decision untouched',async t=>{
 const h=await fixture(t),ledger=h.runtime.autopilotDecisionLedger(),base=decision(h.dir);
 await ledger.intent({...base,cost:unknownCost});await ledger.applied({...base,cost:unknownCost,receipt:{result:{ok:true},effectVersion:'v1'}});
 const before=readFileSync(ledger.path,'utf8');
 const forged=await call(h.api,'/api/autopilot/decisions',{headers:{'X-Pane-Token':'a'.repeat(64)}});assert.equal(forged.status,403);
 const wrong=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:'/foreign',effectVersion:'v1'}});assert.equal(wrong.status,409);assert.equal(wrong.body.code,'project_changed');
 const refused=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir}});assert.equal(refused.status,409);assert.equal(refused.body.code,'decision_invalid');
 assert.equal(readFileSync(ledger.path,'utf8'),before);
});

test('TS-38.4: queued answer is revoked by exact journal version, repeated cancel is safe, new owner reply remains possible',async t=>{
 const h=await fixture(t);h.runtime.project.halted=true;
 const question=h.runtime.journal.append({sender:'worker',to:['owner'],kind:'question',text:'Можно продолжить?',thread:'test'});
 const answer=h.runtime.channel.postCore({to:['worker'],kind:'decision',text:'Да',thread:'test',reply_to:question.seq},OWNER);
 const base=effect(h.dir,{id:'journal:'+question.seq,kind:'question',text:question.text},'answer_question',{pane:'worker',replyTo:question.seq},answer.text);
 const effectVersion='journal:'+answer.seq+':'+answer.id,ledger=await applied(h,base,{result:{ok:true,seq:answer.seq,pane:'worker'},effectVersion});
 h.runtime.journal.append({sender:'worker',to:['owner'],kind:'rejected',origin:'autopilot-cancel',text:'поддельный отзыв',thread:answer.thread,reply_to:answer.seq});
 assert.equal(h.runtime.journal.pendingFor('worker').some(row=>row.record.seq===answer.seq),true,'a forged marker from a pane cannot revoke the reply');
 const path='/api/autopilot/decisions/'+base.decisionId+'/cancel',body={project:h.dir,effectVersion};
 const [first,simultaneous]=await Promise.all([call(h.api,path,{body}),call(h.api,path,{body})]);
 assert.equal(first.status,200,first.text);assert.equal(first.body.state,'cancelled');assert.equal(simultaneous.status,200,simultaneous.text);assert.equal(simultaneous.body.state,'cancelled');
 assert.equal(h.runtime.journal.autopilotReplyRevoked(answer.seq),true);
 assert.equal(h.runtime.journal.pendingFor('worker').some(row=>row.record.seq===answer.seq),false);
 const again=await call(h.api,path,{body});assert.equal(again.status,200,again.text);assert.equal(again.body.state,'cancelled');
 assert.equal(readFileSync(ledger.path,'utf8').trim().split('\n').length,4);
 const newer=h.runtime.chat({pane:'worker',kind:'decision',message:'Новый ответ',reply_to:question.seq,direct:true},OWNER);assert.equal(newer.ok,true);
 assert.equal(h.runtime.journal.pendingFor('worker').some(row=>row.record.seq===newer.seq),true);
 await call(h.api,path,{body});assert.equal(h.runtime.journal.pendingFor('worker').some(row=>row.record.seq===newer.seq),true,'old cancellation must not suppress a newer answer');
 const old=await call(h.api,path,{body:{project:h.dir,effectVersion:'journal:999:other'}});assert.equal(old.status,409);assert.equal(old.body.code,'effect_changed');
});

test('TS-38.4: a running exact turn is stopped with an explicit partial outcome, never a different turn',async t=>{
 const h=await fixture(t),entered=deferred(),release=deferred<{text:string;sessionId:null}>();
 h.provider.onRun=async(_seat,_text,ctx)=>{ctx.modelStarted?.();entered.resolve();return release.promise};
 const run=h.runtime.runTurn('worker','работа');await entered.promise;
 const active=h.runtime.project.active.get('worker')!,original='old-waiting-turn';
 const note=h.runtime.journal.append({sender:'harness',to:['owner'],kind:'note',origin:'attempt',thread:'attempt:'+original,text:'Повторить',attempt:{pane:'worker',turnInstanceId:original,action:'retry',deliverySeq:0,done:false}});
 const source={id:'waiting:worker:'+original,kind:'waiting',text:'Ход ждёт'},base=effect(h.dir,source,'continue_pane',{pane:'worker',turnInstanceId:original,action:'retry'},null);
 const effectVersion='attempt:'+note.seq;await applied(h,base,{result:{ok:true,seq:note.seq,pane:'worker',turnInstanceId:original,action:'retry',startedTurnInstanceId:active.scope.turnInstanceId},effectVersion});
 const response=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion}});
 assert.equal(response.status,200,response.text);assert.equal(response.body.state,'partial');assert.match(response.body.reason,/не откатываются/);assert.equal(active.stopRequested,true);
 release.resolve({text:'после остановки',sessionId:null});await run.catch(()=>{});
 const nextEntered=deferred(),nextRelease=deferred<{text:string;sessionId:null}>();h.provider.onRun=async(_seat,_text,ctx)=>{ctx.modelStarted?.();nextEntered.resolve();return nextRelease.promise};
 const next=h.runtime.runTurn('worker','новый ход');await nextEntered.promise;const nextActive=h.runtime.project.active.get('worker')!;
 const repeat=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion}});
 assert.equal(repeat.status,200);assert.equal(nextActive.stopRequested,false,'old cancel must not stop a later turn');
 nextRelease.resolve({text:'новый ответ',sessionId:null});await next.catch(()=>{});
});

test('TS-38.4: applied permission is irreversibly refused and its explanation persists across restart',async t=>{
 const h=await fixture(t),base=effect(h.dir,{id:'approval:x',kind:'approval',text:'Доступ'},'approve',{pane:'worker',approvalId:'x'},null),effectVersion='approval:worker:x:allow';
 const ledger=await applied(h,base,{result:{ok:true,pane:'worker',approvalId:'x',decision:'allow'},effectVersion}),path='/api/autopilot/decisions/'+base.decisionId+'/cancel';
 const response=await call(h.api,path,{body:{project:h.dir,effectVersion}});assert.equal(response.status,409);assert.equal(response.body.code,'cancel_irreversible');
 assert.equal(ledger.cancellation(base.decisionId)?.state,'irreversible');
 await h.runtime.openProject(h.dir);assert.equal(h.runtime.autopilotDecisionLedger().cancellation(base.decisionId)?.state,'irreversible');
 const repeat=await call(h.api,path,{body:{project:h.dir,effectVersion}});assert.equal(repeat.status,409);assert.equal(readFileSync(ledger.path,'utf8').trim().split('\n').length,4);
});

test('TS-38.4: an interrupted cancellation resumes from its durable answer marker without posting another',async t=>{
 const h=await fixture(t);h.runtime.project.halted=true;
 const question=h.runtime.journal.append({sender:'worker',to:['owner'],kind:'question',text:'Выбрать путь?',thread:'recovery'});
 const answer=h.runtime.channel.postCore({to:['worker'],kind:'decision',text:'Путь А',thread:'recovery',reply_to:question.seq},OWNER);
 const base=effect(h.dir,{id:'journal:'+question.seq,kind:'question',text:question.text},'answer_question',{pane:'worker',replyTo:question.seq},answer.text),effectVersion='journal:'+answer.seq+':'+answer.id;
 const ledger=await applied(h,base,{result:{ok:true,seq:answer.seq,pane:'worker'},effectVersion});
 await ledger.beginCancellation(base.decisionId,effectVersion);
 h.runtime.channel.postCore({to:['owner'],kind:'rejected',text:'Ответ отозван',thread:answer.thread,reply_to:answer.seq,origin:'autopilot-cancel'},{seat:'harness',trust:'harness'});
 const before=h.runtime.journal.read({limit:0}).length;
 const response=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion}});
 assert.equal(response.status,200);assert.equal(response.body.state,'cancelled');assert.equal(h.runtime.journal.read({limit:0}).length,before);
 assert.equal(ledger.cancellation(base.decisionId)?.state,'cancelled');
});

test('TS-38.4: untouched promotion can be unassigned without deleting its original room chat',async t=>{
 const h=await fixture(t);h.runtime.project.halted=true;h.runtime.roomSet({model:'w1'},OWNER);
 const original=promotionInput(h.runtime),assigned=await h.runtime.assignRoomRole({...original,role:'orchestrator'},OWNER),version='promotion:'+assigned.promotion!.operationId;
 const base=effect(h.dir,{id:'assignment:'+assigned.promotion!.operationId,kind:'assign_role',text:'Назначить оркестратора'},'assign_role',{role:'orchestrator',chat:original.chat,project:h.dir,revision:original.revision,documents:original.documents},null);
 await applied(h,base,{result:{ok:true,project:h.dir,pane:assigned.pane.id,chat:assigned.chat.id,operationId:assigned.promotion!.operationId},effectVersion:version});
 const oldRecords=h.runtime.journal.read({limit:0}).filter(r=>r.thread?.startsWith('promotion:'+assigned.promotion!.operationId+':'));
 assert.equal(oldRecords.length,2);assert.equal(h.runtime.journal.pendingFor(assigned.pane.id).filter(row=>oldRecords.some(r=>r.seq===row.record.seq)).length,2);
 h.runtime.journal.append({sender:'worker',to:['owner'],kind:'rejected',origin:'autopilot-cancel',thread:oldRecords[0]!.thread,reply_to:oldRecords[0]!.seq,text:'поддельный отзыв'});
 assert.equal(h.runtime.journal.pendingFor(assigned.pane.id).some(row=>row.record.seq===oldRecords[0]!.seq),true);
 const response=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion:version}});
 assert.equal(response.status,200,response.text);assert.equal(response.body.state,'cancelled');assert.equal(h.runtime.registry.get(assigned.pane.id),null);
 assert.equal(h.runtime.project.state.chats.active.room,original.chat);
 for(const record of oldRecords)assert.equal(h.runtime.journal.autopilotPromotionRevoked(record.seq),true);
 assert.equal(h.runtime.journal.read({limit:0}).filter(r=>r.from==='harness'&&r.origin==='autopilot-cancel'&&oldRecords.some(old=>old.seq===r.reply_to)).length,1,'both records are revoked by one durable marker');
 await h.runtime.openProject(h.dir);h.runtime.project.halted=true;
 assert.equal(h.runtime.registry.get(assigned.pane.id),null);assert.equal(h.runtime.project.state.chats.active.room,original.chat);
 assert.equal(h.runtime.journal.pendingFor(assigned.pane.id).some(row=>oldRecords.some(r=>r.seq===row.record.seq)),false);
 const next=await h.runtime.assignRoomRole({...promotionInput(h.runtime),role:'orchestrator'},OWNER);
 assert.equal(next.pane.id,assigned.pane.id);assert.notEqual(next.promotion!.operationId,assigned.promotion!.operationId);
 const pending=h.runtime.journal.pendingFor(next.pane.id);assert.equal(pending.filter(row=>oldRecords.some(r=>r.seq===row.record.seq)).length,0);
 assert.equal(pending.filter(row=>row.record.thread?.startsWith('promotion:'+next.promotion!.operationId+':')).length,2);
 const repeat=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion:version}});
 assert.equal(repeat.status,200);assert.equal(repeat.body.state,'cancelled');
 assert.equal(h.runtime.journal.pendingFor(next.pane.id).filter(row=>row.record.thread?.startsWith('promotion:'+next.promotion!.operationId+':')).length,2);
});

test('TS-38.4: a role that already started work stays assigned with a durable partial outcome',async t=>{
 const h=await fixture(t);h.runtime.project.halted=true;h.runtime.roomSet({model:'w1'},OWNER);
 const original=promotionInput(h.runtime),assigned=await h.runtime.assignRoomRole({...original,role:'orchestrator'},OWNER),version='promotion:'+assigned.promotion!.operationId;
 const base=effect(h.dir,{id:'assignment:'+assigned.promotion!.operationId,kind:'assign_role',text:'Назначить оркестратора'},'assign_role',{role:'orchestrator',chat:original.chat,project:h.dir,revision:original.revision,documents:original.documents},null);
 await applied(h,base,{result:{ok:true,project:h.dir,pane:assigned.pane.id,chat:assigned.chat.id,operationId:assigned.promotion!.operationId},effectVersion:version});
 const intro=h.runtime.journal.read({limit:0}).find(r=>r.thread==='promotion:'+assigned.promotion!.operationId+':intro')!;
 h.runtime.journal.advance(assigned.pane.id,intro.seq);
 const response=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion:version}});
 assert.equal(response.status,200,response.text);assert.equal(response.body.state,'partial');assert.ok(h.runtime.registry.get(assigned.pane.id));
 assert.equal(h.runtime.autopilotDecisionLedger().cancellation(base.decisionId)?.state,'partial');
});

test('TS-38.4: a promotion cancellation survives ordinary restart without delivering its task',async t=>{
 const h=await fixture(t);h.runtime.project.halted=true;h.runtime.roomSet({model:'w1'},OWNER);
 const original=promotionInput(h.runtime),assigned=await h.runtime.assignRoomRole({...original,role:'orchestrator'},OWNER),operationId=assigned.promotion!.operationId,version='promotion:'+operationId;
 const base=effect(h.dir,{id:'assignment:'+operationId,kind:'assign_role',text:'Назначить оркестратора'},'assign_role',{role:'orchestrator',chat:original.chat,project:h.dir,revision:original.revision,documents:original.documents},null);
 const ledger=await applied(h,base,{result:{ok:true,project:h.dir,pane:assigned.pane.id,chat:assigned.chat.id,operationId},effectVersion:version});
 const records=h.runtime.journal.read({limit:0}).filter(r=>r.thread?.startsWith('promotion:'+operationId+':'));
 await ledger.beginCancellation(base.decisionId,version);
 const intro=records.find(r=>r.thread?.endsWith(':intro'))!;
 h.runtime.channel.postCore({to:['owner'],kind:'rejected',reply_to:intro.seq,thread:intro.thread,origin:'autopilot-cancel',text:'Вводная отозвана'},{seat:'harness',trust:'harness'});
 await h.runtime.openProject(h.dir);await h.runtime.idle();
 assert.equal(h.runtime.project.halted,false,'the normal queue remains enabled');
 assert.equal(h.provider.calls.filter(call=>call.seat.id===assigned.pane.id).length,0,'restart cannot deliver the cancelled promotion task');
 assert.equal(h.runtime.journal.pendingFor(assigned.pane.id).some(row=>records.some(old=>old.seq===row.record.seq)),false);
 const response=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion:version}});
 assert.equal(response.status,200,response.text);assert.equal(response.body.state,'cancelled');assert.equal(h.runtime.registry.get(assigned.pane.id),null);
 for(const record of records)assert.equal(h.runtime.journal.autopilotPromotionRevoked(record.seq),true);
 const markers=h.runtime.journal.read({limit:0}).filter(r=>r.from==='harness'&&r.origin==='autopilot-cancel'&&records.some(old=>old.seq===r.reply_to));assert.equal(markers.length,1);
});

test('TS-38.4: a reassigned role in team.yaml cannot be removed by an old cancellation',async t=>{
 const h=await fixture(t);h.runtime.project.halted=true;h.runtime.roomSet({model:'w1'},OWNER);
 const original=promotionInput(h.runtime),assigned=await h.runtime.assignRoomRole({...original,role:'orchestrator'},OWNER),version='promotion:'+assigned.promotion!.operationId;
 const base=effect(h.dir,{id:'assignment:'+assigned.promotion!.operationId,kind:'assign_role',text:'Назначить оркестратора'},'assign_role',{role:'orchestrator',chat:original.chat,project:h.dir,revision:original.revision,documents:original.documents},null);
 await applied(h,base,{result:{ok:true,project:h.dir,pane:assigned.pane.id,chat:assigned.chat.id,operationId:assigned.promotion!.operationId},effectVersion:version});
 const manifest=join(h.dir,'.harness','team.yaml'),before=readFileSync(manifest,'utf8'),oldInstructions='roles/seats/'+assigned.promotion!.operationId+'.md',newInstructions='roles/other.md';
 assert.ok(before.includes(oldInstructions));writeFileSync(manifest,before.replace(oldInstructions,newInstructions));
 const response=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion:version}});
 assert.equal(response.status,409,response.text);assert.equal(response.body.code,'effect_changed');
 assert.ok(readFileSync(manifest,'utf8').includes(newInstructions));assert.ok(h.runtime.registry.get(assigned.pane.id));
});

test('TS-38.4: a changed role model refuses old cancellation without revoking its assignment records',async t=>{
 const h=await fixture(t);h.runtime.project.halted=true;h.runtime.roomSet({model:'w1'},OWNER);
 const original=promotionInput(h.runtime),assigned=await h.runtime.assignRoomRole({...original,role:'orchestrator'},OWNER),version='promotion:'+assigned.promotion!.operationId;
 const base=effect(h.dir,{id:'assignment:'+assigned.promotion!.operationId,kind:'assign_role',text:'Назначить оркестратора'},'assign_role',{role:'orchestrator',chat:original.chat,project:h.dir,revision:original.revision,documents:original.documents},null);
 await applied(h,base,{result:{ok:true,project:h.dir,pane:assigned.pane.id,chat:assigned.chat.id,operationId:assigned.promotion!.operationId},effectVersion:version});
 h.runtime.paneSet(assigned.pane.id,{model:'w2'},OWNER);
 const response=await call(h.api,'/api/autopilot/decisions/'+base.decisionId+'/cancel',{body:{project:h.dir,effectVersion:version}});
 assert.equal(response.status,409,response.text);assert.equal(response.body.code,'effect_changed');
 assert.equal(h.runtime.registry.get(assigned.pane.id)?.model,'w2');
 const records=h.runtime.journal.read({limit:0}).filter(r=>r.thread?.startsWith('promotion:'+assigned.promotion!.operationId+':'));
 assert.equal(records.length,2);assert.equal(records.every(r=>!h.runtime.journal.autopilotPromotionRevoked(r.seq)),true);
});

test('TS-38.3: forged id and edited journal line fail closed',async t=>{
 const h=await fixture(t),ledger=h.runtime.autopilotDecisionLedger(),base=decision(h.dir);
 await assert.rejects(ledger.intent({...base,decisionId:'b'.repeat(64),cost:unknownCost}),{code:'decision_invalid'});
 await ledger.intent({...base,cost:unknownCost});
 const raw=readFileSync(ledger.path,'utf8');writeFileSync(ledger.path,raw.replace('Продолжать проверку?','Подменённый вопрос'));
 const response=await call(h.api,'/api/autopilot/decisions');assert.equal(response.status,409);assert.equal(response.body.code,'decision_invalid');
});

test('TS-38.3 r2: parallel different proposals for one issue leave one readable intent',async t=>{
 const h=await fixture(t),ledger=h.runtime.autopilotDecisionLedger(),first=decision(h.dir),secondProposal={...first.proposal,answer:'Нет, остановить до утра'},second={...first,proposal:secondProposal,proposalHash:autopilotDecisionHash(secondProposal),decisionId:autopilotDecisionId(h.dir,question,secondProposal,first.generation)};
 const results=await Promise.allSettled([ledger.intent({...first,cost:unknownCost}),ledger.intent({...second,cost:unknownCost})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 const rejected=results.find(result=>result.status==='rejected');assert.equal(rejected?.status,'rejected');assert.equal((rejected as PromiseRejectedResult).reason.code,'decision_conflict');
 const listed=await call(h.api,'/api/autopilot/decisions');assert.equal(listed.status,200,listed.text);assert.equal(listed.body.decisions.length,1);assert.equal(listed.body.decisions[0].entry.state,'intent');
 assert.equal(readFileSync(ledger.path,'utf8').trim().split('\n').length,1);
});

test('TS-38.3: missing cost and linked project state cannot masquerade as a decision journal',async t=>{
 const project=mkdtempSync(join(tmpdir(),'harnessy-decisions-')),outside=mkdtempSync(join(tmpdir(),'harnessy-decisions-outside-'));t.after(()=>{rmSync(project,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true})});
 const base=decision(project),ledger=new AutopilotDecisionLedger(project);
 await assert.rejects(ledger.intent({...base,cost:undefined as never}),{code:'decision_invalid'});
 symlinkSync(outside,join(project,'.harness'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(ledger.intent({...base,cost:unknownCost}),{code:'decision_invalid'});
 assert.equal(existsSync(join(outside,'state','autopilot-decisions.ndjson')),false);
});
