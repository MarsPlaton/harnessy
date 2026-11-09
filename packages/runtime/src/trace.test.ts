import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,existsSync,readFileSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TraceStore,traceData} from './trace.ts';
function store(t:any,options=()=>({enabled:true,maxBytes:32768})){const dir=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-trace-')));mkdirSync(join(dir,'.harness/state'),{recursive:true});const s=new TraceStore(dir,options,()=>1800000000000,id=>['worker','lead'].includes(id));t.after(async()=>{await s.close();rmSync(dir,{recursive:true,force:true})});return s}
test('233: buffered spans preserve their chain and sequence after restart without blocking the caller',async t=>{
 const s=store(t),click=s.record('ui.action',{actor:'owner',data:{action:'Назначить оркестратора'}});s.run(click,()=>{s.record('http.request');s.record('tool.result',{actor:'model:lead',outcome:'rejected',reason:{code:'approval_policy',text:'Вызов отклонён политикой'}})});assert.equal(existsSync(s.path),false);await s.flush();const rows=await s.read({traceId:click.traceId});assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.seq),[1,2,3]);assert.equal(rows[2]!.parentSpanId,click.spanId);assert.equal(rows[2]!.reason.code,'approval_policy');assert.equal((await s.read({outcome:'rejected'})).length,1);const next=new TraceStore(s.project);t.after(()=>next.close());next.record('ui.action');await next.flush();assert.equal((await next.read()).at(-1)!.seq,4);
});
test('238: tool text, secret fields, nested credentials and foreign paths never enter trace bytes',async t=>{
 const s=store(t),secret='fixture-secret-value-not-real';s.record('tool.call',{data:{name:'write_file',token:secret,args:{api_key:secret,text:'opaque private credentials',path:'/outside/project/private.key'},result:'raw provider output '+secret},reason:{code:'provider_error',text:'Failed at /outside/project/file'}});await s.flush();const bytes=readFileSync(s.path,'utf8');assert.ok(!bytes.includes(secret));assert.ok(!bytes.includes('opaque private credentials'));assert.ok(!bytes.includes('/outside'));assert.ok(!bytes.includes('raw provider output'));assert.equal((await s.read())[0]!.truncated,true);assert.equal((traceData({name:'x'.repeat(9000)},s.project).data as any).name.length<=256,true);
});
test('233/238: rotation bounds retained bytes and concurrent engines do not repeat sequence numbers',async t=>{
 const s=store(t),other=new TraceStore(s.project,()=>({enabled:true,maxBytes:32768}));t.after(()=>other.close());for(let n=0;n<5;n++){for(let i=0;i<20;i++){s.record('ui.action',{data:{action:'a'.repeat(100),index:i}});other.record('ui.action',{data:{action:'b'.repeat(100),index:i}})}await Promise.all([s.flush(),other.flush()])}const rows=await s.read();assert.ok(existsSync(s.path+'.1'));assert.ok(statSync(s.path).size+statSync(s.path+'.1').size<=32768);assert.equal(new Set(rows.map(r=>r.seq)).size,rows.length);assert.equal(rows.at(-1)!.seq,200);
});
test('238: disabled tracing writes nothing; an unsafe trace path cannot overwrite another file or interrupt work',async t=>{
 const off=store(t,()=>({enabled:false,maxBytes:32768}));off.record('turn.start');await off.flush();assert.equal(existsSync(off.path),false);const s=store(t),outside=join(s.project,'sentinel');writeFileSync(outside,'unchanged');try{symlinkSync(outside,s.path)}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows file symlink requires privilege');return}throw e}assert.doesNotThrow(()=>s.record('turn.start'));await s.flush();assert.equal(readFileSync(outside,'utf8'),'unchanged');assert.ok(s.status.error);assert.equal(s.status.dropped,1);
});

