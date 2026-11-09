import test from 'node:test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,mkdirSync,statSync,readdirSync,symlinkSync,renameSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {copilotFixture} from './copilot-test-helpers.ts';
import {CliStateStore} from './cli/state.ts';
import {ProviderCatalog,cliEntry} from './catalog.ts';
import {COPILOT_UNAVAILABLE} from './copilot.ts';
import {bridge} from './bridge-test-support.ts';
import {assertPrivateDirectory} from '@harnessy/team';

test('261/281: process metadata uses only RPC reads, masks account, keeps HOME and excludes environment overrides',async t=>{
 const h=await copilotFixture(t),{row}=await new ProviderCatalog([h.entry]).read('copilot');
 assert.equal(row.version,'1.0.12');assert.equal(row.login.state,'ok');assert.equal(row.login.account,'a•••@github.com');assert.deepEqual(row.models,[{id:'cp-model',label:'Copilot Model'}]);assert.deepEqual(row.capabilities.probe,{ok:true});assert.equal(row.capabilities.resume,true);assert.equal(row.capabilities.mcp,true);assert.equal(row.capabilities.limits,true);assert.equal(row.capabilities.turn?.all.ok,true);
 for(const c of h.capture().filter(c=>c.args)){assert.equal(c.home,process.env.HOME);assert.deepEqual(c.forbidden,[]);assert.ok(!c.args.includes('--prompt'))}
 assert.deepEqual(h.capture().filter(c=>c.rpc).map(c=>c.rpc),['auth.getStatus','models.list']);for(const c of h.capture().filter(c=>c.rpc))assert.equal(existsSync(c.config),false);
 assert.equal(readdirSync(h.stateRoot).length,0);
});
for(const scenario of ['logged-out','no-identity','bad-models','wrong-id','broken-rpc'])test('261: absent or forged metadata cannot start Copilot: '+scenario,async t=>{
 const h=await copilotFixture(t,scenario),{row}=await new ProviderCatalog([h.entry]).read('copilot');assert.equal(row.login.state,scenario==='logged-out'?'none':'error');
 await assert.rejects(h.provider.runTurn(h.seat,'do not run',h.ctx));assert.equal(h.capture().some(c=>c.turn),false);assert.equal(h.registered.length,0);
});
test('261: missing Copilot is installed:false, not an empty ready catalog',async t=>{const h=await copilotFixture(t),entry=cliEntry({...h.description,binary:join(h.dir,'missing')},h.deps);assert.equal((await new ProviderCatalog([entry]).read('copilot')).row.installed,false)});
// 307 cancels the blanket refusal in 293; modes/resume now run with a private state path.
for(const mode of ['read','edit','all'] as const)test('307: Copilot '+mode+' and resume preserve private state',async t=>{
 const h=await copilotFixture(t);const first=await h.provider.runTurn({...h.seat,mode},'hello',h.ctx);
 assert.ok(first.sessionId);const second=await h.provider.runTurn({...h.seat,mode,sessionId:first.sessionId},'again',h.ctx);assert.equal(second.sessionId,first.sessionId);
 const turns=h.capture().filter(c=>c.turn);assert.equal(turns.length,2);assert.equal(turns[0].config,turns[1].config);assert.ok(existsSync(turns[0].config));assert.ok(h.registered.length>0);
});
test('293: the MCP bridge has no probe/resume escape hatch',async()=>{
 const r=await bridge(['probe','provider_probe','resume'].map((name,i)=>({jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name,arguments:{provider:'copilot',model:'cp-model',from:'owner'}}})));
 assert.deepEqual(r.requests,[]);for(const row of r.replies){const result=row.result as any;assert.equal(result.isError,true);assert.match(JSON.stringify(result),/unknown_request/)}
});
test('281/282: state cleanup is journaled, preserves neighbours, refuses traversal, symlinks and a running seat',async t=>{
 const h=await copilotFixture(t),store=new CliStateStore('copilot',h.stateRoot),a=store.acquire(h.dir,'worker'),b=store.acquire(h.dir,'reviewer');writeFileSync(join(a.path,'session'),'worker');writeFileSync(join(b.path,'session'),'reviewer');
 if(process.platform==='win32')assert.equal(assertPrivateDirectory(a.path).isDirectory(),true);else assert.equal(statSync(a.path).mode&0o777,0o700);assert.throws(()=>store.acquire(h.dir,'worker'),{code:'busy'});await assert.rejects(store.remove(h.dir,undefined,()=>{}),{code:'busy'});a.release();b.release();
 await assert.rejects(store.remove(h.dir,'../outside',()=>{}),{code:'protocol'});await assert.rejects(store.remove(h.dir,'worker',()=>{throw Error('journal failed')}));assert.ok(existsSync(a.path));
 const journal:any[]=[];await store.remove(h.dir,'worker',e=>{journal.push(e)});assert.equal(existsSync(a.path),false);assert.equal(readFileSync(join(b.path,'session'),'utf8'),'reviewer');assert.equal(journal[0].kind,'provider.state.remove');
 symlinkSync(h.dir,a.path);await assert.rejects(store.remove(h.dir,'worker',()=>{}),{code:'protocol'});assert.ok(existsSync(h.account));
 const root=join(h.stateRoot,'copilot');renameSync(root,root+'-saved');symlinkSync(h.dir,root);await assert.rejects(store.remove(h.dir,'reviewer',()=>{}),{code:'protocol'});assert.ok(existsSync(h.account));
});
test('282: cleanup holds exclusion across the journal await',async t=>{
 const h=await copilotFixture(t),store=new CliStateStore('copilot',h.stateRoot),a=store.acquire(h.dir,'worker');a.release();let resume!:()=>void;const waiting=new Promise<void>(r=>resume=r),job=store.remove(h.dir,'worker',()=>waiting);
 assert.throws(()=>store.acquire(h.dir,'worker'),{code:'busy'});resume();await job;const next=store.acquire(h.dir,'worker');next.release();
});

