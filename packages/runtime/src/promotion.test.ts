import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,symlinkSync,rmSync} from 'node:fs';
import {join,sep} from 'node:path';
import {withPathLock} from '@harnessy/team';
import {GitOps} from '@harnessy/projects';
import {createRuntime,RuntimeError} from './index.ts';
import {diskIO,type StateIO} from './state.ts';
import {harness,OWNER,FakeProvider,completedActions,deferred} from './test-helpers.ts';
const code=(c:string)=>(e:unknown)=>e instanceof RuntimeError&&e.code===c;
function input(r:Awaited<ReturnType<typeof harness>>['runtime'],extra:Record<string,unknown>={}){const list=r.chatsList(OWNER),chat=list.chats.find(c=>c.id===list.active.room)!;return {id:chat.id,args:{project:r.project.dir,revision:chat.revision,documents:chat.documents,...extra}}}

test('154: promotion keeps chat identity, session and old receipts with provenance; batch once, restart and repeat',async t=>{
 const h=await harness(t),r=h.runtime;r.roomSet({model:'w2'},OWNER);r.chat({pane:'room',message:'Составим исковое заявление'},OWNER);await r.idle();const room=r.registry.get('room')!,session=room.sessionId,original=structuredClone(room.transcript),i=input(r);
 const out=await r.promoteChat(i.id,i.args,OWNER);await r.idle();assert.equal(out.chat.id,i.id);assert.equal(out.pane.id,'orchestrator');assert.equal(h.provider.calls.length,2);assert.equal(h.provider.calls[1]!.seat.sessionId,session);
 const chat=r.project.state.chats.chats[i.id]!;assert.deepEqual(chat.transcript.slice(0,original.length).map(({provenance,...m})=>m),original);assert.equal((chat.transcript[0]!.provenance as any).pane,'room');
 assert.equal(r.project.state.results(r.registry.get('orchestrator')!).length,1);assert.equal(r.journal.read({limit:0}).filter(x=>x.thread?.startsWith('promotion:')).length,2);
 assert.match(h.provider.calls[1]!.message,/исковое заявление/);assert.ok(h.provider.calls[1]!.message.includes(join(h.dir,'.harness','MEMORY.md')));assert.match(h.provider.calls[1]!.message,/первое поручение/i);
 const again=await r.promoteChat(i.id,i.args,OWNER);assert.equal(again.already,true);await r.idle();assert.equal(h.provider.calls.length,2);
 await r.close();const provider=new FakeProvider(),next=await createRuntime({...h.deps,providers:{claude:provider}},completedActions);t.after(()=>next.close());await next.idle();assert.equal(next.project.state.chats.active.orchestrator,i.id);assert.equal(next.registry.get('orchestrator')!.status,'idle');assert.equal(provider.calls.length,0);assert.equal((await next.promoteChat(i.id,i.args,OWNER)).already,true);
});

test('154/155: folder promotion keeps id, one carry, document references and new session',async t=>{
 const h=await harness(t),r=h.runtime,root=join(h.dir,'projects'),doc=join(h.dir,'case.txt');writeFileSync(doc,'private document body');await r.settingsPatch('owner',{projectsRoot:root},OWNER);r.roomSet({model:'w2',folder:false},OWNER);const room=r.registry.get('room')!;room.record('me','Хочу исковое заявление');room.record('ai','Обсудили ответчика');room.record('peer','удаляемая реплика');room.transcript.pop();room.sessionId='source-session';room.carry='ранние решения';const i=input(r,{documents:[{project:h.dir,path:'case.txt'}],createProject:false,task:'  Первое поручение  '});
 const out=await r.promoteChat(i.id,i.args,OWNER);await r.idle();assert.equal(out.chat.id,i.id);assert.equal(out.created,true);assert.ok(out.project.startsWith(root+sep));assert.equal(existsSync(join(out.project,'.git')),true);assert.equal(existsSync(join(out.project,'case.txt')),false);
 assert.equal(h.provider.calls.length,1);assert.equal(h.provider.calls[0]!.seat.sessionId,null);assert.equal(h.provider.calls[0]!.message.split('Владелец: Хочу исковое заявление').length-1,1);assert.match(h.provider.calls[0]!.message,/ранние решения/);assert.doesNotMatch(h.provider.calls[0]!.message,/private document body/);assert.deepEqual(out.chat.documents,[{project:h.dir,path:'case.txt'}]);
 await r.promoteChat(i.id,i.args,OWNER);await r.idle();assert.equal(h.provider.calls.length,1);assert.equal(readdirSync(root).length,1);const promoted=r.chatGet(i.id,OWNER).messages;assert.deepEqual(promoted.slice(0,2).map(m=>m.seq),[1,2]);assert.ok(promoted.slice(2).every(m=>m.seq!>3));
 await r.projectSet(h.dir,{},OWNER);assert.equal(r.project.restoreFailed.has('room'),false);assert.equal((r.project.state.chats.chats[i.id]!.promotion as any).done,true);
 const reopened=await r.promoteChat(i.id,i.args,OWNER);await r.idle();assert.equal(reopened.project,out.project);assert.equal(reopened.chat.id,i.id);assert.equal(h.provider.calls.length,1);assert.equal(readdirSync(root).length,1);
});

