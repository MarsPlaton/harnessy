import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {fixture,call,deferred,OWNER} from './test-helpers.ts';
const rate={vendor:'claude',model:'same',inputPerM:2,outputPerM:4,cacheReadPerM:1,currency:'USD'};
const turn=(id:string,ts:number,extra:Record<string,unknown>={})=>({role:'ai',text:'PRIVATE TEXT',ts,deliverySeq:0,runtime:{turnInstanceId:id},vendor:'claude',model:'same',usage:{input:1_000_000,output:500_000,cacheRead:2_000_000},durationMs:10,outcome:'ok',sessionId:'PRIVATE SESSION',token:'PRIVATE TOKEN',...extra});
const save=(h:Awaited<ReturnType<typeof fixture>>,transcript:unknown[])=>writeFileSync(h.runtime.project.state.chatsPath,JSON.stringify({chats:{chat:{pane:'worker',title:'TITLE',transcript}}}));
const prices=(h:Awaited<ReturnType<typeof fixture>>,priceList:unknown)=>call(h.api,'/api/settings',{body:{scope:'owner',patch:{priceList}}});

test('174–176: aggregation prices only measured local runs; currencies, vendors, unknown origin and UTC days remain distinct',async t=>{
 const h=await fixture(t),now=h.clock.now()/1000;assert.equal((await prices(h,[rate,{...rate,vendor:'codex',currency:'EUR',inputPerM:0,outputPerM:0,cacheReadPerM:0}])).status,200);
 const rows=[turn('a',now),turn('b',now-86400,{vendor:'codex',durationMs:20,outcome:'error'}),turn('c',now,{vendor:undefined,durationMs:0,outcome:'interrupted'}),turn('d',now,{model:'missing',durationMs:100,outcome:undefined}),turn('e',now,{usage:{input:1,output:0,cacheRead:null},durationMs:undefined}),turn('f',0,{durationMs:40,usage:{input:0,output:0,cacheRead:0}}),turn('g',now,{model:null,durationMs:60}),turn('transfer',now,{origin:'transferred'}),{role:'ai',text:'old',ts:now}];
 save(h,[rows[0],...rows]);const bytes=readFileSync(h.runtime.project.state.chatsPath),memory=JSON.stringify(h.runtime.project.state.chats);
 const response=await call(h.api,'/api/spend?period=7');assert.equal(response.status,200);const r=response.body,g=r.totals;
 assert.equal(g.turns,6);assert.equal(g.pricedTurns,2);assert.equal(g.unpricedTurns,4);assert.equal(g.cost,null);assert.equal(g.currency,null);assert.deepEqual(g.costByCurrency,[{currency:'EUR',cost:0},{currency:'USD',cost:6}]);
 assert.match(g.costReason,/провайдер не сохранён: 1/);assert.match(g.costReason,/модель не сохранена: 1/);assert.match(g.costReason,/нет цены модели: 1/);assert.match(g.costReason,/измерения токенов неполны: 1/);
 assert.equal(r.transferred,1);assert.equal(r.unknownOrigin,1);assert.equal(r.undated,1);assert.equal(g.durationSamples,5);assert.equal(g.p50DurationMs,20);assert.equal(g.p95DurationMs,100);assert.equal(g.errorRate,1/5);assert.equal(r.errorRateUnit,'ratio');
 assert.equal(r.byVendor.length,3);assert.equal(r.byVendor.find((v:any)=>v.vendor===null).unpricedTurns,1);assert.equal(r.byModelVendor.filter((v:any)=>v.model==='same').length,3);
 const same=r.byModel.find((v:any)=>v.model==='same');assert.equal(same.cost,null);assert.equal(same.costByCurrency.length,2);
 assert.equal(r.byPane[0].turns,6);assert.equal(r.byChat[0].turns,6);assert.equal(r.byDay.length,8);assert.equal(r.byDay.reduce((n:number,d:any)=>n+d.turns,0),6);const empty=r.byDay.find((d:any)=>d.turns===0);assert.equal(empty.input,0);assert.equal(empty.cost,null);assert.equal(empty.p50DurationMs,null);assert.equal(empty.errorRate,null);assert.equal(r.timeZone,'UTC');assert.equal(r.pricingBasis,'current');
 const all=(await call(h.api,'/api/spend?period=all')).body;assert.equal(all.totals.turns,7);assert.equal(all.byDay.length,2);assert.equal(all.byDay.reduce((n:number,d:any)=>n+d.turns,0),6);assert.equal(all.totals.pricedTurns,3);
 await prices(h,[{...rate,inputPerM:4},{...rate,vendor:'codex',currency:'EUR',inputPerM:0,outputPerM:0,cacheReadPerM:0}]);assert.equal((await call(h.api,'/api/spend?period=7')).body.costByCurrency.find((v:any)=>v.currency==='USD').cost,8);
 assert.deepEqual(readFileSync(h.runtime.project.state.chatsPath),bytes);assert.equal(JSON.stringify(h.runtime.project.state.chats),memory);assert.doesNotMatch(response.text,/PRIVATE/);
});

