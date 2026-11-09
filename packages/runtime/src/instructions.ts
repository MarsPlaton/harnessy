import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync,statSync,lstatSync,renameSync,fsyncSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve,relative,isAbsolute,sep,basename} from 'node:path';
import {loadTeam,withPathLock,atomicWrite} from '@harnessy/team';
import type {Initiator} from '@harnessy/journal';
import type {Runtime} from './runtime.ts';
import type {ProjectState} from './types.ts';
import {RuntimeError} from './errors.ts';
import {owner,same,place} from './operations.ts';
const limit=256*1024;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const inside=(root:string,file:string)=>{const p=relative(root,file);return !!p&&!isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+sep)};
const fail=(code:string,text:string,status=409):never=>{throw new RuntimeError(code,text,status)};
function paths(p:ProjectState){const team=p.team&&loadTeam(p.team.harnessDir);return Object.values(team?.seats??{}).filter(s=>s.instructions).map(s=>({id:s.id,path:resolve(team!.harnessDir,s.instructions!)}))}
function target(p:ProjectState,id:string){
 place(p,id);const configured=paths(p).find(s=>s.id===id);if(!configured)throw new RuntimeError('instruction_missing','У роли не задан файл инструкции.',404,{fields:{canCreate:false}});
 const root=realpathSync(p.dir),requested=configured.path;if(!inside(root,requested))return fail('file_outside','Инструкция должна находиться внутри проекта.',403);
 let canonical:string,exists=true;try{canonical=realpathSync(requested)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;exists=false;try{lstatSync(requested);return fail('target_changed','Цель инструкции недоступна; проверьте ссылку.')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}try{canonical=resolve(realpathSync(dirname(requested)),basename(requested))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;throw new RuntimeError('instruction_missing','Каталог инструкции отсутствует. Восстановите каталог проекта.',404,{fields:{canCreate:false}})}}
 if(!inside(root,canonical))return fail('file_outside','Ссылка инструкции ведёт за пределы проекта.',403);
 const parent=realpathSync(dirname(requested)),parentInfo=statSync(parent),canonicalParent=realpathSync(dirname(canonical)),canonicalParentInfo=statSync(canonicalParent);
 let bytes:Buffer|null=null,identity:string|null=null;
 if(exists){const fd=openSync(canonical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const before=fstatSync(fd);if(!before.isFile()||before.size>limit)return fail('instruction_invalid','Инструкция должна быть обычным текстовым файлом до 256 КиБ.',400);bytes=readFileSync(fd);const after=fstatSync(fd),actual=statSync(requested);if(realpathSync(requested)!==canonical||actual.dev!==before.dev||actual.ino!==before.ino||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||bytes.length!==before.size)return fail('target_changed','Файл инструкции изменился во время чтения.');identity=before.dev+':'+before.ino}finally{closeSync(fd)}}
 const sharedWith=paths(p).filter(s=>{try{return realpathSync(s.path)===canonical}catch{return s.path===requested}}).map(s=>s.id);
 return {requested,canonical,parent,parentIdentity:parentInfo.dev+':'+parentInfo.ino,canonicalParent,canonicalParentIdentity:canonicalParentInfo.dev+':'+canonicalParentInfo.ino,identity,bytes,hash:bytes===null?null:hash(bytes),sharedWith,path:relative(root,requested)};
}
function readReceipt(p:ProjectState,id:string,t:ReturnType<typeof target>){return {ok:true as const,project:p.dir,instance:p.trace.instanceId,pane:id,path:t.path,name:basename(t.path),size:t.bytes?.length??0,text:t.bytes?.toString('utf8')??'',hash:t.hash,sharedWith:t.sharedWith,canCreate:t.bytes===null}}
export function instructionFile(runtime:Runtime,path:string){const p=runtime.project,entry=paths(p).find(s=>s.path===resolve(p.dir,path));if(!entry)return null;const t=target(p,entry.id),value=readReceipt(p,entry.id,t);if(t.bytes===null)throw new RuntimeError('instruction_missing','Файл инструкции отсутствует. Его можно создать для этой роли.',404,{fields:{...value,ok:false}});return value}
export async function updateInstruction(runtime:Runtime,id:string,input:Record<string,unknown>,initiator:Initiator){
 const p=owner(runtime,initiator),text=input.text,expectedHash=input.expectedHash;
 if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>limit||!(expectedHash===null||typeof expectedHash==='string'&&/^[0-9a-f]{64}$/.test(expectedHash)))return fail('instruction_invalid','Нужны текст до 256 КиБ и hash прочитанного файла.',400);
 const current=()=>{same(runtime,p);runtime.assertOwner(initiator);if(input.project!==p.dir||input.instance!==p.trace.instanceId)fail('project_changed','Проект изменился. Перечитайте инструкцию.')};current();
 return withPathLock(p.dir,()=>{current();const before=target(p,id);if(before.hash!==expectedHash)fail('file_changed','Файл изменился. Черновик сохранён — перечитайте инструкцию.');
  const nextHash=hash(Buffer.from(text)),verify=()=>{current();let now:ReturnType<typeof target>;try{now=target(p,id)}catch{return fail('target_changed','Цель инструкции изменилась. Перечитайте файл.')}
   if(['requested','canonical','parent','parentIdentity','canonicalParent','canonicalParentIdentity','identity'].some(key=>now[key as keyof typeof now]!==before[key as keyof typeof before]))fail('target_changed','Цель инструкции изменилась. Перечитайте файл.');if(now.hash!==before.hash)fail('file_changed','Файл изменился. Перечитайте инструкцию.');};
  p.journal.append({sender:'harness',to:['owner'],kind:'note',origin:'instruction-update',text:'Инструкция '+id+': '+(before.hash??'файл отсутствует')+' → '+nextHash});
  verify();atomicWrite(before.canonical,text,(from,to)=>{verify();renameSync(from,to)});
  if(process.platform!=='win32'){const fd=openSync(before.canonicalParent,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
  p.team=loadTeam(p.team!.harnessDir);runtime.ownerAutopilotAction(p,initiator);p.owner.publish({type:'instructionUpdated',project:p.dir,pane:id,hash:nextHash});
  return {...readReceipt(p,id,target(p,id)),appliesFrom:'next' as const};
 });
}