for(const entry of ['direct','alias'] as const)test('154: '+entry+' refuses another orchestrator without replacing either history',async t=>{
 const h=await harness(t,{seats:'  lead: {kind: orchestrator, role: юрист, vendor: claude, model: w1, mode: read}'}),r=h.runtime;r.registry.get('lead')!.record('ai','old team history');r.roomSet({model:'w2'},OWNER);r.registry.get('room')!.record('me','new discussion');const i=input(r),lead=r.chatsList(OWNER).active.lead;
 await assert.rejects(entry==='direct'?r.promoteChat(i.id,i.args,OWNER):r.assignRoomRole({...i.args,chat:i.id,role:'orchestrator'},OWNER),(e:unknown)=>{assert.ok(e instanceof RuntimeError);assert.equal(e.code,'orchestrator_exists');assert.deepEqual(e.fields,{pane:'lead',chat:lead});return true});assert.equal(r.project.state.chats.active.room,i.id);assert.equal(r.registry.get('lead')!.transcript[0]!.text,'old team history');assert.equal(h.provider.calls.length,0);
});

test('154: null model and absent/stale binding refuse; selecting a model invalidates persisted revision',async t=>{
 const h=await harness(t,{seats:' {}'}),r=h.runtime,i=input(r);assert.equal(r.chatGet(i.id,OWNER).chat.model,null);await assert.rejects(r.promoteChat(i.id,i.args,OWNER),code('model_required'));await assert.rejects(r.promoteChat(i.id,{project:h.dir,documents:[]},OWNER),code('promotion_invalid'));
 r.roomSet({model:'w1'},OWNER);await assert.rejects(r.promoteChat(i.id,i.args,OWNER),code('stale_chat'));assert.equal(r.registry.get('orchestrator'),null);assert.equal(h.provider.calls.length,0);
});

test('155: required references, ordinary files, realpath containment and 50 limit',async t=>{
 const h=await harness(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);mkdirSync(join(h.dir,'source'));writeFileSync(join(h.dir,'secret.txt'),'outside source');symlinkSync(join(h.dir,'secret.txt'),join(h.dir,'source','escape'));
 for(const docs of [undefined,[{project:join(h.dir,'source'),path:'escape'}],[{project:h.dir,path:'source'}],Array(51).fill({project:h.dir,path:'secret.txt'})]){const i=input(r,{documents:docs});await assert.rejects(r.promoteChat(i.id,i.args,OWNER),code('documents_invalid'))}assert.equal(h.provider.calls.length,0);
});

test('154 ОКНА: queued lock rechecks persisted revision after await',async t=>{
 const h=await harness(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);const i=input(r),entered=deferred(),gate=deferred();const lock=withPathLock(h.dir,async()=>{entered.resolve();await gate.promise});await entered.promise;const promoting=r.promoteChat(i.id,i.args,OWNER);r.registry.get('room')!.record('me','changed while waiting');gate.resolve();await lock;await assert.rejects(promoting,code('stale_chat'));assert.equal(r.registry.get('orchestrator'),null);assert.equal(h.provider.calls.length,0);
});

