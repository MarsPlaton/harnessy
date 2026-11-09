import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,existsSync,mkdirSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {assertPrivateDirectory} from '@harnessy/team';
import {CliProvider} from './cli/provider.ts';
import {cliFixture} from './cli/test-support.ts';
import {GEMINI} from './gemini.ts';
import {cliEntry,ProviderCatalog} from './catalog.ts';
import {geminiStream} from './gemini-stream.ts';

test('47.11: Gemini account tier refusal retains the provider reason and never asks for login',()=>{
 const result={stderr:'Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.',stdout:'',code:55,signal:null};
 const denied=GEMINI.failure!(result)!;assert.equal(denied.code,'permission_denied');assert.match(denied.text,/Подписка\/тариф/);assert.match(denied.text,/This client is no longer supported/);assert.doesNotMatch(denied.text,/вход/i);
 assert.equal(GEMINI.failure!({...result,code:41,stderr:'Login required'})?.code,'not_logged_in');
 for(const stderr of ['IneligibleTierError: unknown','network unavailable',''])assert.equal(GEMINI.failure!({...result,stderr}),undefined);
});

test('303/306/47.11: Gemini 0.63 rejects user-owned system settings; private user settings preserve login and resume',async t=>{
 const h=await cliFixture(t,'probe'),binary=join(h.dir,'gemini-fixture.cjs'),log=join(h.dir,'gemini-log.json'),owner=join(h.dir,'owner'),original=join(owner,'.gemini'),account=join(original,'google_accounts.json');mkdirSync(original,{recursive:true});writeFileSync(account,JSON.stringify({active:'test@example.test'}));writeFileSync(join(original,'oauth_creds.json'),'fixture-login',{mode:0o600});writeFileSync(join(original,'settings.json'),'owner-settings-must-not-change');
 writeFileSync(binary,'#!'+process.execPath+'\n'+String.raw`
 const fs=require('node:fs'),args=process.argv.slice(2);if(args.includes('--version')){console.log('0.63.0');process.exit(0)}
 if(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH){console.error('Security Warning: Skipping system settings file: Parent directory is insecure: not owned by root');process.exit(1)}
 const dir=require('node:path').join(process.env.GEMINI_CLI_HOME,'.gemini'),path=require('node:path').join(dir,'settings.json'),config=JSON.parse(fs.readFileSync(path,'utf8'));
 const resume=fs.existsSync(require('node:path').join(dir,'session-marker'));fs.writeFileSync(require('node:path').join(dir,'session-marker'),'session');
 if(!resume){const path=require('node:path');fs.mkdirSync(path.join(dir,'tmp','fixture','chats'),{recursive:true});fs.writeFileSync(path.join(dir,'projects.json'),JSON.stringify({projects:{[process.cwd()]:'fixture'}}));fs.writeFileSync(path.join(dir,'tmp','fixture','chats','session-2026-ab123456.jsonl'),JSON.stringify({sessionId:'ab123456-1234-1234-1234-123456789abc'})+'\n');}
 if(fs.readFileSync(require('node:path').join(dir,'oauth_creds.json'),'utf8')!=='fixture-login')process.exit(2);
 fs.writeFileSync(require('node:path').join(dir,'oauth_creds.json'),'refreshed-private');
 fs.writeFileSync(process.env.TEST_LOG,JSON.stringify({args,path,config,resume,mode:fs.statSync(path).mode&511,home:process.env.HOME,key:!!process.env.GEMINI_API_KEY}));
 for(const e of [{type:'init',session_id:'ab123456-1234-1234-1234-123456789abc'},{type:'message',role:'user',content:'echo'},{type:'tool_use',tool_id:'tool-1',tool_name:'read_file',parameters:{path:'test'}},{type:'tool_result',tool_id:'tool-1',status:'success',output:'text'},{type:'message',role:'assistant',content:'готов',delta:true},{type:'result',status:'success',stats:{input:12,cached:3,output_tokens:2}}])console.log(JSON.stringify(e));
 `,{mode:0o700});
 const d={...GEMINI,binary},env={...process.env,GEMINI_CLI_HOME:owner,TEST_LOG:log,GEMINI_API_KEY:'should-not-leak'},p=new CliProvider(d,{env,cwd:h.dir,temporaryDirectory:h.dir,stateRoot:h.dir});t.after(()=>p.close());const seat={...h.seat,vendor:'gemini',model:'default',mode:'all' as const};
 const result=await p.runTurn(seat,'hello',h.ctx);assert.equal(result.text,'готов');const r=JSON.parse(readFileSync(log,'utf8'));assert.ok(!r.args.includes('-m')&&!r.args.includes('--model'));assert.ok(r.args.includes('yolo'));assert.deepEqual(r.config.mcp.allowed,['harnessy']);assert.deepEqual(Object.keys(r.config.mcpServers),['harnessy']);assert.ok(r.config.mcpServers.harnessy.env.PANE_TOKEN);assert.equal(r.config.hooksConfig.enabled,false);if(process.platform==='win32')assertPrivateDirectory(dirname(r.path));else assert.equal(r.mode,0o600);assert.equal(r.key,false);assert.equal(r.home,process.env.HOME);assert.equal(existsSync(r.path),false);assert.deepEqual(h.traces.map(v=>v.phase),['call','result']);assert.deepEqual((h.events.at(-1) as any).usage,{input:12,output:2,cacheRead:3});
 const row=(await new ProviderCatalog([cliEntry(d,{env,cwd:h.dir})]).read('gemini')).row;assert.equal(row.login.state,'unknown');assert.deepEqual(row.models,[{id:'default',label:'по умолчанию программы'}]);assert.equal(row.capabilities.turn?.all.ok,true);assert.deepEqual(row.capabilities.probe,{ok:true,note:'полный доступ'});assert.equal(row.capabilities.turn?.read.ok,false);assert.equal(row.capabilities.turn?.edit.ok,false);
 assert.equal(readFileSync(join(original,'oauth_creds.json'),'utf8'),'fixture-login');assert.equal(readFileSync(join(original,'settings.json'),'utf8'),'owner-settings-must-not-change');assert.equal(r.resume,false);
 await p.runTurn({...seat,sessionId:result.sessionId},'again',h.ctx);assert.equal(JSON.parse(readFileSync(log,'utf8')).resume,true);
 for(const mode of ['read','edit'] as const)await assert.rejects(p.runTurn({...seat,mode},'no',h.ctx),{code:'mode_unsupported'});
});
test('47.11: only the exact legacy Gemini session is imported; owner files stay unchanged',async t=>{
 const h=await cliFixture(t,'probe'),source=join(h.dir,'old'),target=join(h.dir,'new'),id='ab123456-1234-1234-1234-123456789abc';
 const chats=join(source,'tmp','fixture','chats');mkdirSync(chats,{recursive:true});mkdirSync(target);
 writeFileSync(join(source,'projects.json'),JSON.stringify({projects:{[realpathSync(h.dir)]:'fixture'}}));
 const filename='session-2026-ab123456.jsonl',body=JSON.stringify({sessionId:id,projectHash:'project'})+'\n'+JSON.stringify({id:'message',type:'user',content:'saved text'})+'\n';
 writeFileSync(join(chats,filename),body);writeFileSync(join(chats,'session-2026-ffffffff.jsonl'),JSON.stringify({sessionId:'ffffffff-0000-0000-0000-000000000000'})+'\n');writeFileSync(join(source,'settings.json'),'owner-settings');
 const {importGeminiSession}=await import('./gemini-session.ts');await importGeminiSession(source,target,h.dir,id,()=>{});
 assert.equal(readFileSync(join(target,'tmp','fixture','chats',filename),'utf8'),body);assert.equal(readFileSync(join(chats,filename),'utf8'),body);assert.equal(existsSync(join(target,'settings.json')),false);assert.equal(existsSync(join(target,'tmp','fixture','chats','session-2026-ffffffff.jsonl')),false);
 await importGeminiSession(source,target,h.dir,id,()=>{});
 await assert.rejects(importGeminiSession(source,target,h.dir,'ffffffff-1234-1234-1234-123456789abc',()=>{}),{code:'session_missing'});
});
test('47.11: workspace settings cannot re-enable hooks over the private user scope',async t=>{
 const h=await cliFixture(t,'probe');mkdirSync(join(h.dir,'.gemini'));writeFileSync(join(h.dir,'.gemini','settings.json'),JSON.stringify({hooksConfig:{enabled:true}}));
 const {prepareGeminiSettings}=await import('./gemini-settings.ts');
 await assert.rejects(prepareGeminiSettings('unused',{seat:{...h.seat,vendor:'gemini',mode:'all'},message:'no',roleNote:'',peers:[],writableRoots:[]},process.env,h.dir),{code:'capability_unsupported'});
});
test('303: Gemini decoder rejects foreign/malformed terminal data and has no fake completion',()=>{
 const d=geminiStream();assert.throws(()=>d({type:'message',role:'assistant',content:'before init'}),{code:'protocol'});d({type:'init',session_id:'s'});assert.throws(()=>d({type:'tool_result',status:'invented',tool_id:'t'}),{code:'protocol'});assert.equal(d({type:'result',status:'error'})[0]?.type,'error');assert.throws(()=>d({type:'result',status:'success'}),{code:'protocol'});
});
