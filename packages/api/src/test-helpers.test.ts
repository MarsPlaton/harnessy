import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {call,sse,deferred} from './test-helpers.ts';
import type {Api} from './server.ts';

for(const scenario of ['headers','body','sse-headers','sse-open'])test('327: abort destroys pending test HTTP/SSE transport: '+scenario,{timeout:10000},async t=>{
 const received=deferred(),closed=deferred(),controller=new AbortController();
 const server=createServer((req,res)=>{req.socket.once('close',()=>closed.resolve());if(scenario==='body'){res.writeHead(200);res.write('{"partial":')}else if(scenario==='sse-open'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders()}received.resolve()});
 t.after(async()=>{controller.abort();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api={url:'http://127.0.0.1:'+(server.address() as {port:number}).port} as Api;
 const result=scenario.startsWith('sse')?sse(api,'all',{signal:controller.signal}):call(api,'/api/status',{signal:controller.signal});
 // Attach rejection before aborting; a stalled response must reject, never resolve as success.
 const rejected=scenario==='sse-open'?null:assert.rejects(result,{code:'ABORT_ERR'});await received.promise;
 if(scenario==='sse-open'){const stream=await result as Awaited<ReturnType<typeof sse>>;controller.abort();await closed.promise;assert.equal(stream.req.destroyed,true);assert.equal(stream.response.destroyed,true)}else{controller.abort();await rejected;await closed.promise}
});

test('327: test deadline releases a real fixture request that never responds and completes after hooks',{timeout:process.platform==='win32'?30000:15000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'harnessy-http-deadline-')),script=join(dir,'deadline.mjs');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const deadlineMs=process.platform==='win32'?12000:2000;
 writeFileSync(script,`
 import test from 'node:test';
 import assert from 'node:assert/strict';
 import {fixture,call} from ${JSON.stringify(new URL('./test-helpers.ts',import.meta.url).href)};
 test('stalled metadata response',{timeout:${deadlineMs}},async t=>{
  const h=await fixture(t),sockets=new Set();h.api.server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
  h.api.server.removeAllListeners('request');h.api.server.on('request',()=>process.stdout.write('request-blocked\\n'));
  t.after(()=>{assert.equal(h.api.server.listening,false);assert.ok([...sockets].every(s=>s.destroyed));process.stdout.write('resources-closed\\n')});
  await call(h.api,'/api/providers/copilot/check',{body:{}});throw Error('stalled request unexpectedly returned');
 });
 `);
 const env:NodeJS.ProcessEnv={...process.env,HARNESS_TEST_HTTP_TRACE:'1'};delete env.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--import',new URL('../../projects/src/test-helpers.ts',import.meta.url).href,'--test',script],{stdio:['ignore','pipe','pipe'],env});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL')});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}))});
 assert.equal(result.signal,null,output);assert.equal(result.code,1,output);assert.match(output,/request-blocked/);assert.match(output,new RegExp('test timed out after '+deadlineMs+'ms'));assert.match(output,/resources-closed/);assert.match(output,/\[test.http\].*"phase":"error"/);assert.match(output,/\[test.http\].*"phase":"request.close"/);
});
