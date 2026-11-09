import platformTest from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,statSync,symlinkSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createConnection,createServer} from 'node:net';
import {execFileSync} from 'node:child_process';
import {SshTunnels} from './ssh-tunnels.ts';
import {sshDouble,sshBinary,stateWhen} from './ssh-test-helpers.ts';
import {harness} from './test-helpers.ts';

// The SSH manager uses Unix process ownership and /usr/bin/ssh; Windows pilot keeps it unavailable.
const test=process.platform==='win32'?platformTest.skip:platformTest;
platformTest('Windows SSH tunnels fail closed until a Windows owner/process design exists',{skip:process.platform!=='win32'},async t=>{
 const f=sshDouble(t);
 await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_unavailable'});
 assert.equal(f.tunnels.get('vps')?.url,null);
 assert.equal(f.commands.length,0);
});

test('22b: lazy shared startup uses strict owner host keys, no shell/config fallback, and a private master forwarding acknowledgment',async t=>{
 const f=sshDouble(t);assert.equal(f.commands.length,0);const before=readFileSync(join(f.keys,'known_hosts'),'utf8'),[a,b]=await Promise.all([f.tunnels.ensure('vps',f.config),f.tunnels.ensure('vps',f.config)]);
 assert.deepEqual(a,b);assert.equal(a.state,'up');assert.match(a.url!,/^socks5h:\/\/127\.0\.0\.1:\d+$/);assert.equal(f.workers.length,1);const command=f.workers[0]!.command,args=command.args;
 for(const flag of ['-N','-T','-M'])assert.ok(args.includes(flag));for(const option of ['BatchMode=yes','ExitOnForwardFailure=yes','StrictHostKeyChecking=yes','ServerAliveInterval=15','ServerAliveCountMax=2','ProxyCommand=none','UpdateHostKeys=no','ForwardAgent=no','IdentitiesOnly=yes'])assert.ok(args.includes(option),option);
 assert.deepEqual(args.slice(-2),['--','fixture.invalid']);const copy=args[args.indexOf('-i')+1]!;assert.equal(copy,join(command.cwd,'identity'));assert.equal(readFileSync(copy,'utf8'),'FIXTURE-NOT-A-PRIVATE-KEY');assert.equal(statSync(copy).mode&0o777,0o600);assert.equal(args[args.indexOf('-p')+1],'2222');assert.ok(args.includes('UserKnownHostsFile="'+join(f.keys,'known_hosts')+'"'));assert.equal(statSync(command.cwd).mode&0o777,0o700);
 const control=f.commands.find(c=>c.args.includes('-O'))!;assert.equal(control.args[control.args.indexOf('-O')+1],'forward');assert.equal(control.args[control.args.indexOf('-S')+1],args[args.indexOf('-S')+1]);assert.equal(control.args[control.args.indexOf('-D')+1],args[args.indexOf('-D')+1]);
 assert.deepEqual(Object.keys(command.env).sort(),['HOME','LC_ALL','PATH','SSH_ASKPASS_REQUIRE',...(process.env.SSH_AUTH_SOCK?['SSH_AUTH_SOCK']:[])].sort());assert.equal(command.env.SSH_ASKPASS_REQUIRE,'never');assert.doesNotMatch(JSON.stringify(a),/tester|fixture.invalid|keyPath|FIXTURE/);a.url='forged';assert.notEqual(f.tunnels.get('vps')!.url,'forged');assert.equal(readFileSync(join(f.keys,'known_hosts'),'utf8'),before);
 await f.tunnels.stop('vps');assert.equal(f.tunnels.get('vps'),null);assert.equal(existsSync(command.cwd),false);
});

