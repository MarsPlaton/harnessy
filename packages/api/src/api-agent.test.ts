import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ServerResponse} from 'node:http';
import {fixture,call,deferred} from './test-helpers.ts';
import {config,endpoint,MemoryKeys} from '../../llm/src/test-helpers.ts';
import {collect} from '../../runtime/src/test-helpers.ts';

function answer(res:ServerResponse,content:string|{name:string;arguments:unknown},id='call-fixture'){
 res.writeHead(200,{'Content-Type':'text/event-stream'});const event=(delta:any,finish:any=null,usage?:any)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'test-model',choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})+'\n\n');
 event({role:'assistant'});if(typeof content==='string')event({content},'stop');else event({tool_calls:[{index:0,id,type:'function',function:{name:content.name,arguments:JSON.stringify(content.arguments)}}]},'tool_calls');event({},null,{prompt_tokens:12,completion_tokens:4,total_tokens:16,prompt_tokens_details:{cached_tokens:2}});res.end('data: [DONE]\n\n');
}
async function connect(h:Awaited<ReturnType<typeof fixture>>,url:string,mode='edit'){
 const route=await call(h.api,'/api/llm/providers/local',{body:{config:{...config(url),retryPolicy:{mode:'normal',maxRetries:0}}}});assert.equal(route.status,200,route.text);
 const pane=await call(h.api,'/api/panes/worker',{body:{vendor:'api:local',model:'test-model',mode}});assert.equal(pane.status,200,pane.text);return route.body.revision;
}

for(const mode of ['check','web'])test('21e HTTP: API '+mode+' applies its tool boundary inside a real model/tool loop',{skip:mode==='check'&&process.platform!=='darwin'},async t=>{
 let step=0;const action=mode==='check'?{name:'shell',arguments:{command:'printf changed > guarded.txt'}}:{name:'web_fetch',arguments:{url:'http://127.0.0.1:3777/api/status'}};
 const server=await endpoint(t,(_b,_q,res)=>answer(res,step++===0?action:'отказ учтён')),h=await fixture(t,{deps:{llmKeys:new MemoryKeys()}});await connect(h,server.url,mode);writeFileSync(join(h.dir,'guarded.txt'),'original');
 const turn=await call(h.api,'/api/chat',{body:{pane:'worker',message:'boundary fixture'}});assert.equal(turn.status,200,turn.text);await h.runtime.idle();
 assert.equal(server.bodies.length,2);assert.match(JSON.stringify(server.bodies[1].messages),mode==='check'?/shell_failed/:/web_url_denied/);assert.equal(readFileSync(join(h.dir,'guarded.txt'),'utf8'),'original');assert.equal(h.runtime.registry.get('worker')!.transcript.at(-1)!.text,'отказ учтён');assert.equal(h.provider.calls.length+h.codex.calls.length,0);
 const names=server.bodies[0].tools.map((x:any)=>x.function.name);assert.equal(names.includes('shell'),mode==='check');assert.equal(names.includes('web_fetch'),mode==='web');for(const name of ['write_file','edit_file','web_search'])assert.equal(names.includes(name),false);
});

