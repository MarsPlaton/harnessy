import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,realpathSync,statSync,mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {Runtime} from '../../runtime/src/runtime.ts';
import {completedActions} from '../../runtime/src/test-helpers.ts';
import {ProviderCatalog,cliEntry,LoginTerminal,ProviderError,type CatalogEntry,type CliSeat,type CliContext} from '@harnessy/providers';
import {fixture,call,sse,deferred,until,OWNER} from './test-helpers.ts';
import {cliFixture} from '../../providers/src/cli/test-support.ts';
import type {TestContext} from 'node:test';
async function setup(t:TestContext,platform='darwin',openedGate?:()=>Promise<void>){
 let email='alice@example.test',loggedIn=true,installed=true,models=[{id:'m1',label:'Model 1'}],versionCalls=0,authCalls=0;const calls:{seat:CliSeat;ctx:CliContext}[]=[],opened:{file:string;text:string;mode:number}[]=[];let run:((s:CliSeat,c:CliContext)=>Promise<{text:string;sessionId:string|null}>)|null=null;
 const entry:CatalogEntry={id:'fixture',title:'Fixture CLI',binary:'/fixture path/cli',login:{args:['login',"value with ' quote"]},forbiddenEnv:['SECRET_KEY'],capabilities:{headless:true,resume:true,mcp:true,limits:false},
 async version(){versionCalls++;if(!installed)throw new ProviderError('no_binary','no binary');return '1.2.3'},async auth(){authCalls++;return {loggedIn,email}},async models(){return models},async runTurn(seat,_message,ctx){calls.push({seat,ctx});if(run)return run(seat,ctx);ctx.modelStarted?.();ctx.publish({type:'done',sessionId:'probe-session',model:seat.model,durationMs:2,usage:{input:3,output:1,cacheRead:null}});return {text:'готов'.repeat(800),sessionId:'probe-session'}}};
 const catalog=new ProviderCatalog([entry]),terminal=new LoginTerminal({platform,open:async file=>{opened.push({file,text:readFileSync(file,'utf8'),mode:statSync(file).mode&511});await openedGate?.()}}),h=await fixture(t,{deps:{providerCatalog:catalog,loginTerminal:terminal}}),stream=await sse(h.api,'all');t.after(()=>stream.close());
 return {...h,entry,catalog,terminal,calls,opened,stream,get versionCalls(){return versionCalls},get authCalls(){return authCalls},get email(){return email},get loggedIn(){return loggedIn},get installed(){return installed},get models(){return models},set models(v:typeof models){models=v},get run(){return run},set email(v:string){email=v},set loggedIn(v:boolean){loggedIn=v},set installed(v:boolean){installed=v},set run(v:typeof run){run=v}};
}
const probeEvents=(h:{stream:Awaited<ReturnType<typeof sse>>})=>h.stream.raw.split('\n\n').flatMap(block=>{try{const event=JSON.parse(block.replace(/^data: /,''));return event.type==='providers'&&event.event==='probe'?[event]:[]}catch{return []}});
async function waitProbe(h:{stream:Awaited<ReturnType<typeof sse>>},predicate:(e:any)=>boolean,timeoutMs=5000){const found=probeEvents(h).find(predicate);if(found)return found;return new Promise<any>((resolve,reject)=>{const finish=(error?:Error,value?:any)=>{clearTimeout(timer);h.stream.response.off('data',check);error?reject(error):resolve(value)},check=()=>{const value=probeEvents(h).find(predicate);if(value)finish(undefined,value)},timer=setTimeout(()=>finish(Error('probe event timeout: '+JSON.stringify(probeEvents(h)))),timeoutMs);h.stream.response.on('data',check);check()})}
const result=(h:{stream:Awaited<ReturnType<typeof sse>>},status:string)=>waitProbe(h,e=>e.status===status);