test('175/176: no samples yields null, legitimate zero yields measured zero; nearest-rank p95 and error denominator',async t=>{
 const h=await fixture(t),now=h.clock.now()/1000;const empty=(await call(h.api,'/api/spend')).body.totals;for(const key of ['cost','currency','averageDurationMs','p50DurationMs','p95DurationMs','errorRate'])assert.equal(empty[key],null);
 await prices(h,[{...rate,inputPerM:0,outputPerM:0,cacheReadPerM:0}]);save(h,Array.from({length:20},(_,i)=>turn('t'+i,now,{durationMs:i,outcome:i===0?'error':i===1?undefined:'ok'})));
 const g=(await call(h.api,'/api/spend')).body.totals;assert.equal(g.cost,0);assert.equal(g.currency,'USD');assert.equal(g.pricedTurns,20);assert.equal(g.unpricedTurns,0);assert.equal(g.costReason,null);assert.equal(g.p50DurationMs,9);assert.equal(g.p95DurationMs,18);assert.equal(g.errorRate,1/19);
 save(h,[turn('unknown',now,{usage:undefined,durationMs:undefined,outcome:undefined})]);const missing=(await call(h.api,'/api/spend')).body.totals;assert.equal(missing.cost,null);assert.equal(missing.p95DurationMs,null);assert.equal(missing.errorRate,null);assert.equal(missing.durationSamples,0);
});

test('175: history cursor uses ts + identity, redacts payload and supports vendor/model filters including null',async t=>{
 const h=await fixture(t),now=h.clock.now()/1000;await prices(h,[rate]);const rows=[turn('a',now),turn('b',now),turn('c',now),turn('old',now-1,{vendor:'codex'}),turn('legacy',0,{vendor:undefined,model:undefined})];save(h,rows);
 const first=await call(h.api,'/api/spend/turns?limit=2');assert.equal(first.status,200);assert.deepEqual(first.body.items.map((r:any)=>r.turnInstanceId),['c','b']);assert.equal(first.body.items[0].cost,6);assert.equal(first.body.items[0].currency,'USD');
 assert.deepEqual(Object.keys(first.body.items[0]).sort(),['turnInstanceId','pane','chat','ts','vendor','model','usage','durationMs','outcome','cost','currency'].sort());assert.doesNotMatch(first.text,/PRIVATE|sessionId|TITLE|token/);
 save(h,[...rows,turn('new',now+.001)]);h.clock.advance(10);
 const second=await call(h.api,'/api/spend/turns?limit=2&before='+first.body.next);assert.deepEqual(second.body.items.map((r:any)=>r.turnInstanceId),['a','old']);
 const third=await call(h.api,'/api/spend/turns?limit=2&before='+second.body.next);assert.deepEqual(third.body.items.map((r:any)=>r.turnInstanceId),['legacy']);assert.equal(third.body.items[0].ts,null);assert.equal(third.body.next,null);
 assert.equal((await call(h.api,'/api/spend/turns?vendor=claude&model=same')).body.items.length,4);assert.equal((await call(h.api,'/api/spend/turns?vendor=null&model=null')).body.items[0].turnInstanceId,'legacy');assert.equal((await call(h.api,'/api/spend/turns?period=7&vendor=null')).body.items.length,0);assert.equal((await call(h.api,'/api/spend/turns?model=absent')).body.items.length,0);
});

for(const [query,code] of [['period=x','period_invalid'],['period=7&period=all','period_invalid'],['limit=0','limit_invalid'],['limit=201','limit_invalid'],['limit=1.5','limit_invalid'],['limit=1&limit=2','limit_invalid'],['vendor=router','vendor_invalid'],['vendor=claude&vendor=codex','vendor_invalid'],['model=','model_invalid'],['model=a&model=b','model_invalid'],['before=','before_invalid'],['before=%%%','before_invalid'],['before=e30','before_invalid'],['before=Wy0xLCJhIl0','before_invalid'],['before=WyIxIiwiYSJd','before_invalid']])test('175: history query refuses '+query,async t=>{const h=await fixture(t),r=await call(h.api,'/api/spend/turns?'+query);assert.equal(r.status,400);assert.equal(r.body.code,code)});

