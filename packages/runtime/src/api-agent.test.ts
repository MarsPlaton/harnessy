import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {StreamChunk} from '@harnessy/llm';
import {ApiAgent} from './api-agent.ts';
import {agentFixture,modelDouble,end,tool} from './agent-test-helpers.ts';
import {deferred} from './test-helpers.ts';

test('21b: streamed model-tool-model loop retains opaque reasoning, tool ids, results and accumulated usage',async t=>{
 const h=agentFixture(t),traces:any[]=[];h.ctx.traceEvent=e=>traces.push(e);const reasoning={type:'reasoning' as const,text:'',redacted:true,signature:'opaque-signature'};
 const model=modelDouble((_r,index)=>index===0?[{type:'text-delta',index:0,text:'Создаю'},end([{type:'text',text:'Создаю'},reasoning,tool('write_file',{path:'artifacts/result.md',text:'CONTENT_ONLY_IN_FILE'})],'tool-calls')]:[end([{type:'text',text:'Готово'}])]);
 const agent=new ApiAgent('local',{service:()=>model.service}),result=await agent.runTurn(h.seat,'task',h.ctx);assert.equal(result.text,'Создаю\n\nГотово');assert.equal(result.sessionId,null);assert.equal(readFileSync(join(h.dir,'artifacts/result.md'),'utf8'),'CONTENT_ONLY_IN_FILE');
 const second=model.requests[1]!;assert.deepEqual(second.messages[2]!.content[1],reasoning);assert.equal(second.messages[3]!.toolCallId,'call-1');assert.equal(second.messages[3]!.isError,false);assert.match(JSON.stringify(second.messages[3]),/result.md/);
 assert.deepEqual(h.events.find(e=>e.type==='done')!.usage,{input:26,output:8,cacheRead:4});assert.equal(h.events.filter(e=>e.type==='delta').map(e=>e.text).join(''),result.text);assert.equal(h.sessions.length,0);assert.equal(model.listeners.size,0);assert.equal(traces.filter(e=>e.phase==='call').length,1);assert.equal(traces.filter(e=>e.phase==='result').length,1);assert.doesNotMatch(JSON.stringify(traces),/CONTENT_ONLY_IN_FILE/);
});

test('21b: unavailable tools return a typed result to the model and cannot escalate read mode',async t=>{
 const h=agentFixture(t);h.seat.mode='read';const model=modelDouble((_r,i)=>i===0?[end([tool('write_file',{path:'oops',text:'bad'})],'tool-calls')]:[end()]);await new ApiAgent('local',{service:()=>model.service}).runTurn(h.seat,'task',h.ctx);
 assert.equal(existsSync(join(h.dir,'oops')),false);assert.equal(model.requests[1]!.messages.at(-1)!.isError,true);assert.match(JSON.stringify(model.requests[1]!.messages.at(-1)),/tool_denied/);
});

for(const malformed of ['duplicate','bad arguments','unfinished','wrong finish'])test('21b: '+malformed+' tool batch causes no partial writes',async t=>{
 const h=agentFixture(t),first=tool('write_file',{path:'first',text:'bad'}),second=tool('write_file',{path:'second',text:'bad'},malformed==='duplicate'?'call-1':'call-2');if(malformed==='bad arguments'&&second.type==='tool-call')second.arguments=null as any;
 const chunks:StreamChunk[]=malformed==='unfinished'?[{type:'block-end',index:0,block:first}]:[end([first,second],malformed==='wrong finish'?'stop':'tool-calls')];const model=modelDouble(()=>chunks);
 await assert.rejects(new ApiAgent('local',{service:()=>model.service}).runTurn(h.seat,'task',h.ctx),{code:'protocol'});assert.equal(existsSync(join(h.dir,'first')),false);assert.equal(existsSync(join(h.dir,'second')),false);
});

test('21b: bounded retries never retry partial text and an always retry can be cancelled',async t=>{
 const error:StreamChunk={type:'finish',reason:'error',failure:{code:'rate_limited',reason:'retry',retryable:true},usage:null};const h=agentFixture(t),waits:number[]=[];const model=modelDouble((_r,i)=>i<2?[error]:[end()],{mode:'normal',maxRetries:2,initialDelayMs:3,maxDelayMs:10,jitterRatio:0});await new ApiAgent('local',{service:()=>model.service,wait:async ms=>{waits.push(ms)}}).runTurn(h.seat,'task',h.ctx);assert.deepEqual(waits,[3,6]);assert.equal(model.requests.length,3);assert.equal(h.events.find(e=>e.type==='done')!.usage.input,13);assert.equal(h.events.find(e=>e.type==='done')!.usageIncomplete,true);
 const partial=modelDouble(()=>[{type:'text-delta',index:0,text:'partial'},error],{mode:'normal',maxRetries:5});await assert.rejects(new ApiAgent('local',{service:()=>partial.service}).runTurn(h.seat,'task',h.ctx),{code:'turn_failed'});assert.equal(partial.requests.length,1);
 const endless=modelDouble(()=>[error],{mode:'always'}),waiting=deferred();const run=new ApiAgent('local',{service:()=>endless.service,wait:()=>{waiting.resolve();return new Promise(()=>{})}}).runTurn(h.seat,'task',h.ctx);await waiting.promise;h.controller.abort();await assert.rejects(run,{code:'cancelled'});assert.equal(endless.requests.length,1);
});

