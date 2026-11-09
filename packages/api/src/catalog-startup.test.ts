import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync,unlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderCatalog,ProviderError,cliEntry,type CatalogEntry} from '@harnessy/providers';
import {antigravityFixture} from '../../providers/src/antigravity-test-helpers.ts';
import {fixture,call,deferred} from './test-helpers.ts';
import {assertPrivateFile} from '@harnessy/team';

// Four concurrent targeted runs: maximum 1023.24 ms at load 8.33; x8 reserve.
const timeout=process.platform==='win32'?60_000:1024*8;
const entry=(id='fixture'):CatalogEntry=>({id,title:id,binary:'/fixture/'+id,login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,resume:true,mcp:true,limits:false},version:async()=> '1',auth:async()=>({loggedIn:true}),models:async()=>[{id:'m1',label:'Model 1'}],runTurn:async()=>{throw Error('no model allowed')}});
const directory=(t:TestContext)=>{const path=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-catalog-')));t.after(()=>rmSync(path,{force:true,recursive:true}));return path};
function finished(c:ProviderCatalog,count=1){const done=deferred<any[]>(),values:any[]=[];const off=c.subscribe(v=>{values.push(v);if(values.length===count){off();done.resolve(values)}});return done.promise}
function delay(ms:number,signal?:AbortSignal){return new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(new ProviderError('cancelled','fixture-secret'))};const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve()},ms);if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true})})}

test('343: ten delayed programs restore immediately; only three read concurrently, slow cancellation preserves disk snapshot', {timeout},async t=>{
 const cacheDir=directory(t),refreshGate=deferred();t.after(()=>refreshGate.resolve());let now=Date.now(),active=0,maximum=0,slow=false,starts=0;
 const entries=Array.from({length:10},(_,i)=>({...entry('program-'+i),version:async(signal?:AbortSignal)=>{starts++;active++;maximum=Math.max(maximum,active);try{if(slow)await refreshGate.promise;await delay(slow&&i===9?2000:30,signal);return '1'}finally{active--}}}));
 const warm=new ProviderCatalog(entries,()=>now,{cacheDir,timeoutMs:600});await warm.list();assert.equal(maximum,3);await warm.close();const old=warm.peek('program-9');
 assert.equal(readdirSync(cacheDir).filter(x=>x.endsWith('.json')).length,10);const bytes=readFileSync(join(cacheDir,'program-9.json'),'utf8');assert.doesNotMatch(bytes,/fixture-secret|command|capabilities|identity/);if(process.platform==='win32')assert.equal(assertPrivateFile(join(cacheDir,'program-9.json')).isFile(),true);else assert.equal(statSync(join(cacheDir,'program-9.json')).mode&0o777,0o600);
 now+=300000;slow=true;active=0;maximum=0;starts=0;const catalog=new ProviderCatalog(entries,()=>now,{cacheDir,timeoutMs:600}),done=finished(catalog,10);
 const initial=catalog.peek('program-9');assert.equal(initial.checking,true);assert.equal(initial.login.checkedAt,old.login.checkedAt);assert.match(initial.login.reason!,/проверяется/);assert.deepEqual(initial.models,old.models);
 const h=await fixture(t,{deps:{providerCatalog:catalog}});const response=await call(h.api,'/api/providers/catalog');assert.equal(active,3,'HTTP responds while every admitted reader is still held');refreshGate.resolve();assert.equal(response.status,200);assert.equal(response.body.providers.length,10);assert.ok(response.body.providers.every((p:any)=>p.models.length===1));
 await done;assert.equal(maximum,3);assert.equal(starts,10);assert.equal(active,0);const rows=(await call(h.api,'/api/providers/catalog')).body.providers,failed=rows.find((p:any)=>p.id==='program-9');assert.equal(failed.login.state,'unknown');assert.equal(failed.checking,true); // 347: disk observations stay unconfirmed after an interrupted refresh.
 assert.equal(failed.login.checkedAt,old.login.checkedAt);assert.deepEqual(failed.models,old.models);assert.match(failed.login.reason,/Временно.*cancelled/);assert.equal(rows.filter((p:any)=>p.login.checkedAt===now).length,9);assert.equal(readFileSync(join(cacheDir,'program-9.json'),'utf8'),bytes);
 for(let i=0;i<3;i++)await call(h.api,'/api/providers/catalog');assert.equal(starts,10,'failed read does not make GET retry forever');
 slow=false;await call(h.api,'/api/providers/program-9/check',{body:{}});assert.equal(catalog.peek('program-9').login.checkedAt,now);assert.equal(catalog.peek('program-9').login.reason,undefined);
});

