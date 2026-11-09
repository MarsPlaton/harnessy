import platformTest from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmodSync,existsSync,readFileSync,writeFileSync,unlinkSync,symlinkSync,watch,mkdtempSync,statSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createServer} from 'node:net';
import {SshTunnels} from './ssh-tunnels.ts';
import {spawnSsh} from './ssh-process.ts';
import {sshBinary,sshDouble} from './ssh-test-helpers.ts';
import {engineOwner,processOwner,saveOwnership,recoverSshDirectories,type SshOwnership} from './ssh-ownership.ts';
import type {TestContext} from 'node:test';
import {trustedSshDirectory} from '@harnessy/projects';

// Unix PID/UID and process-group recovery is not part of the Windows subscription pilot.
const test=process.platform==='win32'?platformTest.skip:platformTest;

const absent=(path:string)=>new Promise<void>(resolve=>{const watcher=watch(dirname(path),()=>{if(!existsSync(path)){watcher.close();resolve()}});if(!existsSync(path)){watcher.close();resolve()}});
async function engine(t:TestContext){
 const f=sshBinary(t),source=join(f.directory,'engine.mjs');f.behavior({ignoreTerm:true});
 writeFileSync(source,`import {SshTunnels} from ${JSON.stringify(new URL('./ssh-tunnels.ts',import.meta.url).href)};const tunnels=new SshTunnels(${JSON.stringify({home:f.home,binary:f.binary,temporaryDirectory:f.directory})});const state=await tunnels.ensure('vps',${JSON.stringify(f.config)});process.send(state);process.on('message',()=>{});`);
 const child=spawn(process.execPath,[source],{env:{PATH:'/usr/bin:/bin',HOME:f.home},stdio:['ignore','ignore','ignore','ipc']});
 t.after(()=>{child.kill('SIGKILL');for(const c of f.commands().filter(c=>c.args.includes('-N'))){try{process.kill(-c.pid,'SIGKILL')}catch{}}});
 const [state]=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('fixture engine failed')})]);const master=f.commands().find(c=>c.args.includes('-N'))!;assert.ok(master);
 return {...f,child,state,master,owner:JSON.parse(readFileSync(join(master.cwd,'owner.json'),'utf8')) as SshOwnership};
}

test('22b/r2: replacing the source before spawn cannot change the key object passed to SSH',async t=>{
 const f=sshBinary(t),external=join(f.directory,'external');writeFileSync(external,'OUTSIDE-KEY-MARKER',{mode:0o600});let copy='';
 const tunnels=new SshTunnels({home:f.home,binary:f.binary,temporaryDirectory:f.directory,spawn:command=>{
  if(command.args.includes('-N')){unlinkSync(f.config.keyPath);symlinkSync(external,f.config.keyPath);copy=command.args[command.args.indexOf('-i')+1]!;assert.equal(readFileSync(copy,'utf8'),'FIXTURE-NOT-A-PRIVATE-KEY');assert.equal(statSync(copy).mode&0o777,0o600)}return spawnSsh(command);
 }});t.after(()=>tunnels.close());assert.equal((await tunnels.ensure('vps',f.config)).state,'up');await tunnels.close();assert.equal(existsSync(copy),false);assert.equal(readFileSync(external,'utf8'),'OUTSIDE-KEY-MARKER');
});

test('22b/r2: public permissions and oversized key files fail without spawning; owner read-only is accepted',async t=>{
 const f=sshDouble(t);for(const mode of [0o644,0o660,0o700]){chmodSync(f.config.keyPath,mode);await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_key_unavailable'})}
 chmodSync(f.config.keyPath,0o600);writeFileSync(f.config.keyPath,Buffer.alloc(1024*1024+1));await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_key_unavailable'});assert.equal(f.commands.length,0);
 writeFileSync(f.config.keyPath,'FIXTURE');chmodSync(f.config.keyPath,0o400);await f.tunnels.ensure('vps',f.config);assert.equal(readFileSync(f.commands[0]!.args[f.commands[0]!.args.indexOf('-i')+1]!,'utf8'),'FIXTURE');
});

test('22b/r2: engine SIGKILL closes SOCKS and removes control directory and private key without parent callbacks',{timeout:15000},async t=>{
 const f=await engine(t),removed=absent(f.master.cwd),ended=once(f.child,'exit');assert.ok(existsSync(join(f.master.cwd,'identity')));f.child.kill('SIGKILL');await ended;await removed;
 assert.equal(existsSync(f.master.cwd),false);assert.throws(()=>process.kill(f.master.pid,0));
 const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(new URL(f.state.url).port),'127.0.0.1',()=>server.close(()=>resolve()))});
});

