import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {networkRevision} from '@harnessy/projects';
import {NetworkStats} from '../../runtime/src/network-stats.ts';
import type {SshTunnelSnapshot} from '../../runtime/src/ssh-tunnels.ts';
import {fixture,call,deferred} from './test-helpers.ts';
import {listen,proxy} from '../../runtime/src/network-test-helpers.ts';
const opts={timeout:15000};
for(const status of [200,429])test('22h: real relay response is counted on its fixed exit after a chain change; HTTP exposes aggregates only: '+status,opts,async t=>{
 const arrived=deferred(),release=deferred(),closed=deferred();let observed=false;const h=await fixture(t,{deps:{networkRelayOptions:{measurement:()=>{if(observed)closed.resolve()}}}});
 const server=http.createServer((_req,res)=>{arrived.resolve();void release.promise.then(()=>{res.setHeader('Connection','close');res.writeHead(status);res.end('private-response-marker')})}),port=await listen(t,server),a=await proxy(t,port),b=await proxy(t,port);
 await h.runtime.settings.changeNetwork(async n=>{for(const [id,url]of [['a',a.url],['b',b.url]])n.exits[id!]={id:id!,label:id!,type:'proxy',url:url!};n.chains.claude=['a'];n.migrated=true;return {result:undefined}});
 const fetch=h.runtime.networkRelay.fetch('claude'),pending=fetch('http://private-destination.invalid/secret-path',{headers:{Authorization:'Bearer fixture-key-marker'}});await arrived.promise;await h.runtime.settings.changeNetwork(async n=>{n.chains.claude=['b'];return {result:undefined}});observed=true;release.resolve();if(status===429)await assert.rejects(pending,{code:'network_unavailable'});else {const result=await pending;assert.equal(result.status,200);assert.equal(await result.text(),'private-response-marker')}await closed.promise;
 const response=await call(h.api,'/api/network/stats?period=hour');assert.equal(response.status,200);assert.equal(response.body.source,'connected');const row=response.body.exits.find((e:any)=>e.exitId==='a');assert.equal(row.metrics.http429.value,status===429?1:0);assert.ok(row.metrics.bytes.value>0);assert.equal(response.body.exits.some((e:any)=>e.exitId==='b'),false);assert.equal(response.body.providers[0].exits[0].exitId,'a');assert.doesNotMatch(JSON.stringify(response.body),/private-destination|secret-path|private-response|fixture-key/);
 assert.doesNotMatch(readFileSync(h.runtime.networkStats.path).toString(),/private-destination|secret-path|private-response|fixture-key/);
});
test('22h: owner-only stats endpoint rejects invalid periods; connected empty source is distinct from a mock',opts,async t=>{
 const h=await fixture(t);const r=await call(h.api,'/api/network/stats');assert.equal(r.status,200);assert.equal(r.body.source,'connected');assert.deepEqual(r.body.exits,[]);assert.deepEqual(r.body.providers,[]);assert.equal((await call(h.api,'/api/network/stats?period=__proto__')).status,400);
 const denied=await call(h.api,'/api/network/stats',{headers:{'X-Harness-Pane':'worker'}});assert.equal(denied.status,403);
});

test('22h: active streaming bytes reach SQLite before the connection closes, without counting the same bytes twice',opts,async t=>{
 const measured=deferred(),release=deferred();const h=await fixture(t,{deps:{networkRelayOptions:{statsIntervalMs:20,measurement:s=>{if(s.bytesDown>0)measured.resolve()}}}}),server=http.createServer((_req,res)=>{res.setHeader('Connection','close');res.write('stream-fragment');void release.promise.then(()=>res.end('end'))}),port=await listen(t,server),p=await proxy(t,port);
 await h.runtime.settings.changeNetwork(async n=>{n.exits.a={id:'a',label:'A',type:'proxy',url:p.url};n.chains.claude=['a'];n.migrated=true;return {result:undefined}});const response=await h.runtime.networkRelay.fetch('claude')('http://stream.invalid/live'),body=response.text();await measured.promise;const during=h.runtime.networkStats.read().exits[0]!.metrics.bytesDown.value;assert.ok(during!>0);release.resolve();assert.equal(await body,'stream-fragmentend');await h.runtime.networkRelay.close();const after=h.runtime.networkStats.read().exits[0]!.metrics.bytesDown.value;assert.ok(after!>=during!);assert.equal(h.runtime.networkRelay.stats()[0]!.bytesDown,after);
});

