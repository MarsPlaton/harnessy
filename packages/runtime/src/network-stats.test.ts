import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Settings} from '@harnessy/projects';
import {NetworkStats} from './network-stats.ts';
const end=Date.UTC(2026,1,1,12),opts={timeout:15000};
async function setup(t:TestContext){const dir=mkdtempSync(join(tmpdir(),'network-stats-')),stores:NetworkStats[]=[];t.after(()=>{for(const store of stores.reverse())store.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})});const settings=new Settings(join(dir,'settings.json'));await settings.changeNetwork(async n=>{n.exits.a={id:'a',label:'Выход A',type:'direct',price:{monthlyUsd:31,perGbUsd:.5}};n.exits.b={id:'b',label:'Выход B',type:'ssh',host:'host.invalid',user:'user',port:22,keyPath:'~/.ssh/fake',price:{perGbUsd:.3}};n.chains.claude=['a','b'];n.migrated=true;return {result:undefined}});const path=join(dir,'stats.sqlite'),stats=new NetworkStats(settings,path,()=>end);stores.push(stats);return {dir,settings,path,stats,track:(store:NetworkStats)=>{stores.push(store);return store}}}
test('22h: persisted aggregates, exact latency distribution, month-boundary pricing and distinct provider/exit counts',opts,async t=>{
 const h=await setup(t);for(const [connectMs,bytesUp]of [[10,1e9],[50,0],[90,0],[500,0]] as const)h.stats.connection({provider:'claude',exit:'a',from:end-2000,to:end-1000,bytesUp,bytesDown:bytesUp*2,connectMs,failed:false});
 h.stats.http('claude','a',200);h.stats.http('claude','a',429);h.stats.http('claude','a',451);h.stats.http('claude','a',403);
 let row=h.stats.read('day').exits[0]!;assert.equal(row.metrics.bytes.value,3e9);assert.equal(row.metrics.bytesUp.value,1e9);assert.equal(row.metrics.bytesDown.value,2e9);assert.equal(row.metrics.latencyP50Ms.value,50);assert.equal(row.metrics.latencyP95Ms.value,500);assert.equal(row.metrics.http429.value,1);assert.equal(row.metrics.blocks.value,1,'403 alone is not proof of a block');assert.equal(row.metrics.availabilityPct.value,100);assert.ok(Math.abs(row.metrics.costUsd.value!-(1.5+.5+31/56))<1e-6);assert.equal(h.stats.read().providers[0]!.metrics.costUsd.value,null);
 h.stats.close();const reopened=h.track(new NetworkStats(h.settings,h.path,()=>end));assert.deepEqual(reopened.read('day').exits[0],row);assert.equal(reopened.read('hour').exits[0]!.metrics.latencyP95Ms.value,500);assert.equal(reopened.read('week').period,'week');assert.equal(reopened.read('month').period,'month');
});
test('22h: no measurements are never zero; consecutive outages count once; recovery starts a new outage',opts,async t=>{
 const {stats}=await setup(t);assert.deepEqual(stats.read().exits,[]);for(let i=0;i<2;i++)stats.connection({provider:'claude',exit:'a',from:end-4000+i*1000,to:end-3500+i*1000,bytesUp:0,bytesDown:0,connectMs:null,failed:true});let m=stats.read().exits[0]!.metrics;assert.equal(m.failures.value,1);assert.equal(m.bytes.value,null);assert.equal(m.latencyP50Ms.value,null);assert.equal(m.http429.value,null);assert.equal(m.reserveMs.reason,'Резерв ещё не подключён');
 stats.connection({provider:'claude',exit:'a',from:end-1500,to:end-1000,bytesUp:10,bytesDown:20,connectMs:3,failed:false});stats.connection({provider:'claude',exit:'a',from:end-800,to:end-500,bytesUp:0,bytesDown:0,connectMs:null,failed:true});m=stats.read().exits[0]!.metrics;assert.equal(m.failures.value,2);assert.equal(m.bytes.value,30);assert.ok(m.availabilityPct.value!>0&&m.availabilityPct.value!<100);
 for(const p of ['__proto__','year','constructor',null])assert.throws(()=>stats.read(p),{code:'network_stats_invalid'});
});
test('22h: identity and tunnel changes persist only counts; repeated events, initial startup and missing country are not changes',opts,async t=>{
 const h=await setup(t);h.stats.identity('b',{ok:true,ip:'192.0.2.11',country:'FixtureLand'});h.stats.identity('b',{ok:true,ip:'192.0.2.12',country:null});h.stats.identity('b',{ok:true,ip:'192.0.2.12',country:'NextFixtureLand'});h.stats.identity('b',{ok:false,ip:'192.0.2.99',country:'Other'});
 for(const [state,generation]of [['starting',1],['up',1],['up',1],['down',1],['starting',2],['up',2]])h.stats.tunnel({id:'b',state,generation});const m=h.stats.read().exits[0]!.metrics;assert.equal(m.ipChanges.value,1);assert.equal(m.countryChanges.value,1);assert.equal(m.tunnelRestarts.value,1);
 for(const file of readdirSync(h.dir).filter(f=>f.startsWith('stats.sqlite'))){const bytes=readFileSync(join(h.dir,file)).toString();assert.doesNotMatch(bytes,/192\.0\.2|FixtureLand|host\.invalid|keyPath|~\/\.ssh/)}
});
test('22h: two stores combine updates atomically and time buckets preserve bytes without retaining per-connection rows',opts,async t=>{
 const h=await setup(t),second=h.track(new NetworkStats(h.settings,h.path,()=>end));for(let i=0;i<5;i++){h.stats.connection({provider:'claude',exit:'b',from:end-90000,to:end-30000,bytesUp:101,bytesDown:203,connectMs:i,failed:false});second.connection({provider:'api:fixture',exit:'b',from:end-90000,to:end-30000,bytesUp:307,bytesDown:409,connectMs:i+10,failed:false})}
 const snapshot=h.stats.read('hour');assert.equal(snapshot.exits[0]!.metrics.bytes.value,5100);assert.equal(snapshot.exits[0]!.series.reduce((sum,r)=>sum+r.metrics.bytes.value!,0),5100);assert.equal(snapshot.providers.length,2);assert.equal(snapshot.providers.find(r=>r.provider==='claude')!.metrics.bytes.value,1520);assert.equal(snapshot.providers.find(r=>r.provider==='api:fixture')!.metrics.bytes.value,3580);
});

