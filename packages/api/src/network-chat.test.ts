import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdirSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture as realFixture,noRepositoryFixture as fixture,call,sse,until,FakeProvider,deferred,OWNER} from './test-helpers.ts';
import {listen,proxy,through} from '../../runtime/src/network-test-helpers.ts';
import {ProviderError} from '@harnessy/providers';

test('TS-45.4: no-repository Git probes are opt-in and reject writes, outside paths and repositories',async t=>{
 const ordinary=await realFixture(t),first=await fixture(t),second=await fixture(t);
 assert.equal(ordinary.deps.gitops,undefined);assert.notEqual(first.dir,second.dir);
 assert.equal(first.runtime.project.repoRoot,null);assert.equal(await first.deps.gitops!.repoRoot(first.dir),null);
 await assert.rejects(first.deps.gitops!.run(['init'],first.dir),/unexpected Git operation/);
 await assert.rejects(first.deps.gitops!.repoRoot(second.dir),/path outside project/);
 await assert.rejects(fixture(t,{deps:{gitops:first.deps.gitops!}}),/custom GitOps conflicts/);
 mkdirSync(join(first.dir,'.git'));await assert.rejects(first.deps.gitops!.repoRoot(first.dir),/Git repository exists/);
 assert.equal(await second.deps.gitops!.repoRoot(second.dir),null);
 symlinkSync('missing-target',join(second.dir,'.git'),process.platform==='win32'?'junction':undefined);await assert.rejects(second.deps.gitops!.repoRoot(second.dir),/Git repository exists/);
});

async function blocked(t:Parameters<typeof fixture>[0]){
 const h=await fixture(t,{deps:{networkRelayOptions:{timeoutMs:100}}});
 await h.runtime.settings.changeNetwork(async c=>{c.migrated=true;c.exits.nl={id:'nl',type:'proxy',label:'Нидерланды',url:'http://127.0.0.1:1'};c.chains.claude=['nl'];return {result:undefined}});
 const sent=await call(h.api,'/api/chat',{body:{pane:'worker',message:'first failed message'}});assert.equal(sent.status,200,sent.text);await h.runtime.idle();assert.ok(h.runtime.waiting('worker')?.failure);
 const input={project:h.dir,turnInstanceId:h.runtime.waiting('worker')!.turnInstanceId,action:'retry',network:'direct_once',binding:h.runtime.paneBinding('worker')};return {h,input};
}

test('23d: owner direct once consumes only failed records; next message still uses saved proxy, and receipt survives HTTP reload',{timeout:20000},async t=>{
 const {h,input}=await blocked(t),settings=h.runtime.settings.network(),stream=await sse(h.api);t.after(()=>stream.close());
 // TS-26 allows visible combination on a new message; pause to inspect an explicit retry in isolation.
 await h.runtime.halt(true,OWNER);
 const second=await call(h.api,'/api/chat',{body:{pane:'worker',message:'later queued message'}});assert.equal(second.status,200);
 input.binding=h.runtime.paneBinding('worker');const approved=await call(h.api,'/api/panes/worker/attempt',{body:input});assert.equal(approved.status,200,approved.text);await h.runtime.halt(false,OWNER);await h.runtime.idle();
 assert.equal(h.provider.calls.length,1);assert.match(h.provider.calls[0]!.message,/first failed message/);assert.doesNotMatch(h.provider.calls[0]!.message,/later queued message/);
 assert.deepEqual(h.runtime.settings.network(),settings);assert.ok(h.runtime.waiting('worker'));assert.deepEqual(h.runtime.waiting('worker')!.recordSeqs,[second.body.seq]);
 const repeat=await call(h.api,'/api/panes/worker/attempt',{body:input});assert.equal(repeat.status,200);await h.runtime.idle();assert.equal(h.provider.calls.length,1);
 assert.equal((await call(h.api,'/api/panes/worker/attempt',{body:{...input,network:undefined}})).body.code,'decision_exists');
 const chat=h.runtime.project.state.chats.active.worker!,messages=(await call(h.api,'/api/chats/'+chat)).body.messages,reply=messages.find((m:any)=>m.role==='ai');assert.equal(reply.network.directOnce,true);assert.deepEqual(reply.network.via,{id:'direct-once',type:'direct',label:'Напрямую'});
 await until(()=>stream.frames.some(e=>e.type==='done'));assert.equal(stream.frames.find(e=>e.type==='done').network.directOnce,true);assert.ok(readFileSync(h.runtime.project.state.chatsPath,'utf8').includes('directOnce'));
});

