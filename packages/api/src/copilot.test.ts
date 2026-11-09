import test from 'node:test';
import {setTimeout as tick} from 'node:timers/promises';
async function until(ready:()=>boolean,signal:AbortSignal){for(let n=0;n<800;n++){signal.throwIfAborted();if(ready())return;await tick(10,undefined,{signal})}throw Error('Copilot SSE result timed out')}
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {CliStateStore} from '../../providers/src/cli/state.ts';
import {ProviderCatalog,LoginTerminal} from '@harnessy/providers';
import {copilotFixture} from '../../providers/src/copilot-test-helpers.ts';
import {fixture,call,sse} from './test-helpers.ts';
// 327: the process fixture takes about 11 seconds on Windows even in isolation;
// leave headroom for concurrent file runs and private-state ACL checks.
const copilotWorstUnderLoadMs=5689,copilotTimeoutMs=process.platform==='win32'?30_000:copilotWorstUnderLoadMs*2;
// 307 explicitly restores probe after owner approval; state remains private.
test('307: Copilot HTTP probe needs owner approval, preserves state, and keeps metadata available',{timeout:copilotTimeoutMs},async t=>{
 const cli=await copilotFixture(t),scripts:string[]=[],h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([cli.entry]),loginTerminal:new LoginTerminal({platform:'darwin',temporaryDirectory:cli.dir,open:async path=>{scripts.push(readFileSync(path,'utf8'))}})}}),stream=await sse(h.api);t.after(()=>stream.close());
 const store=new CliStateStore('copilot',cli.stateRoot),state=store.acquire(h.dir,'provider-probe');writeFileSync(join(state.path,'session'),'keep');state.release();
 await call(h.api,'/api/providers/copilot/check',{body:{}});const catalog=await call(h.api,'/api/providers/catalog'),row=catalog.body.providers[0];assert.equal(row.login.state,'ok');assert.equal(row.reason,undefined);assert.equal(row.capabilities.resume,true);assert.equal(row.capabilities.mcp,true);assert.equal(row.capabilities.limits,true);assert.equal(row.models[0].id,'cp-model');
 assert.equal((await call(h.api,'/api/providers/copilot/check',{body:{}})).body.login.state,'ok');await until(()=>stream.frames.some(e=>e.type==='providers'&&e.event==='check'),t.signal);
 const first=await call(h.api,'/api/providers/copilot/probe',{body:{model:'cp-model'}}),again=await call(h.api,'/api/providers/copilot/probe',{body:{model:'cp-model'}});assert.equal(first.status,200);assert.equal(again.body.approvalId,first.body.approvalId);assert.equal(cli.capture().some(c=>c.turn),false);
 await call(h.api,'/api/approve',{body:{pane:'owner',id:first.body.approvalId,decision:'allow',project:h.dir}});await until(()=>stream.frames.some(e=>e.type==='providers'&&e.event==='probe'&&e.status==='done'),t.signal);assert.equal(cli.capture().filter(c=>c.turn).length,1);
 assert.equal((await call(h.api,'/api/providers/copilot/probe',{body:{model:'cp-model',confirmed:true}})).body.code,'probe_invalid');
 const login=await call(h.api,'/api/providers/copilot/login-terminal',{body:{command:'touch /OWNER',model:'ignored'}});assert.equal(login.body.ok,true);assert.match(scripts[0]!,/'login'/);assert.doesNotMatch(scripts[0]!,/OWNER|FAKE-SECRET/);
 const forbidden=await call(h.api,'/api/providers/copilot/probe',{body:{model:'cp-model'},headers:{'X-Pane-Token':'forged','X-Harness-Pane':'owner'}});assert.equal(forbidden.body.code,'owner_only');assert.equal(cli.capture().filter(c=>c.turn).length,1);assert.equal(readFileSync(join(state.path,'session'),'utf8'),'keep');await h.runtime.close();assert.ok(existsSync(state.path));
});
test('283/367: limits HTTP uses the cached account until expiry or an explicit login check, never calls a model',{timeout:copilotTimeoutMs},async t=>{
 const cli=await copilotFixture(t),h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([cli.entry])}});
 const first=await call(h.api,'/api/limits');assert.equal(first.status,200,first.text);const cp=first.body.providers.find((p:any)=>p.vendor==='copilot');assert.ok(cp,JSON.stringify(first.body));assert.equal(cp.windows[0].label,'месяц · премиум-запросы');assert.equal(cp.windows[0].windowMinutes,null);assert.equal(cp.windows[0].percentUsed,25);assert.equal(cp.account,'alice@github.com');assert.equal(cp.checkedAt,h.clock.now());
 const measured=(await h.runtime.project.trace.read()).filter(e=>e.kind==='provider.limits');assert.equal(measured.length,1);assert.equal(measured[0]!.outcome,'ok');assert.deepEqual(measured[0]!.data,{vendor:'copilot',code:null,reason:''});assert.equal(measured[0]!.durationMs,0);assert.doesNotMatch(JSON.stringify(measured),/alice|github.com|FAKE-/);
 await call(h.api,'/api/limits');assert.equal(cli.capture().filter(c=>c.rpc==='account.getQuota').length,1);assert.equal(cli.capture().some(c=>c.turn),false);
 writeFileSync(cli.account,'another');const auths=cli.capture().filter(c=>c.rpc==='auth.getStatus').length,cached=await call(h.api,'/api/limits');assert.equal(cached.body.providers.find((p:any)=>p.vendor==='copilot').account,'alice@github.com');assert.equal(cli.capture().filter(c=>c.rpc==='auth.getStatus').length,auths);await call(h.api,'/api/providers/copilot/check',{body:{}});const changed=await call(h.api,'/api/limits');assert.equal(changed.body.providers.find((p:any)=>p.vendor==='copilot').account,'another@github.com');assert.equal(cli.capture().filter(c=>c.rpc==='account.getQuota').length,2);
});

