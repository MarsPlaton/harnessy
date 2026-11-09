import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderCatalog,limitsReason,type CatalogEntry,type ProviderLimits} from '@harnessy/providers';
import {ProviderLimitsStore} from './provider-limits.ts';
import {FakeClock,deferred,until,harness,collect} from './test-helpers.ts';
const live=(clock:FakeClock):ProviderLimits=>({ok:true,plan:null,source:'not copied',fetchedAt:clock.now()/1000,windows:[{label:'month',percentUsed:25,resetsAt:clock.now()/1000+86400,windowMinutes:44640}]});
function setup(t:any){const dir=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-cli-limits-'))),clock=new FakeClock();let identity='a@github.com',authError=false,authReads=0,reads=0,result:()=>Promise<ProviderLimits>=async()=>live(clock),events=0;
 const entry:CatalogEntry={id:'copilot',title:'GitHub Copilot',binary:'fake',login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,resume:true,mcp:true,limits:true},version:async()=>'1.0',auth:async()=>{authReads++;if(authError)throw Error('no verified account');return {loggedIn:!!identity,email:identity}},models:async()=>[],runTurn:async()=>{throw Error('no model allowed')},limits:async()=>{reads++;return result()}};
 const catalog=new ProviderCatalog([entry]),stores:ProviderLimitsStore[]=[],diagnostics:any[]=[];const create=()=>{const s=new ProviderLimitsStore(catalog,clock,()=>events++,dir,event=>diagnostics.push(event));stores.push(s);return s};
 t.after(()=>{stores.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true})});return {dir,clock,catalog,entry,create,diagnostics,get authReads(){return authReads},get reads(){return reads},get events(){return events},identity:(s:string)=>{identity=s},confirm:async(s:string)=>{identity=s;await catalog.get('copilot').auth()},authError:(value=true)=>{authError=value},result:(fn:()=>Promise<ProviderLimits>)=>{result=fn},disk:()=>JSON.parse(readFileSync(join(dir,'copilot.json'),'utf8'))};
}
test('283: two engines share one account-bound monthly measurement and five-minute TTL',async t=>{
 const h=setup(t),gate=deferred<ProviderLimits>();h.result(()=>gate.promise);const a=h.create(),b=h.create(),first=a.refresh(),second=b.refresh();await until(()=>h.reads===1);gate.resolve(live(h.clock));await Promise.all([first,second]);
 for(const s of [a,b]){const row=s.snapshot().providers[0]!;assert.equal(row.vendor,'copilot');assert.equal(row.windows[0]!.label,'month');assert.equal(row.windows[0]!.percentUsed,25);assert.equal(row.checkedAt,h.clock.now());assert.equal(row.account,'a@github.com')}
 assert.equal(h.reads,1);h.clock.advance(299999);await h.create().refresh();assert.equal(h.reads,1);h.clock.advance(1);await b.refresh();assert.equal(h.reads,2);assert.doesNotMatch(readFileSync(join(h.dir,'copilot.json'),'utf8'),/not copied|token|secret/);
 await h.confirm('b@github.com');await a.refresh();assert.equal(h.reads,3);assert.equal(a.snapshot().providers[0]!.account,'b@github.com');assert.ok(h.events>0);
});
test('283: account change during quota read rejects the measurement without invented zero',async t=>{
 const h=setup(t),gate=deferred<ProviderLimits>(),s=h.create();h.result(()=>gate.promise);const job=s.refresh();await until(()=>h.reads===1);await h.confirm('b@github.com');gate.resolve(live(h.clock));await job;
 assert.equal(s.snapshot().providers[0]!.ok,false);assert.deepEqual(s.snapshot().providers[0]!.windows,[]);assert.equal(s.snapshot().errors[0]!.code,'login_changed');assert.equal(h.disk().value,null);await s.refresh();assert.equal(s.snapshot().providers[0]!.account,'b@github.com');assert.equal(h.reads,2);
});
test('283: unavailable/throwing quota persists bounded backoff, Retry-After and recovery across engines',async t=>{
 const h=setup(t),s=h.create();h.result(async()=>({ok:false,code:'limits_rate_limited',reason:'private response',retryAfterSeconds:720}));await s.refresh();assert.equal(h.disk().nextAttemptAt,h.clock.now()+720000);assert.equal(h.disk().backoff,300000);
 assert.equal(s.snapshot().providers[0]!.ok,false);assert.deepEqual(s.snapshot().providers[0]!.windows,[]);assert.equal(s.snapshot().errors[0]!.code,'limits_unavailable');assert.doesNotMatch(JSON.stringify(s.snapshot()),/private response/);
 h.clock.advance(719999);await h.create().refresh();assert.equal(h.reads,1);h.clock.advance(1);h.result(async()=>{throw Error('private transport')});await s.refresh();assert.equal(h.disk().backoff,600000);assert.equal(h.disk().pending,null);
 for(const delay of [600000,1200000,1800000]){h.clock.advance(delay);await s.refresh();assert.equal(h.disk().backoff,Math.min(delay*2,1800000))}
 h.clock.advance(1800000);h.result(async()=>live(h.clock));await s.refresh();assert.equal(h.disk().backoff,0);assert.equal(s.snapshot().providers[0]!.windows[0]!.percentUsed,25);
});
test('283: timeout ends a pending attempt; close prevents late publication and cache completion',async t=>{
 const h=setup(t),gate=deferred<ProviderLimits>(),s=h.create();h.result(()=>gate.promise);const job=s.refresh();await until(()=>h.reads===1);h.clock.advance(15000);await job;assert.equal(h.disk().pending,null);assert.equal(s.snapshot().errors[0]!.code,'limits_unavailable');
 h.clock.advance(300000);const next=s.refresh();await until(()=>h.reads===2);const before=readFileSync(join(h.dir,'copilot.json'),'utf8'),events=h.events;s.close();await next;gate.resolve(live(h.clock));await Promise.resolve();assert.equal(h.events,events);assert.equal(readFileSync(join(h.dir,'copilot.json'),'utf8'),before);
});
test('283: corrupt bytes, missing measurement fields and symlinks cannot masquerade as a quota',async t=>{
 const h=setup(t),s=h.create(),file=join(h.dir,'copilot.json');const corrupt=Buffer.from([0xff,123]);writeFileSync(file,corrupt);await s.refresh();assert.deepEqual(readFileSync(file),corrupt);assert.equal(h.reads,0);assert.equal(s.snapshot().errors[0]!.code,'limits_unavailable');unlinkSync(file);
 const outside=join(h.dir,'untouched');writeFileSync(outside,'untouched');await t.test('file symlink cache is rejected',async sub=>{try{symlinkSync(outside,file)}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){sub.skip('Windows file symlink requires privilege');return}throw e}await s.refresh();assert.equal(readFileSync(outside,'utf8'),'untouched');assert.equal(h.reads,0);unlinkSync(file)});
 h.result(async()=>({ok:true,plan:null,windows:[{label:'month'}],fetchedAt:h.clock.now()/1000}) as any);await s.refresh();assert.deepEqual(s.snapshot().providers[0]!.windows,[]);assert.equal(h.disk().value,null);
});
test('283: CLI measurement survives base-provider SSE; closing the project invalidates outstanding reads',async t=>{
 const h=setup(t),runtime=await harness(t,{deps:{providerCatalog:h.catalog,clock:h.clock,limitsCacheDir:h.dir}}),events=collect(runtime.runtime);t.after(()=>events.sub.close());const first=await runtime.runtime.limits();assert.equal(first.providers.find(p=>p.vendor==='copilot')!.windows[0]!.percentUsed,25);
 await until(()=>events.events.some(e=>e.type==='limits'));for(const e of events.events.filter(e=>e.type==='limits'))if((e as any).providers.some((p:any)=>p.vendor==='copilot'))assert.equal((e as any).providers.find((p:any)=>p.vendor==='copilot').windows[0].percentUsed,25);
 const gate=deferred<ProviderLimits>();h.result(()=>gate.promise);h.clock.advance(300000);const job=runtime.runtime.limits(),rejected=assert.rejects(job,{code:'project_changed'});await until(()=>h.reads===2);await runtime.runtime.close();await rejected;gate.resolve(live(h.clock));
});

