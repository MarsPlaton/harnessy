import type {TestContext} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OPENCODE} from './opencode.ts';
import {cliEntry} from './catalog.ts';

// Isolated maximum 1199.32 ms; four concurrent runs at load 61.87: 1504.23 ms.
// Eightfold reserve for full-workspace contention, with bounded HTTP cleanup.
export const OPENCODE_TEST_TIMEOUT_MS=1505*8;
// Sanitized 1.18.4 auth-list shape: provider names/types, never credentials.
export const opencodeAuthText='┌  Credentials /fixture/auth.json\n│\n●  Fixture OAuth oauth\n│\n●  Fixture API api\n│\n└  2 credentials\n\n┌  Environment\n│\n●  Fixture Provider FIXTURE_API_KEY\n│\n└  1 environment variable\n';
export const opencodeNoAuthText='┌  Credentials /fixture/auth.json\n│\n└  0 credentials\n';
export const opencodeModelText='opencode/free-model\nfixture/~account/models/model:variant\n';
export function opencodeFixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'harnessy-opencode-')),binary=join(dir,'opencode fixture.cjs'),log=join(dir,'calls.jsonl'),state=join(dir,'metadata.json');writeFileSync(log,'');
 const update=(patch:Record<string,unknown>)=>writeFileSync(state,JSON.stringify({version:'1.18.4',auth:opencodeAuthText,models:opencodeModelText,...patch}));update({});
 writeFileSync(binary,'#!'+process.execPath+'\n'+String.raw`
 const fs=require('node:fs'),args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(process.env.OPENCODE_FIXTURE_STATE,'utf8'));
 fs.appendFileSync(process.env.OPENCODE_FIXTURE_LOG,JSON.stringify({args,cwd:process.cwd(),files:fs.readdirSync(process.cwd()),home:process.env.HOME,bridgeKeys:['PANE_TOKEN','APP_URL','PANE_ID','SEATS'].filter(k=>process.env[k])})+'\n');
 if(JSON.stringify(args)==='["--version"]'){console.log(state.version);process.exit(0)}
 if(JSON.stringify(args)==='["auth","list","--pure"]'){console.log(state.auth);process.exit(state.authCode||0)}
 if(JSON.stringify(args)==='["models","--pure"]'){if(state.modelsCode){console.error('fixture-secret');process.exit(state.modelsCode)}console.log(state.models);process.exit(0)}
 if(args[0]==='run'&&args.includes('--auto')){const sessionID=args.includes('--session')?args[args.indexOf('--session')+1]:'opencode-session';const out=(type,part)=>console.log(JSON.stringify({type,sessionID,part:{...part,sessionID}}));if(state.turnError){console.log(JSON.stringify({type:'error',sessionID,error:{message:'fixture-secret'}}));process.exit(0)}out('step_start',{type:'step-start'});out('text',{type:'text',text:'готов'});if(!state.truncated)out('step_finish',{type:'step-finish',reason:'stop'});process.exit(0)}
console.error('unexpected command');process.exit(99);
 `,{mode:0o700});
 const env={...process.env,OPENCODE_FIXTURE_LOG:log,OPENCODE_FIXTURE_STATE:state,PANE_TOKEN:'fixture-token',APP_URL:'fixture-url',PANE_ID:'fixture-pane',SEATS:'fixture-seats'},description={...OPENCODE,binary},deps={env,cwd:dir},entry=cliEntry(description,deps);
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return {dir,description,deps,entry,update,capture:():any[]=>readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}
