import test,{describe,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {EventParser,argumentsFor,measure} from '../tools/latency-probe.ts';
import {fixture} from './test-helpers.ts';

function markDouble(api:Awaited<ReturnType<typeof fixture>>['api']){
  api.server.prependListener('request',(request,response)=>{if(request.method==='GET'&&request.url?.startsWith('/api/events/'))response.setHeader('X-Harnessy-Test-Double','1')});
}

async function localServer(t:TestContext,handle:(req:IncomingMessage,res:ServerResponse)=>void){
  const server=createServer(handle);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))});
  const address=server.address();assert.ok(address&&typeof address!=='string');return 'http://127.0.0.1:'+address.port;
}

test('TS-47.T: SSE parser handles split UTF-8, CRLF, multiline data and comments',()=>{
  const parser=new EventParser(),raw=Buffer.from(': keepalive\r\ndata: {"type":"delta",\r\ndata: "text":"Привет"}\r\n\r\ndata: {"type":"done"}\n\n');
  const events=[];for(const byte of raw)events.push(...parser.push(Uint8Array.of(byte)));events.push(...parser.finish());
  assert.deepEqual(events,[{type:'delta',text:'Привет'},{type:'done'}]);
  assert.throws(()=>new EventParser().push(Buffer.from('data: {bad}\n\n')),/invalid SSE JSON/);
  const incomplete=new EventParser();incomplete.push(Buffer.from('data: {"type":"delta"}'));assert.throws(()=>incomplete.finish(),/incomplete SSE/);
});

test('TS-47.T: missing mode and the owner port in double mode are refused',async()=>{
  assert.throws(()=>argumentsFor(['--url','http://127.0.0.1:3777','--pane','worker']),/choose --double or --live/);
  assert.throws(()=>argumentsFor(['--url','http://127.0.0.1:3777','--pane','worker','--double']),/port 3777/);
  assert.throws(()=>argumentsFor(['--url','https://example.org','--pane','worker','--live']),/local HTTP origin/);
  await assert.rejects(measure({url:'http://127.0.0.1:3777',pane:'worker',message:'x',mode:'double'}),/port 3777/);
});

test('TS-47.T: an unmarked engine receives no chat request in double mode',async t=>{
  const h=await fixture(t,{noRepository:true});
  await assert.rejects(measure({url:h.api.url,pane:'worker',message:'must not be sent',mode:'double'}),/test-double marker missing/);
  assert.equal(h.provider.calls.length,0);assert.equal(h.runtime.project.journal.lastSeq,0);
});

test('TS-47.T r2: a POST redirect from a marked double never reaches the foreign engine',async t=>{
  let foreignPosts=0,markedPosts=0;
  const foreign=await localServer(t,(req,res)=>{if(req.method==='POST')foreignPosts++;req.resume();res.end('{}')});
  const marked=await localServer(t,(req,res)=>{
    if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream','X-Harnessy-Test-Double':'1'});res.write(': ready\n\n');return}
    markedPosts++;req.resume();res.writeHead(307,{Location:foreign+'/api/chat'});res.end();
  });
  await assert.rejects(measure({url:marked,pane:'worker',message:'must not be forwarded',mode:'double',timeoutMs:5000}));
  assert.equal(markedPosts,1);assert.equal(foreignPosts,0);
});

test('TS-47.T r2: an SSE redirect cannot borrow another origin marker to authorize a POST',async t=>{
  let markedRequests=0,ordinaryPosts=0;
  const marked=await localServer(t,(_req,res)=>{markedRequests++;res.writeHead(200,{'Content-Type':'text/event-stream','X-Harnessy-Test-Double':'1'});res.write(': ready\n\n')});
  const ordinary=await localServer(t,(req,res)=>{
    if(req.method==='GET'){res.writeHead(307,{Location:marked+'/api/events/worker'});res.end();return}
    ordinaryPosts++;req.resume();res.end('{}');
  });
  await assert.rejects(measure({url:ordinary,pane:'worker',message:'must not be sent',mode:'double',timeoutMs:5000}));
  assert.equal(markedRequests,0);assert.equal(ordinaryPosts,0);
});

// Each sample owns its project, server and provider; overlap the real delays
// without shortening them or sharing state between measurements.
const delayWindows=new Map<number,{start:number;end:number|null}>();
describe('TS-53: independent latency samples',{concurrency:3},()=>{
for(const ms of [15000,2000,0])test('TS-47.T: real engine with FakeProvider measures '+ms+' ms delay',{timeout:45_000},async t=>{
  const h=await fixture(t,{noRepository:true});markDouble(h.api);h.provider.onRun=async(seat,_message,ctx)=>{
    ctx.modelStarted?.();const window={start:performance.now(),end:null as number|null};delayWindows.set(ms,window);
    if(ms)await delay(ms);window.end=performance.now();ctx.publish({type:'delta',text:'Готово'});
    ctx.publish({type:'done',sessionId:null,model:seat.model,durationMs:ms,usage:{input:1,output:1,cacheRead:0}});return {text:'Готово',sessionId:null};
  };
  const row=await measure({url:h.api.url,pane:'worker',message:'Проверка',mode:'double',timeoutMs:30_000});
  assert.equal(row.outcome,'done');assert.ok(row.seq>0);assert.ok(row.traceId);
  assert.equal(row.sent.elapsedMs,0);assert.ok(row.accepted.elapsedMs>=0);assert.ok(row.firstEvent);
  assert.ok(row.firstOutputEvent);assert.ok(row.firstOutputEvent.elapsedMs>=ms-100,JSON.stringify(row));
  assert.ok(row.firstCharacter);assert.ok(row.firstCharacter.elapsedMs>=ms-100,JSON.stringify(row));
  assert.ok(row.end.elapsedMs>=row.firstCharacter.elapsedMs);assert.equal(h.provider.calls.length,1);
});
});

