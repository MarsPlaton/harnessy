import platformTest from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,call,deferred} from './test-helpers.ts';
import {sshBinary,sshDouble} from '../../runtime/src/ssh-test-helpers.ts';
import {SshTunnels} from '../../runtime/src/ssh-tunnels.ts';
import {networkRevision} from '@harnessy/projects';
// These lifecycle scenarios require the Unix SSH tunnel implementation.
const test=process.platform==='win32'?platformTest.skip:platformTest;
const opts={timeout:15000},root='/api/network';
const output=(input:string)=>({code:0,signal:null,stderr:'',stdout:input.includes('ipapi.co')?'{"country_name":"Fixture"}\n0.01':'{"ip":"192.0.2.1"}\n0.02'});
async function saved(h:Awaited<ReturnType<typeof fixture>>,config:{host:string;port:number;user:string;keyPath:string}){
 const exit={...config,id:'vps',label:'VPS',type:'ssh' as const,keyPath:'~/.ssh/key'};
 await h.runtime.settings.changeNetwork(async n=>{n.migrated=true;n.legacyLabelsVersion=1;n.exits.vps=exit;return {result:undefined}});
 return {exit,revision:networkRevision(exit)};
}
const stopped=(child:{pid:number;cwd:string})=>{assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});assert.equal(existsSync(join(child.cwd,'identity')),false)};
for(const path of ['saved','preview'] as const)for(const success of [true,false])test('23a r2: '+path+' SSH check releases its real child and key after IP '+(success?'success':'failure'),opts,async t=>{
 const f=sshBinary(t),tunnels=new SshTunnels({home:f.home,binary:f.binary,temporaryDirectory:f.directory}),h=await fixture(t,{deps:{sshTunnels:tunnels,networkCheckOptions:{execute:async spec=>success?output(spec.input!):{code:7,signal:null,stdout:'',stderr:'unavailable'}}}});
 const {exit,revision}=await saved(h,f.config);
 const result=path==='saved'?(await call(h.api,root+'/exits/vps/check',{body:{revision}})).body.check:await h.runtime.networkChecks.preview(exit,undefined,AbortSignal.timeout(10000));
 assert.equal(result.ok,success);const children=f.commands().filter(c=>c.args.includes('-N'));assert.equal(children.length,1);stopped(children[0]);assert.deepEqual(tunnels.snapshots(),[]);
 assert.equal(path==='saved'?h.runtime.networkChecks.snapshot('vps',revision!)?.ok:result.ok,success);
});
for(const success of [true,false])test('23a r2: a provider-owned SSH tunnel survives a separate saved check with IP '+success,opts,async t=>{
 const f=sshBinary(t),tunnels=new SshTunnels({home:f.home,binary:f.binary,temporaryDirectory:f.directory}),h=await fixture(t,{deps:{sshTunnels:tunnels,networkCheckOptions:{execute:async spec=>success?output(spec.input!):{code:7,signal:null,stdout:'',stderr:''}}}});
 const {revision}=await saved(h,f.config);await h.runtime.settings.changeNetwork(async n=>{n.chains.claude=['vps'];return {result:undefined}});
 try{const live=await tunnels.ensure('vps',f.config),child=f.commands().find(c=>c.args.includes('-N'));
 assert.equal((await call(h.api,root+'/exits/vps/check',{body:{revision}})).body.check.ok,success);
 assert.deepEqual(tunnels.get('vps'),live);assert.doesNotThrow(()=>process.kill(child.pid,0));assert.equal(existsSync(join(child.cwd,'identity')),true);
 const checks=f.commands().filter(c=>c.args.includes('-N')&&c.pid!==child.pid);assert.equal(checks.length,1);stopped(checks[0]);assert.equal(tunnels.snapshots().length,1);
 }finally{await tunnels.close()}
});
for(const phase of ['startup','ip','country'] as const)test('23a r2: HTTP cancellation during '+phase+' removes saved-check resources without retry',opts,async t=>{
 const f=sshDouble(t),started=deferred(),cleaned=deferred();if(phase==='startup')f.holdControl(true);
 const stop=f.tunnels.stop.bind(f.tunnels);f.tunnels.stop=async id=>{await stop(id);cleaned.resolve()};
 const h=await fixture(t,{deps:{sshTunnels:f.tunnels,networkCheckOptions:{execute:async(spec,signal)=>{
  if(phase==='ip'||phase==='country'&&spec.input!.includes('ipapi.co')){started.resolve();await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})});signal.throwIfAborted()}
  return output(spec.input!);
 }}}});
 const {revision}=await saved(h,f.config),abort=new AbortController(),pending=call(h.api,root+'/exits/vps/check',{body:{revision},signal:abort.signal}),rejected=assert.rejects(pending);
 await (phase==='startup'?f.controlEntered.promise:started.promise);abort.abort();await rejected;await cleaned.promise;
 assert.deepEqual(f.tunnels.snapshots(),[]);assert.equal(f.workers.length,1);assert.equal(existsSync(f.workers[0]!.command.cwd),false);assert.equal(h.runtime.networkChecks.snapshot('vps',revision!),null);f.clock.advance(60000);assert.equal(f.workers.length,1);
});
test('23a r2: revision change during IP response cleans SSH resources and does not publish stale check',opts,async t=>{
 const f=sshDouble(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());const h=await fixture(t,{deps:{sshTunnels:f.tunnels,networkCheckOptions:{execute:async spec=>{entered.resolve();await release.promise;return output(spec.input!)}}}});
 const {revision}=await saved(h,f.config),pending=call(h.api,root+'/exits/vps/check',{body:{revision}});await entered.promise;
 await h.runtime.settings.changeNetwork(async n=>{n.exits.vps!.label='Changed';return {result:undefined}});release.resolve();assert.equal((await pending).body.code,'network_conflict');assert.deepEqual(f.tunnels.snapshots(),[]);assert.equal(existsSync(f.workers[0]!.command.cwd),false);assert.equal(h.runtime.networkChecks.snapshot('vps',revision!),null);
});
test('23a r2: concurrent saved checks own different tunnels; cancelling one keeps the other alive',opts,async t=>{
 const f=sshDouble(t),entered=deferred(),release=deferred(),cleaned=deferred();t.after(()=>release.resolve());let requests=0;
 const stop=f.tunnels.stop.bind(f.tunnels);f.tunnels.stop=async id=>{await stop(id);cleaned.resolve()};
 const h=await fixture(t,{deps:{sshTunnels:f.tunnels,networkCheckOptions:{execute:async(spec,signal)=>{
  if(spec.input!.includes('ipify')){if(++requests===2)entered.resolve();await Promise.race([release.promise,new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})]);signal.throwIfAborted()}
  return output(spec.input!);
 }}}});
 const {revision}=await saved(h,f.config),abort=new AbortController(),first=call(h.api,root+'/exits/vps/check',{body:{revision},signal:abort.signal}),rejected=assert.rejects(first),second=call(h.api,root+'/exits/vps/check',{body:{revision}});
 await entered.promise;assert.equal(f.tunnels.snapshots().length,2);abort.abort();await rejected;await cleaned.promise;assert.equal(f.tunnels.snapshots().length,1);assert.equal(f.tunnels.snapshots()[0]!.state,'up');release.resolve();assert.equal((await second).body.check.ok,true);assert.deepEqual(f.tunnels.snapshots(),[]);for(const w of f.workers)assert.equal(existsSync(w.command.cwd),false);
});