test('283: absent capability is excluded; absent account returns a per-provider failure without a measurement or quota call',async t=>{
 const h=setup(t),noLimits=new ProviderCatalog([{...h.entry,capabilities:{...h.entry.capabilities,limits:false}}]);
 const s=new ProviderLimitsStore(noLimits,h.clock,()=>{},h.dir);t.after(()=>s.close());await s.refresh();assert.deepEqual(s.snapshot().providers,[]);assert.equal(h.reads,0);
 h.identity('');const enabled=h.create();await enabled.refresh();assert.equal(enabled.snapshot().providers[0]!.ok,false);assert.deepEqual(enabled.snapshot().providers[0]!.windows,[]);assert.equal(enabled.snapshot().errors[0]!.code,'limits_unavailable');assert.equal(h.reads,0);
});

test('286: rate limit preserves the last same-account measurement across TTL and engine restart',async t=>{
 const h=setup(t),s=h.create();await s.refresh();const saved=h.disk().value;h.clock.advance(300000);
 h.result(async()=>({ok:false,code:'limits_rate_limited',reason:'private upstream body',retryAfterSeconds:720}));await s.refresh();
 assert.deepEqual(h.disk().value,saved);assert.equal(h.disk().nextAttemptAt,h.clock.now()+720000);
 const restarted=h.create();await restarted.refresh();assert.equal(h.reads,2);
 for(const store of [s,restarted]){const row=store.snapshot().providers[0]!;assert.equal(row.ok,false);assert.equal(row.stale,true);assert.equal(row.code,'limits_unavailable');assert.equal(row.fetchedAt,saved.fetchedAt);assert.equal(row.windows[0]!.percentUsed,25);assert.equal(row.windows[0]!.resetsAt,saved.windows[0].resetsAt);assert.equal(row.nextAttemptAt,(h.clock.now()+720000)/1000);assert.doesNotMatch(JSON.stringify(row),/private upstream body/)}
 await h.confirm('b@github.com');await s.refresh();assert.equal(h.reads,3);assert.equal(h.disk().value,null);assert.deepEqual(s.snapshot().providers[0]!.windows,[]);
});
test('367: transient auth failure preserves the last measurement and its age across readers and restarts',async t=>{
 const h=setup(t),s=h.create();await s.refresh();const value=h.disk().value;assert.equal(h.authReads,1);
 h.authError();await Promise.all(Array.from({length:8},()=>s.refresh()));assert.equal(h.authReads,1,'fresh cache never checks login');
 h.clock.advance(300000);await s.refresh();assert.equal(h.authReads,2);assert.deepEqual(h.disk().value,value);
 const restarted=h.create();await restarted.refresh();assert.equal(h.authReads,2);
 for(const store of [s,restarted]){const row=store.snapshot().providers[0]!;assert.equal(row.ok,false);assert.equal(row.stale,true);assert.equal(row.account,'a@github.com');assert.equal(row.windows[0]!.percentUsed,25);assert.equal(row.fetchedAt,value.fetchedAt);assert.equal(row.reason,limitsReason('limits_auth'))}
 h.clock.advance(300000);h.authError(false);await restarted.refresh();assert.equal(h.authReads,3);assert.equal(h.reads,2);assert.equal(restarted.snapshot().providers[0]!.stale,false);assert.equal(restarted.snapshot().providers[0]!.ok,true);
});