for(const changed of ['missing','network','project','chat','revision','instance','action','token','aba'])test('23d: direct permission rejects '+changed+' binding without a model call',async t=>{
 const {h,input}=await blocked(t);let body:any=structuredClone(input);
 if(changed==='missing')delete body.binding;if(changed==='network')delete body.binding.networkGeneration;if(changed==='project')body.project='/other';if(changed==='chat')body.binding.chat='other';if(changed==='revision')body.binding.revision++;if(changed==='instance')body.binding.instanceId='other';if(changed==='action')body.action='skip';if(changed==='token'){await assert.rejects(h.runtime.attempt('worker',body,{seat:'worker',trust:'agent'}),{code:'policy_denied'});assert.equal((await call(h.api,'/api/peer/attempt',{body,headers:{'X-Pane-Token':'fake'}})).status,404);assert.equal(h.provider.calls.length,0);return}
 if(changed==='aba'){await call(h.api,'/api/panes/worker',{body:{model:'w2'}});await call(h.api,'/api/panes/worker',{body:{model:'w1'}})}
 const result=await call(h.api,'/api/panes/worker/attempt',{body});assert.ok(result.status>=400,result.text);await h.runtime.idle();assert.equal(h.provider.calls.length,0);assert.ok(h.runtime.waiting('worker'));
});

test('23d: direct once uses the local relay for CLI, never another proxy or a later turn',async t=>{
 const {h}=await blocked(t),origin=http.createServer((_q,r)=>r.end('direct fixture')),port=await listen(t,origin),relay=h.runtime.networkRelay;
 const turn=relay.begin('claude','explicit-fixture',t.signal,undefined,true);t.after(()=>turn.close());const env=await relay.environment('claude',t.signal,turn);assert.ok(env?.HTTP_PROXY);
 assert.equal(await through(env!.HTTP_PROXY!,'http://127.0.0.1:'+port),'direct fixture');assert.equal(turn.receipt()?.directOnce,true);
 // A public address is resolved only by our fake fallback; this would not be reached by a configured proxy.
 await turn.close();const ordinary=relay.begin('claude','ordinary-fixture',t.signal);t.after(()=>ordinary.close());await assert.rejects(ordinary.ready(),{code:'network_no_reserve'});
});

test('23d: selected reserve metadata travels with answer, SSE and HTTP; public receipt contains no connection credentials',{timeout:20000},async t=>{
 const origin=http.createServer((_q,r)=>r.end('saved answer')),p=await proxy(t,await listen(t,origin)),fake=new FakeProvider(),h=await fixture(t,{deps:{providers:{claude:fake},networkRelayOptions:{timeoutMs:100}}});
 await h.runtime.settings.changeNetwork(async c=>{c.migrated=true;c.exits.a={id:'a',type:'proxy',label:'Основной',url:'http://127.0.0.1:1'};c.exits.b={id:'b',type:'proxy',label:'Нидерланды',url:p.url};c.chains.claude=['a','b'];return {result:undefined}});
 h.runtime.networkChecks.snapshot=(id,revision)=>({revision,checkedAt:1,ok:true,ip:'192.0.2.1',country:'Netherlands',durationMs:1,state:'checked'});
 fake.onRun=async(seat,_text,ctx)=>{ctx.modelStarted?.();const text=await through(ctx.env.HTTP_PROXY!,'http://fixture.invalid');ctx.publish({type:'delta',text});ctx.publish({type:'done',model:seat.model,sessionId:null,durationMs:1,usage:{input:null,output:null,cacheRead:null}});return {text,sessionId:null}};
 const stream=await sse(h.api);t.after(()=>stream.close());await call(h.api,'/api/chat',{body:{pane:'worker',message:'fake reserve'}});await h.runtime.idle();await until(()=>stream.frames.some(e=>e.type==='done'));
 const done=stream.frames.find(e=>e.type==='done');assert.equal(done.network.via.label,'Нидерланды');assert.equal(done.network.reserve.from.label,'Основной');assert.equal(done.network.reserve.reason,'connection');assert.equal(stream.frames.find(e=>e.type==='networkRoute').network.via.id,'b');
 const chat=h.runtime.project.state.chats.active.worker!,response=(await call(h.api,'/api/chats/'+chat)).body.messages.find((m:any)=>m.role==='ai');assert.equal(response.text,'saved answer');assert.deepEqual(response.network,done.network);assert.doesNotMatch(JSON.stringify(done.network),/url|password|login|127\.0\.0\.1/);
 const status=await call(h.api,'/api/status');assert.deepEqual(status.body.network.claude,done.network.via);
 await h.runtime.settings.changeNetwork(async c=>{c.chains.claude=['a'];return {result:undefined}});assert.deepEqual((await call(h.api,'/api/chats/'+chat)).body.messages.find((m:any)=>m.role==='ai').network,done.network);
});