test('TS-33: selected executable is validated, saved for owner and replaces the catalog entry',async t=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'harnessy-program-'))),path=join(dir,'fixture'),wrong=join(dir,'another');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(path,'#!/bin/sh\nexit 0\n',{mode:0o755});writeFileSync(wrong,'#!/bin/sh\nexit 0\n',{mode:0o755});
 const make=(binary:string):CatalogEntry=>({id:'fixture',title:'Fixture',binary,login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,resume:false,mcp:false,limits:false},withBinary:make,version:async()=>binary===path?'fixture 1.0':Promise.reject(new ProviderError('no_binary','missing')),auth:async()=>({loggedIn:false}),models:async()=>[],runTurn:async()=>({text:'',sessionId:null})});
 const catalog=new ProviderCatalog([make('fixture')]),h=await fixture(t,{deps:{providerCatalog:catalog}});
 const bad=await call(h.api,'/api/providers/fixture/binary',{body:{path:wrong}});assert.equal(bad.status,400);assert.match(bad.body.error,/Это не fixture/);assert.equal(h.runtime.settings.get().owner.programBinary_fixture,undefined);
 const forged=await call(h.api,'/api/providers/fixture/binary',{body:{path,command:'touch /tmp/forged'}});assert.equal(forged.status,400);
 const agent=await call(h.api,'/api/providers/fixture/binary',{body:{path},headers:{'X-Pane-Token':'fake'}});assert.equal(agent.status,403);
 const saved=await call(h.api,'/api/providers/fixture/binary',{body:{path}});assert.equal(saved.status,200);assert.equal(saved.body.provider.binary,path);assert.equal(h.runtime.settings.get().owner.programBinary_fixture,path);
 assert.equal((await call(h.api,'/api/providers/catalog')).body.providers.find((p:any)=>p.id==='fixture').binary,path);
});

