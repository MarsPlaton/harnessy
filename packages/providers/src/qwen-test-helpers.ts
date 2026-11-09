import type {TestContext} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {QWEN} from './qwen.ts';
import {cliEntry} from './catalog.ts';

// New HTTP/process tests: isolated maximum 2366.05 ms; four concurrent runs
// maximum 853.19 ms (load 6.99). Eightfold reserve for the full workspace run.
export const QWEN_TEST_TIMEOUT_MS=2367*8;
export const QWEN_SESSION='123e4567-e89b-12d3-a456-426614174000';
export function qwenFixture(t:TestContext,scenario='ok'){
 const dir=mkdtempSync(join(tmpdir(),'harnessy-qwen-')),binary=join(dir,'qwen.cjs'),captureFile=join(dir,'calls.jsonl');writeFileSync(captureFile,'');
 writeFileSync(binary,'#!'+process.execPath+'\n'+String.raw`
 const fs=require('node:fs'),{spawn}=require('node:child_process');
 const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1],scenario=process.env.QWEN_FIXTURE_SCENARIO;
 const log=x=>fs.appendFileSync(process.env.QWEN_FIXTURE_CAPTURE,JSON.stringify(x)+'\n');
 log({args,home:process.env.HOME,keys:['OPENAI_API_KEY','OPENAI_BASE_URL','QWEN_API_KEY','DASHSCOPE_API_KEY','PANE_TOKEN'].filter(k=>process.env[k])});
 if(args.includes('--version')){console.log(scenario==='bad-version'?'invalid-version':'0.24.0');process.exit(0)}
 const path=get('--mcp-config'),config=JSON.parse(fs.readFileSync(path,'utf8')),server=config.mcpServers.harnessy;
 log({path,mode:fs.statSync(path).mode&511,servers:Object.keys(config.mcpServers),tokenPresent:!!server.env.PANE_TOKEN});
 const sid=scenario==='mismatch'?'other-session':args.includes('--resume')?get('--resume'):'123e4567-e89b-12d3-a456-426614174000';
 const out=x=>console.log(JSON.stringify({session_id:sid,...x}));
 out({type:'system',subtype:'init'});
 if(scenario==='hang')setInterval(()=>{},1000);
 else if(scenario==='bad-json')console.log('not json');
 else if(scenario==='denied'){out({type:'result',is_error:true,subtype:'error_during_execution',error:{message:'permission denied'}})}
 else if(scenario==='logged-out'){out({type:'result',is_error:true,subtype:'error_during_execution',error:{message:'Please authenticate with Qwen OAuth'}})}
 else if(scenario==='truncated'){out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'partial'}]}})}
 else if(scenario==='crash')process.exit(7);
 else (async()=>{
  if(scenario==='bridge'){
   out({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'call-1',name:'mcp__harnessy__send',input:{to:'reviewer',kind:'status',text:'fixture'}}]}});
   const result=await new Promise((resolve,reject)=>{const p=spawn(server.command,server.args,{env:{...process.env,...server.env},stdio:['pipe','pipe','pipe']});let text='';p.stdout.on('data',b=>text+=b);p.on('error',reject);p.on('close',code=>code?reject(Error('bridge failed')):resolve(JSON.parse(text.trim()).result));p.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send',arguments:{to:'reviewer',kind:'status',text:'fixture'}}})+'\n')});
   if(result.isError)throw Error('MCP error');
   out({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call-1',content:result,is_error:false}]}});
  }
  out({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'готов'}]}});
  out({type:'result',is_error:false,subtype:'success',result:'готов',usage:{input_tokens:12,cache_read_input_tokens:3,output_tokens:2}});
 })().catch(()=>process.exitCode=8);
 `,{mode:0o700});
 const env={...process.env,QWEN_FIXTURE_SCENARIO:scenario,QWEN_FIXTURE_CAPTURE:captureFile,OPENAI_API_KEY:'fixture-secret',OPENAI_BASE_URL:'https://fixture.invalid',QWEN_API_KEY:'fixture-secret',DASHSCOPE_API_KEY:'fixture-secret',PANE_TOKEN:'fixture-token'},description={...QWEN,binary},deps={env,cwd:dir,temporaryDirectory:dir},entry=cliEntry(description,deps);
 t.after(async()=>{await entry.close?.();rmSync(dir,{recursive:true,force:true})});
 return {dir,binary,description,deps,entry,capture:():any[]=>readFileSync(captureFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))};
}
