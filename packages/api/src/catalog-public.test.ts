import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderCatalog,ProviderError,type CatalogEntry} from '@harnessy/providers';
import {CatalogCache} from '../../providers/src/catalog-cache.ts';
import {hardenPrivateDirectory} from '@harnessy/team';
import {fixture,call} from './test-helpers.ts';
const opts={timeout:15000},marker='sk-REVIEW-ONLY-CACHE-SECRET-123456789';
const entry=():CatalogEntry=>({id:'fixture',title:'Fixture',binary:'/fixture/fixture',login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,mcp:true,resume:true,limits:false},version:async()=> '1',auth:async()=>({loggedIn:true,email:'alice@example.test'}),models:async()=>[{id:'model-1',label:'Model 1'}],runTurn:async()=>{throw Error('no model allowed')}});

test('354: cache never forwards embedded credentials in model id, label, version or account through HTTP',{...opts},async t=>{
 const cacheDir=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-public-')));t.after(()=>rmSync(cacheDir,{recursive:true,force:true}));if(process.platform==='win32')hardenPrivateDirectory(cacheDir);
 for(const field of ['account','label','id','version']){
  const raw:any={schema:1,id:'fixture',binary:'/fixture/fixture',installed:true,version:'1',login:{state:'ok',account:'a•••@example.test',checkedAt:Date.now()},models:[{id:'model-1',label:'Model 1'}]};
  if(field==='account')raw.login.account='a•••@'+marker+'.example.test';else if(field==='version')raw.version='prefix_'+marker;else raw.models[0][field]='prefix_'+marker;
  writeFileSync(join(cacheDir,'fixture.json'),JSON.stringify(raw),{mode:0o600});
  const c=new ProviderCatalog([{...entry(),version:async()=>{throw new ProviderError('cancelled','not read')}}],Date.now,{cacheDir});assert.equal(c.peek('fixture').installed,null);assert.deepEqual(c.cacheDiagnostics(),[{vendor:'fixture',code:'cache_fields'}]);
  const h=await fixture(t,{deps:{providerCatalog:c}}),r=await call(h.api,'/api/providers/catalog');assert.equal(r.status,200);assert.equal(r.text.includes(marker),false,field);assert.deepEqual(r.body.providers[0].models,[]);
 }
});

test('354: fresh metadata uses the same public checks; masks are made only from a valid credential-free email',opts,async t=>{
 for(const field of ['account','label','id','version','reason','service']){
  const e=entry();if(field==='account')e.auth=async()=>({loggedIn:true,email:'alice@'+marker+'.example.test'});else if(field==='version')e.version=async()=> 'prefix_'+marker;else if(field==='reason')e.auth=async()=>({loggedIn:false,state:'unknown',reason:'prefix_'+marker});else if(field==='service')e.service=async()=>({ok:false,reason:'prefix_'+marker});else e.models=async()=>[{id:field==='id'?'prefix_'+marker:'model-1',label:field==='label'?'prefix_'+marker:'Model 1'}];
  const c=new ProviderCatalog([e]),h=await fixture(t,{deps:{providerCatalog:c}});await c.read('fixture');const r=await call(h.api,'/api/providers/catalog');assert.equal(r.status,200);assert.equal(r.text.includes(marker),false,field);if(field==='account')assert.equal(r.body.providers[0].login.account,undefined);else assert.equal(r.body.providers[0].login.state,'error');
 }
 const e=entry(),c=new ProviderCatalog([e]);t.after(()=>c.close());assert.equal((await c.read('fixture')).row.login.account,'a•••@example.test');
 for(const email of ['not-an-email','alice@@example.test','alice@bad_domain.test','alice@.example.test']){c.get('fixture').auth=async()=>({loggedIn:true,email});assert.equal((await c.read('fixture')).row.login.account,undefined)}
});

test('354: cache writes and static model fallbacks refuse unsafe public data without replacing a valid snapshot',opts,async t=>{
 const cacheDir=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-public-write-')));t.after(()=>rmSync(cacheDir,{recursive:true,force:true}));const c=new ProviderCatalog([entry()]);t.after(()=>c.close());const {row}=await c.read('fixture'),cache=new CatalogCache(cacheDir,Date.now);cache.save(row);const path=join(cacheDir,'fixture.json'),bytes=readFileSync(path,'utf8');
 const cases=[{...row,login:{...row.login,account:'a•••@'+marker+'.example.test'}},{...row,version:'prefix_'+marker},{...row,models:[{id:'model-1',label:'prefix_'+marker}]},{...row,models:[{id:'m'.repeat(181),label:'Model'}]},{...row,models:[{id:'model-1',label:'Model\u200bhidden'}]}];
 for(const unsafe of cases){assert.throws(()=>cache.save(unsafe),{code:'cache_fields'});assert.equal(readFileSync(path,'utf8'),bytes)}
 assert.throws(()=>new ProviderCatalog([{...entry(),staticModels:[{id:'model-1',label:'prefix_'+marker}]}]),{code:'protocol'});
});