for(const [stderr,code] of [['No ED25519 host key is known and you have requested strict checking. Host key verification failed.','ssh_host_key_unknown'],['REMOTE HOST IDENTIFICATION HAS CHANGED!','ssh_host_key_changed'],['Permission denied (publickey).','ssh_auth_failed'],['bind: Address already in use','ssh_forward_failed'],['Connection reset by peer','ssh_connect_failed']] as const)test('22b: typed '+code+' never exposes stderr, a stale URL or direct fallback',async t=>{
 const f=sshDouble(t);f.setExit({code:255,stderr:stderr+' SECRET-MARKER '+f.config.keyPath});await assert.rejects(f.tunnels.ensure('vps',f.config),{code});const state=f.tunnels.get('vps')!;assert.equal(state.state,'down');assert.equal(state.url,null);assert.equal(state.code,code);assert.doesNotMatch(JSON.stringify(state),/SECRET-MARKER|keyPath|ssh-test/);assert.equal(state.retryAt!==null,['ssh_forward_failed','ssh_connect_failed'].includes(code));
 if(code==='ssh_host_key_unknown'){assert.match(state.reason!,/Добавьте ключ хоста/);f.clock.advance(30000);assert.equal(f.workers.length,1)}
});

test('22b: crash supervision backs off, restores the same output id with a new generation, and stop cancels future restarts',async t=>{
 const f=sshDouble(t),first=await f.tunnels.ensure('vps',f.config),down=stateWhen(f.tunnels,'vps',s=>s.state==='down');f.workers[0]!.exit({code:255,stderr:'lost'});await down;assert.equal(f.tunnels.get('vps')!.retryAt,f.clock.now()+1000);
 await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_connect_failed'});f.clock.advance(999);assert.equal(f.workers.length,1);const up=stateWhen(f.tunnels,'vps',s=>s.state==='up');f.clock.advance(1);const second=await up;assert.ok(second.generation>first.generation);assert.equal(f.workers.length,2);
 const downAgain=stateWhen(f.tunnels,'vps',s=>s.state==='down');f.workers[1]!.exit({code:255,stderr:'lost again'});await downAgain;assert.equal(f.tunnels.get('vps')!.retryAt,f.clock.now()+2000);await f.tunnels.stop('vps');f.clock.advance(60000);assert.equal(f.workers.length,2);
});

test('22b: cancellation and A → B → A configuration replacement cannot resurrect an old startup',async t=>{
 const f=sshDouble(t);f.holdControl(true);const first=f.tunnels.ensure('vps',f.config),rejected=assert.rejects(first,{code:'ssh_stopped'});const second=f.tunnels.ensure('vps',{...f.config,host:'second.invalid'}),rejectedSecond=assert.rejects(second,{code:'ssh_stopped'});f.holdControl(false);const third=f.tunnels.ensure('vps',f.config);await Promise.all([rejected,rejectedSecond]);const result=await third;assert.equal(result.state,'up');assert.equal(f.workers.length,1);await f.tunnels.close();await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_stopped'});assert.deepEqual(f.tunnels.snapshots(),[]);
});

test('22b: absent fields, option injection, escaped/symlinked keys and absent known_hosts fail before launching SSH',async t=>{
 const f=sshDouble(t);for(const value of [null,{}, {...f.config,host:'-oProxyCommand=bad'}, {...f.config,host:'a\nHost *'}, {...f.config,user:'root;cmd'}, {...f.config,port:0}, {...f.config,port:1.5}, {...f.config,keyPath:'~/.ssh/${TOKEN}'},{...f.config,keyPath:'~/.ssh/%h'},{...f.config,extra:'bad'}])await assert.rejects(f.tunnels.ensure('vps',value as any),{code:'ssh_config_invalid'});
 const outside=join(f.directory,'outside');writeFileSync(outside,'NOT-A-KEY');symlinkSync(outside,join(f.keys,'escape'));for(const keyPath of [outside,join(f.keys,'escape'),'relative-key',join(f.keys,'missing')])await assert.rejects(f.tunnels.ensure('vps',{...f.config,keyPath}),{code:'ssh_key_unavailable'});
 rmSync(join(f.keys,'known_hosts'));await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_host_key_unknown'});assert.equal(f.commands.length,0);
});