for(const after of [false,true])for(const stage of ['intent','chat','done'])test('154 recovery: '+stage+' write '+(after?'after':'before')+' physical save preserves batch/id',async t=>{
 let armed=false,failed=false;const io:StateIO={...diskIO,write(path,text){const data=path.endsWith(join('state','chats.json'))?JSON.parse(text):null,chat=data&&Object.values(data.chats).find((c:any)=>c.promotion&&(stage==='intent'?c.pane==='room':stage==='chat'?c.pane==='orchestrator'&&!c.promotion.done:c.promotion.done));if(armed&&!failed&&chat){failed=true;if(after)diskIO.write(path,text);throw Error('injected '+stage)}diskIO.write(path,text)}};
 const h=await harness(t,{deps:{stateIO:io}}),r=h.runtime;r.roomSet({model:'w1'},OWNER);r.registry.get('room')!.record('me','one source');const i=input(r);armed=true;await assert.rejects(r.promoteChat(i.id,i.args,OWNER),code('write_failed'));assert.equal(h.provider.calls.length,0);armed=false;
 // Simulate abrupt process loss: do not flush in-memory state over the last physical bytes.
 r.project.closed=true;await r.close();const provider=new FakeProvider(),next=await createRuntime({...h.deps,providers:{claude:provider}},completedActions);t.after(()=>next.close());await next.promoteChat(i.id,i.args,OWNER);await next.idle();assert.equal(next.project.state.chats.active.orchestrator,i.id);assert.equal(provider.calls.length,1);assert.equal(next.journal.read({limit:0}).filter(x=>x.thread?.startsWith('promotion:')).length,2);
});

for(const suffix of ['intro','task'])test('154 journal interruption after '+suffix+' append resumes one batch with stable receipts',async t=>{
 const h=await harness(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);const i=input(r),append=r.journal.append.bind(r.journal);let fail=true;
 r.journal.append=(record)=>{const result=append(record);if(fail&&record.thread?.endsWith(':'+suffix)){fail=false;throw Error('after durable append')}return result};
 await assert.rejects(r.promoteChat(i.id,i.args,OWNER),/after durable append/);await r.idle();assert.equal(h.provider.calls.length,0);assert.throws(()=>r.chat({pane:'room',message:'must not overwrite pending'},OWNER),code('restore_failed'));assert.throws(()=>r.postOwner({to:'room',kind:'question',text:'second door'},OWNER),code('busy'));await assert.rejects(r.onboard('orchestrator',OWNER),code('restore_failed'));
 r.project.closed=true;await r.close();const provider=new FakeProvider(),next=await createRuntime({...h.deps,providers:{claude:provider}},completedActions);t.after(()=>next.close());await next.idle();assert.equal(provider.calls.length,1);assert.equal(next.journal.read({limit:0}).filter(x=>x.thread?.startsWith('promotion:')).length,2);assert.equal(next.project.state.chats.active.orchestrator,i.id);
});

test('154: saved target intent survives failure before switching, retry never allocates another project',async t=>{
 const h=await harness(t),r=h.runtime,root=join(h.dir,'projects');await r.settingsPatch('owner',{projectsRoot:root},OWNER);r.roomSet({model:'w1',folder:false},OWNER);r.registry.get('room')!.record('me','one project only');const i=input(r),open=r.openProject.bind(r);let once=true;
 r.openProject=async(...args)=>{if(once){once=false;throw Error('before project switch')}return open(...args)};
 await assert.rejects(r.promoteChat(i.id,i.args,OWNER),/before project switch/);const marker=r.project.state.chats.chats[i.id]!.promotion as any;assert.equal(readdirSync(root).length,1);const intended=marker.target;
 r.project.closed=true;await r.close();const provider=new FakeProvider(),next=await createRuntime({...h.deps,providers:{claude:provider}},completedActions);t.after(()=>next.close());const out=await next.promoteChat(i.id,i.args,OWNER);await next.idle();assert.equal(out.project,intended);assert.equal(out.chat.id,i.id);assert.equal(provider.calls.length,1);assert.equal(readdirSync(root).length,1);
});

test('154/155: input object is frozen before awaiting project lock',async t=>{
 const h=await harness(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);writeFileSync(join(h.dir,'file.txt'),'original');mkdirSync(join(h.dir,'other'));writeFileSync(join(h.dir,'other','file.txt'),'other');const i=input(r,{task:'frozen task',documents:[{project:h.dir,path:'file.txt'}]}),gate=deferred(),entered=deferred();const lock=withPathLock(h.dir,async()=>{entered.resolve();await gate.promise});await entered.promise;
 const pending=r.promoteChat(i.id,i.args,OWNER);(i.args as Record<string,unknown>).task='mutated caller';i.args.documents=[];gate.resolve();await lock;await pending;await r.idle();assert.match(h.provider.calls[0]!.message,/frozen task/);assert.doesNotMatch(h.provider.calls[0]!.message,/mutated caller/);
});