test('TS-33: project links, foreign project binaries and disguised target names are rejected before execution',async t=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'harnessy-program-target-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let versionCalls=0;const make=(binary:string):CatalogEntry=>({id:'fixture',title:'Fixture',binary,login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,resume:false,mcp:false,limits:false},withBinary:make,
  version:async()=>{versionCalls++;return 'fixture 1.0'},auth:async()=>({loggedIn:false}),models:async()=>[],runTurn:async()=>({text:'',sessionId:null})});
 const h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([make('fixture')])}}),baseline=versionCalls,safe=join(dir,'safe'),foreign=join(dir,'foreign'),links=join(dir,'links');
 for(const folder of [safe,foreign,links,join(foreign,'.git')])mkdirSync(folder);
 const valid=join(safe,'fixture'),other=join(safe,'other-tool'),foreignFile=join(foreign,'fixture');
 for(const file of [valid,other,foreignFile])writeFileSync(file,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const inProject=join(h.dir,'fixture');try{symlinkSync(valid,inProject)}catch(error){if(process.platform==='win32'&&(error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows account cannot create file symlinks');return}throw error}
 const outside=await call(h.api,'/api/providers/fixture/binary',{body:{path:inProject}});assert.equal(outside.status,400);
 const foreignDirect=await call(h.api,'/api/providers/fixture/binary',{body:{path:foreignFile}});assert.equal(foreignDirect.status,400);
 const foreignLink=join(links,'fixture');symlinkSync(foreignFile,foreignLink);
 assert.equal((await call(h.api,'/api/providers/fixture/binary',{body:{path:foreignLink}})).status,400);
 const wrongTarget=join(dir,'fixture');symlinkSync(other,wrongTarget);
 assert.equal((await call(h.api,'/api/providers/fixture/binary',{body:{path:wrongTarget}})).status,400);
 assert.equal(versionCalls,baseline);assert.equal(h.runtime.settings.get().owner.programBinary_fixture,undefined);
 const safeLink=join(safe,'launcher','fixture');mkdirSync(join(safe,'launcher'));symlinkSync(valid,safeLink);
 const saved=await call(h.api,'/api/providers/fixture/binary',{body:{path:safeLink}});
 assert.equal(saved.status,200);assert.equal(saved.body.provider.binary,valid);assert.equal(h.runtime.settings.get().owner.programBinary_fixture,valid);
});

test('TS-33: canonical targets of installed Codex and Claude launchers remain selectable',async t=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'harnessy-program-launchers-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const previous={codex:process.env.CODEX_BIN,claude:process.env.CLAUDE_BIN};t.after(()=>{for(const [id,value] of Object.entries(previous)){const key=id==='codex'?'CODEX_BIN':'CLAUDE_BIN';if(value===undefined)delete process.env[key];else process.env[key]=value}});
 const entries:CatalogEntry[]=[],choices:[string,string,string][]=[
  ['codex',join(dir,'.local','bin','codex'),join(dir,'.local','lib','node_modules','@openai','codex','bin','codex.js')],
  ['claude',join(dir,'.local','bin','claude'),join(dir,'.local','share','claude','versions','2.1.270')],
 ];
 for(const [id,link,target] of choices){mkdirSync(dirname(target),{recursive:true});mkdirSync(dirname(link),{recursive:true});writeFileSync(target,'#!/bin/sh\nexit 0\n',{mode:0o700});try{symlinkSync(target,link)}catch(error){if(process.platform==='win32'&&(error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows account cannot create file symlinks');return}throw error}
  const make=(binary:string):CatalogEntry=>({id,title:id,binary,login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,resume:false,mcp:false,limits:false},withBinary:make,
   version:async()=>id==='codex'?'codex-cli 1.0':'Claude Code 2.1.270',auth:async()=>({loggedIn:false}),models:async()=>[],runTurn:async()=>({text:'',sessionId:null})});entries.push(make(id));
 }
 const h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog(entries)}});
 for(const [id,link,target] of choices){const response=await call(h.api,'/api/providers/'+id+'/binary',{body:{path:link}});assert.equal(response.status,200,id+': '+response.text);assert.equal(response.body.provider.binary,target);assert.equal(h.runtime.settings.get().owner['programBinary_'+id],target)}
 delete process.env.CODEX_BIN;delete process.env.CLAUDE_BIN;
 const {providerCatalog:unusedCatalog,...restartDeps}=h.deps;void unusedCatalog;
 const restarted=new Runtime({...restartDeps,catalogCacheDir:join(dir,'restart-cache'),networkStatsPath:join(dir,'restart.sqlite')},completedActions);
 for(const [id,,target] of choices)assert.equal(restarted.providerOperations.catalog.get(id).binary,target,id+' must restore the saved canonical executable');
 await restarted.close();
 // A target replaced after selection must not become an executable in another project.
 const codexTarget=choices[0]![2],foreign=join(dir,'foreign-project');mkdirSync(foreign);mkdirSync(join(foreign,'.git'));
 const other=join(foreign,'other-tool');writeFileSync(other,'#!/bin/sh\nexit 0\n',{mode:0o700});rmSync(codexTarget);symlinkSync(other,codexTarget);
 delete process.env.CODEX_BIN;delete process.env.CLAUDE_BIN;
 const unsafe=new Runtime({...restartDeps,catalogCacheDir:join(dir,'unsafe-cache'),networkStatsPath:join(dir,'unsafe.sqlite')},completedActions);
 assert.equal(unsafe.providerOperations.catalog.get('codex').binary,'codex');
 await unsafe.close();
});

test('TS-33: concurrent path changes leave the last selection in settings and catalog',async t=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'harnessy-program-race-'))),a=join(dir,'a','fixture'),b=join(dir,'b','fixture');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const path of [a,b]){mkdirSync(dirname(path));writeFileSync(path,'#!/bin/sh\nexit 0\n',{mode:0o755})}
 const started=deferred(),release=deferred();let delayed=false;
 const make=(binary:string):CatalogEntry=>({id:'fixture',title:'Fixture',binary,login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,resume:false,mcp:false,limits:false},withBinary:make,
  version:async()=>{if(binary===a&&!delayed){delayed=true;started.resolve();await release.promise}return 'fixture 1.0'},auth:async()=>({loggedIn:false}),models:async()=>[],runTurn:async()=>({text:'',sessionId:null})});
 const h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([make('fixture')])}});
 const first=call(h.api,'/api/providers/fixture/binary',{body:{path:a}});await started.promise;
 const firstJob=(h.runtime as any).programBinaryJobs.get('fixture');
 const second=call(h.api,'/api/providers/fixture/binary',{body:{path:b}});await until(()=>(h.runtime as any).programBinaryJobs.get('fixture')!==firstJob);release.resolve();
 const replies=await Promise.all([first,second]);assert.deepEqual(replies.map(r=>r.status),[200,200]);
 assert.equal(h.runtime.settings.get().owner.programBinary_fixture,b);
 assert.equal((await call(h.api,'/api/providers/catalog')).body.providers.find((p:any)=>p.id==='fixture').binary,b);
});

