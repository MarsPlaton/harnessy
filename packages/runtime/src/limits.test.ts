import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,symlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import type {ProviderLimits} from '@harnessy/providers';
import {LimitsStore} from './limits.ts';
import {harness,FakeProvider,FakeClock,deferred,until,collect,OWNER} from './test-helpers.ts';
const live=(now:number,percent=18):Extract<ProviderLimits,{ok:true}>=>({ok:true,plan:null,fetchedAt:now/1000,source:'fixture',windows:[{label:'5 ч',percentUsed:percent,resetsAt:now/1000+60,windowMinutes:300}]});
test('144/200: quotas persist only measurements, throttle scheduled reads for five minutes and turn reads for 60 seconds and emit an event',async t=>{
 const clock=new FakeClock();let reads=0;const provider=Object.assign(new FakeProvider(),{limits:async()=>{reads++;return {...live(clock.now()),token:'fixture-secret'}}});
 const h=await harness(t,{deps:{providers:{claude:provider},clock}}),events=collect(h.runtime);t.after(()=>events.sub.close());
 let result=await h.runtime.limits();assert.equal(reads,1);assert.equal(result.providers[0]!.windows[0]!.percentUsed,18);assert.equal(result.providers[0]!.windows[0]!.resetsIn,60);
 const path=join(h.dir,'.harness/state/limits.json');assert.doesNotMatch(readFileSync(path,'utf8'),/fixture-secret|token|fixture/);await h.runtime.limits();assert.equal(reads,1);
 clock.advance(60000);await h.runtime.limits();assert.equal(reads,1);clock.advance(240000);await until(()=>reads===2);await h.runtime.limits();assert.equal(reads,2);
 clock.advance(60000);await h.runtime.runTurn('worker','hello');await until(()=>reads===3);await h.runtime.limits();assert.ok(events.events.some(e=>e.type==='limits'));
 const store=new LimitsStore(h.dir,clock,{claude:provider},()=>{},join(h.dir,'limits-cache'));assert.equal(store.snapshot().providers[0]!.windows[0]!.percentUsed,18);store.close();
});
test('144/203: unsupported providers and failed refresh retain typed reasons and a dated stale snapshot',async t=>{
 const h=await harness(t);const unavailable=await h.runtime.limits();assert.equal(unavailable.providers[0]!.code,'limits_unsupported');assert.deepEqual(unavailable.providers[0]!.windows,[]);
 const provider=Object.assign(new FakeProvider(),{limits:async():Promise<ProviderLimits>=>live(h.clock.now())});const store=new LimitsStore(h.dir,h.clock,{claude:provider},()=>{},join(h.dir,'limits-cache'));t.after(()=>store.close());await store.refresh();h.clock.advance(901000);assert.equal(store.snapshot().providers[0]!.stale,true);
 provider.limits=async()=>({ok:false,code:'limits_rate_limited',reason:'fixture-secret'});await store.refresh();const stale=store.snapshot().providers[0]!;assert.equal(stale.windows[0]!.percentUsed,18);assert.equal(stale.code,'limits_rate_limited');assert.equal(stale.stale,true);assert.doesNotMatch(JSON.stringify(stale),/fixture-secret/);
});
test('200: closing or switching a project cancels quota reads; late responses cannot write or publish into either project',async t=>{
 const gate=deferred<ProviderLimits>(),provider=Object.assign(new FakeProvider(),{limits:async()=>gate.promise});const h=await harness(t,{deps:{providers:{claude:provider}}}),events=collect(h.runtime);const pending=h.runtime.limits();const changed=assert.rejects(pending,e=>!!e&&typeof e==='object'&&'code'in e&&e.code==='project_changed');
 const next=join(h.dir,'next');mkdirSync(next);await h.runtime.projectSet(next,{},OWNER);await changed;gate.resolve(live(h.clock.now()));await Promise.resolve();assert.equal(existsSync(join(h.dir,'.harness/state/limits.json')),false);assert.equal(existsSync(join(next,'.harness/state/limits.json')),false);assert.ok(!events.events.some(e=>e.type==='limits'));
});
test('200: timeout bounds a stalled provider and leaves a usable typed response',async t=>{
 const provider=Object.assign(new FakeProvider(),{limits:async()=>new Promise<ProviderLimits>(()=>{})}),h=await harness(t,{deps:{providers:{claude:provider}}});const pending=h.runtime.limits();h.clock.advance(10000);const result=await pending;assert.equal(result.providers[0]!.code,'limits_timeout');assert.deepEqual(result.providers[0]!.windows,[]);
});
test('200: missing fields, foreign cache and symlinks never masquerade as current live quota',async t=>{
 const h=await harness(t),path=join(h.dir,'.harness/state/limits.json');for(const payload of [{version:1,project:'/foreign',providers:[]},{version:1,project:h.dir,providers:[{vendor:'claude',fetchedAt:h.clock.now()/1000,windows:[{label:'5 ч',percentUsed:99}]}]}]){writeFileSync(path,JSON.stringify(payload));const store=new LimitsStore(h.dir,h.clock,{claude:h.provider},()=>{},join(h.dir,'limits-cache'));assert.equal(store.snapshot().providers[0]!.code,'limits_invalid');assert.deepEqual(store.snapshot().providers[0]!.windows,[]);store.close()}
 const outside=join(h.dir,'outside.json');writeFileSync(outside,'untouched');const linkDir=join(h.dir,'symlink-project');mkdirSync(join(linkDir,'.harness/state'),{recursive:true});let linked=true;try{symlinkSync(outside,join(linkDir,'.harness/state/limits.json'))}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){linked=false;t.diagnostic('Windows file symlink requires privilege')}else throw e}if(linked){const provider=Object.assign(new FakeProvider(),{limits:async()=>live(h.clock.now())}),store=new LimitsStore(linkDir,h.clock,{claude:provider},()=>{},join(linkDir,'limits-cache'));assert.equal(store.snapshot().providers[0]!.code,'limits_invalid');await store.refresh();assert.equal(readFileSync(outside,'utf8'),'untouched');store.close()}
});

