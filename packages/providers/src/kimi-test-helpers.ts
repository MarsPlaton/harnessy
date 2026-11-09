import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {TestContext} from 'node:test';
import {cliEntry} from './catalog.ts';
import {KIMI} from './kimi.ts';
export function kimiFixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'harnessy-kimi-')),binary=join(dir,'kimi fixture.mjs'),log=join(dir,'calls.ndjson'),state=join(dir,'state.json');writeFileSync(state,'{}');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(binary,'#!'+process.execPath+`\nimport {appendFileSync,readdirSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2),state=JSON.parse(readFileSync(process.env.KIMI_FIXTURE_STATE,'utf8')); appendFileSync(process.env.KIMI_FIXTURE_LOG,JSON.stringify({args,cwd:process.cwd(),files:readdirSync(process.cwd()),home:process.env.HOME,key:!!process.env.KIMI_API_KEY,moonshot:!!process.env.MOONSHOT_API_KEY,pane:!!process.env.PANE_TOKEN})+'\\n');
if(args.includes('--prompt')&&args.includes('stream-json')&&!args.includes('--auto')&&!args.includes('--yolo')){if(state.turnError){console.error('FIXTURE-SECRET login expired');process.exit(1)}const session_id=args.includes('--session')?args[args.indexOf('--session')+1]:'kimi-session';console.log(JSON.stringify({role:'assistant',content:'готов'}));if(!state.truncated)console.log(JSON.stringify({role:'meta',type:'session.resume_hint',session_id}));process.exit(0)}
if(JSON.stringify(args)!=='["--version"]')process.exit(99);console.log(process.env.KIMI_FIXTURE_VERSION||'2.1.1');\n`,{mode:0o700});
 const description={...KIMI,binary},env={...process.env,KIMI_FIXTURE_LOG:log,KIMI_FIXTURE_STATE:state,KIMI_API_KEY:'FIXTURE-SECRET',MOONSHOT_API_KEY:'FIXTURE-SECRET',PANE_TOKEN:'FIXTURE-PANE'};
 return {dir,binary,description,env,update:(patch:Record<string,unknown>)=>writeFileSync(state,JSON.stringify(patch)),entry:cliEntry(description,{env,cwd:dir}),capture:():any[]=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]};
}
