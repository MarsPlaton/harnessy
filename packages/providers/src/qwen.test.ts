import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {QWEN,QWEN_LOGIN_UNKNOWN,QWEN_MODELS_UNAVAILABLE,qwenVersion} from './qwen.ts';
import {qwenStream} from './qwen-stream.ts';
import {ProviderCatalog,CLI_DESCRIPTORS,cliEntry} from './catalog.ts';
import {ProviderError} from './types.ts';
import {CliProvider} from './cli/provider.ts';
import {qwenFixture,QWEN_SESSION,QWEN_TEST_TIMEOUT_MS as timeout} from './qwen-test-helpers.ts';
import {cliFixture} from './cli/test-support.ts';
import {assertPrivateDirectory,assertPrivateFile} from '@harnessy/team';

test('333 Qwen metadata: version only, unknown auth, default model, no invented quota', {timeout},async t=>{
 const f=qwenFixture(t),catalog=new ProviderCatalog([f.entry]);t.after(()=>catalog.close());const {row}=await catalog.read('qwen');
 assert.ok(CLI_DESCRIPTORS.includes(QWEN));assert.equal(row.installed,true);assert.equal(row.version,'0.24.0');assert.equal(row.login.state,'unknown');assert.equal(row.login.reason,QWEN_LOGIN_UNKNOWN);assert.equal(row.modelsReason,QWEN_MODELS_UNAVAILABLE);assert.deepEqual(row.models,[{id:'default',label:'по умолчанию программы'}]);assert.equal(row.login.account,undefined);
 assert.equal(row.capabilities.turn?.all.ok,true);for(const mode of ['read','edit'] as const){assert.equal(row.capabilities.turn?.[mode].ok,false);assert.ok(row.capabilities.turn?.[mode].reason)}
 assert.equal(row.capabilities.mcp,true);assert.equal(row.capabilities.resume,true);assert.equal(row.capabilities.limits,false);assert.deepEqual(catalog.limitsEntries(),[]);
 assert.deepEqual(f.capture().map(v=>v.args),[['--version']]);assert.deepEqual(f.capture()[0].keys,[]);assert.equal(f.capture()[0].home,process.env.HOME);assert.doesNotMatch(JSON.stringify(row),/fixture-secret|fixture-token/);
 const absent=cliEntry({...QWEN,binary:join(f.dir,'absent')},f.deps),missing=(await new ProviderCatalog([absent]).read('qwen')).row;assert.equal(missing.installed,false);assert.deepEqual(missing.models,[]);
 for(const stdout of ['', '{}', 'Qwen 0.24.0', '0.24.0\nsecret'])assert.throws(()=>qwenVersion.parse({stdout,stderr:'',code:0,signal:null}),{code:'protocol'});
 for(const unavailableReason of ['', '\n', undefined])assert.throws(()=>new CliProvider({...QWEN,auth:{unavailableReason}} as any),{code:'protocol'});
});

test('333 Qwen all: isolated MCP file, OAuth only, actual bridge, tools/usage, exact-session resume and cleanup', {timeout},async t=>{
 const h=await cliFixture(t,'probe'),f=qwenFixture(t,'bridge'),p=new CliProvider(f.description,f.deps);t.after(()=>p.close());
 let privateAcl=false;const ctx={...h.ctx,signal:AbortSignal.any([t.signal,h.ctx.signal]),beforeModel:async()=>{if(process.platform==='win32'){const directory=join(f.dir,readdirSync(f.dir).find(name=>name.startsWith('harnessy-cli-'))!);privateAcl=assertPrivateDirectory(directory).isDirectory()&&assertPrivateFile(join(directory,'mcp.json')).isFile()}}},seat={...h.seat,cwd:f.dir,vendor:'qwen',model:'default',mode:'all' as const};
 const first=await p.runTurn(seat,'hello',ctx);assert.equal(first.text,'готов');assert.equal(first.sessionId,QWEN_SESSION);
 assert.equal(h.requests.length,1);assert.deepEqual(h.traces.map(e=>e.phase),['call','result']);assert.deepEqual((h.events.at(-1) as any).usage,{input:9,output:2,cacheRead:3});assert.equal(h.starts,1);assert.deepEqual(h.registered,h.revoked);
 const command=f.capture().find(x=>x.args),config=f.capture().find(x=>x.path);assert.equal(command.args[command.args.indexOf('--auth-type')+1],'qwen-oauth');assert.ok(command.args.includes('--safe-mode'));assert.equal(command.args[command.args.indexOf('--approval-mode')+1],'yolo');assert.ok(!command.args.includes('-m')&&!command.args.includes('--model'));assert.deepEqual(command.keys,[]);assert.equal(command.home,process.env.HOME);if(process.platform==='win32')assert.equal(privateAcl,true);else assert.equal(config.mode,0o600);assert.deepEqual(config.servers,['harnessy']);assert.ok(config.tokenPresent);assert.equal(existsSync(config.path),false);
 const again=await p.runTurn({...seat,sessionId:first.sessionId},'again',ctx);assert.equal(again.sessionId,QWEN_SESSION);assert.ok(f.capture().some(x=>x.args?.includes('--resume')&&x.args.includes(QWEN_SESSION)));
 const before=f.capture().length;
 for(const mode of ['read','edit'] as const)await assert.rejects(p.runTurn({...seat,mode},'no',ctx),{code:'mode_unsupported'});
 await assert.rejects(p.runTurn({...seat,model:'invented'},'no',ctx),{code:'model_unsupported'});
 await assert.rejects(p.runTurn({...seat,sessionId:'--yolo'},'no',ctx),{code:'session_missing'});
 assert.equal(f.capture().length,before);
});