test('281/282: process-owned lease excludes a second engine and recovers after a crashed engine',async t=>{
 const h=await copilotFixture(t),module=new URL('./cli/state.ts',import.meta.url).href;
 const script='import {CliStateStore} from '+JSON.stringify(module)+'; new CliStateStore("copilot",process.argv[1]).acquire(process.argv[2],"worker"); console.log("locked"); setInterval(()=>{},1000)';
 const child=spawn(process.execPath,['--input-type=module','-e',script,h.stateRoot,h.dir],{stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));
 const exited=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',()=>resolve())});let errors='';child.stderr.on('data',b=>errors+=b);
 await Promise.race([new Promise<void>(resolve=>child.stdout.once('data',()=>resolve())),exited.then(()=>{throw Error(errors)})]);
 const store=new CliStateStore('copilot',h.stateRoot);assert.throws(()=>store.acquire(h.dir,'worker'),{code:'busy'});child.kill('SIGKILL');await exited;
 const recovered=store.acquire(h.dir,'worker');recovered.release();let journal=0;await store.remove(h.dir,undefined,()=>{journal++});assert.equal(journal,1);assert.equal(existsSync(recovered.path),false);
});

test('307: replacement during beforeModel is rejected by the final object check',async t=>{
 const h=await copilotFixture(t),store=new CliStateStore('copilot',h.stateRoot),lease=store.acquire(h.dir,h.seat.id),outside=join(h.dir,'outside');lease.release();mkdirSync(outside);writeFileSync(join(outside,'keep'),'safe');
 await assert.rejects(h.provider.runTurn(h.seat,'no turn',{...h.ctx,beforeModel:async()=>{renameSync(lease.path,lease.path+'-saved');symlinkSync(outside,lease.path)}}),{code:'state_dir_tampered'});
 assert.equal(h.capture().some(c=>c.turn),false);assert.deepEqual(readdirSync(outside),['keep']);assert.equal(readFileSync(join(outside,'keep'),'utf8'),'safe');
});