test('286: account substitution during a refresh discards the previous account cache',async t=>{
 const h=setup(t),s=h.create();await s.refresh();h.clock.advance(300000);h.result(async()=>{await h.confirm('b@github.com');return live(h.clock)});await s.refresh();assert.equal(s.snapshot().providers[0]!.code,'login_changed');assert.deepEqual(s.snapshot().providers[0]!.windows,[]);assert.equal(h.disk().value,null);
});

for(const transition of ['b@github.com','','aba'])for(const failed of ['reject','timeout'])test('367/r2: '+failed+' after confirmed '+(transition||'logout')+' cannot retain a previous quota',async t=>{
 const h=setup(t),s=h.create();await s.refresh();h.clock.advance(300000);const gate=deferred<ProviderLimits>();h.result(()=>gate.promise);const pending=s.refresh();await until(()=>h.reads===2);
 await h.confirm(transition==='aba'?'b@github.com':transition);if(transition==='aba')await h.confirm('a@github.com');
 if(failed==='reject')gate.reject(Error('private quota failure'));else h.clock.advance(15000);await pending;
 const row=s.snapshot().providers[0]!;assert.deepEqual(row.windows,[]);assert.equal(row.account,null);assert.equal(row.code,'login_changed');assert.match(row.reason!,/Вход сменился/);assert.equal(h.disk().value,null);assert.equal(h.diagnostics.at(-1)?.code,'login_changed');
 if(failed==='timeout'){gate.resolve(live(h.clock));await Promise.resolve();assert.deepEqual(s.snapshot().providers[0]!.windows,[])}
});

