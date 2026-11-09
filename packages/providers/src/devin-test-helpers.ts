import type {TestContext} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEVIN} from './devin.ts';
import {cliEntry} from './catalog.ts';

// Isolated maximum 536.96 ms; four concurrent runs at load 10.32: 722.01 ms.
// Eightfold reserve for full-workspace contention, with bounded HTTP cleanup.
export const DEVIN_TEST_TIMEOUT_MS=723*8;
// Sanitized shape captured from 3000.11.3; no real account or credential data.
export const devinAuthText=(email='fixture@example.test')=>`Logged in (via Devin).\n\nCredentials:\n  File:              /fixture/credentials.toml\n  API server:        https://server.codeium.com\n\nUser:\n  Name:              Fixture\n  Email:             ${email}\n  User ID:           fixture-user\n\nAccount:\n  Tier:              Devin Pro\n  Plan:              Pro\n  Team ID:           fixture-team\n\nTeam settings:\n  Allowed models:    2 explicitly allowed\n  MCP servers:       allowed (no restrictions)\n`;
export const devinModelPayload={families:[{family_label:'Adaptive',family_uid:'Adaptive',slug:'adaptive',aliases:[],variants:[{model_uid:'adaptive',label:'Adaptive',description:'Automatically balances quality and cost',cost_summary:'fixture cost',is_new:false,is_beta:false}]},{family_label:'Fixture',variants:[{model_uid:'fixture-model',label:'Fixture Model',cost_tier:1,is_beta:false,is_new:true,max_context_tokens:128000,max_output_tokens:32000}]}]};
export function devinFixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'harnessy-devin-')),binary=join(dir,'devin fixture.cjs'),log=join(dir,'calls.jsonl'),state=join(dir,'metadata.json');writeFileSync(log,'');
 const update=(patch:Record<string,unknown>)=>writeFileSync(state,JSON.stringify({version:'devin 3000.11.3 (9c803229faa4)',auth:devinAuthText(),models:devinModelPayload,...patch}));update({});
 writeFileSync(binary,'#!'+process.execPath+'\n'+String.raw`
 const fs=require('node:fs'),args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(process.env.DEVIN_FIXTURE_STATE,'utf8'));
 fs.appendFileSync(process.env.DEVIN_FIXTURE_LOG,JSON.stringify({args,cwd:process.cwd(),files:fs.readdirSync(process.cwd()),home:process.env.HOME,keys:['DEVIN_API_KEY','WINDSURF_API_KEY','CODEIUM_API_KEY','PANE_TOKEN'].filter(k=>process.env[k])})+'\n');
 if(JSON.stringify(args)==='["--version"]'){console.log(state.version);process.exit(0)}
 if(JSON.stringify(args)==='["auth","status"]'){console.log(state.auth);process.exit(state.authCode||0)}
 if(JSON.stringify(args)==='["models","list","--format","json"]'){if(state.modelsCode){console.error('fixture-secret');process.exit(state.modelsCode)}console.log(JSON.stringify(state.models));process.exit(0)}
 if(args.includes('--print')&&args.includes('dangerous')){if(state.turnError){console.error('fixture-secret login expired');process.exit(1)}const id=args.includes('--resume')?args[args.indexOf('--resume')+1]:'devin-session';const file=args[args.indexOf('--export')+1];if(state.exportCase==='symlink')fs.symlinkSync(process.env.DEVIN_FIXTURE_STATE,file);else if(!state.noExport)fs.writeFileSync(file,state.exportCase==='malformed'?'{}':JSON.stringify({session_id:state.exportCase==='foreign'?'foreign-session':id,steps:[]}));console.log('готов');process.exit(0)}
console.error('unexpected command');process.exit(99);
 `,{mode:0o700});
 const env={...process.env,DEVIN_FIXTURE_LOG:log,DEVIN_FIXTURE_STATE:state,DEVIN_API_KEY:'fixture-secret',WINDSURF_API_KEY:'fixture-secret',CODEIUM_API_KEY:'fixture-secret',PANE_TOKEN:'fixture-token'},description={...DEVIN,binary},deps={env,cwd:dir},entry=cliEntry(description,deps);
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return {dir,description,deps,entry,update,capture:():any[]=>readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))};
}