for(const code of ['region_restricted','network_blocked','network_unavailable'] as const)test('23d: typed '+code+' is retained for explicit retry before model starts',async t=>{
 const h=await fixture(t),stream=await sse(h.api);t.after(()=>stream.close());h.provider.onRun=async()=>{throw new ProviderError(code,'diagnostic containing region is not a classification')};await call(h.api,'/api/chat',{body:{pane:'worker',message:'fake unavailable'}});await h.runtime.idle();assert.equal(h.runtime.waiting('worker')?.failure?.code,code);await until(()=>stream.frames.some(e=>e.type==='error'));assert.equal(stream.frames.find(e=>e.type==='error').waiting.failure.code,code);
});

test('23d: direct owner retry also reaches API agent once, using only a local HTTP model double',{timeout:20000},async t=>{
 const {config,openai}=await import('../../llm/src/test-helpers.ts');let calls=0;const origin=http.createServer((q,r)=>{q.resume();calls++;openai(r)}),port=await listen(t,origin),h=await fixture(t,{deps:{networkRelayOptions:{timeoutMs:100},llmFetch:async(input,init)=>fetch(String(input).replace('https://127.0.0.2','http://127.0.0.1'),init)}});
 // Keep a loopback-only fixture; the transport double forwards its alias to the listening socket.
 await h.runtime.settings.changeLlmProvider('test',config('https://127.0.0.2:'+port+'/v1'),null);await h.runtime.settings.changeNetwork(async c=>{c.migrated=true;c.exits.a={id:'a',label:'Failed proxy',type:'proxy',url:'http://127.0.0.1:1'};c.chains['api:test']=['a'];return {result:undefined}});
 assert.equal((await call(h.api,'/api/panes/worker',{body:{vendor:'api:test',model:'test-model'}})).status,200);await call(h.api,'/api/chat',{body:{pane:'worker',message:'API double'}});await h.runtime.idle();assert.equal(calls,0);const failure=h.runtime.waiting('worker');assert.ok(failure);
 const body={project:h.dir,turnInstanceId:failure.turnInstanceId,action:'retry',network:'direct_once',binding:h.runtime.paneBinding('worker')};const reply=await call(h.api,'/api/panes/worker/attempt',{body});assert.equal(reply.status,200,reply.text);await h.runtime.idle();assert.equal(calls,1);assert.equal(h.runtime.waiting('worker'),null);const message=h.runtime.registry.get('worker')!.transcript.find(m=>m.role==='ai')!;assert.equal(message.text,'hello world');assert.equal((message.network as any).directOnce,true);assert.deepEqual(h.runtime.settings.network().chains['api:test'],['a']);
});


