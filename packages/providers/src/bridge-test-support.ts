import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const script=fileURLToPath(new URL('../bin/pane-mcp.mjs',import.meta.url));
export async function bridge(messages:unknown[],token:string|null='test-token',config:{PANE_ID?:string;APP_URL?:string;SEATS?:string}={},response?:Record<string,unknown>){
 const dir=await mkdtemp(join(tmpdir(),'providers-bridge-')),calls=join(dir,'calls.ndjson'),loader=join(dir,'fetch.mjs');
 await writeFile(loader,`import {appendFileSync} from 'node:fs';
globalThis.fetch=async(url,options={})=>{
 appendFileSync(process.env.TEST_CALLS,JSON.stringify({url:String(url),...options})+'\\n');
 return {ok:true,json:async()=>(${response?JSON.stringify(response):"{ok:true,seq:1,to:['reviewer'],thread:'task',reply:'answer',sha:'123',mergeSha:'456',branch:'integration',pane:'new',label:'New',model:'m',mode:'read',mandate:1,text:'transcript'}"})};
};`);
 try{
 const env={...process.env,PANE_ID:'worker',APP_URL:'http://fake.invalid',SEATS:'worker:Worker;reviewer:Review',TEST_CALLS:calls,...config};
 if(token!==null)Object.assign(env,{PANE_TOKEN:token});else delete (env as Record<string,string|undefined>).PANE_TOKEN;
 const child=spawn(process.execPath,['--import',pathToFileURL(loader).href,script],{env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',c=>{stdout+=String(c)});child.stderr.on('data',c=>{stderr+=String(c)});
 const exit=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
 child.stdin.end(messages.map(m=>JSON.stringify(m)).join('\n')+'\n');const code=await exit;
 assert.equal(code,0,stderr);const replies=stdout.trim().split('\n').filter(Boolean).map(s=>JSON.parse(s) as Record<string,unknown>);
 let requests:Record<string,unknown>[]=[];try{requests=(await readFile(calls,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 return {requests,replies,stderr}
 }finally{await rm(dir,{recursive:true,force:true})}
}