test('268: public catalog/check use only metadata, mask account and publish providers on change',async t=>{
 const h=await setup(t),r=await call(h.api,'/api/providers/catalog');assert.equal(r.status,200);const p=r.body.providers[0];assert.equal(p.id,'fixture');assert.equal(p.kind,'subscription');assert.equal(p.installed,true);assert.equal(p.version,'1.2.3');assert.equal(p.login.state,'ok');assert.equal(p.login.account,'a•••@example.test');assert.deepEqual(p.models,[{id:'m1',label:'Model 1'}]);assert.equal(p.capabilities.mcp,true);assert.equal(h.calls.length,0);assert.equal(h.opened.length,0);assert.equal(JSON.stringify(r.body).includes('alice'),false);
 h.loggedIn=false;const check=await call(h.api,'/api/providers/fixture/check',{body:{}});assert.equal(check.body.login.state,'none');await until(()=>h.stream.frames.some(e=>e.type==='providers'&&e.provider==='fixture'&&e.event==='check'&&e.status==='done'));assert.equal(h.calls.length,0);assert.equal(h.opened.length,0);
 h.installed=false;await call(h.api,'/api/providers/fixture/check',{body:{}});const missing=await call(h.api,'/api/providers/catalog');assert.equal(missing.body.providers[0].installed,false);assert.deepEqual(missing.body.providers[0].models,[]);assert.equal((await call(h.api,'/api/providers/fixture/check',{body:{}})).body.code,'not_installed');assert.equal((await call(h.api,'/api/providers/unknown/check',{body:{}})).body.code,'provider_unknown');
});

test('269: login-terminal ignores forged command, executes descriptor only and records the action',async t=>{
 const h=await setup(t),r=await call(h.api,'/api/providers/fixture/login-terminal',{body:{command:'touch /OWNER-FILE',args:['--evil']}});assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.match(r.body.command,/fixture path/);assert.equal(h.opened.length,1);const script=h.opened[0]!;if(process.platform!=='win32')assert.equal(script.mode,0o700);assert.doesNotMatch(script.text,/OWNER-FILE|--evil/);assert.match(script.text,/'-u' 'SECRET_KEY'/);assert.match(script.text,/'value with '\\'' quote'/);assert.equal(h.calls.length,0);assert.equal(h.runtime.journal.read({limit:0}).filter(r=>r.origin==='provider.login_terminal').length,1);const traces=await h.runtime.project.trace.read();assert.ok(traces.some(r=>r.kind==='provider.login_terminal.start'));assert.ok(traces.some(r=>r.kind==='provider.login_terminal'&&r.outcome==='ok'));assert.equal(JSON.stringify(traces).includes('alice@example.test'),false);await h.terminal.close();assert.equal(existsSync(script.file),false);
});

test('269: unknown/absent/other-platform/agent requests cannot open Terminal',async t=>{
 const h=await setup(t,'linux');assert.equal((await call(h.api,'/api/providers/fixture/login-terminal',{body:{}})).body.code,'platform_unsupported');assert.equal((await call(h.api,'/api/providers/unknown/login-terminal',{body:{}})).body.code,'provider_unknown');h.installed=false;assert.equal((await call(h.api,'/api/providers/fixture/login-terminal',{body:{}})).body.code,'not_installed');
 for(const path of ['catalog','fixture/check','fixture/probe','fixture/login-terminal']){const r=await call(h.api,'/api/providers/'+path,{...(path==='catalog'?{}:{body:{model:'m1'}}),headers:{'X-Pane-Token':'agent-token','X-Harness-Pane':'worker'}});assert.equal(r.status,403);assert.equal(r.body.code,'owner_only')}
 await assert.rejects(h.runtime.providerOperations.login('fixture',{seat:'owner',trust:'agent'}),{code:'owner_only'});assert.equal(h.opened.length,0);assert.equal(h.calls.length,0);
});

test('271: direct/repeated/concurrent probe creates one owner approval, then one isolated read-only turn and SSE result',async t=>{
 const h=await setup(t),post=()=>call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}}),[one,two]=await Promise.all([post(),post()]);assert.equal(one.body.status,'awaiting_approval');assert.equal(one.body.approvalId,two.body.approvalId);assert.deepEqual(one.body.price,{kind:'subscription',label:'расходуется подписка'});assert.equal(one.body.provider,'fixture');assert.equal(one.body.model,'m1');assert.equal(h.runtime.owner.approvals.size,1);assert.equal(h.calls.length,0);const id=one.body.approvalId;
 const fake=await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1',confirmed:true}});assert.equal(fake.body.code,'probe_invalid');assert.equal(h.calls.length,0);assert.equal((await call(h.api,'/api/approve',{body:{pane:'owner',project:h.dir,id,decision:'allow'},headers:{'X-Pane-Token':'fake'}})).status,403);assert.equal(h.calls.length,0);
 assert.equal((await call(h.api,'/api/approve',{body:{pane:'owner',project:h.dir,id,decision:'allow'}})).body.ok,true);const completed=await result(h,'done');assert.equal(completed.provider,'fixture');assert.equal(completed.model,'m1');assert.equal(completed.approvalId,id);assert.equal(typeof completed.at,'number');assert.equal(completed.turn.model,'m1');assert.equal(completed.turn.text.length,2000);assert.deepEqual(completed.turn.usage,{input:3,output:1,cacheRead:null});assert.equal(h.calls.length,1);const turn=h.calls[0]!;assert.equal(turn.seat.mode,'read');assert.equal(turn.seat.sessionId,null);assert.notEqual(turn.seat.cwd,h.dir);assert.equal(turn.ctx.projectDir,null);assert.deepEqual(turn.ctx.writableRoots,[]);assert.equal((await turn.ctx.tools.createSeats({proposalId:'p',version:1})).ok,false);await until(()=>!existsSync(turn.seat.cwd));assert.equal(h.runtime.registry.panes.size,1);assert.equal((await call(h.api,'/api/approve',{body:{pane:'owner',project:h.dir,id,decision:'allow'}})).body.ok,false);
});