test('22b: actual child double opens loopback SOCKS, strict flags parse in installed ssh without connecting, Runtime close kills a TERM-resistant child',{timeout:15000},async t=>{
 const f=sshBinary(t);f.behavior({ignoreTerm:true});const tunnels=new SshTunnels({home:f.home,binary:f.binary,temporaryDirectory:f.directory}),h=await harness(t,{deps:{sshTunnels:tunnels}}),state=await h.runtime.sshTunnels.ensure('vps',f.config),port=Number(new URL(state.url!).port);
 const reply=await new Promise<Buffer>((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port});socket.on('connect',()=>socket.write(Buffer.from([5,1,0])));socket.once('data',data=>{socket.destroy();resolve(data)});socket.once('error',reject)});assert.deepEqual([...reply],[5,0]);
 const main=f.commands().find((c:any)=>c.args.includes('-N')),native=execFileSync('/usr/bin/ssh',['-G',...main.args],{env:{PATH:'/usr/bin:/bin',HOME:f.home,LC_ALL:'C'},encoding:'utf8'});assert.match(native,/stricthostkeychecking true/);assert.match(native,/batchmode yes/);assert.match(native,/dynamicforward \[?127\.0\.0\.1\]?:/);assert.equal(readFileSync(f.config.keyPath,'utf8'),'FIXTURE-NOT-A-PRIVATE-KEY');
 await h.runtime.close();assert.equal(existsSync(main.cwd),false);assert.deepEqual(tunnels.snapshots(),[]);const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(()=>resolve()))});
});

test('22b: stop during a pending master acknowledgment rejects the caller and ignores a late success',async t=>{
 const f=sshDouble(t);f.holdControl(true);const pending=f.tunnels.ensure('vps',f.config),rejected=assert.rejects(pending,{code:'ssh_stopped'});await f.controlEntered.promise;const directory=f.workers[0]!.command.cwd;await f.tunnels.stop('vps');await rejected;f.controls[0]!({code:0,stderr:''});assert.equal(f.tunnels.get('vps'),null);assert.equal(existsSync(directory),false);assert.ok(f.stops>=2);f.clock.advance(60000);assert.equal(f.workers.length,1);
});
test('22b: a state subscriber stopping the newly ready tunnel prevents a successful receipt',async t=>{
 const f=sshDouble(t);let stop:Promise<void>|undefined;f.tunnels.subscribe(state=>{if(state.state==='up')stop=f.tunnels.stop('vps')});await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_stopped'});await stop;assert.equal(f.tunnels.get('vps'),null);assert.equal(existsSync(f.workers[0]!.command.cwd),false);
});

test('22b: repeated connection failures cap the retry delay and host-key repair requires a new explicit request',async t=>{
 const f=sshDouble(t);f.setExit({code:255,stderr:'Connection refused'});await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_connect_failed'});
 for(const wait of [1000,2000,4000,8000,16000,30000,30000]){const before=f.tunnels.get('vps')!,down=stateWhen(f.tunnels,'vps',s=>s.state==='down'&&s.generation>before.generation);assert.equal(before.retryAt,f.clock.now()+wait);f.clock.advance(wait);await down}
 await f.tunnels.stop('vps');f.setExit({code:255,stderr:'Host key verification failed'});await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_host_key_unknown'});const count=f.workers.length;f.clock.advance(60000);assert.equal(f.workers.length,count);f.setExit(null);assert.equal((await f.tunnels.ensure('vps',f.config)).state,'up');
});

test('22b: a missing binary and a hung startup are bounded typed failures with cleaned private files',{timeout:15000},async t=>{
 const f=sshBinary(t);for(const binary of [join(f.directory,'absent'),f.home]){const missing=new SshTunnels({home:f.home,binary,temporaryDirectory:f.directory});t.after(()=>missing.close());await assert.rejects(missing.ensure('vps',f.config),{code:'ssh_unavailable'})}
 f.behavior({hang:true});const tunnels=new SshTunnels({home:f.home,binary:f.binary,temporaryDirectory:f.directory,startupTimeoutMs:100});t.after(()=>tunnels.close());await assert.rejects(tunnels.ensure('vps',f.config),{code:'ssh_timeout'});assert.equal(tunnels.get('vps')!.url,null);await tunnels.close();for(const command of f.commands())assert.equal(existsSync(command.cwd),false);
});
