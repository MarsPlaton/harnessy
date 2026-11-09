import {constants,openSync,fstatSync,lstatSync,readSync,closeSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
export type RouterHealth={ok:true;models:string[];families:string[]}|{ok:false;reason:string};
export type RouterModels={ok:true;models:string[]}|{ok:false;reason:string};
export interface RouterSource {health():Promise<RouterHealth>;models():RouterModels}
export const ROUTER_CONFIG_LIMIT=128_000;
const modelId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z][a-zA-Z0-9:._/-]{0,255}$/.test(value);
export function readRouterModels(path=join(homedir(),'.codex/provider-router/routes.json')):RouterModels{
 let fd:number|undefined;
 try{
  const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink())throw Error('invalid');
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd),after=lstatSync(path);
  if(!stat.isFile()||stat.size>ROUTER_CONFIG_LIMIT||after.isSymbolicLink()||after.dev!==before.dev||after.ino!==before.ino||stat.dev!==before.dev||stat.ino!==before.ino)throw Error('invalid');
  const buffer=Buffer.alloc(ROUTER_CONFIG_LIMIT+1);let size=0;
  while(size<buffer.length){const n=readSync(fd,buffer,size,buffer.length-size,null);if(!n)break;size+=n}
  if(size>ROUTER_CONFIG_LIMIT)throw Error('invalid');
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size)));
  if(!data||typeof data!=='object'||!data.routes||typeof data.routes!=='object'||Array.isArray(data.routes)||!Array.isArray(data.fallbackModels))throw Error('invalid');
  // Route values (including keyFile, keys and URLs) never enter the projection.
  const models=[...Object.keys(data.routes),...data.fallbackModels];
  if(models.length>2000||!models.every(modelId))throw Error('invalid');
  return {ok:true,models:[...new Set(models)]};
 }catch(e){return {ok:false,reason:(e as NodeJS.ErrnoException).code==='ENOENT'?'списки моделей provider-router не найдены':'списки моделей provider-router не читаются'}}
 finally{if(fd!==undefined)closeSync(fd)}
}
export const ROUTER_HEALTH_URL='http://127.0.0.1:11435/health';
export async function readRouterHealth(fetcher:typeof fetch=fetch):Promise<RouterHealth>{
 const invalid:RouterHealth={ok:false,reason:'нечитаемый ответ /health'};
 try{
  const response=await fetcher(ROUTER_HEALTH_URL,{signal:AbortSignal.timeout(1000),redirect:'error'});
  if(!response.ok)return {ok:false,reason:'/health: HTTP '+response.status};
  const reader=response.body?.getReader();if(!reader)return invalid;
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>ROUTER_CONFIG_LIMIT){await reader.cancel();return invalid}chunks.push(next.value)}
  const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  if(!data||typeof data!=='object'||!('ok' in data)||data.ok!==true||!('models' in data)||!Array.isArray(data.models)||data.models.length>2000||!data.models.every(modelId))return invalid;
  const models=[...new Set(data.models as string[])],families=[...new Set(models.map(id=>id.match(/^[a-zA-Z]+/)![0].toLowerCase()))];
  return {ok:true,models,families};
 }catch{return {ok:false,reason:'программа не отвечает на /health'}}
}
// Status and Connections share a short snapshot, including an unavailable result.
export function routerHealthReader(read:()=>Promise<RouterHealth>=readRouterHealth,now=Date.now){
 let cached:RouterHealth|null=null,until=0,pending:Promise<RouterHealth>|null=null;
 return async():Promise<RouterHealth>=>{
  if(cached&&now()<until)return cached;if(pending)return pending;
  pending=read().catch(()=>({ok:false as const,reason:'программа не отвечает на /health'})).then(value=>{cached=value;until=now()+10_000;return value}).finally(()=>{pending=null});return pending;
 };
}
