import type {TestContext} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GEMINI} from './gemini.ts';
import {cliEntry} from './catalog.ts';

export function geminiFixture(t:TestContext){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-gemini-'))),config=join(dir,'.gemini'),account=join(config,'google_accounts.json'),captureFile=join(dir,'calls.jsonl'),binary=join(dir,'gemini.cjs');mkdirSync(config);
 writeFileSync(binary,'#!'+process.execPath+'\n'+`const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(captureFile)},JSON.stringify({args,home:process.env.HOME,apiKey:!!process.env.GEMINI_API_KEY,paneToken:!!process.env.PANE_TOKEN})+'\\n');if(JSON.stringify(args)!=='["--version"]')process.exit(99);console.log('0.55.1');`,{mode:0o700});
 const stateRoot=join(dir,'cli-state');mkdirSync(stateRoot);
 const env={...process.env,GEMINI_CLI_HOME:dir,GEMINI_API_KEY:'FIXTURE-SECRET',PANE_TOKEN:'FIXTURE-PANE-TOKEN'},description={...GEMINI,binary},entry=cliEntry(description,{env,cwd:dir,stateRoot});
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return {dir,config,account,description,entry,env,capture:():any[]=>existsSync(captureFile)?readFileSync(captureFile,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[]};
}
