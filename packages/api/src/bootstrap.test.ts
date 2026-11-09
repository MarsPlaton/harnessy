import test,{describe,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import type {AddressInfo} from 'node:net';
import {ProviderError} from '@harnessy/providers';
import {Journal} from '@harnessy/journal';
import {bootstrap,repositoryRoot} from './bootstrap.ts';
import {PROTO_ENTRY} from './server.ts';
import {FakeProvider,deferred} from './test-helpers.ts';
function setup(t:import('node:test').TestContext){const root=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-api-start-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const env:NodeJS.ProcessEnv={PORT:'0',CHAT_WORK_DIR:join(root,'default'),HARNESS_PROJECTS_ROOT:join(root,'projects'),HARNESSY_SITE:join(root,'absent-site'),HARNESS_LAST_PROJECT_FILE:join(root,'last'),HARNESS_PROJECTS_FILE:join(root,'registry.json'),HARNESS_PINS_FILE:join(root,'pins.json'),HARNESS_SETTINGS_FILE:join(root,'settings.json'),HARNESS_CONNECTIONS_FILE:join(root,'connections.json')};
 const claude=new FakeProvider(),codex=new FakeProvider('codex'),log:string[]=[];return {root,env,claude,codex,log,options:{env,providers:()=>({claude,codex}),log:(line:string)=>log.push(line),findClaude:async()=>null}}
}

test('5/14/15/16/71: startup falls back for missing/unreadable/deleted last project and keeps status available without auth',async t=>{
 const h=setup(t);h.claude.auth=async()=>{throw new ProviderError('no_binary','claude не найден; задай CLAUDE_BIN')};h.codex.auth=async()=>{throw new ProviderError('not_logged_in','нет входа')};h.codex.models=async()=>{throw new ProviderError('models_unavailable','нет каталога')};
 for(const last of ['missing','unreadable','deleted']){
 if(existsSync(h.env.HARNESS_LAST_PROJECT_FILE!))rmSync(h.env.HARNESS_LAST_PROJECT_FILE!,{recursive:true});
 if(last==='unreadable')mkdirSync(h.env.HARNESS_LAST_PROJECT_FILE!);if(last==='deleted')writeFileSync(h.env.HARNESS_LAST_PROJECT_FILE!,join(h.root,'deleted'));
 const app=await bootstrap(h.options);t.after(()=>app.close());assert.equal(app.runtime.project.dir,realpathSync(h.env.CHAT_WORK_DIR!));assert.ok(existsSync(h.env.HARNESS_PROJECTS_ROOT!));
 const status=await fetch(app.url+'/api/status').then(r=>r.json()) as any;assert.equal(status.auth.claude.error,'claude не найден; задай CLAUDE_BIN');assert.equal(status.models.codex.length,2);
 const root=await fetch(app.url+'/',{redirect:'manual'});assert.equal(root.status,302);assert.equal(root.headers.get('location'),PROTO_ENTRY);await root.text();
 assert.equal((await fetch(app.url+'/sketches/missing')).status,404);assert.ok(h.log.some(s=>s.includes('папки нет — '+h.env.HARNESSY_SITE)));assert.ok(h.log.some(s=>s.includes('НЕТ — выполни в Терминале: claude auth login')));await app.close()
 }
 assert.ok(h.log.some(s=>s.includes('последний проект не прочитан')));assert.ok(h.log.some(s=>s.includes('последняя папка недоступна')))
});

test('5/14: valid last project wins; HARNESS_NO_LAST ignores it and preserves registry/last bytes',async t=>{
 const h=setup(t),project=join(h.root,'last-project');mkdirSync(project);writeFileSync(h.env.HARNESS_LAST_PROJECT_FILE!,project);writeFileSync(h.env.HARNESS_PROJECTS_FILE!,'[]');
 const selected=await bootstrap(h.options);t.after(()=>selected.close());assert.equal(selected.runtime.project.dir,realpathSync(project));await selected.close();const last=readFileSync(h.env.HARNESS_LAST_PROJECT_FILE!,'utf8'),registry=readFileSync(h.env.HARNESS_PROJECTS_FILE!,'utf8');
 const skipped=await bootstrap({...h.options,env:{...h.env,HARNESS_NO_LAST:'1'}});t.after(()=>skipped.close());assert.equal(skipped.runtime.project.dir,realpathSync(h.env.CHAT_WORK_DIR!));await skipped.close();assert.equal(readFileSync(h.env.HARNESS_LAST_PROJECT_FILE!,'utf8'),last);assert.equal(readFileSync(h.env.HARNESS_PROJECTS_FILE!,'utf8'),registry)
});

test('Windows Autopilot can be enabled through the owner API without starting an unrequested model',{skip:process.platform!=='win32'},async t=>{
 const h=setup(t),app=await bootstrap(h.options);t.after(()=>app.close());await app.runtime.idle();
 const status=await fetch(app.url+'/api/status').then(r=>r.json()) as any;
 assert.equal(status.autopilot.on,false);assert.notEqual(status.autopilot.available,false);
 const before=app.runtime.settings.autopilot();
 const enabled=await fetch(app.url+'/api/autopilot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:status.project,instance:status.trace.instanceId,on:true,until:'morning',conditions:{operations:['answer_question'],maxSpendPercent:5},revision:before.revision})});
 assert.equal(enabled.status,200);assert.equal((await enabled.json() as any).autopilot.on,true);
 const decisions=await fetch(app.url+'/api/autopilot/decisions').then(r=>r.json()) as any;
 assert.deepEqual(decisions.decisions,[]);
 const stopped=await fetch(app.url+'/api/autopilot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:status.project,instance:status.trace.instanceId,on:false,revision:app.runtime.settings.autopilot().revision})});
 assert.equal(stopped.status,200);
 assert.equal(app.runtime.settings.autopilot().on,false);
 assert.equal(h.claude.calls.length,0);
 assert.equal(app.runtime.journal.read({limit:0}).some(row=>row.origin==='autopilot-owner'),false);
});

test('17/18: occupied port and partial runtime startup both close created providers without model calls',async t=>{
 const h=setup(t),occupied=createServer();await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>occupied.close(()=>resolve())));
 await assert.rejects(bootstrap({...h.options,env:{...h.env,PORT:String((occupied.address() as AddressInfo).port)}}),/EADDRINUSE/);assert.equal(h.claude.closes,1);assert.equal(h.codex.closes,1);assert.equal(h.claude.calls.length,0);
 mkdirSync(join(h.env.CHAT_WORK_DIR!,'.harness/state'),{recursive:true});writeFileSync(join(h.env.CHAT_WORK_DIR!,'.harness/state/actions.json'),'{broken');
 await assert.rejects(bootstrap(h.options),e=>!!e&&typeof e==='object'&&'code' in e&&e.code==='actions_invalid');assert.equal(h.claude.closes,2);assert.equal(h.codex.closes,2);assert.equal(h.codex.calls.length,0)
});

test('18/71: queued model starts only after HTTP listens and sees actual ephemeral appUrl',async t=>{
 const h=setup(t),dir=h.env.CHAT_WORK_DIR!;mkdirSync(join(dir,'.harness'),{recursive:true});writeFileSync(join(dir,'.harness/team.yaml'),'version: 1\nseats:\n  codex: {role: executor, vendor: codex, model: gpt-test, mode: read}\n');
 const j=new Journal(dir);j.append({sender:'owner',to:['codex'],kind:'task',text:'работа'});let httpStatus=0;
 h.codex.onRun=async(_s,_m,c)=>{c.modelStarted?.();httpStatus=(await fetch(c.appUrl+'/api/status')).status;return {text:'готово',sessionId:null}};
 const app=await bootstrap({...h.options,env:{...h.env,HARNESS_NO_LAST:'1'}});t.after(()=>app.close());await app.runtime.idle();assert.equal(httpStatus,200);assert.equal(h.codex.calls.length,1);assert.equal(h.codex.calls[0]!.ctx.appUrl,app.url);assert.ok(!app.url.endsWith(':0'))
});

// TS-20/323: 2026-10-12, load average up to 61.65, --test-concurrency=8.
// Four completed variants: 20386.50 / 11961.33 / 16499.30 / 20279.95 ms.
const launcherWorstUnderLoadMs=20_387; // observed maximum, rounded up
const launcherTimeoutMs=launcherWorstUnderLoadMs*2;
describe('323: run.sh variants run serially', {concurrency:false},()=>{
 let active=0;
 // Fail on overlapping variants even if a runner or future edit enables concurrency.
 beforeEach(()=>{active++;assert.equal(active,1,'323: launcher variants overlap')});
 afterEach(()=>{assert.equal(active,1,'323: launcher variants overlap');active--});
 for(const via of ['direct','directory link','file link','relative file link'])test('10/17/18/179/180/191: actual ui/desktop/run.sh via '+via+' launches TS, opens the prototype instead of the old window and exits on SIGTERM, duplicate port fails', {timeout:launcherTimeoutMs,skip:process.platform==='win32'},async t=>{
 const h=setup(t),trace=join(h.root,'trace'),hook=join(h.root,'providers.mjs'),site=join(h.root,'site');mkdirSync(site);mkdirSync(join(site,'proto'));writeFileSync(join(site,'proto/10-new-chat.html'),'<title>Window</title>');
 // Node's test-only module substitution prevents any SDK process or model call in the child.
 const providers=pathToFileURL(join(repositoryRoot,'packages/providers/src/index.ts')).href;
 writeFileSync(hook,`import {mock} from 'node:test';import {appendFileSync} from 'node:fs';
const original=await import(${JSON.stringify(providers)});
class Fake {constructor(vendor){this.vendor=vendor}async auth(){return {loggedIn:true,authMethod:'subscription'}}async models(){return [{id:'gpt-test',label:'test'}]}async listSessions(){return []}async sessionMessages(){return []}async runTurn(){throw Error('unexpected model call')}async reset(){}async close(){appendFileSync(${JSON.stringify(trace)},this.vendor+' closed\\n')}}
mock.module(${JSON.stringify(providers)},{namedExports:{...original,ClaudeProvider:class extends Fake{constructor(){super('claude')}},CodexProvider:class extends Fake{constructor(){super('codex')}}}});
`);
 const wrappers=join(h.root,'test-bin');mkdirSync(wrappers);const quote=(s:string)=>"'"+s.replaceAll("'","'\"'\"'")+"'";
 writeFileSync(join(wrappers,'node'),'#!/bin/sh\nexec '+quote(process.execPath)+' --experimental-test-module-mocks --import '+quote(pathToFileURL(hook).href)+' "$@"\n',{mode:0o755});
 const env={...process.env,...h.env,HARNESS_NO_LAST:'1',HARNESSY_SITE:site,NODE_OPTIONS:'',PATH:wrappers+':'+(process.env.PATH??'')};
 const launcher=join(repositoryRoot,'ui/desktop/run.sh');let script=launcher;
 if(via==='directory link'){const dir=join(h.root,'HARNESS link');symlinkSync(join(repositoryRoot,'ui/desktop'),dir,'dir');script=join(dir,'run.sh')}
 if(via==='file link'||via==='relative file link'){script=join(h.root,'run link.sh');symlinkSync(via==='file link'?launcher:relative(h.root,launcher),script)}
 const child=spawn('/bin/sh',[script],{cwd:h.root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')});
 const url=await new Promise<string>((resolve,reject)=>{const onData=()=>{const m=stdout.match(/^\[harness\] (http:\/\/127\.0\.0\.1:\d+)$/m);if(m){child.stdout.off('data',onData);resolve(m[1]!)}};child.stdout.on('data',onData);child.once('exit',()=>reject(Error('child exited: '+stderr)));onData()});
 const status=await fetch(url+'/api/status').then(r=>r.json()) as any;assert.equal(status.auth.claude.authMethod,'subscription');
 const root=await fetch(url+'/',{redirect:'manual'});assert.equal(root.status,302);assert.equal(root.headers.get('location'),PROTO_ENTRY);assert.equal(root.headers.get('cache-control'),'no-store');assert.equal(await root.text(),PROTO_ENTRY+'\n');
 const window=await fetch(url+'/');assert.equal(window.status,200);assert.equal(window.url,url+PROTO_ENTRY);assert.equal(await window.text(),'<title>Window</title>');
 const duplicate=spawn('/bin/sh',[script],{cwd:h.root,env:{...env,PORT:new URL(url).port},stdio:['ignore','pipe','pipe']});let duplicateError='';duplicate.stderr.on('data',d=>duplicateError+=d);duplicate.stdout.resume();const code=await new Promise<number|null>(resolve=>duplicate.once('exit',resolve));assert.notEqual(code,0);assert.match(duplicateError,/EADDRINUSE/);
 child.kill('SIGTERM');const exit=await ended;assert.equal(exit.code,0);assert.equal(exit.signal,null);assert.match(readFileSync(trace,'utf8'),/claude closed/);assert.match(readFileSync(trace,'utf8'),/codex closed/);assert.match(stdout,/вход Claude по подписке: да \(subscription\)/);assert.ok(stdout.includes('[harness] прототип Harnessy: '+url+PROTO_ENTRY))
});
});

test('18/71: shutdown during startup auth closes partially started server/providers and never kicks queued models',{timeout:process.platform==='win32'?15000:5000},async t=>{
 const h=setup(t),dir=h.env.CHAT_WORK_DIR!;mkdirSync(join(dir,'.harness'),{recursive:true});writeFileSync(join(dir,'.harness/team.yaml'),'version: 1\nseats:\n  codex: {role: executor, vendor: codex, model: gpt-test, mode: read}\n');new Journal(dir).append({sender:'owner',to:['codex'],kind:'task',text:'работа'});
 const controller=new AbortController(),gate=deferred<{loggedIn:boolean}>(),entered=deferred();h.claude.auth=async()=>{entered.resolve();return gate.promise};
 const starting=bootstrap({...h.options,env:{...h.env,HARNESS_NO_LAST:'1'},signal:controller.signal});void starting.catch(()=>{});await entered.promise;controller.abort();
 await assert.rejects(starting,e=>!!e&&typeof e==='object'&&'code' in e&&e.code==='cancelled');assert.equal(h.claude.closes,1);assert.equal(h.codex.closes,1);assert.equal(h.codex.calls.length,0);gate.resolve({loggedIn:true});
 assert.equal(new Journal(dir).pendingFor('codex').length,1)
});