test('238: reducing the size rotates the retained tail and keeps sequence numbers increasing',async t=>{
 let cap=128*1024;const s=store(t,()=>({enabled:true,maxBytes:cap}));for(let i=0;i<70;i++)s.record('ui.action',{data:{action:'fixture '+i,name:'x'.repeat(200)}});await s.flush();const before=(await s.read()).at(-1)!.seq;cap=32768;s.record('ui.action');await s.flush();assert.equal((await s.read()).at(-1)!.seq,before+1);assert.ok(statSync(s.path).size+statSync(s.path+'.1').size<=cap);
});

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('233: two OS processes append and rotate one project without duplicate sequence numbers',async t=>{
 const s=store(t),code="const {TraceStore}=await import(process.argv[2]);const s=new TraceStore(process.argv[1],()=>({enabled:true,maxBytes:32768}));for(let round=0;round<3;round++){for(let i=0;i<12;i++)s.record('ui.action',{data:{action:'fixture'}});await s.flush()}if(s.status.dropped)throw Error('dropped '+s.status.dropped);await s.close();",run=()=>promisify(execFile)(process.execPath,['--input-type=module','-e',code,s.project,new URL('./trace.ts',import.meta.url).href]);await Promise.all([run(),run()]);const rows=await s.read();assert.equal(new Set(rows.map(r=>r.seq)).size,rows.length);assert.equal(rows.at(-1)!.seq,72);
});
test('238: a secret in a reason is masked while a canonical API route remains useful',async t=>{const s=store(t);s.record('http.response',{data:{route:'/api/panes/:id/attempt'},reason:{code:'provider_error',text:'Bearer short-token; password=tiny; sk-short; {"access_token":"quoted"}'}});await s.flush();const row=(await s.read())[0]!;assert.equal((row.data as any).route,'/api/panes/:id/attempt');for(const value of ['short-token','tiny','sk-short','quoted'])assert.ok(!row.reason.text.includes(value));});

test('238: nested numeric payloads are bounded and throwing getters cannot interrupt the model',async t=>{const s=store(t);let payload:unknown=12;for(let i=0;i<4;i++)payload=Array(16).fill(payload);const r=traceData(payload,s.project);assert.ok(Buffer.byteLength(JSON.stringify(r.data))<=4096);assert.equal(r.truncated,true);assert.doesNotThrow(()=>s.record('tool.call',{data:{get broken(){throw Error('private getter')}}}));await s.flush();assert.equal((await s.read())[0]!.truncated,true);});

test('233/234: project-open restoration preserves journal parents; turn lookup never waits for storage',async t=>{const s=store(t),span=s.record('queue.posted',{refs:{journalSeq:7}});await s.flush();const next=new TraceStore(s.project);t.after(()=>next.close());await next.restore();assert.equal(next.parentForJournal([7])?.traceId,span.traceId);next.read=()=>{throw Error('disk read must not precede a turn')};assert.equal(next.parentForJournal([7])?.spanId,span.spanId);assert.equal(next.parentForJournal([999]),undefined);});

test('238 round 2: the entire envelope and inherited context are scrubbed before persistence',async t=>{
 const s=store(t),marker='sk_test_SYNTHETIC_FIXTURE_ONLY_1234567890',short='sk_test_fixture',parent={store:s,traceId:marker,spanId:marker,parentSpanId:marker,chat:marker,pane:short,turnInstanceId:marker};
 const ctx=s.record('ui.'+short,{actor:'model:'+short,outcome:marker,reason:{code:marker,text:marker},refs:{attemptId:marker,proposalId:marker,journalSeq:marker},durationMs:1e100} as any,parent);
 s.record('ui.action',{traceId:marker,spanId:marker,parentSpanId:marker,chat:marker,pane:short,turnInstanceId:marker});
 const id=randomUUID(),good=s.record('turn.start',{actor:'model:worker',chat:'c123abc',pane:'worker',turnInstanceId:id,refs:{attemptId:id}});s.end(good,'turn.end');await s.flush();
 const rows=await s.read(),bytes=readFileSync(s.path,'utf8');for(const text of [bytes,JSON.stringify(rows),JSON.stringify({...ctx,store:undefined})]){assert.ok(!text.includes(marker));assert.ok(!text.includes(short))}
 assert.equal(rows[0]!.chat,null);assert.equal(rows[0]!.pane,null);assert.equal(rows[0]!.turnInstanceId,null);assert.equal(rows[0]!.outcome,'failed');assert.equal(rows[0]!.durationMs,null);assert.deepEqual(rows[0]!.refs,{});assert.equal(rows[0]!.truncated,true);
 assert.equal(rows[2]!.chat,'c123abc');assert.equal(rows[2]!.pane,'worker');assert.equal(rows[2]!.turnInstanceId,id);assert.equal(rows[3]!.spanId,good.spanId);assert.equal(s.forTurn(id)?.spanId,good.spanId);
});

test('238 round 2: oversize or invalid metadata is removed and cannot enter the returned context',async t=>{
 const s=store(t),huge='x'.repeat(1000),ctx=s.record('ui.'+huge,{actor:'model:'+huge,chat:huge,pane:'worker\nprivate',turnInstanceId:huge});await s.flush();const row=(await s.read())[0]!;assert.equal(row.kind,'error.internal');assert.equal(row.actor,'engine');assert.equal(row.chat,null);assert.equal(row.pane,null);assert.equal(row.turnInstanceId,null);assert.equal(ctx.chat,null);assert.equal(row.truncated,true);assert.ok(!readFileSync(s.path,'utf8').includes(huge));
});