test('22b/r2: next engine reaps an owned orphan even if both engine and guardian were killed',{timeout:15000},async t=>{
 const f=await engine(t);assert.ok(f.owner.guardian);process.kill(f.owner.guardian!.pid,'SIGKILL');const ended=once(f.child,'exit');f.child.kill('SIGKILL');await ended;assert.ok(existsSync(f.master.cwd));process.kill(f.master.pid,0);
 const next=new SshTunnels({home:f.home,binary:f.binary,temporaryDirectory:f.directory});t.after(()=>next.close());assert.equal(existsSync(f.master.cwd),false);
});

test('22b/r2: recovery ignores live engines, damaged markers, symlinks and recycled process IDs',async t=>{
 const f=sshDouble(t),live=mkdtempSync(join(f.directory,'hssh-')),recycled=mkdtempSync(join(f.directory,'hssh-')),bad=mkdtempSync(join(f.directory,'hssh-')),linked=join(f.directory,'hssh-ABC123');
 saveOwnership(live,{version:1,engine:engineOwner()!});writeFileSync(join(bad,'owner.json'),'{',{mode:0o600});symlinkSync(live,linked);
 const child=spawn(process.execPath,['-e','process.on("message",()=>{});process.send("ready")'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});t.after(()=>child.kill('SIGKILL'));await once(child,'message');
 const owner=processOwner(child.pid!)!;saveOwnership(recycled,{version:1,engine:{...owner,stamp:owner.stamp+'-old'},ssh:{...owner,stamp:owner.stamp+'-old'}});
 recoverSshDirectories(f.directory,()=>null);assert.equal(existsSync(recycled),true,'metadata failure is not proof of death');assert.equal(existsSync(live),true);process.kill(child.pid!,0);
 recoverSshDirectories(f.directory);
 assert.equal(existsSync(live),true);assert.equal(existsSync(bad),true);assert.equal(existsSync(linked),true);assert.equal(existsSync(recycled),false);process.kill(child.pid!,0);
});

test('22b/r3: the SSH root itself must be an owner directory without group/other write permission',async t=>{
 const f=sshDouble(t);for(const mode of [0o777,0o775,0o702]){chmodSync(f.keys,mode);await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_key_unavailable'})}
 chmodSync(f.keys,0o755);assert.throws(()=>trustedSshDirectory(f.home,process.getuid!()+1));assert.equal(f.commands.length,0);
 renameSync(f.keys,f.keys+'-real');symlinkSync(f.keys+'-real',f.keys);await assert.rejects(f.tunnels.ensure('vps',f.config),{code:'ssh_key_unavailable'});assert.equal(f.commands.length,0);
 unlinkSync(f.keys);renameSync(f.keys+'-real',f.keys);assert.equal((await f.tunnels.ensure('vps',f.config)).state,'up');
});

test('22b/r3: forged birth metadata never permits killing an unrelated process; configured SSH also needs the engine marker',{timeout:15000},async t=>{
 const f=sshBinary(t),dir=mkdtempSync(join(f.directory,'hssh-'));
 const child=spawn(process.execPath,['-e','process.on("message",()=>process.send("alive"));process.send("ready")'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});t.after(()=>child.kill('SIGKILL'));await once(child,'message');
 const owner=processOwner(child.pid!)!,reported:number[]=[];saveOwnership(dir,{version:1,engine:{...engineOwner()!,stamp:'not-this-engine'},ssh:owner});
 for(const binary of ['/usr/bin/ssh',process.execPath,f.binary]){recoverSshDirectories(f.directory,undefined,{binary,report:pid=>reported.push(pid)});process.kill(child.pid!,0);assert.equal(existsSync(dir),true)}
 assert.deepEqual(reported,[child.pid,child.pid,child.pid]);const pong=once(child,'message');child.send('ping');assert.equal((await pong)[0],'alive');
});