test('155 ОКНА: symlink substitution after validation never grants another document',async t=>{
 const h=await harness(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);const file=join(h.dir,'doc.txt');writeFileSync(file,'original');writeFileSync(join(h.dir,'other.txt'),'replacement');const i=input(r,{documents:[{project:h.dir,path:'doc.txt'}]}),gate=deferred(),entered=deferred();const lock=withPathLock(h.dir,async()=>{entered.resolve();await gate.promise});await entered.promise;
 const pending=r.promoteChat(i.id,i.args,OWNER);const {unlinkSync}=await import('node:fs');unlinkSync(file);symlinkSync(join(h.dir,'other.txt'),file);gate.resolve();await lock;await assert.rejects(pending,code('documents_invalid'));assert.equal(r.registry.get('orchestrator'),null);assert.equal(h.provider.calls.length,0);
});


test('154 ОКНА: captured project root checked inside init lock; refusal still allows project navigation',async t=>{
 let root='',once=true;const git=new GitOps(async(args,path)=>{if(once&&root&&path?.startsWith(root+sep)){once=false;rmSync(path,{recursive:true});symlinkSync(root,path,process.platform==='win32'?'junction':'dir')}return {code:1,stdout:'',stderr:''}}),h=await harness(t,{deps:{gitops:git}}),r=h.runtime,other=join(h.dir,'other');root=join(h.dir,'projects');mkdirSync(root);mkdirSync(other);await r.settingsPatch('project',{projectsRoot:root},OWNER);r.roomSet({model:'w1',folder:false},OWNER);const i=input(r);
 await assert.rejects(r.promoteChat(i.id,i.args,OWNER),code('path_is_root'));assert.equal(existsSync(join(root,'.harness','team.yaml')),false);assert.equal(r.project.dir,h.dir);assert.equal(h.provider.calls.length,0);await r.projectSet(other,{},OWNER);assert.equal(r.project.dir,other);
});

for(const field of ['input','source','boundary'])test('154 absence: damaged saved '+field+' never becomes an agent or invokes a model',async t=>{
 let armed=false;const io:StateIO={...diskIO,write(path,text){diskIO.write(path,text);if(armed&&path.endsWith(join('state','chats.json'))&&Object.values(JSON.parse(text).chats).some((c:any)=>c.promotion)){armed=false;throw Error('intent saved')}}};
 const h=await harness(t,{deps:{stateIO:io}}),r=h.runtime;r.roomSet({model:'w1'},OWNER);const i=input(r);await assert.rejects(r.promoteChat(i.id,i.args,{seat:'worker',trust:'agent'}),code('policy_denied'));armed=true;await assert.rejects(r.promoteChat(i.id,i.args,OWNER),/intent saved/);r.project.closed=true;await r.close();const path=join(h.dir,'.harness/state/chats.json'),saved=JSON.parse(readFileSync(path,'utf8'));delete saved.chats[i.id].promotion[field];writeFileSync(path,JSON.stringify(saved));
 const provider=new FakeProvider(),next=await createRuntime({...h.deps,providers:{claude:provider}},completedActions);t.after(()=>next.close());assert.equal(provider.calls.length,0);assert.equal(next.registry.get('orchestrator'),null);assert.match(next.lineErrors.join(';'),/повышение/);await assert.rejects(next.promoteChat(i.id,i.args,OWNER),code('promotion_invalid'));
});


test('154: long conversation stays intact; oversized task is rejected before saving an intent',async t=>{
 const h=await harness(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);const text='история '.repeat(15000)+' последнее решение';r.registry.get('room')!.record('me',text);const i=input(r,{task:'x'.repeat(100001)});
 await assert.rejects(r.promoteChat(i.id,i.args,OWNER),code('promotion_invalid'));assert.equal(r.project.state.chats.chats[i.id]!.promotion,undefined);
 const out=await r.promoteChat(i.id,{...i.args,task:'  '},OWNER);await r.idle();assert.equal(r.chatGet(out.chat.id,OWNER).messages[0]!.text,text);assert.equal(h.provider.calls.length,1);assert.match(h.provider.calls[0]!.message,/последнее решение/);await r.promoteChat(i.id,{...i.args,task:'  '},OWNER);await r.idle();assert.equal(h.provider.calls.length,1);
});