test('367/r2: corrupt cache preserves only the last measurement for the still-confirmed account, including direct snapshots',async t=>{
 const h=setup(t),s=h.create();await s.refresh();const file=join(h.dir,'copilot.json'),broken='broken fixture';writeFileSync(file,broken);
 await s.refresh();assert.equal(s.snapshot().providers[0]!.windows[0]!.percentUsed,25,'temporary storage failure with the same login retains the measured value');
 await h.confirm('b@github.com');assert.deepEqual(s.snapshot().providers[0]!.windows,[],'an unrelated SSE snapshot cannot republish account A');assert.equal(s.snapshot().providers[0]!.code,'login_changed');
 await s.refresh();assert.deepEqual(s.snapshot().providers[0]!.windows,[]);assert.equal(s.snapshot().providers[0]!.code,'login_changed');assert.equal(h.diagnostics.at(-1)?.code,'login_changed');assert.equal(readFileSync(file,'utf8'),broken);assert.equal(h.reads,1);
});

for(const aba of [false,true])test('367/r2: damaged cache during rejected quota cannot bypass the captured login generation'+(aba?' (ABA)':''),async t=>{
 const h=setup(t),s=h.create();await s.refresh();h.clock.advance(300000);const gate=deferred<ProviderLimits>();h.result(()=>gate.promise);const pending=s.refresh();await until(()=>h.reads===2);
 await h.confirm('b@github.com');if(aba)await h.confirm('a@github.com');const file=join(h.dir,'copilot.json');writeFileSync(file,'broken');gate.reject(Error('quota rejected'));await pending;
 assert.deepEqual(s.snapshot().providers[0]!.windows,[]);assert.equal(s.snapshot().providers[0]!.code,'login_changed');assert.equal(readFileSync(file,'utf8'),'broken');
});

