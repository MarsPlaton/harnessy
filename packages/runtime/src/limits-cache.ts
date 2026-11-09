import {lstatSync,mkdirSync,openSync,closeSync,fstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,realpathSync,constants} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {record,limitPlan,limitCredits,type LimitCredits,type ProviderLimits,type LimitWindow,type LimitsCode,type BuiltinVendor as Vendor} from '@harnessy/providers';

export const POLL_SECONDS=300,TURN_SECONDS=60;
export const reasons:Record<LimitsCode,string>={
 limits_unlimited:'все квоты безлимитны',limits_unsupported:'лимиты провайдер не отдаёт',limits_not_applicable:'ключ API не имеет окон подписки',limits_auth:'вход по подписке недоступен',limits_rate_limited:'сервис лимитов просит повторить позже',limits_unavailable:'сервис лимитов временно недоступен',limits_invalid:'ответ или сохранённый снимок лимитов повреждён',limits_timeout:'чтение лимитов отменено или превысило время ожидания',limits_storage:'не удалось сохранить снимок лимитов'};
export type Saved={vendor:Vendor;account?:string|null;plan:string|null;planLevel?:'5x'|'20x'|null;extraUsageEnabled?:boolean|null;windows:LimitWindow[];fetchedAt:number;credits?:LimitCredits;resetCredits?:number};
export function limitAccount(raw:unknown):string|null{return typeof raw==='string'&&/^[^\s@]+@[^\s@]+$/.test(raw.trim())?raw.trim().toLowerCase():null}
export function saved(raw:unknown,vendor:Vendor,now:number):Saved|null{
 if(!record(raw)||!(raw.plan===null||typeof raw.plan==='string'&&limitPlan(raw.plan)===raw.plan)||raw.vendor!==vendor||typeof raw.fetchedAt!=='number'||!Number.isFinite(raw.fetchedAt)||raw.fetchedAt<=0||raw.fetchedAt>now+60||!Array.isArray(raw.windows)||raw.windows.length>20)return null;
 const credits=raw.credits===undefined?undefined:limitCredits(raw.credits),reset=raw.resetCredits;
 if(credits===null||reset!==undefined&&(!Number.isSafeInteger(reset)||Number(reset)<0)||!raw.windows.length&&!credits&&reset===undefined)return null;
 const windows:LimitWindow[]=[];
 for(const w of raw.windows){if(!record(w)||typeof w.label!=='string'||!w.label||w.label.length>80||typeof w.percentUsed!=='number'||!Number.isFinite(w.percentUsed)||w.percentUsed<0||w.percentUsed>100||!Number.isSafeInteger(w.windowMinutes)||Number(w.windowMinutes)<=0||!(w.resetsAt===null||typeof w.resetsAt==='number'&&Number.isFinite(w.resetsAt)&&w.resetsAt>0))return null;
 windows.push({label:w.label,percentUsed:w.percentUsed,windowMinutes:Number(w.windowMinutes),resetsAt:w.resetsAt})}
 return {vendor,...(Object.hasOwn(raw,'account')?{account:limitAccount(raw.account)}:{}),plan:raw.plan as string|null,...(Object.hasOwn(raw,'planLevel')?{planLevel:raw.planLevel==='5x'||raw.planLevel==='20x'?raw.planLevel:null}:{}),...(Object.hasOwn(raw,'extraUsageEnabled')?{extraUsageEnabled:typeof raw.extraUsageEnabled==='boolean'?raw.extraUsageEnabled:null}:{}),windows,fetchedAt:raw.fetchedAt,...(credits?{credits}:{}),...(reset!==undefined?{resetCredits:Number(reset)}:{})};
}
export interface SharedSnapshot {version:1;vendor:Vendor;attemptedAt:number;retryAt:number|null;backoff:number;pending:string|null;code:LimitsCode|null;value:Saved|null}
export const nextAttempt=(row:SharedSnapshot,afterTurn=false)=>row.retryAt??row.attemptedAt+(afterTurn&&!row.pending?TURN_SECONDS:POLL_SECONDS);
function directory(path:string){
 try{if(!lstatSync(path).isDirectory()||realpathSync(path)!==resolve(path))throw Error('unsafe cache directory')}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;directory(dirname(path));try{mkdirSync(path,{mode:0o700})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}if(!lstatSync(path).isDirectory()||realpathSync(path)!==resolve(path))throw Error('unsafe cache directory')}
}
export function atomicJSON(path:string,value:unknown){const temporary=path+'.'+randomUUID()+'.tmp';try{writeFileSync(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,path)}finally{try{unlinkSync(temporary)}catch{}}}
export class SharedLimitsCache {
 readonly dir:string;private now:()=>number;
 constructor(dir:string,now:()=>number){this.dir=dir;this.now=now}
 path(vendor:Vendor){return join(this.dir,vendor+'.json')}
 load(vendor:Vendor):SharedSnapshot|null{
 let fd:number|undefined;try{if(realpathSync(this.dir)!==resolve(this.dir))throw Error('unsafe cache directory');const before=lstatSync(this.path(vendor));if(!before.isFile()||before.isSymbolicLink())throw Error('unsafe cache file');fd=openSync(this.path(vendor),constants.O_RDONLY|constants.O_NOFOLLOW);
  const opened=fstatSync(fd),after=lstatSync(this.path(vendor));if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||after.isSymbolicLink()||after.dev!==before.dev||after.ino!==before.ino)throw Error('unsafe cache file')
 }catch(e){if(fd!==undefined)closeSync(fd);if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
 let raw:unknown;try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>65536)throw Error('unsafe cache file');try{raw=JSON.parse(readFileSync(fd,'utf8'))}catch{return null}}finally{closeSync(fd)}
 if(!record(raw)||raw.version!==1||raw.vendor!==vendor||typeof raw.attemptedAt!=='number'||!Number.isFinite(raw.attemptedAt)||raw.attemptedAt<=0||raw.attemptedAt>this.now()+60||!(raw.retryAt===null||typeof raw.retryAt==='number'&&Number.isFinite(raw.retryAt)&&raw.retryAt>=raw.attemptedAt)||!Number.isSafeInteger(raw.backoff)||Number(raw.backoff)<0||Number(raw.backoff)>1800||!(raw.pending===null||typeof raw.pending==='string'&&/^[a-f0-9-]{36}$/.test(raw.pending))||!(raw.code===null||typeof raw.code==='string'&&Object.hasOwn(reasons,raw.code)))return null;
 const value=raw.value===null?null:saved(raw.value,vendor,this.now());if(raw.value!==null&&!value||!value&&raw.code===null&&raw.pending===null||raw.retryAt!==null&&(raw.pending!==null||!['limits_rate_limited','limits_unavailable'].includes(String(raw.code))))return null;
 return {version:1,vendor,attemptedAt:raw.attemptedAt,retryAt:raw.retryAt as number|null,backoff:Number(raw.backoff),pending:raw.pending as string|null,code:raw.code as LimitsCode|null,value};
 }
 private locked<T>(action:()=>T):T{
 directory(this.dir);const path=join(this.dir,'coordination.sqlite');try{if(!lstatSync(path).isFile())throw Error('unsafe coordinator')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 // OS-backed transaction lock covers only synchronous cache read/rename. A crashed engine releases it automatically.
 const db=new DatabaseSync(path);try{db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');const result=action();db.exec('COMMIT');return result}finally{db.close()}
 }
 claim(vendor:Vendor,afterTurn:boolean,fallback:Saved|null):{row:SharedSnapshot;token:string|null}{return this.locked(()=>{
 const previous=this.load(vendor),now=this.now();if(previous&&now<nextAttempt(previous,afterTurn))return {row:previous,token:null};
 const token=randomUUID(),row:SharedSnapshot={version:1,vendor,attemptedAt:now,retryAt:null,backoff:previous?.backoff??0,pending:token,code:previous?.code??(previous?.value||fallback?null:'limits_unavailable'),value:previous?.value??fallback};atomicJSON(this.path(vendor),row);return {row,token};
 })}
 complete(vendor:Vendor,token:string,result:ProviderLimits):SharedSnapshot|null{return this.locked(()=>{
 const row=this.load(vendor);if(!row||row.pending!==token)return row;const now=this.now(),value=result?.ok===true?saved({...result,vendor},vendor,now):null;
 row.pending=null;
 if(value){row.value=value;row.code=null;row.backoff=0;row.retryAt=null}
 else {row.code=result?.ok===false&&Object.hasOwn(reasons,result.code)?result.code:'limits_invalid';if(row.code==='limits_not_applicable')row.value=null;
 if(row.code==='limits_rate_limited'||row.code==='limits_unavailable'){row.backoff=Math.min(1800,Math.max(POLL_SECONDS,row.backoff*2));const retry=result.ok===false&&typeof result.retryAfterSeconds==='number'&&Number.isFinite(result.retryAfterSeconds)&&result.retryAfterSeconds>=0?result.retryAfterSeconds:0;row.retryAt=now+Math.max(row.backoff,retry)}else {row.backoff=0;row.retryAt=null}}
 atomicJSON(this.path(vendor),row);return row;
 })}
}