for(const decline of ['deny','timeout','switch'] as const)test('271: '+decline+' before approval never invokes provider',async t=>{
 const h=await setup(t),p=await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}}),id=p.body.approvalId;
 if(decline==='deny')await call(h.api,'/api/approve',{body:{pane:'owner',project:h.dir,id,decision:'deny'}});else if(decline==='timeout')h.clock.advance(900000);else await h.runtime.closeProject();
 if(decline!=='switch')assert.equal((await result(h,'declined')).error.code,'approval_declined');assert.equal(h.calls.length,0);
});

test('271: change of account with same public mask invalidates an approved probe',async t=>{
 const h=await setup(t),p=await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}});h.email='amy@example.test';await call(h.api,'/api/approve',{body:{pane:'owner',project:h.dir,id:p.body.approvalId,decision:'allow'}});assert.equal((await result(h,'error')).error.code,'login_changed');assert.equal(h.calls.length,0);
});

test('271: cancelled/failing/no-terminal probes return typed outcomes and leave a retry door',async t=>{
 const h=await setup(t);h.run=async()=>{throw new ProviderError('transport_lost','failure containing SECRET')};const first=await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}});await call(h.api,'/api/approve',{body:{pane:'owner',project:h.dir,id:first.body.approvalId,decision:'allow'}});const failed=await result(h,'error');assert.equal(failed.error.code,'transport_lost');assert.equal(JSON.stringify(failed).includes('SECRET'),false);
 const retry=await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}});assert.notEqual(retry.body.approvalId,first.body.approvalId);h.run=async()=>({text:'unconfirmed',sessionId:null});await call(h.api,'/api/approve',{body:{pane:'owner',project:h.dir,id:retry.body.approvalId,decision:'allow'}});await waitProbe(h,e=>e.approvalId===retry.body.approvalId&&e.error?.code==='protocol');assert.equal(probeEvents(h).some(e=>e.status==='done'),false);
});