test('299: parser reason survives API snapshot, TTL/backoff, cache restart and stale windows; recovery clears it',async t=>{
 const h=setup(t),s=h.create();await s.refresh();const saved=h.disk().value;h.clock.advance(300000);
 const reason='Copilot не передал дату сброса квоты';h.result(async()=>({ok:false,code:'limits_unavailable',reason}));await s.refresh();
 assert.equal(s.snapshot().providers[0]!.reason,reason);assert.equal(h.disk().reason,reason);assert.deepEqual(h.disk().value,saved);
 const restarted=h.create();await restarted.refresh();assert.equal(restarted.snapshot().providers[0]!.reason,reason);assert.equal(restarted.snapshot().errors[0]!.reason,reason);assert.equal(h.reads,2);
 assert.equal(h.diagnostics.length,2,'a cached failure is not a new CLI read');assert.deepEqual(h.diagnostics[1],{vendor:'copilot',ok:false,code:'limits_unavailable',reason,durationMs:0});
 h.clock.advance(300000);h.result(async()=>live(h.clock));await s.refresh();assert.equal(h.disk().reason,null);assert.equal(s.snapshot().providers[0]!.reason,undefined);assert.equal(h.diagnostics.at(-1).ok,true);
});

test('299: unknown reasons and thrown errors never expose secrets to cache, diagnostics or API',async t=>{
 const h=setup(t),s=h.create(),secret='PRIVATE-RAW-ERROR Bearer small-secret account@example.test';h.result(async()=>({ok:false,code:'limits_rate_limited',reason:secret}));await s.refresh();
 assert.equal(s.snapshot().providers[0]!.reason,limitsReason('limits_rate_limited'));assert.equal(h.disk().reason,limitsReason('limits_rate_limited'));
 h.clock.advance(300000);h.result(async()=>{throw Error(secret)});await s.refresh();assert.equal(s.snapshot().providers[0]!.reason,limitsReason('limits_unavailable'));
 assert.doesNotMatch(JSON.stringify([h.disk(),h.diagnostics,s.snapshot()]),/PRIVATE|small-secret|account@example/);
});

test('299: old caches without a reason remain readable; untrusted reason text cannot escape the cache',async t=>{
 const h=setup(t),s=h.create();h.result(async()=>({ok:false,code:'limits_unavailable',reason:'Copilot не передал измеряемые квоты'}));await s.refresh();
 const row=h.disk(),file=join(h.dir,'copilot.json');delete row.reason;writeFileSync(file,JSON.stringify(row));const legacy=h.create();await legacy.refresh();assert.equal(legacy.snapshot().providers[0]!.reason,limitsReason('limits_unavailable'));
 row.reason='unmarked-private-value';writeFileSync(file,JSON.stringify(row));const forged=h.create();await forged.refresh();assert.equal(forged.snapshot().providers[0]!.reason,limitsReason('limits_unavailable'));assert.doesNotMatch(JSON.stringify(h.diagnostics),/unmarked-private/);assert.equal(h.reads,1);
});

test('299: timeout and account replacement diagnostics retain duration and cannot inherit parser reasons from the old account',async t=>{
 const h=setup(t),gate=deferred<ProviderLimits>(),s=h.create();h.result(()=>gate.promise);const pending=s.refresh();await until(()=>h.reads===1);h.clock.advance(15000);await pending;
 assert.equal(h.disk().reason,limitsReason('limits_timeout'));assert.equal(h.diagnostics[0].durationMs,15000);
 h.clock.advance(300000);h.result(async()=>{await h.confirm('b@github.com');return {ok:false,code:'limits_unavailable',reason:'Copilot не передал дату сброса квоты'}});await s.refresh();
 assert.equal(h.disk().reason,'Вход сменился во время чтения лимитов');assert.equal(h.diagnostics.at(-1).code,'login_changed');assert.equal(h.disk().value,null);
});


test('319: unknown window duration survives cache restart without manufacturing a start or rejecting measured quota',async t=>{
 const h=setup(t),s=h.create();h.result(async()=>{const v=live(h.clock);if(v.ok)v.windows[0]!.windowMinutes=null;return v});await s.refresh();assert.equal(s.snapshot().providers[0]!.ok,true);assert.equal(h.disk().value.windows[0].windowMinutes,null);
 const restart=h.create();await restart.refresh();const row=restart.snapshot().providers[0]!;assert.equal(row.ok,true);assert.equal(row.windows[0]!.percentUsed,25);assert.equal(row.windows[0]!.windowMinutes,null);assert.equal(h.reads,1);
});

