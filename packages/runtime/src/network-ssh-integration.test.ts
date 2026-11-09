import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {fixture} from '../../api/src/test-helpers.ts';
import {SshTunnels} from './ssh-tunnels.ts';
import {sshDouble} from './ssh-test-helpers.ts';
import {listen,socks} from './network-test-helpers.ts';

test('22c integration: Runtime uses the real SSH manager, SOCKS URL and shutdown; no external SSH', {timeout:20000,skip:process.platform==='win32'},async t=>{
 const target=http.createServer((_q,r)=>r.end('through real tunnel manager')),port=await listen(t,target),upstream=await socks(t,port),f=sshDouble(t),sockets=new Set<net.Socket>(),servers:net.Server[]=[];
 const tunnels=new SshTunnels({home:f.home,temporaryDirectory:f.directory,spawn:command=>{
  const child=f.spawn(command);
  if(command.args.includes('-N')){const listenPort=Number(command.args[command.args.indexOf('-D')+1]!.split(':').at(-1));
   const server=net.createServer(client=>{const remote=net.connect(Number(new URL(upstream.url).port),'127.0.0.1');sockets.add(client);sockets.add(remote);client.on('error',()=>remote.destroy());remote.on('error',()=>client.destroy());client.once('close',()=>{sockets.delete(client);remote.destroy()});remote.once('close',()=>{sockets.delete(remote);client.destroy()});client.pipe(remote);remote.pipe(client)});server.listen(listenPort,'127.0.0.1');servers.push(server);
  }
  return child;
 }});
 t.after(async()=>{await tunnels.close();for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise<void>(r=>server.close(()=>r()))))});
 const h=await fixture(t,{deps:{sshTunnels:tunnels}});assert.equal(h.runtime.sshTunnels,tunnels);
 await h.runtime.settings.changeNetwork(async c=>{c.migrated=true;c.exits.ssh={id:'ssh',label:'SSH',type:'ssh',...f.config,keyPath:'~/.ssh/key'};c.chains.claude=['ssh'];return {result:undefined}});
 assert.equal(await(await h.runtime.networkRelay.fetch('claude')('http://ssh-fixture.invalid')).text(),'through real tunnel manager');assert.deepEqual(upstream.hosts,['ssh-fixture.invalid']);assert.equal(tunnels.get('ssh')?.state,'up');assert.match(tunnels.get('ssh')!.url!,/^socks5h:\/\/127\.0\.0\.1:/);assert.ok(f.commands.some(command=>command.args.includes('-D')));
 await h.runtime.close();assert.equal(tunnels.get('ssh'),null);assert.ok(f.stops>0);
});
test('22c integration: default Runtime has a real SSH manager', {timeout:10000},async t=>{
 const h=await fixture(t);assert.ok(h.runtime.sshTunnels instanceof SshTunnels);
});
