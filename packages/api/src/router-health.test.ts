import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readRouterModels,readRouterHealth,routerHealthReader,ROUTER_CONFIG_LIMIT,ROUTER_HEALTH_URL,type RouterHealth} from './router-health.ts';
import {fixture,call,deferred,OWNER} from './test-helpers.ts';
const fetchJson=(body:unknown,status=200)=>(async(url:unknown,options:any)=>{assert.equal(url,ROUTER_HEALTH_URL);assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);return new Response(JSON.stringify(body),{status})}) as typeof fetch;

test('302: health families come from actual model ids; malformed and unavailable sources have reasons',async()=>{
 assert.deepEqual(await readRouterHealth(fetchJson({ok:true,models:['nova3','nova4','test-model','glm-5.2']})),{ok:true,models:['nova3','nova4','test-model','glm-5.2'],families:['nova','test','glm']});
 for(const body of [{ok:false,models:[]},{ok:true},{ok:true,models:['<img>']},{ok:true,models:[123]}]){const result=await readRouterHealth(fetchJson(body));assert.equal(result.ok,false);assert.match(JSON.stringify(result),/нечитаемый/)}
 assert.deepEqual(await readRouterHealth(fetchJson({},503)),{ok:false,reason:'/health: HTTP 503'});
 assert.equal((await readRouterHealth((async()=>new Response(' '.repeat(ROUTER_CONFIG_LIMIT+1))) as typeof fetch)).ok,false);
 const unavailable=await readRouterHealth((async()=>{throw Error('untrusted remote detail')}) as typeof fetch);assert.deepEqual(unavailable,{ok:false,reason:'программа не отвечает на /health'});
});

test('302: parallel reads share a bounded-lived snapshot and refresh an unavailable source',async()=>{
 let now=0,calls=0;const gate=deferred<RouterHealth>(),read=routerHealthReader(()=>{calls++;return gate.promise},()=>now),a=read(),b=read();assert.equal(calls,1);gate.resolve({ok:false,reason:'offline'});assert.deepEqual(await a,await b);await read();assert.equal(calls,1);now=10_001;await read();assert.equal(calls,2);
});

test('321: only model names leave routes.json; missing, malformed, symlink and oversized files refuse',t=>{
 const dir=mkdtempSync(join(tmpdir(),'harnessy-router-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'routes.json');
 assert.equal(readRouterModels(path).ok,false);
 const raw={routes:{'gpt-routed':{keyFile:join(dir,'key-must-never-be-opened'),key:'sk_test_DO_NOT_EXPOSE',baseUrl:'https://private.example/api'},'qwen3':{}},fallbackModels:['kimi:cloud','gpt-routed'],token:'sk_test_DO_NOT_EXPOSE'};writeFileSync(path,JSON.stringify(raw));
 assert.deepEqual(readRouterModels(path),{ok:true,models:['gpt-routed','qwen3','kimi:cloud']});
 const link=join(dir,'link');try{symlinkSync(path,link);assert.equal(readRouterModels(link).ok,false)}catch(e){if(process.platform!=='win32'||(e as NodeJS.ErrnoException).code!=='EPERM')throw e}
 for(const bad of ['{',JSON.stringify({routes:{},fallbackModels:'bad'}),JSON.stringify({routes:{'<img>':{}},fallbackModels:[]}),JSON.stringify({routes:[],fallbackModels:[]})]){writeFileSync(path,bad);assert.equal(readRouterModels(path).ok,false)}
 writeFileSync(path,' '.repeat(ROUTER_CONFIG_LIMIT+1));assert.equal(readRouterModels(path).ok,false);assert.equal(readRouterModels(dir).ok,false);
});

test('302/316/321: HTTP projects exact routing metadata, live families and safe reasons into trace',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'harnessy-router-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'routes.json'),secret='sk_test_router_SENTINEL_1234567890';
 writeFileSync(path,JSON.stringify({routes:{'gpt-routed':{keyFile:'/private/no-read.key',key:secret,baseUrl:'https://private.example/api'}},fallbackModels:['kimi:cloud'],apiKey:secret}));
 let offline=false;const h=await fixture(t,{router:{models:()=>readRouterModels(path),health:()=>readRouterHealth(fetchJson(offline?{}:{ok:true,models:['nova3','glm-5.2']},offline?503:200))}});
 h.codex.models=async()=>[{id:'gpt-routed',label:'Routed GPT'},{id:'kimi:cloud',label:'Kimi'},{id:'qwen-unrelated',label:'Not routed'},{id:'gpt-native',label:'GPT'}];
 const status=await call(h.api,'/api/status');assert.equal(status.status,200);assert.deepEqual(status.body.models.codex.map((m:any)=>[m.id,m.via??null]),[['gpt-routed','provider-router'],['kimi:cloud','provider-router'],['qwen-unrelated',null],['gpt-native',null]]);
 const connection=await call(h.api,'/api/connections'),row=connection.body.providers.find((p:any)=>p.id==='router');assert.equal(row.name,'provider-router');assert.equal(row.kind,'локально · 127.0.0.1:11435 · nova, glm');assert.equal(row.routable,false);
 offline=true;const failed=await call(h.api,'/api/connections'),missing=failed.body.providers.find((p:any)=>p.id==='router');assert.match(missing.kind,/нет данных · \/health: HTTP 503/);assert.equal(missing.models,null);
 const unavailable=await call(h.api,'/api/status');for(const m of unavailable.body.models.codex)assert.deepEqual(m.viaStatus,m.via?{ok:false,reason:'provider-router не отвечает: /health: HTTP 503'}:undefined);
 offline=false;const recovered=await call(h.api,'/api/status');for(const m of recovered.body.models.codex)assert.deepEqual(m.viaStatus,m.via?{ok:true}:undefined);
 rmSync(path);const noConfig=await call(h.api,'/api/status');assert.ok(noConfig.body.models.codex.every((m:any)=>!Object.hasOwn(m,'via')));
 const trace=await call(h.api,'/api/trace');assert.equal(trace.status,200);assert.match(trace.text,/models.unavailable/);const reason=trace.body.records.find((row:any)=>row.kind==='models.unavailable').reason;assert.equal(reason.code,'unavailable');assert.match(reason.text,/provider-router/);
 const output=status.text+connection.text+failed.text+noConfig.text+trace.text+readFileSync(h.runtime.project.trace.path,'utf8');for(const forbidden of [secret,'/private/no-read.key','https://private.example/api','keyFile','apiKey'])assert.equal(output.includes(forbidden),false,forbidden);
 assert.equal(h.provider.calls.length+h.codex.calls.length,0);
});

for(const path of ['/api/connections','/api/status'])test('302/328: late health response cannot install '+path+' from another project',async t=>{
 const gate=deferred<RouterHealth>(),seen=deferred();t.after(()=>gate.resolve({ok:false,reason:'closed'}));const h=await fixture(t,{router:{models:()=>({ok:true,models:['test1']}),health:()=>{seen.resolve();return gate.promise}}});h.codex.models=async()=>[{id:'test1',label:'Test'}];
 const request=call(h.api,path);await seen.promise;const next=join(h.dir,'next');mkdirSync(next);await h.runtime.projectSet(next,{},OWNER);gate.resolve({ok:true,models:['test1'],families:['test']});assert.equal((await request).status,409);
});