test('271: project close cancels the actual active probe before accepting another project',async t=>{
 const h=await setup(t),started=deferred();h.run=async(_s,c)=>{c.modelStarted?.();started.resolve();await new Promise<void>(r=>c.signal.addEventListener('abort',()=>r(),{once:true}));throw new ProviderError('cancelled','cancelled')};const p=await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}});await call(h.api,'/api/approve',{body:{pane:'owner',project:h.dir,id:p.body.approvalId,decision:'allow'}});await started.promise;await h.runtime.closeProject();assert.equal(h.calls.length,1);assert.equal(existsSync(h.calls[0]!.seat.cwd),false);assert.equal(probeEvents(h).some(e=>e.status==='done'),false);
});


test('272/273: a different model cannot reuse the pending card; approval requires an explicit decision and project',async t=>{
 const h=await setup(t);h.models=[{id:'m1',label:'Model 1'},{id:'m2',label:'Model 2'}];
 const [a,b]=await Promise.all(['m1','m2'].map(model=>call(h.api,'/api/providers/fixture/probe',{body:{model}})));
 assert.ok(a&&b);const accepted=a.status===200?a:b,conflict=a.status===409?a:b,id=accepted.body.approvalId;
 assert.equal(conflict.status,409);assert.equal(conflict.body.ok,false);assert.equal(conflict.body.code,'probe_conflict');assert.deepEqual(conflict.body.pending,{approvalId:id,model:accepted.body.model});assert.equal(conflict.body.approvalId,undefined);assert.equal(h.runtime.owner.approvals.size,1);assert.equal(h.calls.length,0);
 const repeat=await call(h.api,'/api/providers/fixture/probe',{body:{model:accepted.body.model}});assert.deepEqual(repeat.body,accepted.body);
 const valid={pane:'owner',id,decision:'allow',project:h.dir};
 for(const key of ['pane','decision','project'] as const){const body:Record<string,unknown>={...valid};delete body[key];const r=await call(h.api,'/api/approve',{body});assert.equal(r.status,400);assert.equal(r.body.code,'approval_invalid')}
 for(const body of [{...valid,pane:'worker'},{...valid,decision:'yes'}])assert.equal((await call(h.api,'/api/approve',{body})).body.code,'approval_invalid');
 const stale=await call(h.api,'/api/approve',{body:{...valid,project:'/another-project'}});assert.equal(stale.status,409);assert.equal(stale.body.code,'project_changed');assert.equal(h.calls.length,0);assert.equal(h.runtime.owner.approvals.size,1);
 await call(h.api,'/api/approve',{body:valid});const done=await result(h,'done');assert.equal(done.model,accepted.body.model);assert.equal(h.calls[0]!.seat.model,accepted.body.model);
 const events=probeEvents(h).filter(e=>e.approvalId===id);assert.deepEqual(events.map(e=>e.status),['awaiting_approval','running','done']);for(const e of events){assert.equal(e.type,'providers');assert.equal(e.provider,'fixture');assert.equal(e.model,accepted.body.model);assert.equal(typeof e.at,'number');assert.equal(e.probe,undefined)}
});

test('268/271: unavailable login, model, binary never creates a probe approval',async t=>{
 const h=await setup(t);assert.equal((await call(h.api,'/api/providers/fixture/probe',{body:{}})).body.code,'model_required');assert.equal((await call(h.api,'/api/providers/unknown/probe',{body:{model:'m1'}})).body.code,'provider_unknown');
 h.loggedIn=false;assert.equal((await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}})).body.code,'not_logged_in');h.loggedIn=true;
 assert.equal((await call(h.api,'/api/providers/fixture/probe',{body:{model:'unknown'}})).body.code,'model_unsupported');h.installed=false;assert.equal((await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}})).body.code,'not_installed');
 assert.equal(h.runtime.owner.approvals.size,0);assert.equal(h.calls.length,0);
});

test('271: a model removed while its approval was pending never starts',async t=>{
 const h=await setup(t),r=await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}});h.models=[];
 await call(h.api,'/api/approve',{body:{pane:'owner',id:r.body.approvalId,decision:'allow',project:h.dir}});const failed=await result(h,'error');assert.equal(failed.error.code,'model_unsupported');assert.equal(h.calls.length,0);
});