test('144: final quota contract distinguishes API-key plans and refuses absent measurement fields',async t=>{
 const h=await harness(t),provider=Object.assign(new FakeProvider(),{limits:async():Promise<ProviderLimits>=>live(h.clock.now())}),store=new LimitsStore(h.dir,h.clock,{claude:provider},()=>{},join(h.dir,'limits-cache'));t.after(()=>store.close());await store.refresh();const row=store.snapshot().providers[0]!;assert.equal(row.status,'ok');assert.equal(row.plan,null);assert.equal(row.fetchedAt,h.clock.now()/1000);
 for(const key of ['plan','fetchedAt','windows']){provider.limits=async()=>{const raw:any=live(h.clock.now());delete raw[key];return raw};h.clock.advance(60000);await store.refresh('claude',true);assert.equal(store.snapshot().providers[0]!.code,'limits_invalid')}
 provider.limits=async()=>({ok:false,code:'limits_not_applicable',reason:'do not pass through'});h.clock.advance(60000);await store.refresh('claude',true);assert.equal(store.snapshot().providers[0]!.status,'not_applicable');assert.deepEqual(store.snapshot().providers[0]!.windows,[]);assert.equal(store.snapshot().providers[0]!.plan,null);assert.doesNotMatch(JSON.stringify(store.snapshot()),/do not pass through/);
});

test('TS-12 r2: snapshot revisions advance when the last quota disappears, across errors and same-project reopen',async t=>{
 const h=await harness(t),provider=Object.assign(new FakeProvider(),{limits:async():Promise<ProviderLimits>=>live(h.clock.now(),61)}),store=new LimitsStore(h.dir,h.clock,{claude:provider},()=>{},join(h.dir,'limits-cache'));t.after(()=>store.close());await store.refresh();const first=store.snapshot();assert.equal(first.providers[0]!.status,'ok');
 provider.limits=async()=>({ok:false,code:'limits_not_applicable',reason:''});h.clock.advance(60000);await store.refresh('claude',true);const empty=store.snapshot();assert.equal(empty.updatedAt,null);assert.equal(empty.providers[0]!.status,'not_applicable');assert.ok(empty.revision>first.revision);assert.deepEqual(empty.providers[0]!.windows,[]);
 provider.limits=async()=>({ok:false,code:'limits_auth',reason:''});h.clock.advance(60000);await store.refresh('claude',true);const error=store.snapshot();assert.equal(error.updatedAt,null);assert.ok(error.revision>empty.revision);const reopened=new LimitsStore(h.dir,h.clock,{claude:provider},()=>{},join(h.dir,'limits-cache'));assert.ok(reopened.snapshot().revision>error.revision);reopened.close();
});

