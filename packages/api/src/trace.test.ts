import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,call,OWNER,until,sse,deferred} from './test-helpers.ts';
import {promotionInput} from '../../runtime/src/test-helpers.ts';
import {invokeTool} from '../../providers/src/tools.ts';
import {serverRequest} from '../../providers/src/codex/protocol.ts';
import {TraceStore} from '../../runtime/src/trace.ts';
function click(h:Awaited<ReturnType<typeof fixture>>){const traceId=randomUUID(),spanId=randomUUID(),binding={project:h.runtime.project.dir,instanceId:h.runtime.project.trace.instanceId};return {body:{action:'Назначить оркестратора',page:'chat',traceId,spanId,binding},headers:{'X-Harness-Trace-Id':traceId,'X-Harness-Span-Id':spanId,'X-Harness-Project':encodeURIComponent(binding.project),'X-Harness-Instance':binding.instanceId}}}

test('233–239: click → promotion HTTP → turn → propose_seats → rejected Codex approval is one chain with durable refs',async t=>{
 const h=await fixture(t);h.runtime.roomSet({model:'w1'},OWNER);h.runtime.registry.get('room')!.record('me','Design a fixture building');const a=click(h);assert.equal((await call(h.api,'/api/trace',{body:a.body})).status,200);
 const events=await sse(h.api);t.after(()=>events.close());h.provider.onRun=async(_seat,_message,ctx)=>{ctx.modelStarted?.();const proposed=await invokeTool('propose_seats',{seats:[{kind:'worker',label:'Analyst',vendor:'claude',model:'w1',mode:'read',intro:'Read fixture'}]},ctx);assert.equal(proposed.ok,true);const decision=await serverRequest('item/commandExecution/requestApproval',{threadId:'t',turnId:'v',command:'fixture-command'},ctx,'t','v');assert.deepEqual(decision,{decision:'decline'});ctx.publish({type:'done',sessionId:null,model:'w1',durationMs:4,usage:{input:2,output:1,cacheRead:0}});return {text:'Approval was denied',sessionId:null}};
 const input=promotionInput(h.runtime),request=call(h.api,'/api/chats/'+input.chat+'/orchestrator',{body:input,headers:a.headers});
 await until(()=>[...h.runtime.registry.panes.values()].some(p=>p.approvals.size>0));const pane=[...h.runtime.registry.panes.values()].find(p=>p.approvals.size>0)!;pane.resolveApproval([...pane.approvals.keys()][0]!,false);const reply=await request;assert.equal(reply.status,200,reply.text);assert.equal(reply.headers['x-harness-trace-id'],a.body.traceId);await h.runtime.idle();
 const response=await call(h.api,'/api/trace?traceId='+a.body.traceId);assert.equal(response.status,200);const rows=response.body.records as any[];
 for(const kind of ['ui.action','http.request','http.response','turn.start','turn.end','tool.call','tool.result','queue.posted','queue.taken','approval.shown','approval.resolved'])assert.ok(rows.some(r=>r.kind===kind),kind);
 assert.ok(rows.some(r=>r.kind==='tool.result'&&r.outcome==='rejected'&&r.reason.code==='approval_policy'));assert.ok(rows.some(r=>r.kind==='tool.result'&&r.refs.proposalId));assert.ok(rows.some(r=>r.kind==='turn.end'&&r.data.usage.input===2));assert.ok(rows.some(r=>r.refs.journalSeq));assert.ok(rows.every(r=>r.project===h.dir&&r.traceId===a.body.traceId));assert.ok(rows.every(r=>r.spanId!==r.parentSpanId));assert.ok(rows.some(r=>r.refs.attemptId));
 await until(()=>events.frames.some(e=>e.type==='done'));assert.equal(events.frames.find(e=>e.type==='done')?.traceId,a.body.traceId);
 const seq=rows.find(r=>r.refs.journalSeq).refs.journalSeq;assert.ok((await call(h.api,'/api/trace?journalSeq='+seq)).body.records.some((r:any)=>r.kind==='ui.action'));
 const restarted=new TraceStore(h.dir);t.after(()=>restarted.close());assert.ok((await restarted.read({traceId:a.body.traceId})).some(r=>r.reason.code==='approval_policy'));
 const cli=execFileSync(process.execPath,[fileURLToPath(new URL('../bin/trace.ts',import.meta.url)),a.body.traceId],{cwd:h.dir,encoding:'utf8'});assert.match(cli,/harnessy:\/\/trace\//);assert.match(cli,/tool.result · rejected.*approval_policy/);
});

test('238: missing, forged or stale UI binding is rejected before a trace can enter another project or engine incarnation',async t=>{
 const h=await fixture(t),a=click(h);for(const binding of [undefined,{project:h.dir},{...a.body.binding,instanceId:randomUUID()},{...a.body.binding,project:'/foreign'}]){assert.equal((await call(h.api,'/api/trace',{body:{...a.body,binding}})).status,409)}
 for(const patch of [{traceId:'invalid'},{spanId:'invalid'},{action:'<img>'},{kind:'tool.result'},{kind:'ui.outcome',outcome:'rejected',reason:'invented'},{page:'../foreign'},{parentSpanId:'fake'}])assert.equal((await call(h.api,'/api/trace',{body:{...a.body,...patch}})).status,400);
 assert.equal((await call(h.api,'/api/trace?traceId='+a.body.traceId)).body.records.length,0);const before=h.runtime.project.trace.instanceId;await h.runtime.projectSet(h.dir,{reload:true},OWNER);assert.notEqual(h.runtime.project.trace.instanceId,before);assert.equal((await call(h.api,'/api/trace',{body:a.body})).status,409);assert.equal((await call(h.api,'/api/chat',{headers:a.headers,body:{pane:'worker',message:'must not run'}})).status,409);assert.equal(h.provider.calls.length,0);
 for(const q of ['traceId=invalid','outcome=invented','since=yesterday','journalSeq=-1'])assert.equal((await call(h.api,'/api/trace?'+q)).status,400);
});

test('238: a delayed HTTP read completes its span in the original store after project switch',async t=>{
 const h=await fixture(t),a=click(h),old=h.runtime.project.trace,gate=deferred<any>();let entered=false;h.provider.auth=()=>{entered=true;return gate.promise};const request=call(h.api,'/api/connections',{headers:a.headers});await until(()=>entered);
 const next=join(h.dir,'other');mkdirSync(join(next,'.harness/state'),{recursive:true});writeFileSync(join(next,'.harness/team.yaml'),'version: 1\nintegration_branch: main\nseats: {}\n');await h.runtime.openProject(next);gate.resolve({loggedIn:true});await request;assert.ok((await old.read({traceId:a.body.traceId})).some(r=>r.kind==='http.response'));assert.equal((await h.runtime.project.trace.read({traceId:a.body.traceId})).length,0);
});

test('238: owner trace controls validate whole patch, exclude project overrides, stop and resume writes',async t=>{
 const h=await fixture(t);for(const patch of [{traceEnabled:'true'},{traceMaxMiB:0},{traceMaxMiB:129},{traceMaxMiB:1.5}])assert.equal((await call(h.api,'/api/settings',{body:{scope:'owner',patch}})).body.ok,false);
 assert.equal((await call(h.api,'/api/settings',{body:{scope:'project',patch:{traceEnabled:false}}})).body.ok,false);writeFileSync(join(h.dir,'.harness/state/settings.json'),JSON.stringify({traceEnabled:false,traceMaxMiB:1}));assert.equal(h.runtime.settings.effective().traceEnabled,undefined);
 assert.equal((await call(h.api,'/api/settings',{body:{scope:'owner',patch:{traceEnabled:false,traceMaxMiB:2}}})).body.ok,true);let a=click(h);await call(h.api,'/api/trace',{body:a.body});assert.equal((await call(h.api,'/api/trace?traceId='+a.body.traceId)).body.records.length,0);assert.equal((await call(h.api,'/api/status')).body.trace.enabled,false);
 await call(h.api,'/api/settings',{body:{scope:'owner',patch:{traceEnabled:true}}});a=click(h);await call(h.api,'/api/trace',{body:a.body});assert.equal((await call(h.api,'/api/trace?traceId='+a.body.traceId)).body.records.length,1);assert.equal(h.runtime.project.trace.status.maxBytes,2*1024*1024);
});

test('234/238: limits 429 and provider errors retain typed reasons without credentials',async t=>{
 const h=await fixture(t),provider=h.provider as any;provider.limits=async()=>({ok:false,code:'limits_rate_limited',reason:'token=short-secret /outside/creds',retryAfter:300});await call(h.api,'/api/limits');const row=(await h.runtime.project.trace.read()).find(r=>r.kind==='limits.measurement'&&r.outcome==='failed');assert.ok(row);assert.equal(row.reason.code,'rate_limited');const bytes=readFileSync(h.runtime.project.trace.path,'utf8');assert.ok(!bytes.includes('short-secret'));assert.ok(!bytes.includes('/outside/creds'));
});

test('233/234: a tool-posted journal record carries the chain into the next model turn',async t=>{
 const h=await fixture(t,{seats:'  lead: {kind: orchestrator, role: orchestrator, vendor: claude, model: w1, mode: read}\n  worker: {kind: worker, role: executor, vendor: claude, model: w1, mode: read}'}),a=click(h);await call(h.api,'/api/trace',{body:a.body});h.provider.onRun=async(seat,_m,ctx)=>{ctx.modelStarted?.();if(seat.id==='lead'){const sent=await invokeTool('send',{to:'worker',kind:'task',text:'fixture work'},ctx);assert.equal(sent.ok,true,JSON.stringify(sent))}return {text:'done',sessionId:null}};const response=await call(h.api,'/api/chat',{body:{pane:'lead',message:'fixture'},headers:a.headers});assert.equal(response.status,200,response.text);await h.runtime.idle();const rows=await h.runtime.project.trace.read({traceId:a.body.traceId});assert.deepEqual(rows.filter(r=>r.kind==='turn.start').map(r=>r.pane).sort(),['lead','worker']);const posted=rows.find(r=>r.kind==='queue.posted'&&r.pane==='lead'),worker=rows.find(r=>r.kind==='turn.start'&&r.pane==='worker');assert.ok(posted&&worker);assert.equal(worker.parentSpanId,posted.spanId);
});

test('234: provider completion without a tool result is explicitly unavailable, not a successful tool',async t=>{const h=await fixture(t);h.provider.onRun=async(_s,_m,ctx)=>{ctx.modelStarted?.();ctx.traceEvent?.({id:'missing',name:'Write',phase:'call'});return {text:'done',sessionId:null}};await h.runtime.runTurn('worker','fixture');const rows=await h.runtime.project.trace.read();assert.ok(rows.some(r=>r.kind==='tool.result'&&r.outcome==='failed'&&r.reason.code==='unavailable'));});

test('234: an HTTP refusal records the typed policy reason and user-facing error',async t=>{const h=await fixture(t),a=click(h);const reply=await call(h.api,'/api/seats/owner',{headers:a.headers,body:{from:'lead'}});assert.equal(reply.status,403);const row=(await h.runtime.project.trace.read({traceId:a.body.traceId})).find(r=>r.kind==='http.response')!;assert.equal(row.reason.code,'approval_policy');assert.match(row.reason.text,/владелец/);assert.equal((row.data as any).route,'/api/seats/owner');});

test('238 round 2: forged chat, seat and turn bindings are typed refusals with no record or credential in disk/HTTP',async t=>{
 const h=await fixture(t);h.runtime.roomSet({model:'w1'},OWNER);const p=h.runtime.project,worker=p.registry.get('worker')!,chat=p.state.activeChat(worker)!,a=click(h),marker='sk_test_SYNTHETIC_FIXTURE_ONLY_1234567890',valid={...a.body.binding,pane:worker.id,chat:chat.id};
 assert.equal((await call(h.api,'/api/trace',{body:{...a.body,binding:valid}})).status,200);
 const before=await p.trace.read();
 for(const binding of [{...valid,chat:marker},{...valid,chat:'cdeadbeef'},{...valid,pane:'unknown'},{...valid,pane:'sk_test_fixture'},{...valid,pane:'room'},{...valid,pane:null},{...valid,turnInstanceId:marker},{...valid,turnInstanceId:randomUUID()},{...a.body.binding,turnInstanceId:randomUUID()},{...valid,chat:{}},{...valid,pane:['worker']},{...valid,turnInstanceId:[]}]){
  const id=randomUUID(),reply=await call(h.api,'/api/trace',{body:{...a.body,traceId:id,binding}});assert.equal(reply.status,400,JSON.stringify(binding));assert.equal(reply.body.code,'trace_invalid');
  const snapshot=await call(h.api,'/api/trace?traceId='+id);assert.deepEqual(snapshot.body.records,[]);assert.ok(!JSON.stringify([reply.body,snapshot.body]).includes(marker));
 }
 for(const patch of [{turnInstanceId:marker},{actor:marker},{binding:{...valid,extra:marker}}])assert.equal((await call(h.api,'/api/trace',{body:{...a.body,binding:valid,...patch}})).body.code,'trace_invalid');
 assert.equal((await p.trace.read()).length,before.length);const bytes=readFileSync(p.trace.path,'utf8');assert.ok(!bytes.includes(marker));assert.ok(!bytes.includes('sk_test_fixture'));
 const all=await call(h.api,'/api/trace');assert.ok(!JSON.stringify(all.body).includes(marker));assert.equal(all.body.records.find((r:any)=>r.traceId===a.body.traceId).chat,chat.id);
});

test('238 round 2: a known turn belongs to its actual chat and seat, including after project reload',async t=>{
 const h=await fixture(t);h.runtime.roomSet({model:'w1'},OWNER);const p=h.runtime.project,pane=p.registry.get('worker')!,chat=p.state.activeChat(pane)!,gate=deferred<{text:string;sessionId:null}>();h.provider.onRun=async()=>gate.promise;t.after(()=>gate.resolve({text:'done',sessionId:null}));const run=h.runtime.runTurn('worker','fixture');await until(()=>h.provider.calls.length===1);
 const turn=(await p.trace.read()).find(row=>row.kind==='turn.start'&&row.pane===pane.id)!;assert.ok(turn.turnInstanceId);
 const post=async(binding:object)=>{const a=click(h);return call(h.api,'/api/trace',{body:{...a.body,binding:{...a.body.binding,...binding}}})};
 const binding={pane:pane.id,chat:chat.id,turnInstanceId:turn.turnInstanceId};assert.equal((await post(binding)).status,200);
 gate.resolve({text:'done',sessionId:null});await run;assert.equal((await post(binding)).status,200);const other=p.state.newChat(pane);p.state.saveChats(p.registry);
 assert.equal((await post({...binding,chat:other.id})).body.code,'trace_invalid');
 const room=p.state.activeChat(p.registry.get('room')!)!;assert.equal((await post({...binding,pane:'room',chat:room.id})).body.code,'trace_invalid');
 await h.runtime.projectSet(h.dir,{reload:true},OWNER);assert.equal(h.runtime.project.trace.forTurn(turn.turnInstanceId!),undefined);
 assert.equal((await post(binding)).status,200);assert.equal((await post({...binding,chat:other.id})).status,400);
});

test('238 round 2: GET also sanitizes the entire stored envelope and never exposes unrecognized fields',async t=>{
 const h=await fixture(t),a=click(h);await call(h.api,'/api/trace',{body:a.body});const original=(await h.runtime.project.trace.read())[0]!,marker='sk_test_SYNTHETIC_FIXTURE_ONLY_1234567890';
 appendFileSync(h.runtime.project.trace.path,JSON.stringify({...original,seq:original.seq+1,kind:'ui.sk_test_fixture',actor:'model:sk_test_fixture',chat:marker,pane:'sk_test_fixture',turnInstanceId:marker,refs:{...original.refs,extra:marker},data:{action:marker},reason:{code:'none',text:marker},extra:marker})+'\n');
 const response=await call(h.api,'/api/trace?traceId='+a.body.traceId);assert.equal(response.status,200);assert.equal(response.body.records.length,2);assert.ok(!response.text.includes(marker));assert.ok(!response.text.includes('sk_test_fixture'));const row=response.body.records[1];assert.equal(row.chat,null);assert.equal(row.pane,null);assert.equal(row.turnInstanceId,null);assert.equal(row.truncated,true);assert.equal('extra' in row,false);assert.equal('extra' in row.refs,false);
});

test('238 round 3: six HTTP-created participant classes retain their identities in actions, turns and stored traces',async t=>{
 const h=await fixture(t,{seats:'  lead: {kind: orchestrator, role: orchestrator, vendor: claude, model: w1, mode: read}'}),gate=deferred<{text:string;sessionId:null}>(),kinds=['assistant','architect','worker','reviewer','tester','researcher'];
 t.after(()=>gate.resolve({text:'Done',sessionId:null}));h.provider.onRun=async(seat,_message,ctx)=>{ctx.modelStarted?.();if(seat.id==='lead'){ctx.registerProcessToken('fixture-token');return gate.promise}return {text:'Done',sessionId:null}};
 assert.equal((await call(h.api,'/api/chat',{body:{pane:'lead',message:'Предложи команду',direct:true}})).status,200);await until(()=>h.provider.calls.length===1);
 const proposed=await call(h.api,'/api/seats/propose',{body:{from:'lead',seats:kinds.map(kind=>({kind,label:kind,vendor:'claude',model:'w1',mode:'read',intro:'Fixture role'}))},headers:{'X-Pane-Token':'fixture-token'}});assert.equal(proposed.status,200,proposed.text);
 gate.resolve({text:'Done',sessionId:null});await h.runtime.idle();const q=proposed.body.proposal,bindings:Array<{pane:string;chat:string;traceId:string}>=[];
 for(let index=0;index<kinds.length;index++)await t.test(kinds[index]!,async()=>{
  const created=await call(h.api,'/api/seats/owner',{body:{project:h.dir,proposalId:q.proposalId,version:q.version,seatIndex:index}});assert.equal(created.status,200,created.text);const {pane,chat}=created.body;
  assert.equal(h.runtime.registry.get(pane)?.kind,kinds[index]);assert.equal(h.runtime.project.state.chats.chats[chat]?.pane,pane);
  const action=click(h),binding={...action.body.binding,pane,chat},reply=await call(h.api,'/api/trace',{body:{...action.body,action:'Открыть чат',binding}});assert.equal(reply.status,200,reply.text);
  assert.equal((await call(h.api,'/api/onboard',{body:{project:h.dir,pane,chat},headers:action.headers})).status,200);await h.runtime.idle();
  const rows=(await call(h.api,'/api/trace')).body.records;assert.ok(rows.some((row:any)=>row.traceId===action.body.traceId&&row.kind==='ui.action'&&row.pane===pane&&row.chat===chat));for(const kind of ['turn.start','turn.end'])assert.ok(rows.some((row:any)=>row.kind===kind&&row.pane===pane&&row.actor==='model:'+pane&&row.chat===chat),kind+' '+kinds[index]);const turn=rows.find((row:any)=>row.kind==='turn.start'&&row.pane===pane&&row.chat===chat);
  const disk=readFileSync(h.runtime.project.trace.path,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.ok(disk.some(row=>row.traceId===turn.traceId&&row.kind==='turn.start'&&row.pane===pane&&row.actor==='model:'+pane));bindings.push({pane,chat,traceId:turn.traceId});
 });
 assert.equal(bindings.length,kinds.length);assert.ok((await h.runtime.project.trace.read()).some(row=>row.refs.proposalId===q.proposalId));await h.runtime.projectSet(h.dir,{reload:true},OWNER);
 for(const binding of bindings){const rows=(await call(h.api,'/api/trace?traceId='+binding.traceId)).body.records;assert.ok(rows.some((row:any)=>row.kind==='turn.start'&&row.pane===binding.pane&&row.actor==='model:'+binding.pane))}
 const marker='sk_test_SYNTHETIC_FIXTURE_ONLY_1234567890',action=click(h),pane=bindings[0]!.pane,before=(await h.runtime.project.trace.read()).length;
 const rejected=await call(h.api,'/api/trace',{body:{...action.body,binding:{...action.body.binding,pane,chat:marker}}});assert.equal(rejected.status,400);assert.equal(rejected.body.code,'trace_invalid');const response=await call(h.api,'/api/trace?traceId='+action.body.traceId);assert.deepEqual(response.body.records,[]);assert.equal((await h.runtime.project.trace.read()).length,before);assert.ok(!response.text.includes(marker));assert.ok(!readFileSync(h.runtime.project.trace.path,'utf8').includes(marker));
});

test('238 round 3: HTTP promotion creates a traceable orchestrator, the seventh role class',async t=>{
 const h=await fixture(t);assert.equal((await call(h.api,'/api/room',{body:{model:'w1'}})).status,200);assert.equal((await call(h.api,'/api/chat',{body:{pane:'room',message:'Создай проект',direct:true}})).status,200);await h.runtime.idle();
 const input=promotionInput(h.runtime),promoted=await call(h.api,'/api/chats/'+input.chat+'/orchestrator',{body:input});assert.equal(promoted.status,200,promoted.text);await h.runtime.idle();
 const p=h.runtime.project,pane=[...p.registry.panes.values()].find(pane=>pane.kind==='orchestrator')!,chat=p.state.chats.active[pane.id]!,action=click(h),binding={...action.body.binding,pane:pane.id,chat};
 assert.equal((await call(h.api,'/api/trace',{body:{...action.body,action:'Написать',binding}})).status,200);assert.equal((await call(h.api,'/api/chat',{body:{pane:pane.id,message:'Следующий шаг',direct:true},headers:action.headers})).status,200);await h.runtime.idle();
 const rows=(await call(h.api,'/api/trace?traceId='+action.body.traceId)).body.records;assert.ok(rows.some((row:any)=>row.kind==='ui.action'&&row.pane===pane.id&&row.chat===chat));for(const kind of ['turn.start','turn.end'])assert.ok(rows.some((row:any)=>row.kind===kind&&row.pane===pane.id&&row.actor==='model:'+pane.id&&row.chat===chat));
 const disk=readFileSync(p.trace.path,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.ok(disk.some(row=>row.traceId===action.body.traceId&&row.kind==='turn.start'&&row.pane===pane.id&&row.actor==='model:'+pane.id));
});

test('365: engine route templates survive request/response, disk, reload and HTTP; supplied URLs and fields stay untrusted',{timeout:15000},async t=>{
 const h=await fixture(t),marker='sk-SYNTHETIC-365-SECRET';
 for(const path of ['/api/llm/providers/discover','/api/llm/providers/fixture/save','/api/llm/providers/'+marker+'/discover','/api/unknown/'+marker])await call(h.api,path+'?credential='+marker,{body:{credential:marker}});
 // The static discover POST and the GET of a provider named discover choose different routes.
 await call(h.api,'/api/llm/providers/discover');
 const template='/api/llm/providers/discover',store=h.runtime.project.trace,rows=await store.read();
 const http=rows.filter(row=>row.kind==='http.request'||row.kind==='http.response');
 for(const kind of ['http.request','http.response']){
  const records=http.filter(row=>row.kind===kind).map(row=>row.data as any);
  assert.deepEqual(records.map(row=>row.route),[template,'/api/llm/providers/:id/save','/api/llm/providers/:id/discover','/api/unknown','/api/llm/providers/:id']);
 }
 const bytes=readFileSync(store.path,'utf8');assert.match(bytes,/\/api\/llm\/providers\/discover/);assert.doesNotMatch(bytes,new RegExp(marker));
 // A forged persisted flag/name is not authority to bypass the shared sanitizer.
 appendFileSync(store.path,JSON.stringify({...http[0],seq:rows.at(-1)!.seq+1,data:{route:'/api/'+marker,routeTemplate:'/api/'+marker,action:'credential=Tiny!'},reason:{code:'provider_error',text:'credential=Tiny!'}})+'\n');
 await h.runtime.projectSet(h.dir,{reload:true},OWNER);
 const response=await call(h.api,'/api/trace');assert.equal(response.status,200);assert.doesNotMatch(response.text,/SYNTHETIC-365-SECRET|Tiny!/);
 for(const kind of ['http.request','http.response'])assert.ok(response.body.records.some((row:any)=>row.kind===kind&&row.data.route===template));
});
