import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {CliProvider} from './provider.ts';
import {executeCli} from './process.ts';
import {cliFixture} from './test-support.ts';
import {cliContract} from './test-contract.ts';
cliContract('259 CLI process contract',cliFixture);

for(const format of ['json','text'] as const)test('259: '+format+' output is decoded without mistaking stdout for protocol events',async t=>{
 const f=await cliFixture(t,'ok',format);const r=await f.provider.runTurn(f.seat,'hello',f.ctx);assert.equal(r.text,'fixture answer');assert.equal(r.sessionId,format==='json'?'session-1':null);assert.equal(f.events.filter(e=>e.type==='done').length,1);assert.deepEqual(f.registered,f.revoked);
});
test('259: metadata capabilities and optional source of limits are explicit',async t=>{
 const f=await cliFixture(t);assert.equal(await f.provider.version(),'test-cli 1.0');assert.deepEqual(await f.provider.auth(),{loggedIn:true,email:'fixture@example.test'});assert.deepEqual(await f.provider.models(),[{id:'test-model',label:'Fixture model'}]);assert.equal((await f.provider.limits()).ok,true);assert.equal((await f.provider.listSessions(f.dir))[0]!.id,'session-1');assert.equal((await f.provider.sessionMessages(f.dir,'session-1'))[0]!.text,'fixture answer');
 const d={...f.description};delete d.limits;delete d.sessions;const p=new CliProvider(d,{env:f.env,cwd:f.dir,temporaryDirectory:f.dir});t.after(()=>p.close());assert.equal((await p.limits()).ok,false);await assert.rejects(p.listSessions(f.dir),{code:'capability_unsupported'});assert.equal(f.starts,0);
});
test('259: unsupported mode/model/resume and invalid descriptor do not fall back to broader permissions',async t=>{
 const f=await cliFixture(t);f.seat.mode='ask';await assert.rejects(f.provider.runTurn(f.seat,'hello',f.ctx),{code:'mode_unsupported'});f.seat.mode='read';f.seat.model='not-listed';await assert.rejects(f.provider.runTurn(f.seat,'hello',f.ctx),{code:'model_unsupported'});
 const d={...f.description};delete d.resume;const p=new CliProvider(d,{env:f.env,cwd:f.dir,temporaryDirectory:f.dir});t.after(()=>p.close());f.seat.sessionId='session-1';await assert.rejects(p.runTurn(f.seat,'hello',f.ctx),{code:'capability_unsupported'});assert.equal(f.starts,0);assert.equal(f.registered.length,0);
 // 303 permits partial mode support, while invalid/absent flag mappings still refuse execution.
 const partial=new CliProvider({...d,modes:{read:()=>[]}},{env:f.env,cwd:f.dir});t.after(()=>partial.close());await assert.rejects(partial.runTurn({...f.seat,sessionId:null},'no',f.ctx),{code:'protocol'});await assert.rejects(partial.runTurn({...f.seat,mode:'all',sessionId:null},'no',f.ctx),{code:'mode_unsupported'});
});
test('259: absent executable is distinguishable from absent login',async t=>{
 const f=await cliFixture(t),p=new CliProvider({...f.description,binary:join(f.dir,'absent')},{env:f.env,cwd:f.dir});t.after(()=>p.close());assert.equal((await p.inspect()).installed,false);await assert.rejects(p.runTurn(f.seat,'hello',f.ctx),{code:'no_binary'});assert.equal(f.starts,0);
});
test('259: changed resume identity is rejected and bridge credentials never leak across text chunks',async t=>{
 const f=await cliFixture(t,'mismatch');f.seat.sessionId='session-1';await assert.rejects(f.provider.runTurn(f.seat,'hello',f.ctx),{code:'protocol'});assert.equal(f.events.some(e=>e.type==='done'),false);
 const s=await cliFixture(t,'secret'),r=await s.provider.runTurn(s.seat,'hello',s.ctx);assert.equal(r.text,'[redacted]');assert.equal(JSON.stringify(s.events).includes(s.registered[0]!),false);assert.equal(JSON.stringify(s.traces).includes(s.registered[0]!),false);
});
test('259: reset cancels active subprocesses, close rejects new work, and pre-cancellation creates no token',async t=>{
 const f=await cliFixture(t,'hang'),run=f.provider.runTurn(f.seat,'hello',f.ctx),rejected=assert.rejects(run,{code:'cancelled'});await f.started;await f.provider.reset();await rejected;assert.deepEqual(f.registered,f.revoked);assert.equal(readdirSync(f.dir).some(n=>n.startsWith('harnessy-cli-')),false);await f.provider.close();await assert.rejects(f.provider.runTurn(f.seat,'new',f.ctx),{code:'cancelled'});
 const s=await cliFixture(t);s.controller.abort();await assert.rejects(s.provider.runTurn(s.seat,'hello',s.ctx),{code:'cancelled'});assert.equal(s.capture().length,0);assert.equal(s.registered.length,0);
});
test('259: read-only config auth returns public fields only; malformed config is not logged-out',async t=>{
 const f=await cliFixture(t),path=join(f.dir,'login.json'),p=new CliProvider({...f.description,auth:{file:()=>path,parse:(raw:string|null)=>raw?JSON.parse(raw):{loggedIn:false}}},{env:f.env,cwd:f.dir});t.after(()=>p.close());assert.deepEqual(await p.auth(),{loggedIn:false});assert.equal(existsSync(path),false);writeFileSync(path,JSON.stringify({loggedIn:true,email:'a@test',accessToken:'fake-token'}));assert.deepEqual(await p.auth(),{loggedIn:true,email:'a@test'});writeFileSync(path,'{');await assert.rejects(p.auth(),{code:'protocol'});
});
test('259: process output/time bounds and UTF-8 failures terminate instead of returning a partial success',async t=>{
 const f=await cliFixture(t),base={binary:process.execPath,cwd:f.dir,env:{},timeoutMs:2000,maxBytes:20};
 await assert.rejects(executeCli({...base,args:['-e','process.stdout.write("x".repeat(1000))']},new AbortController().signal),{code:'protocol'});
 await assert.rejects(executeCli({...base,args:['-e','process.stdout.write(Buffer.from([255]))']},new AbortController().signal),{code:'protocol'});
 await assert.rejects(executeCli({...base,args:['-e','setInterval(()=>{},1000)'],timeoutMs:50},new AbortController().signal),{code:'transport_lost'});
});

