import {closeSync,constants,fstatSync,lstatSync,mkdirSync,openSync,readSync,realpathSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {record,providerId} from './types.ts';
import type {CatalogRow} from './catalog.ts';
import {publicCatalogText} from './catalog-public.ts';
import {assertPrivateDirectory,assertPrivateFile,hardenPrivateDirectory} from '@harnessy/team';

export const catalogCacheDirectory=()=>process.env.HARNESS_SETTINGS_FILE?join(dirname(resolve(process.env.HARNESS_SETTINGS_FILE)),'provider-catalog'):join(homedir(),'.harnessy','catalog');

type Saved=Pick<CatalogRow,'installed'|'version'|'models'> & {login:Pick<CatalogRow['login'],'state'|'account'|'checkedAt'>};
const mask=(v:unknown)=>publicCatalogText(v,'account');
const modelId=(v:unknown)=>publicCatalogText(v,'modelId');
const modelLabel=(v:unknown)=>publicCatalogText(v,'label');
const version=(v:unknown)=>publicCatalogText(v,'version');
export class CatalogCacheError extends Error {readonly code:string;constructor(code:string){super('Сохранённый каталог отклонён');this.code=code}}
const MAX_BYTES=2*1024*1024;
/** Public observations only. Commands, permissions, raw identities and credentials never enter this cache. */
export class CatalogCache {
 private dir:string;private now:()=>number;private ready=false;
 constructor(dir:string,now:()=>number){this.dir=dir;this.now=now}
 private path(id:string){if(!providerId(id))throw Error('invalid cache id');return join(this.dir,id+'.json')}
 private directory(path=this.dir){try{if(!lstatSync(path).isDirectory()||realpathSync(path)!==resolve(path))throw Error('unsafe cache directory')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;this.directory(dirname(path));try{mkdirSync(path,{mode:0o700})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}if(!lstatSync(path).isDirectory()||realpathSync(path)!==resolve(path))throw Error('unsafe cache directory')}if(process.platform==='win32'&&path===this.dir&&!this.ready){hardenPrivateDirectory(path);this.ready=true}}
 load(id:string,binary:string):Saved|null{
  let fd:number;try{if(realpathSync(this.dir)!==resolve(this.dir))throw Error('unsafe cache directory');fd=openSync(this.path(id),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
  let raw:unknown;try{if(process.platform==='win32')assertPrivateDirectory(this.dir);const stat=fstatSync(fd);if(process.platform==='win32'){try{const named=assertPrivateFile(this.path(id));if(named.dev!==stat.dev||named.ino!==stat.ino)throw Error('cache file changed')}catch{throw new CatalogCacheError('cache_permissions')}}else{if(typeof process.getuid!=='function'||stat.uid!==process.getuid())throw new CatalogCacheError('cache_owner');if((stat.mode&0o7777)&~0o600)throw new CatalogCacheError('cache_permissions')}if(!stat.isFile()||stat.size>MAX_BYTES)throw new CatalogCacheError('cache_fields');const buf=Buffer.alloc(MAX_BYTES+1),n=readSync(fd,buf,0,buf.length,0);if(n>MAX_BYTES)throw new CatalogCacheError('cache_fields');raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buf.subarray(0,n)))}finally{closeSync(fd)}
  if(!record(raw)||raw.schema!==1||raw.id!==id||raw.binary!==binary||typeof raw.installed!=='boolean'||!(raw.version===null||version(raw.version))||!record(raw.login)||!['ok','none','unknown','error'].includes(String(raw.login.state))||typeof raw.login.checkedAt!=='number'||!Number.isFinite(raw.login.checkedAt)||raw.login.checkedAt<=0||raw.login.checkedAt>this.now()+60000||raw.login.account!==undefined&&!mask(raw.login.account)||!Array.isArray(raw.models)||raw.models.length>10000)throw new CatalogCacheError('cache_fields');
  const models:CatalogRow['models']=[],seen=new Set<string>();for(const m of raw.models){if(!record(m)||!modelId(m.id)||!modelLabel(m.label)||m.images!==undefined&&typeof m.images!=='boolean'||seen.has(m.id))throw new CatalogCacheError('cache_fields');seen.add(m.id);models.push({id:m.id,label:m.label,...(m.images===true?{images:true}:{})})}
  if(!raw.installed&&(raw.version!==null||models.length)||raw.login.state==='none'&&raw.login.account!==undefined)throw new CatalogCacheError('cache_fields');
  return {installed:raw.installed,version:raw.version,login:{state:raw.login.state as Saved['login']['state'],checkedAt:raw.login.checkedAt,...(raw.login.account?{account:raw.login.account as string}:{})},models};
 }
 save(row:CatalogRow){
  if(row.installed===null||row.login.checkedAt===undefined)return;
  if(row.models.some(m=>!modelId(m.id)||!modelLabel(m.label))||row.version!==null&&!version(row.version)||row.login.account!==undefined&&!mask(row.login.account))throw new CatalogCacheError('cache_fields');
  const value={schema:1,id:row.id,binary:row.binary,installed:row.installed,version:row.installed?row.version:null,login:{state:row.login.state,checkedAt:row.login.checkedAt,...(row.login.account&&mask(row.login.account)?{account:row.login.account}:{})},models:row.models.map(({id,label,images})=>({id,label,...(images===true?{images:true}:{})}))};
  const bytes=JSON.stringify(value)+'\n';if(Buffer.byteLength(bytes)>MAX_BYTES)throw Error('cache too large');this.directory();const file=this.path(row.id),temporary=file+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});renameSync(temporary,file)}finally{try{unlinkSync(temporary)}catch{}}
 }
}
