import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProviderCatalog,ProviderError,type CatalogEntry} from '@harnessy/providers';
import {fixture,call} from './test-helpers.ts';
import {hardenPrivateDirectory} from '@harnessy/team';
const timeout=8000;
function directory(t:any){const path=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'harnessy-restored-')));t.after(()=>fs.rmSync(path,{recursive:true,force:true}));if(process.platform==='win32')hardenPrivateDirectory(path);return path}
const entry=():CatalogEntry=>({id:'fixture',title:'Fixture',binary:'/fixture/bin',login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,mcp:true,resume:true,limits:false,turn:{read:{ok:true},edit:{ok:true},all:{ok:true}},probe:{ok:true}},version:async()=>{throw new ProviderError('cancelled','unread')},auth:async()=>({loggedIn:true,email:'alice@example.test'}),models:async()=>[{id:'real',label:'Real model'}],runTurn:async()=>{throw Error('no model permitted')}});
function seed(path:string,patch:Record<string,unknown>={}){const value={schema:1,id:'fixture',binary:'/fixture/bin',installed:true,version:'1',login:{state:'ok',account:'a•••@example.test',checkedAt:Date.now()-10000},models:[{id:'forged-model',label:'Forged model'}],...patch};fs.writeFileSync(join(path,'fixture.json'),JSON.stringify(value),{mode:0o600});return value}

test('347: restored data survives cancellation only as observation; all owner selection/probe doors refuse until fresh read',{timeout},async t=>{
 const path=directory(t),saved=seed(path),source=entry(),catalog=new ProviderCatalog([source],Date.now,{cacheDir:path});t.after(()=>catalog.close());const h=await fixture(t,{deps:{providerCatalog:catalog}});await catalog.read('fixture');
 const row=(await call(h.api,'/api/providers/catalog')).body.providers[0];assert.equal(row.checking,true);assert.equal(row.login.state,'unknown');assert.equal(row.login.checkedAt,saved.login.checkedAt);assert.match(row.login.reason,/проверяется/);assert.deepEqual(row.models,saved.models);assert.equal(h.runtime.registry.models.fixture?.some(m=>m.id==='forged-model')??false,false,'proposal validation must not see unconfirmed cached models');
 const before=h.runtime.registry.get('worker')!.settings();for(const url of ['/api/panes/worker','/api/room','/api/providers/fixture/probe']){const r=await call(h.api,url,{body:url.endsWith('/probe')?{model:'forged-model'}:{vendor:'fixture',model:'forged-model',mode:'read',folder:true}});assert.equal(r.status,409,r.text);assert.equal(r.body.code,'provider_checking',r.text)}assert.deepEqual(h.runtime.registry.get('worker')!.settings(),before);
 catalog.get('fixture').version=async()=> '1';await catalog.read('fixture');assert.equal(catalog.peek('fixture').checking,false);assert.equal(catalog.peek('fixture').login.state,'ok');assert.equal((await call(h.api,'/api/panes/worker',{body:{vendor:'fixture',model:'real',mode:'read'}})).status,200);
});

for(const fault of (process.platform==='win32'?['permissions','label','id','version']:['uid','permissions','label','id','version']) as ('uid'|'permissions'|'label'|'id'|'version')[])test('347: '+fault+' rejects the file, emits a safe trace reason and never reflects secret-shaped cache fields',{timeout:process.platform==='win32'?30_000:timeout},async t=>{
 const path=directory(t),marker='sk-REVIEW-ONLY-CACHE-SECRET-123456789';seed(path,fault==='label'?{models:[{id:'forged',label:marker}]}:fault==='id'?{models:[{id:'../private<script>',label:'Valid'}]}:fault==='version'?{version:marker}:{});if(fault==='permissions'){if(process.platform==='win32')execFileSync('icacls.exe',[join(path,'fixture.json'),'/grant','*S-1-1-0:R'],{windowsHide:true});else fs.chmodSync(join(path,'fixture.json'),0o640)}
 const original=fs.fstatSync;let catalog:ProviderCatalog;try{if(fault==='uid'){fs.fstatSync=((...args:any[])=>Object.assign((original as any)(...args),{uid:(process.getuid?.()??0)+1})) as typeof fs.fstatSync;syncBuiltinESMExports()}catalog=new ProviderCatalog([entry()],Date.now,{cacheDir:path})}finally{fs.fstatSync=original;syncBuiltinESMExports()}
 assert.equal(catalog!.peek('fixture').installed,null);const h=await fixture(t,{deps:{providerCatalog:catalog!}}),response=await call(h.api,'/api/providers/catalog');assert.doesNotMatch(response.text,/sk-REVIEW|private<script>/);const traces=(await call(h.api,'/api/trace')).body.records;const event=traces.find((v:any)=>v.kind==='provider.catalog_cache');assert.ok(event);assert.equal(event.reason.code,'storage');assert.equal(event.data.code,fault==='uid'?'cache_owner':fault==='permissions'?'cache_permissions':'cache_fields');assert.equal(event.data.vendor,'fixture');assert.doesNotMatch(JSON.stringify(traces),/sk-REVIEW|private<script>/);
});

test('347: restored same-mask accounts cannot inherit models after partial fresh reads; a confirmed logout remains unconfirmed after restart',{timeout},async t=>{
 const path=directory(t),source=entry();source.version=async()=> '1';const warm=new ProviderCatalog([source],Date.now,{cacheDir:path});await warm.read('fixture');await warm.close();source.auth=async()=>({loggedIn:true,email:'amy@example.test'});source.models=async()=>{throw new ProviderError('cancelled','unread')};const next=new ProviderCatalog([source],Date.now,{cacheDir:path});await next.read('fixture');assert.equal(next.peek('fixture').checking,true);assert.equal(next.peek('fixture').login.state,'unknown');assert.deepEqual(next.peek('fixture').models,[]);await next.close();
 source.auth=async()=>({loggedIn:false});const out=new ProviderCatalog([source],Date.now,{cacheDir:path});await out.read('fixture');assert.equal(out.peek('fixture').checking,false);assert.equal(out.peek('fixture').login.state,'none');await out.close();const again=new ProviderCatalog([source],Date.now,{cacheDir:path});t.after(()=>again.close());assert.equal(again.peek('fixture').checking,true);assert.equal(again.peek('fixture').login.state,'unknown');assert.deepEqual(again.peek('fixture').models,[]);
});