for(const scenario of ['probe','denied','ok'] as const)test('259/271: HTTP approval runs the real CLI driver: '+scenario,async t=>{
 const cli=await cliFixture(t,scenario),catalog=new ProviderCatalog([cliEntry(cli.description,{env:cli.env,cwd:cli.dir,temporaryDirectory:cli.dir})]),h=await fixture(t,{deps:{providerCatalog:catalog}}),stream=await sse(h.api);t.after(()=>stream.close());
 const requested=await call(h.api,'/api/providers/test-cli/probe',{body:{model:'test-model'}});assert.equal(requested.status,200);assert.equal(cli.capture().some(e=>e.action==='turn'),false);
 await call(h.api,'/api/approve',{body:{pane:'owner',id:requested.body.approvalId,decision:'allow',project:h.dir}});const outcome=await waitProbe({stream},e=>e.approvalId===requested.body.approvalId&&['done','error'].includes(e.status),process.platform==='win32'?20_000:5000);
 const turn=cli.capture().find(e=>e.action==='turn')!;assert.equal(turn.args[turn.args.indexOf('--sandbox')+1],'read-only');const config=cli.capture().find(e=>e.configPath)!;if(process.platform!=='win32')assert.equal(config.mode,0o600);assert.equal(existsSync(config.configPath),false);
 if(scenario==='probe'){assert.equal(outcome.status,'done');assert.equal(outcome.turn.text,'fixture answer');assert.deepEqual(outcome.turn.usage,{input:10,output:2,cacheRead:3})}else{assert.equal(outcome.status,'error');assert.equal(outcome.error.code,scenario==='denied'?'permission_denied':'transport_lost')}
 assert.equal(h.runtime.journal.read({limit:0}).some(r=>r.text==='fixture'),false,'the probe bridge cannot write to the project');assert.equal(h.provider.calls.length,0);
});


test('269: closing a project during terminal launch records the actual launch, not a false failure',async t=>{
 const gate=deferred(),seen=deferred(),h=await setup(t,'darwin',async()=>{seen.resolve();await gate.promise}),old=h.runtime.project;
 const opening=call(h.api,'/api/providers/fixture/login-terminal',{body:{}});await seen.promise;await h.runtime.closeProject();gate.resolve();const response=await opening;assert.equal(response.body.ok,true);assert.equal(h.opened.length,1);
 const outcomes=(await old.trace.read()).filter(e=>e.kind==='provider.login_terminal'&&e.outcome);assert.equal(outcomes.filter(e=>e.outcome==='ok').length,1);assert.equal(outcomes.some(e=>e.outcome==='failed'),false);
});

for(const kind of ['throw','event'])test('350: probe '+kind+' preserves safe cause and duration in SSE and trace', {timeout:15000}, async t=>{
 const h=await setup(t);h.run=async(s,ctx)=>{ctx.modelStarted?.();h.clock.advance(10000);const message='upstream unavailable; token=HIDDEN-CREDENTIAL <script>';
 if(kind==='throw')throw new ProviderError('transport_lost',message);ctx.publish({type:'error',text:message});return {text:'',sessionId:null}};
 const probe=await call(h.api,'/api/providers/fixture/probe',{body:{model:'m1'}});await call(h.api,'/api/approve',{body:{pane:'owner',id:probe.body.approvalId,decision:'allow',project:h.dir}});const failed=await result(h,'error');
 assert.equal(failed.error.code,kind==='throw'?'transport_lost':'turn_failed');assert.match(failed.error.reason,/upstream unavailable/);assert.equal(failed.error.durationMs,10000);assert.doesNotMatch(JSON.stringify(failed),/HIDDEN-CREDENTIAL/);
 const rows=await h.runtime.project.trace.read(),trace=rows.find(r=>r.kind==='turn.failed')!;assert.equal(trace.durationMs,10000);assert.match(trace.reason.text,/upstream unavailable/);assert.equal((trace.data as any).code,failed.error.code);assert.doesNotMatch(JSON.stringify(rows),/HIDDEN-CREDENTIAL/);
});
