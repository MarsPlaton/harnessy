import {spawn} from 'node:child_process';
import {extname} from 'node:path';
import {ProviderError} from '../types.ts';
import type {CliExecutor} from './types.ts';
import {MetadataRpc} from './rpc.ts';

/** No shell, bounded output, and termination of the per-turn process group. */
export const executeCli:CliExecutor=(request,signal,hooks={})=>new Promise((resolve,reject)=>{
 if(signal.aborted){reject(new ProviderError('cancelled','ход отменён'));return}
 const nodeScript=process.platform==='win32'&&['.js','.mjs','.cjs'].includes(extname(request.binary).toLowerCase());
 const child=spawn(nodeScript?process.execPath:request.binary,nodeScript?[request.binary,...request.args]:request.args,{cwd:request.cwd,env:request.env,stdio:'pipe',shell:false,detached:process.platform!=='win32'});
 let stdout='',stderr='',bytes=0,error:ProviderError|undefined,killTimer:NodeJS.Timeout|undefined;
 const decoder=new TextDecoder('utf-8',{fatal:true}),errDecoder=new TextDecoder('utf-8',{fatal:true});
 const rpc=request.rpcMethod?new MetadataRpc():null;
 const kill=(sig:NodeJS.Signals)=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,sig);else child.kill(sig)}catch{}};
 const stop=(reason:ProviderError)=>{if(error)return;error=reason;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),250);killTimer.unref()};
 const aborted=()=>stop(new ProviderError('cancelled','ход отменён'));
 signal.addEventListener('abort',aborted,{once:true});
 const timer=setTimeout(()=>stop(new ProviderError('transport_lost','CLI: время ожидания истекло')),request.timeoutMs);timer.unref();
 child.on('spawn',()=>{if(signal.aborted){aborted();return}try{hooks.started?.();if(rpc)child.stdin.write(rpc.request(request.rpcMethod!));else child.stdin.end(request.input??'')}catch{stop(new ProviderError('protocol','CLI: запуск ввода не удался'))}});
 child.stdin.on('error',()=>{}); // Exit/close determines whether the turn completed.
 child.stdout.on('data',(chunk:Buffer)=>{if(error)return;try{bytes+=chunk.length;if(bytes>request.maxBytes)throw Error();if(rpc){const value=rpc.push(chunk);if(value!==undefined){stdout=value;child.stdin.end()}return}const text=decoder.decode(chunk,{stream:true});stdout+=text;hooks.stdout?.(text)}catch(e){stop(e instanceof ProviderError?e:new ProviderError('protocol','CLI: неверный UTF-8 или превышен предел вывода'))}});
 child.stderr.on('data',(chunk:Buffer)=>{if(error)return;try{if(Buffer.byteLength(stderr)+chunk.length>65536)throw Error();stderr+=errDecoder.decode(chunk,{stream:true})}catch{stop(new ProviderError('protocol','CLI: неверный или слишком большой stderr'))}});
 child.on('error',(e:NodeJS.ErrnoException)=>{stop(new ProviderError(e.code==='ENOENT'?'no_binary':'transport_lost',e.code==='ENOENT'?'CLI: программа не найдена':'CLI: процесс не запущен'))});
 child.on('close',(code,exitSignal)=>{
  clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal.removeEventListener('abort',aborted);
  if(!error)try{if(rpc)rpc.finish();const tail=decoder.decode();stdout+=tail;if(tail)hooks.stdout?.(tail);stderr+=errDecoder.decode()}catch(e){error=e instanceof ProviderError?e:new ProviderError('protocol','CLI: оборванный UTF-8')}
  // A CLI may leave a bridge child behind even after its own clean exit.
  kill('SIGKILL');
  if(error)reject(error);else resolve({stdout,stderr,code,signal:exitSignal});
 });
 if(signal.aborted)aborted();
});