test('176: HTTP prices require owner scope; corrupt settings fail both spend routes and settings without erasure; repair stays reachable',async t=>{
 const h=await fixture(t),path=join(h.dir,'owner-settings.json');await h.runtime.runTurn('worker','reply');const memory=JSON.stringify(h.runtime.project.state.chats);
 const badScope=await call(h.api,'/api/settings',{body:{scope:'project',patch:{priceList:[rate]}}});assert.equal(badScope.status,400);assert.match(badScope.body.error,/только область owner/);
 assert.equal((await prices(h,[rate,rate])).status,400);assert.equal((await prices(h,[{...rate,inputPerM:-1}])).status,400);
 for(const bytes of [Buffer.from('{'),Buffer.from([0xff]),Buffer.from(JSON.stringify({keep:1,priceList:[{...rate,currency:null}]}))]){
  writeFileSync(path,bytes);for(const route of ['/api/spend','/api/spend/turns','/api/settings']){const r=await call(h.api,route);assert.equal(r.status,409,route);assert.equal(r.body.code,'pricelist_unreadable')}
  assert.deepEqual(readFileSync(path),bytes);assert.equal(JSON.stringify(h.runtime.project.state.chats),memory);
 }
 await h.runtime.openProject(h.dir);assert.equal((await prices(h,[rate])).status,200);assert.equal((await call(h.api,'/api/settings')).body.owner.keep,1);assert.equal((await call(h.api,'/api/spend')).status,200);
 await assert.rejects(h.runtime.settingsPatch('owner',{priceList:[]},{seat:'worker',trust:'agent'} as never));
});

test('175: history rejects a late disk snapshot after project switch',async t=>{
 if(process.platform==='win32'){t.skip('Windows snapshot reads synchronously, so they cannot outlive a project switch');return}
 const h=await fixture(t);await h.runtime.runTurn('worker','reply');const original=fs.readFile,entered=deferred(),gate=deferred(),path=h.runtime.project.state.chatsPath;t.after(()=>{gate.resolve();t.mock.restoreAll();syncBuiltinESMExports()});
 t.mock.method(fs,'readFile',async(...args:Parameters<typeof fs.readFile>)=>{if(args[0]===path){entered.resolve();await gate.promise}return original(...args)});syncBuiltinESMExports();
 const pending=call(h.api,'/api/spend/turns');await entered.promise;const next=join(h.dir,'next');mkdirSync(next);await h.runtime.projectSet(next,{},OWNER);gate.resolve();const r=await pending;assert.equal(r.status,409);assert.equal(r.body.code,'project_changed');
});

test('175/176: arithmetic overflow is explicit and never serialized as a free priced turn',async t=>{
 const h=await fixture(t);await prices(h,[{...rate,inputPerM:Number.MAX_VALUE}]);save(h,[turn('large',h.clock.now()/1000,{usage:{input:Number.MAX_VALUE,output:0,cacheRead:0}})]);
 const r=await call(h.api,'/api/spend');assert.equal(r.status,200);assert.equal(r.body.cost,null);assert.equal(r.body.unpricedTurns,1);assert.match(r.body.costReason,/вне числового диапазона/);
 save(h,[turn('one',h.clock.now()/1000,{usage:{input:Number.MAX_VALUE,output:0,cacheRead:0}}),turn('two',h.clock.now()/1000,{usage:{input:Number.MAX_VALUE,output:0,cacheRead:0}})]);assert.equal((await call(h.api,'/api/spend')).body.code,'spend_unreadable');
});

test('174: legacy and router-looking models never inherit a vendor or tariff from the current seat',async t=>{
 const h=await fixture(t),now=h.clock.now()/1000;await prices(h,[rate,{...rate,vendor:'codex',model:'qwen3'},{...rate,vendor:'router',model:'qwen3'}]);
 save(h,[turn('legacy',now,{vendor:undefined}),turn('router',now,{vendor:'router',model:'qwen3'}),turn('codex',now,{vendor:'codex',model:'qwen3'})]);
 const result=await call(h.api,'/api/spend');assert.equal(result.body.byVendor.length,2);assert.equal(result.body.byVendor.find((v:any)=>v.vendor===null).turns,2);assert.equal(result.body.pricedTurns,1);assert.equal(result.body.cost,6);
 const history=await call(h.api,'/api/spend/turns');assert.deepEqual(history.body.items.filter((r:any)=>r.cost===null).map((r:any)=>r.vendor),[null,null]);assert.equal(history.body.items.find((r:any)=>r.turnInstanceId==='codex').vendor,'codex');
});
