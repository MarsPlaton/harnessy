import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import type {TestContext} from 'node:test';
import type {cliFixture,Scenario} from './test-support.ts';

/** The same behavior contract is reusable by each subscription CLI descriptor. */
export function cliContract(name:string,setup:(t:TestContext,scenario?:Scenario)=>Promise<Awaited<ReturnType<typeof cliFixture>>>){
 test(name+': authentication is metadata, login is display-only, and an absent login never starts a model',async t=>{
  const f=await setup(t,'logged-out');assert.equal((await f.provider.inspect()).installed,true);assert.equal((await f.provider.auth()).loggedIn,false);
  await assert.rejects(f.provider.runTurn(f.seat,'hello',f.ctx),{code:'not_logged_in'});assert.equal(f.starts,0);assert.equal(f.registered.length,0);assert.equal(f.capture().some(x=>x.action==='login'||x.action==='turn'),false);
 });
 test(name+': a turn uses pane-mcp with a per-turn token, emits trace call/result and removes private configuration',async t=>{
  const f=await setup(t);const r=await f.provider.runTurn(f.seat,'literal $(touch NEVER) ; "quote"',f.ctx);assert.equal(r.text,'fixture answer');assert.equal(r.sessionId,'session-1');
  assert.equal(f.starts,1);assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0]!.body,{from:'worker',to:'reviewer',kind:'status',text:'fixture'});assert.equal(f.requests[0]!.token,f.registered[0]);assert.deepEqual(f.revoked,f.registered);
  assert.deepEqual(f.traces.map(e=>[e.phase,e.name]),[['call','panes.send'],['result','panes.send']]);assert.equal(f.events.filter(e=>e.type==='done'||e.type==='error').length,1);const result=f.events.find(e=>e.type==='done');assert.equal(result?.model,f.seat.model);assert.deepEqual(result?.usage,{input:10,output:2,cacheRead:3});
  const cfg=f.capture().find(x=>x.configPath)!;if(process.platform==='win32')assert.equal(cfg.privateAcl,true);else{assert.equal(cfg.mode,0o600);assert.equal(cfg.directoryMode,0o700)}assert.equal(existsSync(cfg.configPath),false);assert.equal(cfg.input.message,'literal $(touch NEVER) ; "quote"');assert.equal(cfg.input.role,'fixture role');
  const turn=f.capture().find(x=>x.action==='turn')!;assert.equal(turn.tokenInEnv,false);assert.equal(turn.apiKeyInEnv,false);assert.equal(turn.proxy,'http://fixture.invalid:1234');assert.equal(f.handle,null);
 });
 test(name+': a resumed turn keeps the session and takes the immutable model/mode snapshot',async t=>{
  const f=await setup(t);f.seat.sessionId='session-1';f.seat.mode='edit';const expectedModel=f.seat.model,expectedArgs=[...f.description.resume!('session-1'),...f.description.modes.edit!({seat:{...f.seat},message:'hello',roleNote:f.ctx.roleNote,peers:f.ctx.peers,writableRoots:f.ctx.writableRoots})];const run=f.provider.runTurn(f.seat,'hello',f.ctx);f.seat.model='late-model';f.seat.mode='all';await run;
  const args=f.capture().find(x=>x.action==='turn')!.args as string[];for(const expected of expectedArgs)assert.ok(args.includes(expected));assert.equal(args.includes('late-model'),false);assert.equal(f.events.find(e=>e.type==='done')?.model,expectedModel);
 });
 for(const [scenario,code] of [['denied','permission_denied'],['crash','transport_lost'],['truncated','transport_lost'],['bad-json','protocol'],['late-failure','transport_lost'],['bad-auth','protocol']] as const)test(name+': '+scenario+' is a typed failure, never a successful terminal',async t=>{
  const f=await setup(t,scenario);await assert.rejects(f.provider.runTurn(f.seat,'hello',f.ctx),{code});assert.equal(f.events.filter(e=>e.type==='error').length,1);assert.equal(f.events.some(e=>e.type==='done'),false);assert.deepEqual(f.revoked,f.registered);assert.equal(f.handle,null);for(const row of f.capture().filter(x=>x.configPath))assert.equal(existsSync(row.configPath),false);
 });
 test(name+': interrupt terminates the process and bridge lifetime, a busy seat cannot start twice',async t=>{
  const f=await setup(t,'hang'),run=f.provider.runTurn(f.seat,'hello',f.ctx);const rejected=assert.rejects(run,{code:'cancelled'});await f.started;await assert.rejects(f.provider.runTurn(f.seat,'second',f.ctx),{code:'busy'});await f.handle!.interrupt();await rejected;assert.equal(f.events.some(e=>e.type==='done'),false);assert.deepEqual(f.registered,f.revoked);assert.equal(f.handle,null);
 });
}