test('343: no cache and timeout remain unknown; real CLI receives cancellation, check never says not installed', {timeout},async t=>{
 const f=antigravityFixture(t);let aborted=false,invocations=0;
 const e=cliEntry(f.description,{env:f.env,cwd:f.dir,execute:async(_request,signal)=>{invocations++;await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new ProviderError('cancelled','fixture-secret'))},{once:true})});throw Error('unreachable')}});
 const catalog=new ProviderCatalog([e],Date.now,{timeoutMs:100}),done=finished(catalog),h=await fixture(t,{deps:{providerCatalog:catalog}});await done;
 const row=catalog.peek('antigravity');assert.equal(row.installed,null);assert.equal(row.login.state,'unknown');assert.deepEqual(row.models,[]);assert.match(row.login.reason!,/Временно/);assert.equal(aborted,true);assert.equal(invocations,1);const check=await call(h.api,'/api/providers/antigravity/check',{body:{}});assert.equal(check.status,409);assert.equal(check.body.code,'provider_checking');assert.doesNotMatch(JSON.stringify(check.body),/fixture-secret/);
});

test('343: cache is public data, not permissions; logout/removal overwrite old observations and corrupt/symlink caches are not followed', {timeout},async t=>{
 const cacheDir=directory(t),e=entry();e.auth=async()=>({loggedIn:true,email:'alice@example.test'});const c=new ProviderCatalog([e],Date.now,{cacheDir});await c.read(e.id);await c.close();const file=join(cacheDir,'fixture.json'),bytes=readFileSync(file,'utf8');assert.doesNotMatch(bytes,/alice@example|loggedIn|token|command|capabilities/);assert.match(bytes,/a•••@example.test/);
 const raw=JSON.parse(bytes);raw.capabilities={mcp:true,turn:{all:{ok:true}}};raw.login.command='evil';writeFileSync(file,JSON.stringify(raw));const denied={...e,capabilities:{...e.capabilities,turn:{read:{ok:false,reason:'denied'},edit:{ok:false,reason:'denied'},all:{ok:false,reason:'denied'}}}};const fresh=new ProviderCatalog([denied],Date.now,{cacheDir});assert.equal(fresh.peek(e.id).capabilities.turn!.all.ok,false);assert.doesNotMatch(fresh.peek(e.id).login.command,/evil/);
 // Same public mask is not proof that an account from disk still owns the models.
 fresh.get(e.id).auth=async()=>({loggedIn:true,email:'amy@example.test'});fresh.get(e.id).models=async()=>{throw new ProviderError('cancelled','timeout')};await fresh.read(e.id);assert.deepEqual(fresh.peek(e.id).models,[]);assert.equal(fresh.peek(e.id).login.state,'unknown');assert.deepEqual(new ProviderCatalog([e],Date.now,{cacheDir}).peek(e.id).models,[],'new binding invalidates the old disk models too');
 fresh.get(e.id).auth=async()=>({loggedIn:false});await fresh.read(e.id);assert.equal(new ProviderCatalog([e],Date.now,{cacheDir}).peek(e.id).login.state,'unknown'); // 347: persisted logout is an observation until checked again.
 // The binary can disappear between version and auth, leaving a version in the in-memory row.
 fresh.get(e.id).auth=async()=>{throw new ProviderError('no_binary','missing')};await fresh.read(e.id);const absent=new ProviderCatalog([e],Date.now,{cacheDir}).peek(e.id);assert.equal(absent.installed,false);assert.deepEqual(absent.models,[]);await fresh.close();
 writeFileSync(file,'{broken');const corrupt=new ProviderCatalog([e],Date.now,{cacheDir});assert.equal(corrupt.peek(e.id).installed,null);assert.match(corrupt.peek(e.id).login.reason!,/не прочитан/);await corrupt.read(e.id);assert.equal(corrupt.peek(e.id).login.state,'ok');await corrupt.close();
 const neighbor=join(cacheDir,'neighbor');writeFileSync(neighbor,'untouched');unlinkSync(file);try{symlinkSync(neighbor,file)}catch(error){if(process.platform==='win32'&&(error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows file symlink privilege unavailable');return}throw error}const link=new ProviderCatalog([e],Date.now,{cacheDir});assert.equal(link.peek(e.id).installed,null);await link.read(e.id);assert.equal(readFileSync(neighbor,'utf8'),'untouched');await link.close();assert.equal(readdirSync(cacheDir).some(name=>name.endsWith('.tmp')),false);
});

test('343: queued readers have their own deadline; close cancels reads and prevents late cache writes', {timeout},async t=>{
 const cacheDir=directory(t),gate=deferred(),first=entry('first'),second=entry('second');let firstDone=false;
 first.version=async()=>{await gate.promise;firstDone=true;return '1'};second.version=async(signal)=>{await delay(20,signal);return '1'};
 const c=new ProviderCatalog([first,second],Date.now,{cacheDir,concurrency:1,timeoutMs:150});const a=c.read('first'),b=c.read('second');const rows=await Promise.all([a,b]);assert.equal(rows[0]!.row.login.state,'unknown');assert.equal(rows[1]!.row.login.state,'ok');gate.resolve();await Promise.resolve();assert.equal(firstDone,true);assert.equal(c.peek('first').login.state,'unknown','late result cannot mutate snapshot');await c.close();
 const hold=deferred();const closed=new ProviderCatalog([{...first,version:async()=>{await hold.promise;return '2'}}],Date.now,{cacheDir});const work=closed.read('first');await Promise.resolve();await closed.close();await work.catch(()=>{});hold.resolve();await Promise.resolve();assert.equal(readdirSync(cacheDir).includes('first.json'),false);
});