for(const [scenario,code] of [['denied','turn_failed'],['logged-out','turn_failed'],['truncated','transport_lost'],['crash','transport_lost'],['bad-json','protocol'],['mismatch','protocol']] as const){
 test('333 Qwen '+scenario+': no false success; MCP and token cleaned', {timeout},async t=>{
  const h=await cliFixture(t,'probe'),f=qwenFixture(t,scenario),p=new CliProvider(f.description,f.deps);t.after(()=>p.close());
  await assert.rejects(p.runTurn({...h.seat,vendor:'qwen',model:'default',mode:'all',sessionId:QWEN_SESSION},'hello',{...h.ctx,signal:AbortSignal.any([t.signal,h.ctx.signal])}),{code});
  assert.ok(!h.events.some(e=>e.type==='done'));assert.equal(h.events.filter(e=>e.type==='error').length,1);assert.deepEqual(h.registered,h.revoked);for(const r of f.capture())if(r.path)assert.equal(existsSync(r.path),false);
 });
}

test('333 Qwen cancellation and late binding guard prevent lingering processes and unauthorized starts', {timeout},async t=>{
 const h=await cliFixture(t,'probe'),f=qwenFixture(t,'hang'),p=new CliProvider(f.description,f.deps);t.after(()=>p.close());const seat={...h.seat,vendor:'qwen',model:'default',mode:'all' as const},ctx={...h.ctx,signal:AbortSignal.any([t.signal,h.ctx.signal])};
 const turn=p.runTurn(seat,'wait',ctx),rejected=assert.rejects(turn,{code:'cancelled'});await h.started;h.controller.abort();await rejected;assert.deepEqual(h.registered,h.revoked);
 const before=f.capture().length;
 await assert.rejects(p.runTurn(seat,'deny',{...h.ctx,signal:t.signal,beforeModel:async()=>{throw new ProviderError('login_changed','binding changed')}}),{code:'login_changed'});
 assert.equal(f.capture().length,before);assert.deepEqual(h.registered,h.revoked);
});

test('333 Qwen raw stream rejects wrong sessions, missing fields, forged tool results and false terminal data', {timeout},()=>{
 const start=()=>{const d=qwenStream();d({type:'system',subtype:'init',session_id:'s'});return d};
 for(const v of [{type:'result',is_error:false,subtype:'success',result:'ok',session_id:'foreign'},{type:'result',session_id:'s',subtype:'success',result:'ok'},{type:'assistant',session_id:'s',message:{role:'user',content:[]}},{type:'user',session_id:'s',message:{role:'user',content:[{type:'tool_result',tool_use_id:'t'}]}},{type:'result',session_id:'s',is_error:false,subtype:'other',result:'ok'},{type:'result',session_id:'s',is_error:false,subtype:'success',result:'ok',usage:{input_tokens:1,cache_read_input_tokens:2}}])assert.throws(()=>start()(v),{code:'protocol'});
 const d=start();assert.deepEqual(d({type:'user',session_id:'s',message:{role:'user',content:[{type:'text',text:'not an answer'}]}}),[]);
 const terminal={type:'result',session_id:'s',is_error:false,subtype:'success',result:'ok'};assert.deepEqual((d(terminal)[0] as any).usage,{input:null,output:null,cacheRead:null});assert.throws(()=>d(terminal),{code:'protocol'});
});