const unlimited=():ProviderLimits=>({ok:false,code:'limits_unlimited',reason:'все квоты Copilot безлимитны'});
test('325: confirmed unlimited replaces finite quota, survives TTL/restart and later accepts a finite measurement',async t=>{
 const h=setup(t),s=h.create();await s.refresh();assert.equal(s.snapshot().providers[0]!.windows[0]!.percentUsed,25);
 h.clock.advance(300000);h.result(async()=>unlimited());await s.refresh();
 const check=(store:ProviderLimitsStore)=>{const row=store.snapshot().providers[0]!;assert.equal(row.ok,true);assert.equal(row.code,'limits_unlimited');assert.equal(row.reason,'все квоты Copilot безлимитны');assert.equal(row.unlimited,true);assert.deepEqual(row.windows,[]);assert.equal(row.stale,false);assert.deepEqual(store.snapshot().errors,[])};
 check(s);assert.equal(h.disk().value.unlimited,true);assert.deepEqual(h.disk().value.windows,[]);assert.equal(h.disk().backoff,0);assert.equal(h.disk().nextAttemptAt,h.clock.now()+300000);
 assert.deepEqual(h.diagnostics.at(-1),{vendor:'copilot',ok:true,code:'limits_unlimited',reason:'все квоты Copilot безлимитны',durationMs:0});
 const restarted=h.create();await restarted.refresh();check(restarted);assert.equal(h.reads,2);assert.equal(h.diagnostics.length,2);
 h.clock.advance(300000);h.result(async()=>({ok:false,code:'limits_rate_limited',reason:'private',retryAfterSeconds:720}));await s.refresh();const stale=s.snapshot().providers[0]!;assert.equal(stale.ok,false);assert.equal(stale.unlimited,true);assert.equal(stale.stale,true);assert.equal(stale.code,'limits_unavailable');assert.deepEqual(stale.windows,[]);assert.equal(stale.fetchedAt,h.disk().value.fetchedAt);
 h.clock.advance(720000);h.result(async()=>live(h.clock));await s.refresh();const finite=s.snapshot().providers[0]!;assert.equal(finite.ok,true);assert.equal(finite.unlimited,undefined);assert.equal(finite.code,undefined);assert.equal(finite.windows[0]!.percentUsed,25);assert.equal(h.disk().value.unlimited,undefined);
});
test('325/367: unlimited is rejected after a catalog-confirmed account change during quota reading',async t=>{
 const h=setup(t),s=h.create();await s.refresh();h.clock.advance(300000);h.result(async()=>{await h.confirm('b@github.com');return unlimited()});await s.refresh();const rejected=s.snapshot().providers[0]!;assert.equal(rejected.code,'login_changed');assert.equal(rejected.unlimited,undefined);assert.deepEqual(rejected.windows,[]);assert.equal(h.disk().value,null);
 await s.refresh();assert.equal(s.snapshot().providers[0]!.account,'b@github.com');assert.equal(s.snapshot().providers[0]!.code,'limits_unlimited');
 await h.confirm('c@github.com');h.result(async()=>({ok:false,code:'limits_unavailable',reason:'private'}));await s.refresh();assert.equal(s.snapshot().providers[0]!.unlimited,undefined);assert.equal(h.disk().value,null);
});
for(const tamper of ['missing-flag','finite-windows','missing-value'])test('325: invalid unlimited cache cannot masquerade as success: '+tamper,async t=>{
 const h=setup(t),s=h.create();h.result(async()=>unlimited());await s.refresh();const raw=h.disk();if(tamper==='missing-flag')delete raw.value.unlimited;else if(tamper==='missing-value')raw.value=null;else {const finite=live(h.clock);if(finite.ok)raw.value.windows=finite.windows}
 const file=join(h.dir,'copilot.json'),bytes=JSON.stringify(raw);writeFileSync(file,bytes);const restarted=h.create();await restarted.refresh();const row=restarted.snapshot().providers[0]!;assert.equal(row.ok,false);assert.equal(row.code,'limits_unavailable');assert.equal(row.unlimited,undefined);assert.equal(readFileSync(file,'utf8'),bytes);assert.equal(h.reads,1);
});