test('TS-30 r2: packaged generic CLI bridge inherits Electron Node mode',async t=>{
 const before=process.env.ELECTRON_RUN_AS_NODE,logging=process.env.ELECTRON_ENABLE_LOGGING;process.env.ELECTRON_RUN_AS_NODE='1';process.env.ELECTRON_ENABLE_LOGGING='1';
 t.after(()=>{if(before===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=before;if(logging===undefined)delete process.env.ELECTRON_ENABLE_LOGGING;else process.env.ELECTRON_ENABLE_LOGGING=logging});
 const f=await cliFixture(t);await f.provider.runTurn(f.seat,'hello',f.ctx);
 const rows=f.capture();for(const row of rows.filter(row=>row.action))assert.deepEqual(row.electronEnv,[]);assert.equal(rows.find(row=>row.configPath)!.runAsNode,'1');
});

test('Windows .js CLI target re-enters Electron as Node even when provider env was stripped',{skip:process.platform!=='win32'},async t=>{
 const f=await cliFixture(t),script=join(f.dir,'target.js'),previous=process.env.ELECTRON_RUN_AS_NODE;
 writeFileSync(script,'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "missing")');
 process.env.ELECTRON_RUN_AS_NODE='1';
 try{const result=await executeCli({binary:script,args:[],cwd:f.dir,env:{},timeoutMs:3000,maxBytes:100},new AbortController().signal);assert.equal(result.stdout,'1')}
 finally{if(previous===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=previous}
});

test('259: all mode is an explicit flag choice, metadata nonzero exit is refused unless descriptor declares it',async t=>{
 const f=await cliFixture(t);f.seat.mode='all';await f.provider.runTurn(f.seat,'hello',f.ctx);const args=f.capture().find(x=>x.action==='turn')!.args as string[];assert.ok(args.includes('all'));
 const deps={cwd:f.dir,env:f.env,execute:async()=>({stdout:'{"loggedIn":false}',stderr:'',code:1,signal:null})},p=new CliProvider(f.description,deps);t.after(()=>p.close());await assert.rejects(p.auth(),{code:'protocol'});
 const auth=f.description.auth;if(!('command'in auth))throw Error('fixture');const accepted=new CliProvider({...f.description,auth:{...auth,exitCodes:[0,1]}},deps);t.after(()=>accepted.close());assert.deepEqual(await accepted.auth(),{loggedIn:false});
});

test('22c: CLI auth and models checks inside a turn inherit the same route as the model process',{timeout:20000},async t=>{
 const f=await cliFixture(t,'probe');await f.provider.runTurn(f.seat,'fixture',f.ctx);
 const rows=f.capture().filter(r=>['auth','models','turn'].includes(r.action));assert.deepEqual(rows.map(r=>r.action),['auth','models','turn']);assert.ok(rows.every(r=>r.proxy===f.ctx.env.HTTPS_PROXY));
});
