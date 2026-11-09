import {lstatSync,mkdirSync,chmodSync,realpathSync,rmSync,readdirSync,readFileSync,writeFileSync,unlinkSync,rmdirSync,openSync,closeSync,fstatSync,constants,type Stats} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ProviderError} from '../types.ts';
import {assertPrivateDirectory,hardenPrivateDirectory} from '@harnessy/team';
const invalid=()=>new ProviderError('protocol','CLI: небезопасный каталог состояния');
function directory(path:string){try{mkdirSync(path,{mode:0o700})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink())throw invalid();if(process.platform==='win32')hardenPrivateDirectory(path);else chmodSync(path,0o700);return realpathSync(path)}
function checkedDirectory(path:string,expected?:Stats){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isDirectory()||realpathSync(path)!==path||expected&&(s.dev!==expected.dev||s.ino!==expected.ino))throw invalid();if(process.platform==='win32')assertPrivateDirectory(path);return s}finally{closeSync(fd)}}
export interface StateRemoval {kind:'provider.state.remove';provider:string;project:string;seat:string|null}
/** Generated paths only. Independent engine processes cannot write/delete the same CLI session together. */
export class CliStateStore {
 private root:string;private namespace:string;
 constructor(namespace:string,root?:string){if(!/^[a-z][a-z0-9-]*$/.test(namespace))throw invalid();this.namespace=namespace;
  const parent=root?directory(resolve(root)):directory(join(directory(join(realpathSync(homedir()),'.harnessy')),'providers'));
  this.root=directory(join(parent,namespace));
 }
 private rootValid(){const s=lstatSync(this.root);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(this.root)!==this.root)throw invalid()}
 private target(project:string,seat?:string){if(!isAbsolute(project)||seat!==undefined&&!/^[A-Za-z0-9_-]{1,80}$/.test(seat))throw invalid();
  const hash=createHash('sha256').update(realpathSync(project)).digest('hex'),base=join(this.root,hash);return {hash,path:seat===undefined?base:join(base,seat)};
 }
 private lock(hash:string,seat:string|null){
  this.rootValid();
  const rootStat=checkedDirectory(this.root),folder=directory(join(this.root,'.leases-'+hash)),folderStat=checkedDirectory(folder),file=join(folder,randomUUID()+'.json');
  writeFileSync(file,JSON.stringify({pid:process.pid,seat}),{mode:0o600,flag:'wx'});let released=false;
  const release=()=>{if(released)return;released=true;try{checkedDirectory(this.root,rootStat);checkedDirectory(folder,folderStat)}catch{return}unlinkSync(file);try{rmdirSync(folder)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOTEMPTY'&&(e as NodeJS.ErrnoException).code!=='ENOENT')throw e}};
  try{for(const name of readdirSync(folder)){const other=join(folder,name);if(other===file)continue;if(!/^[0-9a-f-]+\.json$/.test(name))throw invalid();
   let stat;try{stat=lstatSync(other)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e}if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024)throw invalid();
   let owner;try{owner=(()=>{const fd=openSync(other,constants.O_RDONLY|constants.O_NOFOLLOW);try{const current=fstatSync(fd);if(!current.isFile()||current.size>1024||current.ino!==stat.ino||current.dev!==stat.dev)throw invalid();return JSON.parse(readFileSync(fd,'utf8'))}finally{closeSync(fd)}})()}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw invalid()}
   if(!owner||!Number.isSafeInteger(owner.pid)||owner.pid<=0||owner.seat!==null&&(typeof owner.seat!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(owner.seat)))throw invalid();
   try{process.kill(owner.pid,0)}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH'){try{unlinkSync(other)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}continue}}
   if(seat===null||owner.seat===null||owner.seat===seat)throw new ProviderError('busy','CLI: состояние используется другим ходом');
  }return release}catch(e){release();throw e}
 }
 acquire(project:string,seat:string){const {hash,path}=this.target(project,seat),release=this.lock(hash,seat);try{directory(dirname(path));directory(path);
  const entries=[this.root,dirname(path),path].map(path=>({path,stat:checkedDirectory(path)}));
  const validate=()=>{try{for(const entry of entries)checkedDirectory(entry.path,entry.stat)}catch{throw new ProviderError('state_dir_tampered','CLI: каталог состояния изменён; запуск отменён')}};
  return {path,validate,release};
 }catch(e){release();throw e}}
 /** No deletion without the caller's journal writer; closing a provider never calls this. */
 async remove(project:string,seat:string|undefined,journal:(entry:StateRemoval)=>void|Promise<void>){
  if(typeof journal!=='function')throw invalid();const {hash,path}=this.target(project,seat),release=this.lock(hash,seat??null);
  try{try{for(const parent of seat?[dirname(path),path]:[path]){const s=lstatSync(parent);if(!s.isDirectory()||s.isSymbolicLink())throw invalid()}}
   catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
   await journal({kind:'provider.state.remove',provider:this.namespace,project:realpathSync(project),seat:seat??null});
   this.rootValid();
   // A journal callback may yield: validate the owned path again before deletion.
   for(const parent of seat?[dirname(path),path]:[path]){const s=lstatSync(parent);if(!s.isDirectory()||s.isSymbolicLink())throw invalid()}
   rmSync(path,{recursive:true});
  }finally{release()}
 }
}