test('367: catalog and three limits readers share one in-flight auth; cancellation of one waiter leaves the others alive',async t=>{
 const h=setup(t),gate=deferred<{loggedIn:boolean;email:string}>();let auths=0,signal:AbortSignal|undefined;
 const catalog=new ProviderCatalog([{...h.entry,auth:async s=>{auths++;signal=s;return gate.promise}}]),a=new ProviderLimitsStore(catalog,h.clock,()=>{},h.dir),b=new ProviderLimitsStore(catalog,h.clock,()=>{},h.dir);
 t.after(()=>{a.close();b.close();void catalog.close()});const stop=new AbortController(),cancelled=catalog.get('copilot').auth(stop.signal);const reject=assert.rejects(cancelled,{code:'cancelled'}),reading=catalog.read('copilot'),jobs=[a.refresh(),a.refresh(),b.refresh()];await until(()=>auths===1);stop.abort();await reject;assert.equal(signal!.aborted,false);gate.resolve({loggedIn:true,email:'a@github.com'});await Promise.all([reading,...jobs]);
 assert.equal(auths,1);assert.equal(h.reads,1);assert.equal(a.snapshot().providers[0]!.windows[0]!.percentUsed,25);assert.equal(b.snapshot().providers[0]!.windows[0]!.percentUsed,25);
});

test('367: repeated auth failures without a previous value are throttled; confirmed logout clears a saved value',async t=>{
 const h=setup(t),s=h.create();h.authError();await s.refresh();await h.create().refresh();assert.equal(h.authReads,1);assert.equal(h.reads,0);assert.deepEqual(s.snapshot().providers[0]!.windows,[]);
 h.clock.advance(300000);h.authError(false);await s.refresh();assert.equal(h.authReads,2);assert.equal(s.snapshot().providers[0]!.windows[0]!.percentUsed,25);
 await h.confirm('');await s.refresh();assert.deepEqual(s.snapshot().providers[0]!.windows,[]);assert.equal(h.disk().value,null);assert.equal(h.disk().account,null);
});

test('367: A→B→A while quota is pending invalidates that result even when account text is equal again',async t=>{
 const h=setup(t),s=h.create(),gate=deferred<ProviderLimits>();h.result(()=>gate.promise);const job=s.refresh();await until(()=>h.reads===1);await h.confirm('b@github.com');await h.confirm('a@github.com');gate.resolve(live(h.clock));await job;assert.equal(s.snapshot().providers[0]!.code,'login_changed');assert.deepEqual(s.snapshot().providers[0]!.windows,[]);assert.equal(h.disk().value,null);
});

test('367: an authenticated response without identity is a transient quota failure, not a confirmed logout',async t=>{
 const h=setup(t);let absent=false;const catalog=new ProviderCatalog([{...h.entry,auth:async()=>absent?{loggedIn:true}:{loggedIn:true,email:'a@github.com'}}]),store=new ProviderLimitsStore(catalog,h.clock,()=>{},h.dir);t.after(()=>{store.close();void catalog.close()});await store.refresh();const known=h.disk().value,binding=catalog.authBinding('copilot');h.clock.advance(300000);absent=true;await store.refresh();
 assert.equal(store.snapshot().providers[0]!.windows[0]!.percentUsed,25);assert.equal(store.snapshot().providers[0]!.reason,limitsReason('limits_auth'));assert.deepEqual(h.disk().value,known);assert.equal(h.reads,1);assert.deepEqual(catalog.authBinding('copilot'),binding);
});
