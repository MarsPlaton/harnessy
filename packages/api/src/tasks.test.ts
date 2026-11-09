import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,call,OWNER,deferred,until} from './test-helpers.ts';
import {TaskStore} from '../../runtime/src/tasks.ts';
const op=(n:number)=>'task_operation_'+n.toString().padStart(6,'0');
const body=(r:any,n:number,extra:any={})=>({project:r.project.dir,instance:r.project.trace.instanceId,opId:op(n),...extra});
async function create(h:any,n:number,extra:any={}){const response=await call(h.api,'/api/tasks',{body:body(h.runtime,n,{text:'Задача '+n,...extra})});assert.equal(response.status,201,JSON.stringify(response.body));return response.body.task}
async function list(h:any){const res=await call(h.api,'/api/tasks');assert.equal(res.status,200);return res.body}
async function held(t:any,seats?:string){const h=await fixture(t,seats?{seats}:{});await h.runtime.halt(true,OWNER);return h}
test('TS-39.1 owner create, unassigned, same op replay, conflict and project/instance forgery',async t=>{
 const h=await held(t),a=await create(h,1),b=await create(h,2,{to:'worker'});assert.equal(a.state,'unassigned');assert.equal(b.state,'queued');assert.equal(b.n,2);assert.match(b.taskId,/^[a-f0-9]{64}$/);assert.ok(h.runtime.journal.pendingFor('worker').some(e=>e.record.seq===b.assignedSeq));
 assert.equal((await create(h,2,{to:'worker'})).taskId,b.taskId);assert.equal((await list(h)).tasks.length,2);
 for(const extra of [{instance:'forged'},{project:'/other'}]){const res=await call(h.api,'/api/tasks',{body:body(h.runtime,3,{text:'x',...extra})});assert.equal(res.body.code,'project_changed')}
 assert.equal((await call(h.api,'/api/tasks',{body:body(h.runtime,2,{text:'different',to:'worker'})})).body.code,'op_conflict');
 for(const headers of [{'X-Pane-Token':'fake'},{'X-Harness-Pane':'worker'}]){assert.equal((await call(h.api,'/api/tasks',{headers,body:body(h.runtime,4,{text:'x'})})).body.code,'owner_only');assert.equal((await call(h.api,'/api/tasks/'+b.taskId+'/assign',{headers,body:body(h.runtime,5,{to:'worker',expectedState:b.expectedState})})).body.code,'owner_only')}
 assert.equal((await call(h.api,'/api/tasks',{headers:{'X-Harness-Pane':'worker'}})).status,403);
});
test('TS-39.1 assignment race and durable revoke leave one current delivery, one card and stable number',async t=>{
 const h=await held(t,'  worker: {role: executor, vendor: claude, model: w1}\n  other: {role: reviewer, vendor: claude, model: w1}'),a=await create(h,1,{to:'worker'});
 const results=await Promise.all([2,3].map(n=>call(h.api,'/api/tasks/'+a.taskId+'/assign',{body:body(h.runtime,n,{to:'other',expectedState:a.expectedState})})));assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.body.code==='task_changed').length,1);
 const next=(await list(h)).tasks[0];assert.equal(next.n,1);assert.equal(next.to,'other');assert.equal((await list(h)).tasks.length,1);assert.equal(h.runtime.journal.pendingFor('worker').some(e=>e.record.seq===a.assignedSeq),false);
 await h.runtime.openProject(h.dir);assert.equal(h.runtime.journal.pendingFor('worker').some(e=>e.record.seq===a.assignedSeq),false);assert.equal(h.runtime.journal.pendingFor('other').filter(e=>e.record.thread===a.thread).length,1);
});
test('TS-39.1 recovery: task journal written before assigned receipt; old-instance op replay does not repeat it',async t=>{
 const h=await held(t),store=(h.runtime as any).tasksStore(),append=store.append.bind(store);let fail=true;store.append=(e:any)=>{if(e.event==='assigned'&&fail){fail=false;throw Error('power loss')}append(e)};
 const input=body(h.runtime,1,{text:'Восстановить',to:'worker'});assert.equal((await call(h.api,'/api/tasks',{body:input})).status,500);assert.equal(h.runtime.journal.read({limit:0}).filter(r=>r.origin==='task-operation:'+op(1)).length,1);
 await h.runtime.openProject(h.dir);const task=(await list(h)).tasks[0];assert.equal(task.state,'queued');assert.equal((await call(h.api,'/api/tasks',{body:input})).body.task.taskId,task.taskId);assert.equal(h.runtime.journal.read({limit:0}).filter(r=>r.origin==='task-operation:'+op(1)).length,1);
});
test('TS-39.1 recovery: revoke persisted before new task; restarted intent finishes once',async t=>{
 const h=await held(t,'  worker: {role: executor, vendor: claude, model: w1}\n  other: {role: reviewer, vendor: claude, model: w1}'),task=await create(h,1,{to:'worker'}),append=h.runtime.journal.append.bind(h.runtime.journal);let fail=true;
 h.runtime.journal.append=(input:any)=>{if(input.origin==='task-operation:'+op(2)&&fail){fail=false;throw Error('power loss')}return append(input)};
 const input=body(h.runtime,2,{to:'other',expectedState:task.expectedState});assert.equal((await call(h.api,'/api/tasks/'+task.taskId+'/assign',{body:input})).status,500);assert.equal(h.runtime.journal.deliveryRevoked(task.assignedSeq),true);
 await h.runtime.openProject(h.dir);await call(h.api,'/api/tasks/'+task.taskId+'/assign',{body:input});const current=(await list(h)).tasks[0];assert.equal(current.to,'other');assert.equal(h.runtime.journal.read({limit:0}).filter(r=>r.origin==='task-operation:'+op(2)).length,1);assert.equal(h.runtime.journal.pendingFor('worker').some(e=>e.record.seq===task.assignedSeq),false);
});
test('TS-39.1 states use typed current-assignment facts, not text, ack, old thread replies or another sender',async t=>{
 const h=await held(t,'  worker: {role: executor, vendor: claude, model: w1}\n  other: {role: reviewer, vendor: claude, model: w1}'),a=await create(h,1,{to:'worker'}),j=h.runtime.journal;
 const post=(kind:string,extra:any={})=>j.append({sender:'worker',to:['owner'],kind,text:'готово',reply_to:a.assignedSeq,...extra});
 post('status');assert.equal((await list(h)).tasks[0].state,'queued');j.advance('worker',a.assignedSeq);assert.equal((await list(h)).tasks[0].state,'work');
 post('review-request');assert.equal((await list(h)).tasks[0].state,'review');post('blocker');assert.equal((await list(h)).tasks[0].state,'blocked');post('status',{outcome:'partial'});assert.equal((await list(h)).tasks[0].state,'partial');post('status',{outcome:'done'});assert.equal((await list(h)).tasks[0].state,'done');
 assert.throws(()=>post('status',{sender:'other',outcome:'done'}),/Исход/);assert.throws(()=>post('note',{outcome:'done'}),/Исход/);
 const b=await create(h,2,{to:'worker'}),res=await call(h.api,'/api/tasks/'+b.taskId+'/assign',{body:body(h.runtime,3,{to:'other',expectedState:b.expectedState})});assert.equal(res.status,200);
 j.append({sender:'worker',to:['owner'],kind:'status',text:'done',outcome:'done',thread:b.thread,reply_to:b.assignedSeq});assert.equal((await list(h)).tasks[1].state,'queued');
});
test('TS-39.1 missing/uncertain/recovering and skipped attempts are unknown and cannot be reassigned',async t=>{
 const h=await held(t),a=await create(h,1,{to:'worker'}),pane=h.runtime.registry.get('worker')!;
 for(const state of ['uncertain','recovering'] as const){pane.status=state;assert.equal((await list(h)).tasks[0].state,'unknown');assert.equal((await call(h.api,'/api/tasks/'+a.taskId+'/assign',{body:body(h.runtime,2,{to:'worker',expectedState:a.expectedState})})).body.code,'task_state_unknown')}
 pane.status='idle';h.runtime.journal.advance('worker',a.assignedSeq);h.runtime.journal.append({sender:'harness',to:['owner'],kind:'note',origin:'attempt',text:'skip',attempt:{pane:'worker',turnInstanceId:'test',action:'skip',recordSeqs:[a.assignedSeq],deliverySeq:a.assignedSeq,done:true}});assert.equal((await list(h)).tasks[0].state,'unknown');
 h.runtime.registry.panes.delete('worker');assert.equal((await list(h)).tasks[0].state,'unknown');
});
test('TS-39.1 real place tool sends outcome end-to-end; active delivery cannot reassign; owner legacy task is read-only',async t=>{
 const h=await held(t),a=await create(h,1,{to:'worker'}),gate=deferred(),seen=deferred();let result:any;
 h.provider.onRun=async(_seat,message,ctx)=>{assert.match(message,/outcome=done\|blocked\|partial/);const seq=message.match(/\[#(\d+)\s*· task/)?.[1];assert.ok(seq,'actual provider context includes assigned sequence');seen.resolve();await gate.promise;result=await ctx.tools.send({to:'owner',kind:'status',text:'Сделано',reply_to:Number(seq),outcome:'done'});ctx.publish({type:'done',sessionId:'s',model:_seat.model,usage:{input:1,output:1,cacheRead:0},durationMs:1});return {text:'Сделано',sessionId:'s'}};
 await h.runtime.halt(false,OWNER);await seen.promise;assert.equal((await list(h)).tasks[0].state,'work');assert.equal((await call(h.api,'/api/tasks/'+a.taskId+'/assign',{body:body(h.runtime,2,{to:'worker',expectedState:a.expectedState})})).body.code,'task_active');gate.resolve();await h.runtime.idle();assert.equal(result.ok,true);assert.equal((await list(h)).tasks[0].state,'done');
 await h.runtime.halt(true,OWNER);h.runtime.postOwner({to:'worker',kind:'task',text:'Старая задача',thread:'task:legacy'},OWNER);const outside=(await list(h)).outsideQueue;assert.equal(outside.length,1);assert.equal(outside[0].n,null);assert.equal(outside[0].readonly,true);
 assert.ok(readFileSync(join(h.dir,'.harness/state/tasks.ndjson'),'utf8').includes('"event":"closed"'));await h.runtime.openProject(h.dir);const restored=(await list(h)).tasks[0];assert.equal(restored.state,'done');assert.equal(restored.replies.find((r:any)=>r.outcome==='done')?.reply_to,a.assignedSeq);
});
test('TS-39.1 registry corruption is a typed failure, not an empty queue',async t=>{const h=await held(t);writeFileSync(new TaskStore(h.runtime.project).path,'not json\n');assert.equal((await call(h.api,'/api/tasks')).body.code,'tasks_unavailable')});
test('TS-39.1 accepted review closes only its current assignment, durable close cites terminal fact',async t=>{
 const h=await held(t,'  worker: {role: executor, vendor: claude, model: w1}\n  other: {role: reviewer, vendor: claude, model: w1}'),a=await create(h,1,{to:'worker'}),j=h.runtime.journal;
 const request=j.append({sender:'worker',to:['other'],kind:'review-request',text:'Проверь',reply_to:a.assignedSeq});
 j.append({sender:'worker',to:['owner'],kind:'verdict',text:'Подделка',reply_to:request.seq,accepted:true,score:9,round:1});assert.equal((await list(h)).tasks[0].state,'review');
 const verdict=j.append({sender:'other',to:['worker'],kind:'verdict',text:'Принято',reply_to:request.seq,accepted:true,score:9,round:1});
 j.append({sender:'worker',to:['owner'],kind:'note',text:'Пояснение',reply_to:a.assignedSeq});assert.equal((await list(h)).tasks[0].state,'done');
 const events=readFileSync(new TaskStore(h.runtime.project).path,'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(events.filter(e=>e.event==='closed').at(-1).bySeq,verdict.seq);
});
test('TS-39.1 source masquerade and missing required registry field are typed, never completed',async t=>{
 const h=await held(t),a=await create(h,1,{to:'worker'}),path=new TaskStore(h.runtime.project).path;
 const foreign=h.runtime.journal.append({sender:'owner',to:['worker'],kind:'task',text:'Иная задача'});h.runtime.journal.append({sender:'worker',to:['owner'],kind:'status',text:'done',reply_to:foreign.seq,outcome:'done'});
 const lines=readFileSync(path,'utf8').trim().split('\n').map(s=>JSON.parse(s));for(const e of lines)if(e.event==='assigned')e.seq=foreign.seq;writeFileSync(path,lines.map(e=>JSON.stringify(e)).join('\n')+'\n');assert.equal((await list(h)).tasks[0].state,'unknown');
 const created=lines.find(e=>e.event==='created');delete created.text;writeFileSync(path,lines.map(e=>JSON.stringify(e)).join('\n')+'\n');assert.equal((await call(h.api,'/api/tasks')).body.code,'tasks_unavailable');assert.ok(a.taskId);
});
test('TS-39.1 a delivery waiting for vendor preparation cannot launch a revoked assignment',async t=>{
 const h=await held(t,'  worker: {role: executor, vendor: claude, model: w1}\n  other: {role: reviewer, vendor: codex, model: gpt-test}'),a=await create(h,1,{to:'worker'}),gate=deferred(),seen=deferred();const runtime=h.runtime as any,wait=runtime.waitVendor.bind(runtime);let hold=true;
 runtime.waitVendor=async(p:any,vendor:any)=>{if(vendor==='claude'&&hold){hold=false;seen.resolve();await gate.promise}return wait(p,vendor)};
 await h.runtime.halt(false,OWNER);await seen.promise;const snapshot=(await list(h)).tasks[0];assert.equal(snapshot.state,'queued');const assigned=await call(h.api,'/api/tasks/'+a.taskId+'/assign',{body:body(h.runtime,2,{to:'other',expectedState:snapshot.expectedState})});assert.equal(assigned.status,200,JSON.stringify(assigned.body));gate.resolve();await h.runtime.idle();assert.equal(h.provider.calls.length,0);assert.equal(h.codex.calls.length,1);
});
test('TS-39.1 authenticated place GET follows read_pane policy and never grants owner writes',async t=>{
 for(const allow of [true,false]){
  const h=await fixture(t,{before:dir=>writeFileSync(join(dir,'.harness/comms-policy.yaml'),'version: 1\nroutes: []\nobserve: {executor: '+(allow?'[owner]':'[]')+'}\n')}),gate=deferred(),seen=deferred();
  h.provider.onRun=async(_s,_m,ctx)=>{ctx.registerProcessToken('queue-reader');seen.resolve();await gate.promise;return {text:'',sessionId:null}};
  const run=h.runtime.runTurn('worker','Чтение');await seen.promise;const headers={'X-Pane-Token':'queue-reader','X-Harness-Pane':'worker'};
  const result=await call(h.api,'/api/tasks',{headers});assert.equal(result.status,allow?200:403,JSON.stringify(result.body));if(!allow)assert.equal(result.body.code,'policy_denied');assert.equal((await call(h.api,'/api/tasks',{headers,body:body(h.runtime,1,{text:'forged'})})).body.code,'owner_only');gate.resolve();await run;
 }
});
test('TS-39.1 accepted task actions revoke until-reply autopilot; rejected writes leave it on',async t=>{
 const h=await held(t);async function enable(){const s=(await call(h.api,'/api/status')).body;const answer=await call(h.api,'/api/autopilot',{body:{project:h.dir,instance:s.trace.instanceId,revision:s.autopilot.revision,on:true,until:'reply',conditions:{operations:['answer_question'],maxSpendPercent:5}}});assert.equal(answer.status,200,JSON.stringify(answer.body))}
 await enable();assert.equal((await call(h.api,'/api/tasks',{body:body(h.runtime,1,{text:'x',instance:'forged'})})).body.code,'project_changed');assert.equal(h.runtime.settings.autopilot().on,true);
 const a=await create(h,1);assert.equal(h.runtime.settings.autopilot().on,false);await enable();assert.equal((await call(h.api,'/api/tasks/'+a.taskId+'/assign',{body:body(h.runtime,2,{to:'worker',expectedState:a.expectedState})})).status,200);assert.equal(h.runtime.settings.autopilot().on,false);
});

test('TS-39.1 skip only changes tasks in that attempt, including after restart',async t=>{
 const h=await held(t),a=await create(h,201,{to:'worker'});
 h.provider.onRun=async(seat,_message,ctx)=>{ctx.modelStarted?.();ctx.publish({type:'done',sessionId:'s',model:seat.model,durationMs:1,usage:{input:1,output:1,cacheRead:0}});return {text:'Без типизированного исхода',sessionId:'s'}};
 await h.runtime.halt(false,OWNER);await h.runtime.idle();assert.equal((await list(h)).tasks[0].state,'work');
 h.provider.onRun=async()=>{throw Error('Не начался второй ход')};const b=await create(h,202,{to:'worker'});await h.runtime.idle();const waiting=h.runtime.waiting('worker')!;assert.deepEqual(waiting.recordSeqs,[b.assignedSeq]);
 assert.equal((await call(h.api,'/api/panes/worker/attempt',{body:{project:h.dir,turnInstanceId:waiting.turnInstanceId,action:'skip'}})).status,200);await h.runtime.idle();
 for(const restart of [false,true]){if(restart)await h.runtime.openProject(h.dir);const rows=(await list(h)).tasks;assert.equal(rows.find((row:any)=>row.taskId===a.taskId).state,'work');assert.equal(rows.find((row:any)=>row.taskId===b.taskId).state,'unknown')}
});
