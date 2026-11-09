import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {fixture,call,deferred,OWNER} from './test-helpers.ts';
const local=(id:string,ts:number,extra:Record<string,unknown>={})=>({role:'ai',text:'confidential answer',ts,deliverySeq:0,runtime:{turnInstanceId:id},...extra});

test('114/125/126: pure file analytics deduplicates local turns and separates transferred, unknown and undated records',async t=>{
 const h=await fixture(t),now=h.clock.now()/1000,path=join(h.dir,'.harness','state','chats.json'),memory=JSON.stringify(h.runtime.project.state.chats);
 const a=local('a',now-.25,{model:'w1',usage:{input:2,output:3,cacheRead:0},durationMs:10,outcome:'ok'});
 const data={chats:{a:{pane:'worker',title:'A',transcript:[a,a,local('b',now-7*86400,{durationMs:0,outcome:'interrupted'}),{role:'ai',text:'moved',ts:now,origin:'transferred',runtime:{turnInstanceId:'masquerade'},deliverySeq:0,usage:{input:999,output:999,cacheRead:999}},
  {role:'ai',text:'legacy',ts:now},{role:'ai',text:'partial origin',ts:now,runtime:{turnInstanceId:'fake'}},local('undated',0,{model:'w3',usage:{input:0,output:0,cacheRead:0},durationMs:0}),local('future',now+1),local('old',now-7*86400-.001,{model:'w1',usage:{input:10,output:10,cacheRead:0},durationMs:40})]},
  b:{pane:'peer',title:'B',transcript:[],turns:[{turnInstanceId:'error',ts:now-1,model:'w2',outcome:'error',errorCode:'transport_lost'},{turnInstanceId:'a',ts:now,model:'w1',outcome:'error',errorCode:'duplicate'}]}},active:{worker:'a'}};
 writeFileSync(path,JSON.stringify(data));const bytes=readFileSync(path),r=await call(h.api,'/api/spend?period=7');assert.equal(r.status,200);
 assert.deepEqual(r.body.totals,{turns:3,input:2,output:3,cacheRead:0,durationMs:10,averageDurationMs:5,durationSamples:2,outcomes:{ok:1,interrupted:1,error:1,unknown:0},missingMeasurements:2,p50DurationMs:0,p95DurationMs:10,errorRate:1/3,cost:null,currency:null,pricedTurns:0,unpricedTurns:3,costReason:'провайдер не сохранён: 3',costByCurrency:[]});
 assert.equal(r.body.transferred,1);assert.equal(r.body.unknownOrigin,2);assert.equal(r.body.undated,1);assert.equal(r.body.byPane.length,2);assert.equal(r.body.byChat.find((g:any)=>g.chat==='a').turns,2);assert.ok(r.body.byModel.some((g:any)=>g.model===null));assert.equal(r.body.cost,null);assert.equal(r.body.costReason,'провайдер не сохранён: 3');assert.equal(r.body.source,'chats.json');assert.equal(r.body.project,h.dir);assert.equal(r.body.since,now-7*86400);assert.doesNotMatch(r.text,/confidential|sessionId/);
 const all=await call(h.api,'/api/spend');assert.equal(all.body.period,'all');assert.equal(all.body.totals.turns,5);assert.equal(all.body.totals.outcomes.unknown,2);assert.equal(all.body.totals.durationSamples,4);assert.equal(all.body.totals.averageDurationMs,12.5);
 for(const period of ['30','90'])assert.equal((await call(h.api,'/api/spend?period='+period)).body.totals.turns,4);
 assert.deepEqual(readFileSync(path),bytes);assert.equal(JSON.stringify(h.runtime.project.state.chats),memory);
});

test('114/126: missing file is empty; malformed file or analytic turn gives typed 409 without replacing the working snapshot',async t=>{
 const h=await fixture(t);await h.runtime.runTurn('worker','kept');const path=h.runtime.project.state.chatsPath,memory=JSON.stringify(h.runtime.project.state.chats);
 for(const invalid of ['{',JSON.stringify({chats:[]}),JSON.stringify({chats:{a:{pane:'worker',transcript:[],turns:[{outcome:'error'}]}}})]){writeFileSync(path,invalid);const r=await call(h.api,'/api/spend');assert.equal(r.status,409);assert.equal(r.body.code,'spend_unreadable');assert.match(r.body.error,/^chats.json не читается:/);assert.equal(JSON.stringify(h.runtime.project.state.chats),memory);assert.equal(readFileSync(path,'utf8'),invalid)}
 rmSync(path);const empty=await call(h.api,'/api/spend');assert.equal(empty.status,200);assert.equal(empty.body.totals.turns,0);assert.equal(empty.body.totals.averageDurationMs,null);assert.deepEqual(empty.body.byModel,[]);assert.equal(JSON.stringify(h.runtime.project.state.chats),memory);
});

for(const invalid of [Buffer.from([0xff]),Buffer.from([0xe2,0x82]),Buffer.from([0xc0,0xaf])])test('TS-10 r2: invalid UTF-8 '+invalid.toString('hex')+' cannot become a counted turn',async t=>{
 const h=await fixture(t);await h.runtime.runTurn('worker','kept');const path=h.runtime.project.state.chatsPath,memory=JSON.stringify(h.runtime.project.state.chats),bytes=readFileSync(path),needle=Buffer.from('готов: worker'),index=bytes.indexOf(needle);assert.ok(index>=0);
 const damaged=Buffer.concat([bytes.subarray(0,index),invalid,bytes.subarray(index+Buffer.byteLength('г'))]);writeFileSync(path,damaged);
 const response=await call(h.api,'/api/spend');assert.equal(response.status,409);assert.equal(response.body.ok,false);assert.equal(response.body.code,'spend_unreadable');assert.match(response.body.error,/^chats.json не читается:/);assert.equal(response.body.totals,undefined);
 assert.deepEqual(readFileSync(path),damaged);assert.equal(JSON.stringify(h.runtime.project.state.chats),memory);
});

for(const period of ['', '0','007','week','7&period=30'])test('126: invalid period '+JSON.stringify(period)+' is a typed 400',async t=>{
 const h=await fixture(t),r=await call(h.api,'/api/spend?period='+period);assert.equal(r.status,400);assert.deepEqual(r.body,{ok:false,code:'period_invalid',error:'period: ожидается 7, 30, 90 или all'});
});

test('114/126: changing project during the file read discards the previous project result',{skip:process.platform==='win32'?'Windows reads the snapshot synchronously to keep atomic replacement available':false},async t=>{
 const h=await fixture(t);await h.runtime.runTurn('worker','old result');const entered=deferred(),gate=deferred(),original=fs.readFile,path=h.runtime.project.state.chatsPath;
 t.after(()=>{gate.resolve();t.mock.restoreAll();syncBuiltinESMExports()});
 t.mock.method(fs,'readFile',async(...args:Parameters<typeof fs.readFile>)=>{if(args[0]===path){entered.resolve();await gate.promise}return original(...args)});syncBuiltinESMExports();
 const pending=call(h.api,'/api/spend');await entered.promise;const next=join(h.dir,'next');mkdirSync(next);await h.runtime.projectSet(next,{},OWNER);gate.resolve();const r=await pending;
 assert.equal(r.status,409);assert.equal(r.body.code,'project_changed');assert.equal(h.runtime.project.dir,next);
});
