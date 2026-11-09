import {lstat,mkdir,open,readdir,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {ProviderError} from './types.ts';
import {canonicalPath} from '@harnessy/team';

const missing=()=>new ProviderError('session_missing','Gemini: исходная сессия недоступна');
async function directory(path:string){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())throw missing()}
async function session(path:string,id:string){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await file.stat();if(!s.isFile()||s.size>64*1024*1024)throw missing();const bytes=await file.readFile();
  const text=bytes.toString('utf8'),first=JSON.parse(path.endsWith('.jsonl')?text.slice(0,text.indexOf('\n')<0?text.length:text.indexOf('\n')):text);return first?.sessionId===id?bytes:null;
 }finally{await file.close()}
}
// Copy only the selected legacy conversation. Never import settings, hooks, other
// projects or sessions, and never write back to the owner's Gemini directory.
export async function importGeminiSession(source:string,target:string,cwd:string,id:string|null,validate:()=>void){
 if(!id)return;
 if(!/^[0-9a-f-]{36}$/i.test(id))throw missing();
 const project=canonicalPath(cwd);
 const registry=async(root:string)=>{try{const r=JSON.parse(await readFile(join(root,'projects.json'),'utf8'));const key=r.projects?.[project];return typeof key==='string'&&/^[a-z0-9-]+$/.test(key)?key:null}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}};
 const find=async(root:string,key:string)=>{try{
  await directory(root);await directory(join(root,'tmp'));await directory(join(root,'tmp',key));
  const chats=join(root,'tmp',key,'chats');await directory(chats);
  for(const name of await readdir(chats))if(/^session-[a-zA-Z0-9-]+\.jsonl?$/.test(name)&&name.endsWith('-'+id.slice(0,8)+(name.endsWith('.jsonl')?'.jsonl':'.json'))){const bytes=await session(join(chats,name),id);if(bytes)return {name,bytes}}
  return null;
 }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e}
 };
 const own=await registry(target);
 if(own&&await find(target,own))return;
 const key=await registry(source);if(!key)throw missing();
 const legacy=await find(source,key);if(!legacy)throw missing();
 // A new isolated home has no registry. An existing home keeps its own key.
 const destination=own??key;validate();
 for(const path of [join(target,'tmp'),join(target,'tmp',destination),join(target,'tmp',destination,'chats')]){await mkdir(path,{mode:0o700,recursive:true});await directory(path)}
 const path=join(target,'tmp',destination,'chats',legacy.name);
 const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await file.writeFile(legacy.bytes)}finally{await file.close()}
 if(!own){validate();await writeFile(join(target,'projects.json'),JSON.stringify({projects:{[project]:destination}}),{mode:0o600,flag:'wx'});await writeFile(join(target,'tmp',destination,'.project_root'),project,{mode:0o600,flag:'wx'})}
}