for(const boundary of ['steps','calls'])test('21b: '+boundary+' limit terminates an endless tool loop',async t=>{
 const h=agentFixture(t),model=modelDouble((_r,i)=>[end([tool('list_files',{},'id-'+i)],'tool-calls')]);await assert.rejects(new ApiAgent('local',{service:()=>model.service,maxSteps:boundary==='steps'?2:10,maxToolCalls:boundary==='calls'?1:10}).runTurn(h.seat,'task',h.ctx),{code:'turn_failed'});assert.equal(model.requests.length,2);
});

for(const action of ['cancel','reset','route'])test('21b: '+action+' stops a transport that never yields and ignores its later write call',async t=>{
 const h=agentFixture(t),entered=deferred(),answer=deferred(),model=modelDouble(async function*(){entered.resolve();await answer.promise;yield end([tool('write_file',{path:'late',text:'bad'})],'tool-calls')});const agent=new ApiAgent('local',{service:()=>model.service}),run=agent.runTurn(h.seat,'task',h.ctx);const rejected=assert.rejects(run,{code:action==='route'?'turn_failed':'cancelled'});await entered.promise;
 if(action==='cancel')h.controller.abort();else if(action==='reset')await agent.reset();else{model.routes.local!.baseURL='http://127.0.0.1:2/v1';model.changed()}await rejected;answer.resolve();await Promise.resolve();assert.equal(existsSync(join(h.dir,'late')),false);assert.equal(model.requests.length,1);assert.equal(model.listeners.size,0);
});

for(const mode of ['check','web'] as const)test('21e: '+mode+' reaches the model with bounded tools',async t=>{const h=agentFixture(t);h.seat.mode=mode;const model=modelDouble(()=>[end()]);await new ApiAgent('local',{service:()=>model.service}).runTurn(h.seat,'task',h.ctx);assert.equal(model.requests.length,1);const names=model.requests[0]!.tools!.map(t=>t.name);assert.ok(names.includes('read_file'));assert.equal(names.includes('shell'),mode==='check');assert.equal(names.includes('web_fetch'),mode==='web');assert.equal(names.includes('write_file'),false);assert.equal(names.includes('edit_file'),false)});

test('21b: an old native session fails explicitly for Harnessy history recovery',async t=>{const h=agentFixture(t);h.seat.sessionId='legacy';const model=modelDouble(()=>[end()]);await assert.rejects(new ApiAgent('local',{service:()=>model.service}).runTurn(h.seat,'task',h.ctx),{code:'session_missing'});assert.equal(model.requests.length,0)});

test('24b: API agent sends ordered image ContentBlocks before text and reports the model capability',async t=>{
 const h=agentFixture(t);h.ctx.attachments=[{data:Buffer.from([1,2,3]),mime:'image/png'},{data:Buffer.from([4,5]),mime:'image/jpeg'}];h.ctx.beforeModel=async()=>{h.ctx.attachments![0]!.data.fill(9)};const model=modelDouble(()=>[end()],{mode:'normal',maxRetries:0},['text','image']),agent=new ApiAgent('local',{service:()=>model.service});
 assert.deepEqual(await agent.models(),[{id:'test-model',label:'Fixture',images:true}]);await agent.runTurn(h.seat,'посмотри',h.ctx);assert.deepEqual(model.requests[0]!.messages[1]!.content,[{type:'image',data:'AQID',mimeType:'image/png'},{type:'image',data:'BAU=',mimeType:'image/jpeg'},{type:'text',text:'посмотри'}]);
});
test('24b: API text-only model rejects attachments before preparation or inference',async t=>{
 const h=agentFixture(t);h.ctx.attachments=[{data:Buffer.from('fixture'),mime:'image/png'}];let preparations=0;const model=modelDouble(()=>[end()]),agent=new ApiAgent('local',{service:()=>model.service,prepareModel:async()=>{preparations++}});
 assert.deepEqual(await agent.models(),[{id:'test-model',label:'Fixture'}]);await assert.rejects(agent.runTurn(h.seat,'нельзя',h.ctx),{code:'images_unsupported'});assert.equal(preparations,0);assert.equal(model.requests.length,0);
});
test('24b: API model capability is rechecked after asynchronous preparation',async t=>{
 const h=agentFixture(t),modalities:('text'|'image')[]=['text','image'];h.ctx.attachments=[{data:Buffer.from('fixture'),mime:'image/png'}];const model=modelDouble(()=>[end()],{mode:'normal',maxRetries:0},modalities),agent=new ApiAgent('local',{service:()=>model.service,prepareModel:async()=>{modalities.splice(1)}});
 await assert.rejects(agent.runTurn(h.seat,'смена модели',h.ctx),{code:'images_unsupported'});assert.equal(model.requests.length,0);
});