test('21b HTTP: API selection, live tool loop, Harnessy history, artifacts, usage and linked trace without native sessions',async t=>{
 let step=0;const server=await endpoint(t,(_b,_req,res)=>answer(res,step++===0?{name:'write_file',arguments:{path:'artifacts/report.md',text:'FILE_PAYLOAD'}}:step===2?'FIRST_ANSWER':'SECOND_ANSWER'));
 const h=await fixture(t,{deps:{llmKeys:new MemoryKeys()}});await connect(h,server.url);const stream=collect(h.runtime);t.after(()=>stream.sub.close());
 const status=(await call(h.api,'/api/status')).body;assert.equal(status.models['api:local'][0].id,'test-model');assert.equal(status.turnModes['api:local'].all.ok,true);assert.equal(status.turnModes['api:local'].check.ok,true);assert.equal(status.turnModes['api:local'].web.ok,true);assert.equal(status.turnModes['api:local'].web.note,'только загрузка страниц по адресу');
 assert.equal(await h.runtime.runTurn('worker','FIRST_QUESTION'),'FIRST_ANSWER');assert.equal(readFileSync(join(h.dir,'artifacts/report.md'),'utf8'),'FILE_PAYLOAD');
 const pane=h.runtime.registry.get('worker')!;assert.equal(pane.sessionId,null);assert.equal(pane.transcript.at(-1)!.artifacts!.paths[0],'artifacts/report.md');
 assert.equal(await h.runtime.runTurn('worker','SECOND_QUESTION'),'SECOND_ANSWER');assert.match(JSON.stringify(server.bodies[2].messages),/FIRST_ANSWER/);assert.match(JSON.stringify(server.bodies[2].messages),/SECOND_QUESTION/);
 assert.equal(h.provider.calls.length,0);assert.equal(h.codex.calls.length,0);assert.equal(stream.events.filter(e=>e.type==='delta').map(e=>e.text).join(''),'FIRST_ANSWERSECOND_ANSWER');
 const spend=await call(h.api,'/api/spend/turns?vendor=api%3Alocal');assert.equal(spend.status,200,spend.text);assert.equal(spend.body.items.length,2);assert.ok(spend.body.items.every((r:any)=>r.vendor==='api:local'&&r.outcome==='ok'));assert.equal(spend.body.items.reduce((n:number,r:any)=>n+r.usage.output,0),12);
 const trace=await call(h.api,'/api/trace');assert.doesNotMatch(trace.text,/FILE_PAYLOAD|FIRST_QUESTION/);const rows=trace.body.records;assert.ok(Array.isArray(rows),trace.text);
 for(const kind of ['llm.request','llm.response','tool.call','tool.result']){const row:any=rows.find((r:any)=>r.kind===kind);assert.ok(row,kind);assert.equal(row.pane,'worker');assert.ok(row.turnInstanceId);assert.ok(row.parentSpanId)}
});

test('21b HTTP: ask mode uses the existing approval card and preserves the file when denied',async t=>{
 let step=0;const first=deferred();const server=await endpoint(t,(_b,_q,res)=>{answer(res,step++===0?{name:'write_file',arguments:{path:'guarded.txt',text:'bad'}}:'denied acknowledged');first.resolve()});
 const h=await fixture(t,{deps:{llmKeys:new MemoryKeys()}});await connect(h,server.url,'ask');writeFileSync(join(h.dir,'guarded.txt'),'old');const sub=h.runtime.subscribe({all:true}),approval=(async()=>{for await(const event of sub.events)if(event.type==='approval')return event;throw Error('approval missing')})();t.after(()=>sub.close());
 const turn=h.runtime.runTurn('worker','change file');await first.promise;const request=await approval;assert.equal(request.pane,'worker');assert.equal(readFileSync(join(h.dir,'guarded.txt'),'utf8'),'old');const denied=await call(h.api,'/api/approve',{body:{pane:request.pane,id:request.id,decision:'deny'}});assert.equal(denied.status,200,denied.text);await turn;
 assert.equal(readFileSync(join(h.dir,'guarded.txt'),'utf8'),'old');assert.match(JSON.stringify(server.bodies[1].messages),/approval_declined/);
});