test('TS-12 r2: an unchanged unsupported source does not send quota events into an idle subscription',async t=>{
 const h=await harness(t),events=collect(h.runtime),first=h.runtime.limitsSnapshot();t.after(()=>events.sub.close());await h.runtime.limits();h.clock.advance(60000);await h.runtime.limits();assert.equal(h.runtime.limitsSnapshot().revision,first.revision);assert.ok(!events.events.some(e=>e.type==='limits'));
});

test('214: fresh shared cache serves two engines without a second provider read and persists each project snapshot',async t=>{
 const clock=new FakeClock(),gate=deferred<ProviderLimits>();let reads=0;const provider=Object.assign(new FakeProvider(),{limits:async()=>{reads++;return gate.promise}});
 const a=await harness(t,{deps:{clock,providers:{claude:provider}}}),b=await harness(t,{deps:{clock,providers:{claude:provider},limitsCacheDir:a.deps.limitsCacheDir!}});
 const one=a.runtime.limits(),two=b.runtime.limits();await until(()=>reads===1);gate.resolve(live(clock.now(),42));const results=await Promise.all([one,two]);for(const result of results)assert.equal(result.providers[0]!.windows[0]!.percentUsed,42);assert.equal(reads,1);
 for(const h of [a,b])assert.equal(JSON.parse(readFileSync(join(h.dir,'.harness/state/limits.json'),'utf8')).providers[0].windows[0].percentUsed,42);
 const fresh=new LimitsStore(b.dir,clock,{claude:provider},()=>{},a.deps.limitsCacheDir);t.after(()=>fresh.close());await fresh.refresh();assert.equal(reads,1);assert.equal(fresh.snapshot().providers[0]!.windows[0]!.percentUsed,42);
 const raw=readFileSync(join(a.deps.limitsCacheDir!,'claude.json'),'utf8');assert.doesNotMatch(raw,/token|accessToken|fixture-secret/);
});

test('214: a turn inside the first minute is coalesced, and scheduled reads cannot run faster than five minutes',async t=>{
 const clock=new FakeClock();let reads=0;const provider=Object.assign(new FakeProvider(),{limits:async()=>{reads++;return live(clock.now())}}),h=await harness(t,{deps:{clock,providers:{claude:provider}}});await h.runtime.limits();assert.equal(reads,1);
 clock.advance(10000);await h.runtime.runTurn('worker','first');await h.runtime.limits();assert.equal(reads,1);clock.advance(49000);await h.runtime.limits();assert.equal(reads,1);clock.advance(1000);await h.runtime.limits();assert.equal(reads,2);
 for(let i=0;i<4;i++){clock.advance(60000);await h.runtime.limits();assert.equal(reads,2)}clock.advance(60000);await h.runtime.limits();assert.equal(reads,3);
});