for(const cut of ['none','intent','materialized'])test('154 МАСКАРАД: worker id orchestrator stays intact; allocated sid survives '+cut,async t=>{
 let armed=false,failed=false;const io:StateIO={...diskIO,write(path,text){diskIO.write(path,text);const data=path.endsWith(join('state','chats.json'))?JSON.parse(text):null;const c=data&&Object.values(data.chats).find((c:any)=>c.promotion&&c.promotion.sid==='orchestrator3'&&(cut==='intent'?c.pane==='room':c.pane==='orchestrator3'));if(armed&&!failed&&cut!=='none'&&c){failed=true;throw Error('saved '+cut)}}};
 const h=await harness(t,{seats:'  orchestrator: {kind: worker, role: researcher, label: Эксперт, vendor: claude, model: w1, mode: read}\n  orchestrator2: {kind: tester, role: tester, vendor: claude, model: w1, mode: read}',deps:{stateIO:io}}),r=h.runtime;
 r.registry.get('orchestrator')!.record('ai','existing worker answer');const before=structuredClone(r.registry.get('orchestrator')!.settings()),oldChat=r.chatsList(OWNER).active.orchestrator;r.roomSet({model:'w1'},OWNER);const i=input(r);armed=true;
 if(cut==='none'){assert.equal((await r.promoteChat(i.id,i.args,OWNER)).pane.id,'orchestrator3');await r.idle()}else {await assert.rejects(r.promoteChat(i.id,i.args,OWNER),code('write_failed'));assert.equal(h.provider.calls.length,0)}
 assert.equal((r.project.state.chats.chats[i.id]!.promotion as any).sid,'orchestrator3');assert.deepEqual(r.registry.get('orchestrator')!.settings(),before);assert.equal(r.project.state.chats.active.orchestrator,oldChat);
 armed=false;r.project.closed=true;await r.close();const provider=new FakeProvider(),next=await createRuntime({...h.deps,providers:{claude:provider}},completedActions);t.after(()=>next.close());await next.idle();
 const repeated=await next.promoteChat(i.id,i.args,OWNER);await next.idle();assert.equal(repeated.pane.id,'orchestrator3');assert.equal(repeated.chat.id,i.id);assert.equal(next.registry.get('orchestrator')!.kind,'worker');assert.equal(next.registry.get('orchestrator')!.transcript[0]!.text,'existing worker answer');assert.equal(next.project.state.chats.active.orchestrator,oldChat);assert.equal(next.registry.get('orchestrator3')!.kind,'orchestrator');assert.equal(h.provider.calls.length+provider.calls.length,1);assert.equal(next.project.restoreFailed.size,0);assert.equal(next.journal.read({limit:0}).filter(x=>x.thread?.startsWith('promotion:')).length,2);
});


test('221: interrupted folder promotion exposes a resumable status after restart instead of an endless busy step',async t=>{
 const h=await harness(t),r=h.runtime;await r.settingsPatch('owner',{projectsRoot:join(h.dir,'projects')},OWNER);r.roomSet({model:'w1',folder:false},OWNER);r.registry.get('room')!.record('me','Документы для команды');const i=input(r);
 r.openProject=async()=>{throw Error('fixture failed to open target')};await assert.rejects(r.promoteChat(i.id,i.args,OWNER),/fixture failed to open target/);
 r.project.closed=true;await r.close();const provider=new FakeProvider(),next=await createRuntime({...h.deps,providers:{claude:provider}},completedActions);t.after(()=>next.close());
 const restored=next.chatGet(i.id,OWNER).chat.promotion!;assert.equal(restored.pending,true);assert.equal(restored.stepCount,4);assert.match(restored.error!,/Повторите «Назначить оркестратора»/);const operationId=restored.operationId;
 const result=await next.promoteChat(i.id,i.args,OWNER);await next.idle();assert.equal(result.promotion!.operationId,operationId);assert.equal(result.promotion!.completed,4);assert.equal(result.promotion!.error,null);assert.equal(provider.calls.length,1);
});


test('221: legacy intent without progress remains resumable; malformed new progress is a typed refusal',async t=>{
 const h=await harness(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);r.registry.get('room')!.record('me','Команда');const i=input(r);await r.promoteChat(i.id,i.args,OWNER);await r.idle();const c=r.project.state.chats.chats[i.id]!,saved=structuredClone(c.promotion) as any;
 for(const bad of [null,{}, {completed:1}, {completed:1,error:true}, {completed:-1,error:null}, {completed:5,error:null}, {completed:1.5,error:null}]){c.promotion={...saved,progress:bad};await assert.rejects(r.promoteChat(i.id,i.args,OWNER),code('promotion_invalid'))}
 c.promotion={...saved};delete (c.promotion as any).progress;const repeated=await r.promoteChat(i.id,i.args,OWNER);assert.equal(repeated.already,true);assert.equal(repeated.promotion!.completed,4);assert.equal(h.provider.calls.length,1);
});
