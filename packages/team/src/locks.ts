import {lstatSync,realpathSync,readlinkSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {isAbsolute,parse,sep,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
// Preserve symlink/.. order for existing prefixes, including paths not created yet.
export function canonicalPath(path:string,links={count:0}):string {
 const native=process.platform==='win32'?path.replaceAll('/',sep):path;
 const full=isAbsolute(native)?native:process.cwd()+sep+native;let current=parse(full).root;
 for(const part of full.slice(current.length).split(sep)){
 if(!part||part==='.')continue;if(part==='..'){current=dirname(current);continue}
 const next=current.endsWith(sep)?current+part:current+sep+part;
 try{const st=lstatSync(next);if(st.isSymbolicLink()){
 if(++links.count>40)throw Error('слишком много символических ссылок');
 const target=readlinkSync(next);current=canonicalPath(isAbsolute(target)?target:current+sep+target,links)
 }else current=realpathSync.native(next)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;current=next}
 }return current
}
declare const lockBrand:unique symbol;
export interface PathLock {readonly path:string;readonly [lockBrand]:true}
const tails=new Map<string,Promise<void>>(),active=new WeakSet<PathLock>();
export function assertPathLock(lock:PathLock,path=lock.path):void {
 if(!active.has(lock)||lock.path!==canonicalPath(path))throw Error('блокировка пути не действует: '+path)
}
// Public entries always queue. Internal composition passes this acquisition explicitly.
export async function withPathLock<T>(path:string,fn:(lock:PathLock)=>T|Promise<T>):Promise<T>{
 const key=canonicalPath(path),previous=tails.get(key)??Promise.resolve();let release!:()=>void;
 const current=new Promise<void>(r=>{release=r});tails.set(key,current);await previous;
 const lock=Object.freeze({path:key}) as PathLock;active.add(lock);
 try{return await fn(lock)}finally{active.delete(lock);release();if(tails.get(key)===current)tails.delete(key)}
}
export function renameWithRetry(from:string,to:string,replace:(from:string,to:string)=>void=renameSync):void {
 for(let attempt=0;;attempt++)try{replace(from,to);return}catch(error){
  const code=(error as NodeJS.ErrnoException).code;
  if(process.platform!=='win32'||!['EPERM','EACCES'].includes(String(code))||attempt>=9)throw error;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
 }
}
export function atomicWrite(path:string,text:string,replace:(from:string,to:string)=>void=renameSync):void {
 const target=canonicalPath(path),temp=target+'.'+randomUUID()+'.tmp';let fd:number|undefined;
 try{fd=openSync(temp,'wx');writeFileSync(fd,text,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;renameWithRetry(temp,target,replace)}
 finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
}