test('214: Retry-After survives another engine, a turn, and reopen; repeated 429/5xx doubles backoff up to 30 minutes',async t=>{
 const h=await harness(t),clock=h.clock;let reads=0,result:ProviderLimits=live(clock.now(),42);const provider=Object.assign(new FakeProvider(),{limits:async()=>{reads++;return result}}),dir=join(h.dir,'backoff'),store=new LimitsStore(h.dir,clock,{claude:provider},()=>{},dir);t.after(()=>store.close());await store.refresh();
 clock.advance(300000);result={ok:false,code:'limits_rate_limited',reason:'fixture-secret',retryAfterSeconds:720};await store.refresh();let row=store.snapshot().providers[0]!;assert.equal(row.status,'unavailable');assert.equal(row.nextAttemptAt,clock.now()/1000+720);assert.equal(row.windows[0]!.percentUsed,42);assert.doesNotMatch(JSON.stringify(row),/fixture-secret/);
 const peer=new LimitsStore(h.dir,clock,{claude:provider},()=>{},dir);t.after(()=>peer.close());clock.advance(719000);await peer.refresh('claude',true);assert.equal(reads,2);assert.equal(peer.snapshot().providers[0]!.nextAttemptAt,row.nextAttemptAt);
 clock.advance(1000);result={ok:false,code:'limits_unavailable',reason:'fixture-secret'};await peer.refresh();assert.equal(reads,3);assert.equal(peer.snapshot().providers[0]!.nextAttemptAt,clock.now()/1000+600);
 for(const delay of [600,1200,1800,1800]){clock.advance(delay*1000);await store.refresh();row=store.snapshot().providers[0]!;assert.equal(row.nextAttemptAt,clock.now()/1000+Math.min(1800,delay*2))}
 clock.advance(1800000);result=live(clock.now(),17);await store.refresh();row=store.snapshot().providers[0]!;assert.equal(row.status,'ok');assert.equal(row.windows[0]!.percentUsed,17);assert.equal(row.nextAttemptAt,clock.now()/1000+300);
 clock.advance(300000);result={ok:false,code:'limits_rate_limited',reason:''};await store.refresh();assert.equal(store.snapshot().providers[0]!.nextAttemptAt,clock.now()/1000+300,'success resets exponential backoff');
});

test('215: Codex credits survive both caches and a failed refresh without inventing a five-hour window',async t=>{
 const h=await harness(t),clock=h.clock;let result:ProviderLimits={ok:true,plan:'Pro',source:'fixture-secret',fetchedAt:clock.now()/1000,windows:[{label:'неделя',percentUsed:21,windowMinutes:10080,resetsAt:null}],credits:{hasCredits:true,unlimited:false,balance:62500},resetCredits:2};const provider=Object.assign(new FakeProvider('codex'),{limits:async()=>result}),dir=join(h.dir,'credits');const store=new LimitsStore(h.dir,clock,{codex:provider},()=>{},dir);t.after(()=>store.close());await store.refresh();
 const next=new LimitsStore(h.dir,clock,{codex:provider},()=>{},dir);t.after(()=>next.close());await next.refresh();let row=next.snapshot().providers[0]!;assert.equal(row.credits!.balance,62500);assert.equal(row.resetCredits,2);assert.equal(row.windows.length,1);assert.equal(row.windows[0]!.windowMinutes,10080);
 clock.advance(300000);result={ok:false,code:'limits_unavailable',reason:'fixture-secret'};await next.refresh();row=next.snapshot().providers[0]!;assert.equal(row.credits!.balance,62500);assert.equal(row.status,'unavailable');assert.doesNotMatch(readFileSync(join(dir,'codex.json'),'utf8'),/fixture-secret/);
});

test('215: Codex credits persist in the project snapshot and survive reload without adding a five-hour window',async t=>{
 const h=await harness(t),clock=h.clock,provider=Object.assign(new FakeProvider('codex'),{limits:async():Promise<ProviderLimits>=>({ok:true,plan:'Pro',source:'fixture-secret',fetchedAt:clock.now()/1000,windows:[{label:'неделя',percentUsed:21,windowMinutes:10080,resetsAt:null}],credits:{hasCredits:true,unlimited:false,balance:62500},resetCredits:2})});const store=new LimitsStore(h.dir,clock,{codex:provider},()=>{},join(h.dir,'limits-cache'));t.after(()=>store.close());await store.refresh();const next=new LimitsStore(h.dir,clock,{codex:provider},()=>{},join(h.dir,'limits-cache'));t.after(()=>next.close());const row=next.snapshot().providers[0]!;assert.equal(row.credits!.balance,62500);assert.equal(row.resetCredits,2);assert.equal(row.windows.length,1);assert.equal(row.windows[0]!.windowMinutes,10080);assert.doesNotMatch(readFileSync(join(h.dir,'.harness/state/limits.json'),'utf8'),/fixture-secret/);
});