test('22h: deleting an exit does not erase historical or already active transfer measurements',opts,async t=>{
 const {stats,settings}=await setup(t);const s={provider:'claude',exit:'a',from:end-1000,to:end-900,bytesUp:3,bytesDown:5,connectMs:10,failed:false};stats.connection(s);await settings.changeNetwork(async n=>{delete n.exits.a;n.chains.claude=['b'];return {result:undefined}});stats.connection({...s,from:end-800,to:end-700,connectMs:null,connected:true});const r=stats.read();assert.equal(r.exits[0]!.metrics.bytes.value,16);assert.match(r.exits[0]!.label,/выход удалён/);assert.equal(r.exits[0]!.metrics.costUsd.value,null);
});

test('22h: optional reserve snapshots persist deltas once, include the current interval and keep absent counters unknown',opts,async t=>{
 const h=await setup(t);h.stats.close();let now=end-120000;
 const stats=h.track(new NetworkStats(h.settings,h.path,()=>now));
 let row:any={provider:'claude',exit:'b',bytesUp:99};stats.watchRelay(()=>[row]);
 assert.deepEqual(stats.read().exits,[],'22c has no reserve counters');
 row={...row,switches:1,reserveMs:0,rateLimits:1,silences:0,destination:'private-destination-marker'};
 assert.equal(stats.read().exits[0]!.metrics.switches.value,1);
 now+=90000;row={...row,reserveMs:90000,silences:1};let snap=stats.read('hour'),m=snap.exits[0]!.metrics;
 assert.equal(m.reserveMs.value,90000);assert.equal(m.rateLimits.value,1);assert.equal(m.silences.value,1);assert.equal(m.bytes.value,null,'cumulative traffic is not counted again');
 assert.equal(m.http429.value,null,'policy failures do not fabricate observed HTTP responses');
 assert.equal(snap.exits[0]!.series.reduce((n,s)=>n+(s.metrics.reserveMs.value??0),0),90000);
 assert.equal(stats.read('hour').exits[0]!.metrics.reserveMs.value,90000,'reading the same snapshot is idempotent');
 now+=30000;row={...row,reserveMs:120000,switches:2};snap=stats.read('hour');assert.equal(snap.exits[0]!.metrics.reserveMs.value,120000);assert.equal(snap.providers[0]!.exits[0]!.metrics.switches.value,2);
 stats.relay([{provider:'codex',exit:'b',switches:1}]);assert.equal(stats.read().providers.find(p=>p.provider==='codex')!.metrics.reserveMs.value,null);
 stats.close();const reopened=h.track(new NetworkStats(h.settings,h.path,()=>now));m=reopened.read().exits[0]!.metrics;assert.equal(m.reserveMs.value,120000);assert.equal(m.switches.value,3);assert.doesNotMatch(readFileSync(h.path).toString(),/private-destination-marker/);
});

test('23a: today begins at engine local midnight and excludes yesterday, while day stays rolling',opts,async t=>{
 const h=await setup(t),midnight=new Date(end).setHours(0,0,0,0);
 for(const [at,bytes]of [[midnight-120000,100],[midnight+120000,200]] as const)h.stats.connection({provider:'claude',exit:'a',from:at,to:at+1000,bytesUp:bytes,bytesDown:0,connectMs:1,failed:false});
 const today=h.stats.read('today');assert.equal(today.from,midnight);assert.equal(today.exits[0]!.metrics.bytes.value,200);assert.equal(h.stats.read('day').exits[0]!.metrics.bytes.value,300);assert.ok(today.exits[0]!.series.every(s=>s.from>=midnight));
});