async function networkChange(h:Awaited<ReturnType<typeof fixture>>,what:string){
 const before=h.runtime.settings.network();await h.runtime.settings.changeNetwork(async c=>{if(what==='chain'){c.exits.other={id:'other',type:'proxy',label:'Другой',url:'http://127.0.0.1:2'};c.chains.claude=['other']}else if(what==='policy')(c.policies??={}).claude={mode:'fallback',silenceSeconds:72};else{const exit=c.exits.nl!;if(exit.type==='proxy')exit.url='http://127.0.0.1:3'}return {result:undefined}});
 if(what==='aba')await h.runtime.settings.changeNetwork(async c=>{Object.assign(c,before);return {result:undefined}});
}
for(const what of ['chain','policy','address','aba'])test('23d r2: old direct approval rejects changed '+what+'; refreshed decision works',async t=>{
 const {h,input}=await blocked(t),generation=input.binding.networkGeneration;await networkChange(h,what);assert.notEqual(h.runtime.paneBinding('worker').networkGeneration,generation);
 const denied=await call(h.api,'/api/panes/worker/attempt',{body:input});assert.equal(denied.status,409);assert.equal(denied.body.code,'binding_changed');assert.match(denied.body.error,/Настройки изменились — решите заново/);await h.runtime.idle();assert.equal(h.provider.calls.length,0);assert.ok(h.runtime.waiting('worker'));
 const binding=h.runtime.paneBinding('worker'),approved=await call(h.api,'/api/panes/worker/attempt',{body:{...input,binding}});assert.equal(approved.status,200,approved.text);await h.runtime.halt(false,OWNER);await h.runtime.idle();assert.equal(h.provider.calls.length,1);
});
for(const what of ['chain','policy','address','aba'])test('23d r2: '+what+' during vendor wait restores a fresh decision card',async t=>{
 const {h,input}=await blocked(t),gate=deferred(),p=h.runtime.project;p.routeJobs.set('claude',gate.promise);t.after(()=>{p.routeJobs.delete('claude');gate.resolve()});
 const approved=await call(h.api,'/api/panes/worker/attempt',{body:input});assert.equal(approved.status,200,approved.text);await networkChange(h,what);p.routeJobs.delete('claude');gate.resolve();await h.runtime.idle();assert.equal(h.provider.calls.length,0);
 const waiting=h.runtime.waiting('worker')!;assert.ok(waiting);assert.notEqual(waiting.turnInstanceId,input.turnInstanceId);assert.equal(waiting.failure?.code,'network_changed');assert.match(waiting.failure!.reason,/Настройки изменились — решите заново/);assert.ok(waiting.actions.includes('retry'));
 const again=await call(h.api,'/api/panes/worker/attempt',{body:{...input,turnInstanceId:waiting.turnInstanceId,binding:h.runtime.paneBinding('worker')}});assert.equal(again.status,200,again.text);await h.runtime.idle();assert.equal(h.provider.calls.length,1);assert.match(h.provider.calls[0]!.message,/first failed message/);
});
test('23d r2: changes during final network preparation cancel direct permission before the provider starts',async t=>{
 const {h,input}=await blocked(t),gate=deferred(),entered=deferred(),relay=h.runtime.networkRelay,prepare=relay.prepare.bind(relay);relay.prepare=async(...args)=>{if(args[2]?.directOnce){entered.resolve();await gate.promise}return prepare(...args)};t.after(()=>gate.resolve());
 assert.equal((await call(h.api,'/api/panes/worker/attempt',{body:input})).status,200);await entered.promise;await networkChange(h,'address');gate.resolve();await h.runtime.idle();assert.equal(h.provider.calls.length,0);assert.equal(h.runtime.waiting('worker')?.failure?.code,'network_changed');
});
test('23d r2: edits to another provider preserve the permission; direct-only chain refuses it',async t=>{
 const {h,input}=await blocked(t);await h.runtime.settings.changeNetwork(async c=>{c.exits.other={id:'other',type:'proxy',label:'Codex',url:'http://127.0.0.1:2'};c.chains.codex=['other'];return {result:undefined}});assert.equal(h.runtime.paneBinding('worker').networkGeneration,input.binding.networkGeneration);
 assert.equal((await call(h.api,'/api/panes/worker/attempt',{body:input})).status,200);await h.runtime.idle();assert.equal(h.provider.calls.length,1);
 const b=await blocked(t);await b.h.runtime.settings.changeNetwork(async c=>{c.exits.direct={id:'direct',type:'direct',label:'Напрямую'};c.chains.claude=['direct'];return {result:undefined}});const result=await call(b.h.api,'/api/panes/worker/attempt',{body:{...b.input,binding:b.h.runtime.paneBinding('worker')}});assert.equal(result.body.code,'attempt_invalid');assert.equal(b.h.provider.calls.length,0);
});