for(const code of ['limits_rate_limited','limits_unavailable'] as const)test(`214 r2: an empty peer reservation and ${code} preserve the project measurement and credits until success or not_applicable`,async t=>{
 const clock=new FakeClock(),a=await harness(t,{deps:{clock}}),b=await harness(t,{deps:{clock}}),dir=join(a.dir,'shared-new-cache'),path=join(a.dir,'.harness/state/limits.json');
 const measured={ok:true as const,plan:'Pro',source:'fixture',fetchedAt:clock.now()/1000,windows:[{label:'неделя',percentUsed:42,windowMinutes:10080,resetsAt:null}],credits:{hasCredits:true,unlimited:false,balance:62500},resetCredits:2};
 const gate=deferred<ProviderLimits>();let reads=0,result:ProviderLimits=measured;const provider=Object.assign(new FakeProvider('codex'),{limits:async()=>{reads++;return reads===2?gate.promise:result}});
 const seed=new LimitsStore(a.dir,clock,{codex:provider},()=>{},dir);await seed.refresh();seed.close();const saved=JSON.parse(readFileSync(path,'utf8')).providers[0];
 unlinkSync(join(dir,'codex.json'));const active=new LimitsStore(a.dir,clock,{codex:provider},()=>{},dir);t.after(()=>active.close());
 const peer=new LimitsStore(b.dir,clock,{codex:provider},()=>{},dir);t.after(()=>peer.close());const pending=peer.refresh();await until(()=>reads===2);
 const opened=new LimitsStore(a.dir,clock,{codex:provider},()=>{},dir);t.after(()=>opened.close());const during=opened.snapshot().providers[0]!,duringDisk=JSON.parse(readFileSync(path,'utf8')).providers;
 gate.resolve({ok:false,code,reason:'fixture-secret'});await pending;await Promise.all([active.refresh(),opened.refresh()]);
 assert.equal(during.windows[0]?.percentUsed,42);assert.equal(during.credits?.balance,62500);assert.equal(during.resetCredits,2);assert.equal(during.fetchedAt,measured.fetchedAt);assert.deepEqual(duringDisk,[saved]);
 for(const store of [active,opened]){const row=store.snapshot().providers[0]!;assert.equal(row.status,'unavailable');assert.equal(row.code,code);assert.equal(row.windows[0]?.percentUsed,42);assert.equal(row.credits?.balance,62500);assert.equal(row.resetCredits,2);assert.equal(row.fetchedAt,measured.fetchedAt);assert.equal(row.nextAttemptAt,clock.now()/1000+300);assert.equal(row.stale,true)}
 assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).providers,[saved]);assert.equal(reads,2);const reopened=new LimitsStore(a.dir,clock,{codex:provider},()=>{},dir);t.after(()=>reopened.close());assert.equal(reopened.snapshot().providers[0]!.credits?.balance,62500);
 clock.advance(300000);result={...measured,fetchedAt:clock.now()/1000,windows:[{...measured.windows[0]!,percentUsed:17}],credits:{...measured.credits,balance:60000},resetCredits:1};await peer.refresh();await opened.refresh();let row=opened.snapshot().providers[0]!;assert.equal(row.status,'ok');assert.equal(row.windows[0]?.percentUsed,17);assert.equal(row.credits?.balance,60000);assert.equal(row.resetCredits,1);
 const revision=opened.snapshot().revision;clock.advance(300000);result={ok:false,code:'limits_not_applicable',reason:''};await peer.refresh();await opened.refresh();row=opened.snapshot().providers[0]!;assert.equal(row.status,'not_applicable');assert.deepEqual(row.windows,[]);assert.equal(row.credits,undefined);assert.equal(row.resetCredits,undefined);assert.equal(row.fetchedAt,null);assert.equal(opened.snapshot().updatedAt,null);assert.ok(opened.snapshot().revision>revision);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).providers,[]);
 const cleared=new LimitsStore(a.dir,clock,{codex:provider},()=>{},dir);t.after(()=>cleared.close());assert.equal(cleared.snapshot().providers[0]!.status,'not_applicable');assert.deepEqual(cleared.snapshot().providers[0]!.windows,[]);assert.equal(reads,4);
});