test('365: only an exact registered top-level route bypasses diagnostic redaction',async t=>{
 const s=store(t),path='/api/llm/providers/discover',paths=[path];s.setRouteTemplates(paths);paths.push('/api/sk-forged');
 s.record('http.request',{data:{route:path,action:path,status:{route:path}},reason:{code:'provider_error',text:path}});
 s.record('http.request',{data:{route:'/api/sk-forged'}});await s.flush();const rows=await s.read(),data=rows[0]!.data as any;
 assert.equal(data.route,path);assert.notEqual(data.action,path);assert.notEqual(data.status.route,path);assert.notEqual(rows[0]!.reason.text,path);assert.doesNotMatch(JSON.stringify(rows),/sk-forged/);
 assert.notEqual((traceData({route:path},s.project).data as any).route,path,'without the engine table text remains untrusted');
});

test('365: model/route ID schema preserves namespaces and long IDs but not secret markers or malformed values',async t=>{
 const s=store(t),model='namespace/'+ 'a'.repeat(190),route='local_openai_compatible_for_models';
 s.record('llm.request',{data:{model,vendor:route,route,reason:model,status:{model}}});
 for(const marker of ['prefix_sk-fixture','github_pat_fixture','AIzaFixture','credential=Tiny!','Bearer tiny'])s.record('llm.response',{data:{model:marker,vendor:marker,route:marker}});
 s.record('llm.request',{data:{model:'/private/fixture.txt',vendor:'/private/fixture.txt',route:'/private/fixture.txt'}});
 s.record('llm.request',{data:{model:null}});s.record('llm.request');
 const rows=await s.read(),data=rows[0]!.data as any;assert.equal(data.model,model);assert.equal(data.vendor,route);assert.equal(data.route,route);assert.notEqual(data.reason,model);assert.notEqual(data.status.model,model);
 for(const row of rows.slice(1,7)){const text=JSON.stringify(row.data);assert.doesNotMatch(text,/sk-fixture|github_pat_fixture|AIzaFixture|Tiny!|tiny|private/)}
 assert.equal((rows[7]!.data as any).model,null);assert.deepEqual(rows[8]!.data,{});
 const restarted=new TraceStore(s.project);t.after(()=>restarted.close());assert.equal(((await restarted.read())[0]!.data as any).model,model);
});

test('365: public usage counter names survive writes and reads while credential fields and forged counter values are scrubbed',async t=>{
 const s=store(t),usage={input:10,output:4,cacheRead:2,cacheWrite:0,totalTokens:16};
 s.record('llm.response',{data:{...usage,usage}});for(const bad of ['credential=Tiny!',{password:'Tiny!'},['Tiny!'],NaN,Infinity,-1])s.record('llm.response',{data:{totalTokens:bad,access_token:'Tiny!'}});
 const rows=await s.read(),data=rows[0]!.data as any;assert.deepEqual(data,{...usage,usage});assert.equal(Object.hasOwn(data,'[секрет]'),false);
 assert.doesNotMatch(readFileSync(s.path,'utf8'),/Tiny!|access_token/);for(const row of rows.slice(1))assert.equal(Object.hasOwn(row.data as object,'totalTokens'),false);
 const restored=new TraceStore(s.project);t.after(()=>restored.close());assert.deepEqual((await restored.read())[0]!.data,{...usage,usage});
});

test('22f: typed public network results survive trace; malformed IP/country/exit/identity values cannot smuggle credentials',async t=>{
 const s=store(t),id='11111111-1111-4111-8111-111111111111';s.record('network.provider_check',{data:{checkId:id,exit:'vps-1',ip:'198.51.100.2',country:'Germany',state:'done',response:true,latencyMs:12}});s.record('network.provider_check',{data:{checkId:'credential=PRIVATE',exit:'credential=PRIVATE',ip:'198.51.100.2 credential=PRIVATE',country:'credential=PRIVATE',state:'token=PRIVATE'}});await s.flush();const rows=await s.read(),raw=JSON.stringify(rows);assert.match(raw,/198.51.100.2/);assert.match(raw,/Germany/);assert.match(raw,/vps-1/);assert.match(raw,new RegExp(id));assert.doesNotMatch(raw,/PRIVATE/);
});
