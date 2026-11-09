import type {TestContext} from 'node:test';
import {request as httpRequest,type IncomingHttpHeaders,type IncomingMessage,type ClientRequest,type RequestOptions} from 'node:http';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {harness,FakeProvider} from '../../runtime/src/test-helpers.ts';
import type {RouterSource} from './router-health.ts';
import {createApi,type Api} from './server.ts';
export {deferred,until,OWNER,FakeProvider,FakeClock} from '../../runtime/src/test-helpers.ts';
const clientSignals=new WeakMap<Api,AbortSignal>();
export async function fixture(t:TestContext,options:Parameters<typeof harness>[1]&{router?:RouterSource}={}){
 // Cancel clients before teardown waits for the server, including requests still awaiting headers.
 const clients=new AbortController(),signal=AbortSignal.any([t.signal,clients.signal]);let api:Api|undefined;
 t.after(async()=>{clients.abort();if(api){clientSignals.delete(api);await api.close()}});
 const codex=new FakeProvider('codex');codex.models=async()=>[{id:'gpt-test',label:'GPT test'}];
 const h=await harness(t,{...options,deps:{...options.deps,providers:{claude:new FakeProvider(),codex,...options.deps?.providers}}});
 const provider=h.deps.providers.claude as FakeProvider,siteDir=join(h.dir,'site');mkdirSync(siteDir);writeFileSync(join(siteDir,'test.js'),'window.test = "готов";');
 api=createApi({runtime:h.runtime,siteDir,port:0,router:options.router??{models:()=>({ok:false,reason:'списки моделей provider-router не найдены'}),health:async()=>({ok:false,reason:'программа не отвечает на /health'})}});clientSignals.set(api,signal);await api.listen();h.deps.appUrl=api.url;
 return {...h,provider,codex,api,siteDir}
}
export function noRepositoryFixture(t:TestContext,options:Parameters<typeof fixture>[1]={}){return fixture(t,{...options,noRepository:true})}
export interface Response {status:number;headers:IncomingHttpHeaders;body:any;text:string}
// Opt-in diagnostics for an outstanding test transport; never log bodies, headers or credentials.
function clientRequest(api:Api,path:string,options:RequestOptions,receive:(response:IncomingMessage)=>void){
 const started=performance.now(),trace=(phase:string)=>{if(process.env.HARNESS_TEST_HTTP_TRACE==='1')process.stderr.write('[test.http] '+JSON.stringify({pid:process.pid,method:options.method??'GET',path:path.split('?')[0],phase,durationMs:Math.round(performance.now()-started)})+'\n')};
 trace('start');const req=httpRequest(api.url,{...options,path},response=>{trace('headers');response.once('end',()=>trace('end'));response.once('close',()=>trace('response.close'));receive(response)});
 req.once('error',()=>trace('error'));req.once('close',()=>trace('request.close'));return req;
}
export function call(api:Api,path:string,options:{method?:string;body?:unknown;raw?:string|Buffer|Buffer[];headers?:Record<string,string>;signal?:AbortSignal}={}):Promise<Response>{return new Promise((resolve,reject)=>{
 const raw=options.raw??(options.body===undefined?undefined:JSON.stringify(options.body));
 const req=clientRequest(api,path,{signal:options.signal??clientSignals.get(api),method:options.method??(raw===undefined?'GET':'POST'),headers:{...(raw===undefined?{}:{'Content-Type':'application/json'}),...options.headers}},res=>{const chunks:Buffer[]=[];res.on('data',d=>chunks.push(Buffer.from(d)));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');let body:unknown=text;try{body=JSON.parse(text)}catch{}resolve({status:res.statusCode??0,headers:res.headers,body,text})});res.on('error',reject)});
 req.on('error',reject);if(Array.isArray(raw)){for(const chunk of raw)req.write(chunk);req.end()}else req.end(raw)
 })}
export async function sse(api:Api,id='all',options:{signal?:AbortSignal}={}){
 let req!:ClientRequest;const response=await new Promise<IncomingMessage>((resolve,reject)=>{req=clientRequest(api,'/api/events/'+id,{signal:options.signal??clientSignals.get(api)},resolve);req.on('error',reject);req.end()});
 let raw='';const frames:any[]=[];response.on('error',()=>{});response.on('data',chunk=>{raw+=chunk.toString();for(const block of chunk.toString().split('\n\n')){if(block.startsWith('data: '))try{frames.push(JSON.parse(block.slice(6)))}catch{}}});
 return {req,response,frames,get raw(){return raw},close(){req.destroy();response.destroy()}}
}