test('283: quota failure is typed over HTTP with no invented Copilot measurement or model call',{timeout:copilotTimeoutMs},async t=>{
 const cli=await copilotFixture(t,'bad-quota'),h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([cli.entry])}}),r=await call(h.api,'/api/limits');
 assert.equal(r.body.ok,false);assert.equal(r.body.code,'limits_unavailable');assert.equal(typeof r.body.reason,'string');assert.equal(r.body.providers.find((p:any)=>p.vendor==='copilot').ok,false);assert.deepEqual(r.body.providers.find((p:any)=>p.vendor==='copilot').windows,[]);assert.equal(cli.capture().some(c=>c.turn),false);
});

for(const [scenario,reason] of [['missing-reset','Copilot не передал дату сброса квоты'],['bad-quota','Copilot: неверная квота']])test('299: '+scenario+' process → parser → HTTP/cache/trace keeps the precise reason without raw metadata',async t=>{
 const cli=await copilotFixture(t,scenario),h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([cli.entry])}});
 const result=await call(h.api,'/api/limits'),row=result.body.providers.find((p:any)=>p.vendor==='copilot');assert.equal(row.reason,reason);assert.equal(row.ok,false);assert.deepEqual(row.windows,[]);
 const cache=JSON.parse(readFileSync(join(h.deps.limitsCacheDir!,'copilot.json'),'utf8'));assert.equal(cache.reason,reason);
 const events=(await h.runtime.project.trace.read()).filter(e=>e.kind==='provider.limits');assert.equal(events.length,1);const event=events[0]!;
 assert.equal(event.outcome,'failed');assert.equal(event.reason.text,reason);assert.deepEqual(event.data,{vendor:'copilot',code:'limits_unavailable',reason});assert.ok(typeof event.durationMs==='number'&&event.durationMs>=0);
 assert.doesNotMatch(JSON.stringify(events),/alice|github.com|FAKE-|quotaSnapshots|resetDate|entitlementRequests/);
 await call(h.api,'/api/limits');assert.equal(cli.capture().filter(c=>c.rpc==='account.getQuota').length,1);assert.equal((await h.runtime.project.trace.read()).filter(e=>e.kind==='provider.limits').length,1);assert.equal(cli.capture().some(c=>c.turn),false);
});


test('319: actual account.getQuota field shape traverses CliProvider and HTTP without requiring a calendar reset',async t=>{
 const cli=await copilotFixture(t,'live-quota-shape'),h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([cli.entry])}});
 const r=await call(h.api,'/api/limits'),cp=r.body.providers.find((p:any)=>p.vendor==='copilot');assert.equal(cp.ok,true);assert.deepEqual(cp.windows.map((w:any)=>[w.label,w.percentUsed,w.windowMinutes,w.resetsAt]),['чат','дополнения'].map(label=>['месяц · '+label,0,null,Date.parse('2026-10-11T23:00:14.764-07:00')/1000]));assert.equal(cp.reason,undefined);assert.equal(cli.capture().some(c=>c.turn),false);
 const events=(await h.runtime.project.trace.read()).filter(e=>e.kind==='provider.limits');assert.equal(events.length,1);assert.equal(events[0]!.outcome,'ok');
});
