import {lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {ProviderError} from '../types.ts';
import {executeCli} from './process.ts';
import type {CliDependencies,CliProbe} from './types.ts';

/** Metadata only: literal arguments, bounded process, no credential-file access. */
export async function readCliMetadata<T>(binary:string,forbiddenEnv:readonly string[],probe:CliProbe<T>,deps:Partial<CliDependencies>={},signal?:AbortSignal):Promise<T>{
 const env={...(deps.env??process.env)};
 for(const key of [...forbiddenEnv,'PANE_TOKEN','PANE_ID','APP_URL','SEATS'])delete env[key];
 const timeoutMs=deps.probeTimeoutMs??15000;
 const r=await (deps.execute??executeCli)({binary,args:[...probe.command.args],...(probe.command.input!==undefined?{input:probe.command.input}:{}),cwd:deps.cwd??process.cwd(),env,timeoutMs,maxBytes:1024*1024},signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs));
 if(r.signal)throw new ProviderError('transport_lost','CLI: чтение прервано');
 if(r.code===null||!(probe.exitCodes??[0]).includes(r.code))throw new ProviderError('protocol','CLI: метаданные не прочитаны');
 try{return probe.parse(r)}catch(e){if(e instanceof ProviderError)throw e;throw new ProviderError('protocol','CLI: неверные метаданные')}
}

/** Only descriptor-selected, nonsecret metadata files; never follow a replacement symlink. */
export async function readCliFileMetadata<T>(probe:{file(env:NodeJS.ProcessEnv):string;parse(text:string|null):T},env:NodeJS.ProcessEnv):Promise<T>{
 let raw:string|null=null;const path=probe.file({...env});
 if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw new ProviderError('protocol','CLI: неверный путь метаданных');
 try{const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink())throw Error('invalid metadata');const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await fd.stat(),after=await lstat(path);if(!stat.isFile()||stat.size>65536||after.isSymbolicLink()||stat.dev!==before.dev||stat.ino!==before.ino||after.dev!==before.dev||after.ino!==before.ino)throw Error('invalid metadata');const bytes=Buffer.alloc(65537),{bytesRead}=await fd.read(bytes,0,bytes.length,0);if(bytesRead>65536)throw Error('metadata too large');raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead))}finally{await fd.close()}}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new ProviderError('protocol','CLI: метаданные не прочитаны')}
 try{return probe.parse(raw)}catch{throw new ProviderError('protocol','CLI: неверные метаданные')}
}