test('22h: actual exit checks and tunnel subscriptions feed aggregate counters and unsubscribe on shutdown',opts,async t=>{
 let ip='192.0.2.10',country='Fixture',unsubscribed=false,notify:(event:SshTunnelSnapshot)=>void=()=>{};
 const h=await fixture(t,{deps:{networkCheckOptions:{execute:async req=>({code:0,signal:null,stderr:'',stdout:req.input?.includes('ipapi.co')?JSON.stringify({country_name:country})+'\n0.002':JSON.stringify({ip})+'\n0.001'})},sshTunnels:{ensure:async()=>{throw new Error('No SSH turn in this check')},get:()=>null,snapshots:()=>[],stop:async()=>{},close:async()=>{},subscribe:fn=>{notify=fn;return()=>{unsubscribed=true;return true}}}}});
 await h.runtime.settings.changeNetwork(async n=>{n.exits.a={id:'a',type:'direct',label:'A'};n.exits.b={id:'b',type:'ssh',label:'B',host:'fixture.invalid',user:'fixture',port:22,keyPath:'~/.ssh/fake'};n.migrated=true;return {result:undefined}});
 const revision=(await call(h.api,'/api/network/exits')).body.exits.find((e:any)=>e.config.id==='a').revision;
 assert.equal((await call(h.api,'/api/network/exits/a/check',{body:{revision}})).status,200);ip='192.0.2.11';country='Next';assert.equal((await call(h.api,'/api/network/exits/a/check',{body:{revision}})).status,200);
 for(const [state,generation]of [['starting',1],['up',1],['down',1],['starting',2],['up',2]] as const)notify({id:'b',state,generation,url:state==='up'?'socks5h://127.0.0.1:4000':null,code:null,reason:null,retryAt:null});
 const body=(await call(h.api,'/api/network/stats')).body;assert.equal(body.exits.find((e:any)=>e.exitId==='a').metrics.ipChanges.value,1);assert.equal(body.exits.find((e:any)=>e.exitId==='a').metrics.countryChanges.value,1);assert.equal(body.exits.find((e:any)=>e.exitId==='b').metrics.tunnelRestarts.value,1);assert.doesNotMatch(JSON.stringify(body),/192\.0\.2|Fixture|Next|fixture\.invalid|~\/\.ssh/);
 await h.runtime.close();assert.equal(unsubscribed,true);
});


test('22h/22d: actual reserve counters reach HTTP and SQLite once across parallel turns',opts,async t=>{
 let now=Date.now();const h=await fixture(t,{deps:{networkRelayOptions:{now:()=>now}}}),origin=http.createServer((_q,r)=>r.end('fixture')),port=await listen(t,origin),a=await proxy(t,port),b=await proxy(t,port);
 await h.runtime.settings.changeNetwork(async n=>{n.migrated=true;for(const [id,url]of [['a',a.url],['b',b.url]])n.exits[id!]={id:id!,label:id!,type:'proxy',url:url!};n.chains.claude=['a','b'];return {result:undefined}});
 h.runtime.networkChecks.snapshot=(id,revision)=>revision===networkRevision(h.runtime.settings.network().exits[id])?{revision,checkedAt:now,ok:true,ip:'192.0.2.1',country:'FixtureLand',durationMs:1,state:'checked'}:null;
 const first=h.runtime.networkRelay.begin('claude','stats-primary',t.signal);await first.ready();assert.equal(first.hop!.id,'a');first.fail('rate_limited');await first.close();
 const one=h.runtime.networkRelay.begin('claude','stats-reserve-one',t.signal),two=h.runtime.networkRelay.begin('claude','stats-reserve-two',t.signal);t.after(()=>Promise.all([one.close(),two.close()]));await Promise.all([one.ready(),two.ready()]);assert.equal(one.hop!.id,'b');assert.equal(two.hop!.id,'b');
 now+=1500;let response=await call(h.api,'/api/network/stats?period=hour');assert.equal(response.body.exits.find((r:any)=>r.exitId==='b').metrics.reserveMs.value,1500);
 one.fail('silence');await Promise.all([one.close(),two.close()]);now+=500;response=await call(h.api,'/api/network/stats?period=hour');assert.equal(response.status,200);const rows=h.runtime.networkRelay.stats();assert.equal(rows.find(r=>r.exit==='a')!.rateLimits,1);assert.equal(rows.find(r=>r.exit==='b')!.reserveMs,2000);assert.equal(rows.find(r=>r.exit==='b')!.silences,1);assert.equal(rows.find(r=>r.exit==='b')!.switches,1);
 const saved=new NetworkStats(h.runtime.settings,h.runtime.networkStats.path);t.after(()=>saved.close());const persistent=saved.read('hour');
 for(const row of rows){const publicRow=response.body.providers.find((r:any)=>r.provider===row.provider).exits.find((r:any)=>r.exitId===row.exit),stored=persistent.providers.find(r=>r.provider===row.provider)!.exits.find(r=>r.exitId===row.exit)!;for(const key of ['switches','reserveMs','rateLimits','silences'] as const){assert.equal(publicRow.metrics[key].value,row[key],key);assert.equal(stored.metrics[key].value,row[key],key)}}
 const again=(await call(h.api,'/api/network/stats?period=hour')).body;assert.deepEqual(again.exits.map((r:any)=>({exitId:r.exitId,metrics:r.metrics})),response.body.exits.map((r:any)=>({exitId:r.exitId,metrics:r.metrics})));assert.equal(again.exits.find((r:any)=>r.exitId==='a').metrics.http429.value,null,'policy counter does not invent an HTTP response');
 saved.close();
});