test('21b HTTP: role tools cannot bypass project role policy and failed requests retain measured usage',async t=>{
 let step=0;const server=await endpoint(t,(_b,_q,res)=>{if(step++===0)answer(res,{name:'propose_seats',arguments:{seats:[{kind:'worker',label:'Unapproved',vendor:'api:local',model:'test-model',mode:'read',intro:'test'}]}});else{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture unavailable'}}))}});
 const h=await fixture(t,{deps:{llmKeys:new MemoryKeys()}});await connect(h,server.url,'read');await h.runtime.settings.patch('owner',{priceList:[{vendor:'api:local',model:'test-model',inputPerM:1,outputPerM:1,cacheReadPerM:1,currency:'USD'}]});await assert.rejects(h.runtime.runTurn('worker','try role tool'));assert.equal(h.runtime.registry.panes.size,1);assert.match(JSON.stringify(server.bodies[1].messages),/policy_denied|role_denied|orchestrator_required/);
 const spend=await call(h.api,'/api/spend/turns?vendor=api%3Alocal');assert.equal(spend.status,200,spend.text);assert.equal(spend.body.items.length,1);assert.equal(spend.body.items[0].outcome,'error');assert.equal(spend.body.items[0].usage.output,4);assert.equal(spend.body.items[0].usageIncomplete,true);assert.equal(spend.body.items[0].cost,null);const totals=await call(h.api,'/api/spend');assert.match(totals.body.costReason,/измерения токенов неполны/);assert.equal(totals.body.totals.missingMeasurements,1);
});

test('21b/21e HTTP: stale models refuse, check/web can be selected without a model call; route removal retains the seat',async t=>{
 const server=await endpoint(t,(_b,_q,res)=>answer(res,'unused')),h=await fixture(t,{deps:{llmKeys:new MemoryKeys()}});const revision=await connect(h,server.url,'read'),before=h.runtime.registry.get('worker')!.settings();
 const refused=await call(h.api,'/api/panes/worker',{body:{model:'not-in-route'}});assert.equal(refused.status,409,refused.text);assert.deepEqual(h.runtime.registry.get('worker')!.settings(),before);
 for(const mode of ['check','web']){const r=await call(h.api,'/api/panes/worker',{body:{mode}});assert.equal(r.status,200,r.text);assert.equal(h.runtime.registry.get('worker')!.mode,mode)}
 const deleted=await call(h.api,'/api/llm/providers/local/delete',{body:{revision}});assert.equal(deleted.status,200,deleted.text);assert.equal(h.runtime.registry.get('worker')!.vendor,'api:local');await assert.rejects(h.runtime.runTurn('worker','route gone'));assert.equal(server.bodies.length,0);assert.equal(h.provider.calls.length,0);
});

test('21b HTTP: cancellation and route replacement stop an active stream before any file action',async t=>{
 for(const action of ['cancel','replace']){const entered=deferred<ServerResponse>(),server=await endpoint(t,(_b,_q,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();entered.resolve(res)}),h=await fixture(t,{deps:{llmKeys:new MemoryKeys()}});const revision=await connect(h,server.url),turn=h.runtime.runTurn('worker','pending');const done=turn.catch(e=>e);const response=await entered.promise;
  if(action==='cancel')h.runtime.cancelTurn('worker','test');else{const changed=await call(h.api,'/api/llm/providers/local',{body:{revision,config:config(server.url+'/changed')}});assert.equal(changed.status,200,changed.text)}await done;response.end();assert.equal(h.runtime.registry.get('worker')!.busy,false);assert.equal(server.bodies.length,1);assert.equal(existsSync(join(h.dir,'late')),false);
 }
});

test('21b HTTP: API room and persisted team use the same route; malformed owner settings leave CLI status available',async t=>{
 const server=await endpoint(t,(_b,_q,res)=>answer(res,'from API')),h=await fixture(t,{seats:'  worker: {role: executor, vendor: api:local, model: test-model, mode: read}',before(dir){writeFileSync(join(dir,'owner-settings.json'),JSON.stringify({llmProviders:{local:config(server.url)}}))},deps:{llmKeys:new MemoryKeys()}});
 assert.equal(h.runtime.registry.get('worker')!.vendor,'api:local');await h.runtime.runTurn('worker','persisted seat');assert.equal(h.provider.calls.length,0);
 const room=await call(h.api,'/api/room',{body:{vendor:'api:local',model:'test-model',folder:true}});assert.equal(room.status,200,room.text);assert.equal(h.runtime.registry.get('room')!.vendor,'api:local');await h.runtime.runTurn('room','room question');assert.equal(server.bodies.length,2);
 writeFileSync(join(h.dir,'owner-settings.json'),'{broken');const status=await call(h.api,'/api/status');assert.equal(status.status,200,status.text);assert.equal(status.body.apiError.code,'settings_unreadable');assert.equal(status.body.network,null);assert.equal(status.body.networkError.code,'network_unreadable');assert.ok(status.body.models.claude.length);assert.equal(readFileSync(join(h.dir,'owner-settings.json'),'utf8'),'{broken');
});

test('21b HTTP: all mode runs a bounded shell tool in the project through its owner binding',{skip:process.platform==='win32'?'Windows pilot has no confined API-agent shell':false},async t=>{
 let step=0;const server=await endpoint(t,(_b,_q,res)=>answer(res,step++===0?{name:'shell',arguments:{command:'pwd; printf API_SHELL',timeout_ms:3000}}:'shell done')),h=await fixture(t,{deps:{llmKeys:new MemoryKeys()}});await connect(h,server.url,'read');
 const changed=await call(h.api,'/api/panes/worker',{body:{mode:'all',binding:h.runtime.paneBinding('worker')}});assert.equal(changed.status,200,changed.text);await h.runtime.runTurn('worker','shell');assert.match(JSON.stringify(server.bodies[1].messages),/API_SHELL/);assert.ok(JSON.stringify(server.bodies[1].messages).includes(h.dir));assert.equal(h.codex.calls.length,0);
});

test('21b HTTP: API orchestrator proposes and creates another API seat only after owner confirmation',async t=>{
 const member={kind:'worker',label:'API worker',vendor:'api:local',model:'test-model',mode:'read',intro:'Use the fixture API.'};let phase='propose',ref:any;
 const server=await endpoint(t,(_b,_q,res)=>{if(phase==='propose'){phase='waiting';answer(res,{name:'propose_seats',arguments:{seats:[member]}})}else if(phase==='create'&&JSON.stringify(_b.messages).includes('CREATE_CONFIRMED')){phase='done';answer(res,{name:'create_seats',arguments:ref})}else answer(res,'fixture done')});
 const h=await fixture(t,{seats:'  worker: {kind: orchestrator, role: lead, vendor: claude, model: w1, mode: read}',deps:{llmKeys:new MemoryKeys()}});await connect(h,server.url,'read');await h.runtime.runTurn('worker','propose');assert.equal(h.runtime.registry.panes.size,1);
 const proposals=(await call(h.api,'/api/seats/proposals')).body.proposals;assert.equal(proposals.length,1);assert.equal(proposals[0].seats[0].vendor,'api:local');ref={proposalId:proposals[0].proposalId,version:proposals[0].version};const confirmed=await call(h.api,'/api/seats/confirm',{body:{...ref,project:h.dir}});assert.equal(confirmed.status,200,confirmed.text);
 await h.runtime.idle();phase='create';await h.runtime.runTurn('worker','CREATE_CONFIRMED');await h.runtime.idle();const added=[...h.runtime.registry.panes.values()].find(p=>p.id!=='worker');assert.ok(added);assert.equal(phase,'done');assert.equal(added.vendor,'api:local');assert.equal(added.model,'test-model');assert.equal(h.provider.calls.length,0);assert.equal(h.codex.calls.length,0);
});

test('350: failed API stream creates the same durable waiting card without a transfer-success receipt', {timeout:15000}, async t=>{
 const server=await endpoint(t,(_b,_req,res)=>{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'upstream offline',type:'server_error'}}))});
 const h=await fixture(t,{deps:{llmKeys:new MemoryKeys()}});await connect(h,server.url,'chat');const pane=h.runtime.registry.get('worker')!;pane.transcript=[{role:'me',text:'saved context',ts:1}];h.runtime.project.state.saveChats(h.runtime.registry);
 await call(h.api,'/api/chat',{body:{pane:'worker',message:'fail'}});await h.runtime.idle();const status=await call(h.api,'/api/status');assert.equal(status.status,200,status.text);const waiting=status.body.panes.find((p:any)=>p.id==='worker').waiting;
 assert.equal(waiting.status,'uncertain');assert.deepEqual(waiting.actions,['retry','skip']);assert.equal(waiting.failure.code,'turn_failed');assert.match(waiting.failure.reason,/provider_error: Ошибка провайдера/);assert.equal(pane.transcript.some(m=>m.contextTransfer),false);
 const queued=await call(h.api,'/api/chat',{body:{pane:'worker',message:'next'}});assert.ok(queued.body.waiting.queuedSeqs.includes(queued.body.seq));assert.equal(server.bodies.length,1);
});