test('21b secrets: split deltas and split final text blocks agree; opaque replay remains intact',async t=>{
 const h=agentFixture(t),secret='fixture-private-route-key',model=modelDouble(()=>[...Array.from(secret,char=>({type:'text-delta' as const,index:0,text:char})),end([{type:'text',text:secret.slice(0,9)},{type:'text',text:secret.slice(9)},{type:'reasoning',text:'opaque',signature:'signature'}])]);model.protection.add(secret);
 const result=await new ApiAgent('local',{service:()=>model.service}).runTurn(h.seat,'task',h.ctx);assert.equal(result.text,'[ключ скрыт]');assert.equal(h.events.filter(e=>e.type==='delta').map(e=>e.text).join(''),'[ключ скрыт]');assert.equal(JSON.stringify(h.events).includes(secret),false);
 const final=modelDouble(()=>[end([{type:'text',text:secret.slice(0,9)},{type:'text',text:secret.slice(9)}])]);final.protection.add(secret);assert.equal((await new ApiAgent('local',{service:()=>final.service}).runTurn(h.seat,'task',h.ctx)).text,'[ключ скрыт]');
});

test('21b secrets: arguments are masked before file, shell and peer effects; tool results and failures before replay or publication',async t=>{
 const h=agentFixture(t),secret='fixture"\\route-key';h.seat.mode='all';writeFileSync(join(h.dir,'input'),secret);let command='',peer='';h.ctx.tools.ask=async args=>{peer=args.text;return {ok:false,code:'fixture_denied',error:'reflected '+secret}};const traces:any[]=[];h.ctx.traceEvent=e=>traces.push(e);
 const model=modelDouble((_r,index)=>index===0?[end([tool('write_file',{path:'result',text:secret}),tool('shell',{command:'printf '+secret},'shell'),tool('ask',{to:'reviewer',text:secret},'ask'),tool('read_file',{path:'input'},'read')],'tool-calls')]:[end([{type:'text',text:secret}])]);model.protection.add(secret);
 const result=await new ApiAgent('local',{service:()=>model.service,shell:async req=>{command=req.args.at(-1)!;return {stdout:secret,stderr:'',code:0,signal:null}}}).runTurn(h.seat,'task',h.ctx);
 assert.equal(command,process.platform==='darwin'?'printf [ключ скрыт]':'');assert.equal(peer,'[ключ скрыт]');assert.equal(readFileSync(join(h.dir,'result'),'utf8'),'[ключ скрыт]');assert.equal(result.text,'[ключ скрыт]');
 const outputs=model.requests[1]!.messages.slice(2);assert.equal(JSON.stringify(outputs).includes(JSON.stringify(secret).slice(1,-1)),false);assert.equal(JSON.stringify([h.events,traces]).includes(JSON.stringify(secret).slice(1,-1)),false);assert.match(JSON.stringify(outputs),/ключ скрыт/);assert.match(JSON.stringify(h.events),/fixture_denied: reflected \[ключ скрыт\]/);
 if(process.platform!=='darwin')assert.match(JSON.stringify(outputs),/sandbox_unavailable/);
});

test('21b secrets: cancellation drops a buffered credential prefix and a partial response is never retried',async t=>{
 const h=agentFixture(t),secret='fixture-route-private',entered=deferred(),release=deferred(),model=modelDouble(async function*(){yield {type:'text-delta',index:0,text:secret.slice(0,9)};entered.resolve();await release.promise;yield end([{type:'text',text:secret}])});model.protection.add(secret);
 const run=new ApiAgent('local',{service:()=>model.service}).runTurn(h.seat,'task',h.ctx),rejected=assert.rejects(run,{code:'cancelled'});await entered.promise;h.controller.abort();await rejected;release.resolve();assert.equal(h.events.filter(e=>e.type==='delta').length,0);
 const h2=agentFixture(t),failed=modelDouble(()=>[{type:'text-delta',index:0,text:secret.slice(0,9)},{type:'finish',reason:'error',failure:{code:'transport',reason:'fixture failure',retryable:true},usage:null}],{mode:'always'});failed.protection.add(secret);await assert.rejects(new ApiAgent('local',{service:()=>failed.service}).runTurn(h2.seat,'task',h2.ctx),{code:'turn_failed'});assert.equal(failed.requests.length,1);
});

for(const action of ['cancel','reset'])test('21d: '+action+' during asynchronous model discovery prevents a late inference',async t=>{
 const h=agentFixture(t),entered=deferred(),release=deferred(),model=modelDouble(()=>[end()]);let signal:AbortSignal|undefined;
 const agent=new ApiAgent('local',{service:async s=>{signal=s;entered.resolve();await release.promise;return model.service}}),run=agent.runTurn(h.seat,'pending discovery',h.ctx),stopped=assert.rejects(run,{code:'cancelled'});await entered.promise;
 if(action==='cancel')h.controller.abort();else await agent.reset();await stopped;assert.equal(signal!.aborted,true);release.resolve();await Promise.resolve();assert.equal(model.requests.length,0);assert.equal(h.events.filter(e=>e.type==='delta').length,0);
});