test('214 r2: an older shared measurement retained by a failed peer cannot replace newer project data',async t=>{
 const h=await harness(t),clock=h.clock,dir=join(h.dir,'older-shared'),path=join(h.dir,'.harness/state/limits.json');let result:ProviderLimits={ok:true,plan:'Pro',source:'fixture',fetchedAt:clock.now()/1000,windows:[{label:'неделя',percentUsed:18,windowMinutes:10080,resetsAt:null}],credits:{hasCredits:true,unlimited:false,balance:1},resetCredits:0};
 const provider=Object.assign(new FakeProvider('codex'),{limits:async()=>result}),seed=new LimitsStore(h.dir,clock,{codex:provider},()=>{},dir);await seed.refresh();seed.close();clock.advance(300000);result={ok:false,code:'limits_unavailable',reason:''};const peer=new LimitsStore(h.dir,clock,{codex:provider},()=>{},dir);await peer.refresh();peer.close();
 const latest={vendor:'codex',plan:'Pro',fetchedAt:clock.now()/1000,windows:[{label:'неделя',percentUsed:42,windowMinutes:10080,resetsAt:null}],credits:{hasCredits:true,unlimited:false,balance:62500},resetCredits:2};writeFileSync(path,JSON.stringify({version:1,project:h.dir,providers:[latest]}));
 const opened=new LimitsStore(h.dir,clock,{codex:provider},()=>{},dir);t.after(()=>opened.close());await opened.refresh();const row=opened.snapshot().providers[0]!;assert.equal(row.code,'limits_unavailable');assert.equal(row.fetchedAt,latest.fetchedAt);assert.equal(row.windows[0]?.percentUsed,42);assert.equal(row.credits?.balance,62500);assert.equal(row.resetCredits,2);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).providers,[latest]);
});

test('TS-14c r2: quota account binding persists in shared/project caches; missing or changing identity stays unbound',async t=>{
 const h=await harness(t),clock=h.clock,dir=join(h.dir,'account-cache');let email:string|undefined='a@example.test',changeDuring=false;
 const provider=Object.assign(new FakeProvider(),{auth:async()=>({loggedIn:true,email}),limits:async():Promise<ProviderLimits>=>{if(changeDuring)email='b@example.test';return {...live(clock.now()),ok:true,plan:'Max',planLevel:'5x',extraUsageEnabled:true}}});
 const store=new LimitsStore(h.dir,clock,{claude:provider},()=>{},dir);t.after(()=>store.close());await store.refresh();assert.equal(store.snapshot().providers[0]!.account,'a@example.test');
 const reopened=new LimitsStore(h.dir,clock,{claude:provider},()=>{},dir);t.after(()=>reopened.close());assert.equal(reopened.snapshot().providers[0]!.account,'a@example.test');assert.equal(reopened.snapshot().providers[0]!.planLevel,'5x');
 changeDuring=true;clock.advance(300000);await store.refresh();assert.equal(store.snapshot().providers[0]!.account,null);
 changeDuring=false;email=undefined;clock.advance(300000);await store.refresh();assert.equal(store.snapshot().providers[0]!.account,null);
 // Legacy project caches still render quota but cannot corroborate a billing account.
 const legacy=join(h.dir,'legacy-account');mkdirSync(join(legacy,'.harness/state'),{recursive:true});writeFileSync(join(legacy,'.harness/state/limits.json'),JSON.stringify({version:1,project:legacy,providers:[{...live(clock.now()),vendor:'claude',plan:'Max',planLevel:'5x'}]}));
 const old=new LimitsStore(legacy,clock,{claude:provider},()=>{},join(legacy,'shared'));t.after(()=>old.close());assert.equal(old.snapshot().providers[0]!.account,null);assert.equal(old.snapshot().providers[0]!.planLevel,'5x');
});
test('TS-14c r2: identity lookup is bounded by the quota timeout, without starting a late measurement',async t=>{
 const h=await harness(t),gate=deferred<{loggedIn:boolean;email:string}>();let reads=0;
 const provider=Object.assign(new FakeProvider(),{auth:()=>gate.promise,limits:async()=>{reads++;return live(h.clock.now())}}),store=new LimitsStore(h.dir,h.clock,{claude:provider},()=>{},join(h.dir,'account-timeout'));t.after(()=>store.close());
 const pending=store.refresh();h.clock.advance(10000);await pending;assert.equal(store.snapshot().providers[0]!.code,'limits_timeout');gate.resolve({loggedIn:true,email:'late@example.test'});await Promise.resolve();await Promise.resolve();assert.equal(reads,0);assert.equal(store.snapshot().providers[0]!.account,null);
});