test('TS-53: independent real delays overlap rather than waiting serially',()=>{
  const slow=delayWindows.get(15000),short=delayWindows.get(2000);
  assert.ok(slow&&short&&slow.end!==null&&short.end!==null);
  assert.ok(slow.start<short.end&&short.start<slow.end);
});

test('TS-47.T: early frames are retained, foreign and replay frames do not complete the sample',async t=>{
  let stream:ServerResponse|undefined;
  const server=createServer((request,response)=>{
    if(request.method==='GET'){
      stream=response;response.writeHead(200,{'Content-Type':'text/event-stream','X-Harnessy-Test-Double':'1'});response.write(': ready\n\n');return;
    }
    assert.ok(stream);request.resume();
    for(const event of [{type:'done',traceId:'foreign'},{type:'done',traceId:'ours',replay:true},{type:'tool',traceId:'ours'},{type:'delta',traceId:'ours',text:'x'},{type:'done',traceId:'ours'}])stream.write('data: '+JSON.stringify(event)+'\n\n');
    stream.end();
    setTimeout(()=>{response.writeHead(200,{'Content-Type':'application/json','X-Harness-Trace-Id':'ours'});response.end(JSON.stringify({ok:true,seq:123,queued:false}))},30);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const row=await measure({url:'http://127.0.0.1:'+address.port,pane:'worker',message:'x',mode:'double',timeoutMs:2000});
  assert.equal(row.traceId,'ours');assert.equal(row.outcome,'done');assert.equal(row.seq,123);
  assert.ok(row.firstOutputEvent&&row.firstCharacter);assert.ok(row.end.elapsedMs<row.accepted.elapsedMs,JSON.stringify(row));
});

test('TS-47.T: a provider failure is recorded without inventing a first character',async t=>{
  const h=await fixture(t,{noRepository:true});markDouble(h.api);h.provider.onRun=async(_seat,_message,ctx)=>{ctx.modelStarted?.();throw Error('fake model failed')};
  const row=await measure({url:h.api.url,pane:'worker',message:'Проверка',mode:'double',timeoutMs:5000});
  assert.equal(row.outcome,'error');assert.equal(row.firstCharacter,null);assert.ok(row.firstEvent);assert.equal(h.provider.calls.length,1);
});

test('TS-47.T: a late delta after done cannot become the first character',async t=>{
  let stream:ServerResponse|undefined;
  const server=createServer((request,response)=>{
    if(request.method==='GET'){stream=response;response.writeHead(200,{'Content-Type':'text/event-stream','X-Harnessy-Test-Double':'1'});response.write(': ready\n\n');return}
    request.resume();assert.ok(stream);
    for(const event of [{type:'done',traceId:'ours'},{type:'delta',traceId:'ours',text:'late'}])stream.write('data: '+JSON.stringify(event)+'\n\n');
    stream.end();setTimeout(()=>{response.writeHead(200,{'Content-Type':'application/json','X-Harness-Trace-Id':'ours'});response.end(JSON.stringify({ok:true,seq:1}))},20);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const row=await measure({url:'http://127.0.0.1:'+address.port,pane:'worker',message:'x',mode:'double',timeoutMs:2000});assert.equal(row.firstCharacter,null);
});

test('TS-47.T: CLI writes two separate samples as JSON without storing the message',async t=>{
  const h=await fixture(t,{noRepository:true});markDouble(h.api);h.provider.onRun=async(seat,_message,ctx)=>{
    ctx.modelStarted?.();ctx.publish({type:'delta',text:'ок'});ctx.publish({type:'done',sessionId:null,model:seat.model,durationMs:1,usage:{input:1,output:1,cacheRead:0}});return {text:'ок',sessionId:null};
  };
  const output=join(h.dir,'measure.json'),secret='fixture-private-message';
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../tools/latency-probe.ts',import.meta.url)),'--url',h.api.url,'--pane','worker','--double','--repeat','2','--message',secret,'--output',output]);
  const raw=await readFile(output,'utf8'),result=JSON.parse(raw);assert.equal(result.mode,'double');assert.equal(result.samples.length,2);
  assert.notEqual(result.samples[0].traceId,result.samples[1].traceId);assert.doesNotMatch(raw,new RegExp(secret));assert.match(stdout,/firstCharacter/);assert.equal(h.provider.calls.length,2);
});