test('23d r2: API agent rechecks permission after preparation before sending any model request',async t=>{
 const {config}=await import('../../llm/src/test-helpers.ts');let calls=0;const h=await fixture(t,{deps:{networkRelayOptions:{timeoutMs:100},llmFetch:async()=>{calls++;throw Error('unexpected model call')}}});await h.runtime.settings.changeLlmProvider('test',config('https://127.0.0.2:9999/v1'),null);
 await h.runtime.settings.changeNetwork(async c=>{c.migrated=true;c.exits.p={id:'p',type:'proxy',label:'Proxy',url:'http://127.0.0.1:1'};c.chains['api:test']=['p'];return {result:undefined}});assert.equal((await call(h.api,'/api/panes/worker',{body:{vendor:'api:test',model:'test-model'}})).status,200);await call(h.api,'/api/chat',{body:{pane:'worker',message:'API payload'}});await h.runtime.idle();const waiting=h.runtime.waiting('worker')!;assert.ok(waiting);assert.equal(calls,0);
 const gate=deferred(),entered=deferred(),relay=h.runtime.networkRelay,prepare=relay.prepare.bind(relay);relay.prepare=async(...args)=>{if(args[2]?.directOnce){entered.resolve();await gate.promise}return prepare(...args)};t.after(()=>gate.resolve());
 const input={project:h.dir,turnInstanceId:waiting.turnInstanceId,action:'retry',network:'direct_once',binding:h.runtime.paneBinding('worker')};assert.equal((await call(h.api,'/api/panes/worker/attempt',{body:input})).status,200);await entered.promise;await h.runtime.settings.changeNetwork(async c=>{(c.policies??={})['api:test']={mode:'fallback',silenceSeconds:72};return {result:undefined}});gate.resolve();await h.runtime.idle();assert.equal(calls,0);assert.equal(h.runtime.waiting('worker')?.failure?.code,'network_changed');
});


test('23d r2: API transport rejects A-B-A after beforeModel, including the loopback shortcut',async t=>{
 const {config}=await import('../../llm/src/test-helpers.ts');let calls=0;const h=await fixture(t,{deps:{networkRelayOptions:{timeoutMs:100},llmFetch:async()=>{calls++;throw Error('unexpected model call')}}});await h.runtime.settings.changeLlmProvider('test',config('https://127.0.0.2:9999/v1'),null);
 await h.runtime.settings.changeNetwork(async c=>{c.migrated=true;c.exits.p={id:'p',type:'proxy',label:'Proxy',url:'http://127.0.0.1:1'};c.chains['api:test']=['p'];return {result:undefined}});assert.equal((await call(h.api,'/api/panes/worker',{body:{vendor:'api:test',model:'test-model'}})).status,200);await call(h.api,'/api/chat',{body:{pane:'worker',message:'API late transport'}});await h.runtime.idle();const waiting=h.runtime.waiting('worker')!;assert.ok(waiting);
 const gate=deferred(),entered=deferred(),routed=h.runtime.routedFetch.bind(h.runtime);h.runtime.routedFetch=provider=>{const actual=routed(provider);return async(input,init)=>{if(h.runtime.networkRelay.scoped(provider)?.directOnce){entered.resolve();await gate.promise}return actual(input,init)}};t.after(()=>gate.resolve());
 const input={project:h.dir,turnInstanceId:waiting.turnInstanceId,action:'retry',network:'direct_once',binding:h.runtime.paneBinding('worker')};assert.equal((await call(h.api,'/api/panes/worker/attempt',{body:input})).status,200);await entered.promise;
 for(const port of [2,1])await h.runtime.settings.changeNetwork(async c=>{const exit=c.exits.p!;if(exit.type==='proxy')exit.url='http://127.0.0.1:'+port;return {result:undefined}});gate.resolve();await h.runtime.idle();assert.equal(calls,0);assert.equal(h.runtime.waiting('worker')?.failure?.code,'network_changed');
});


test('23d r2: a settings edit while finishing the decision cannot rebind the grant or reuse its old attempt',async t=>{
 const {h,input}=await blocked(t),p=h.runtime.project,parent=p.trace.forTurn(input.turnInstanceId);assert.ok(parent);const clear=p.state.clearAttempt.bind(p.state);
 p.state.clearAttempt=id=>{clear(id);p.state.clearAttempt=clear;const path=join(h.dir,'owner-settings.json'),owner=JSON.parse(readFileSync(path,'utf8'));owner.network.exits.nl.url='http://127.0.0.1:3';writeFileSync(path,JSON.stringify(owner))};
 await p.trace.run(parent,()=>h.runtime.attempt('worker',input,OWNER));await h.runtime.idle();assert.equal(h.provider.calls.length,0);const waiting=h.runtime.waiting('worker')!;assert.ok(waiting);assert.notEqual(waiting.turnInstanceId,input.turnInstanceId);assert.equal(waiting.failure?.code,'network_changed');
 const retry=await call(h.api,'/api/panes/worker/attempt',{body:{...input,turnInstanceId:waiting.turnInstanceId,binding:h.runtime.paneBinding('worker')}});assert.equal(retry.status,200,retry.text);await h.runtime.idle();assert.equal(h.provider.calls.length,1);
});
