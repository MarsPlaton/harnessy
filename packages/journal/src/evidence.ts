import {realpathSync,lstatSync,readlinkSync,readFileSync,existsSync,statSync} from 'node:fs';
import {dirname,basename,relative,isAbsolute,parse,sep} from 'node:path';
import {pythonTrim} from './compat-json.ts';
import {JournalError} from './types.ts';
const SECTIONS=['Ran','Skipped','Planned','Manual'];
// Resolve components in filesystem order: a symlink is followed before a later '..'.
function realPath(path:string,links={count:0}):{path:string;missing:boolean} {
 const native=process.platform==='win32'?path.replaceAll('/',sep):path;
 const absolute=isAbsolute(native)?native:process.cwd()+sep+native;let current=parse(absolute).root,missing=false;
 const parts=absolute.slice(current.length).split(sep);
 for(const part of parts){
 if(!part||part==='.'||part==='..'){
 if(!missing&&!statSync(current).isDirectory())throw new Error('компонент пути не является каталогом');
 if(part==='..'){if(missing)throw new Error('missing prefix traversal');current=dirname(current)}continue
 }
 const candidate=current.endsWith(sep)?current+part:current+sep+part;
 try{
 const stat=lstatSync(candidate);
 if(stat.isSymbolicLink()){
 if(++links.count>40)throw new Error('слишком много символических ссылок');
 const target=readlinkSync(candidate),result=realPath(isAbsolute(target)?target:current+sep+target,links);current=result.path;missing||=result.missing;
 }else current=realpathSync(candidate);
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;current=candidate;missing=true}
 }
 return {path:current,missing}
}
export function resolveEvidence(projectRoot:string,path:unknown):string|null {
 if(typeof path!=='string'||!pythonTrim(path))return null;
 try{
 const root=realPath(projectRoot).path,raw=isAbsolute(path)?path:root+sep+path,target=realPath(raw),canonical=target.path,rel=relative(root,canonical);
 if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))return null;
 // Missing final paths remain unresolved so callers can create them safely later.
 return target.missing?raw:canonical
 }catch{return null}
}
export function checkReport(path:string):string|null {
 if(!existsSync(path)||!statSync(path).isFile())return 'файла отчёта нет: '+path;
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readFileSync(path))}catch{return 'отчёт не читается: '+path}
 if(!pythonTrim(text))return 'отчёт пуст: '+path;
 const found=new Set([...text.matchAll(/^[\p{White_Space}\u001c-\u001f]*(?:#{1,6}[\p{White_Space}\u001c-\u001f]*|\*\*|__)?[\p{White_Space}\u001c-\u001f]*(Ran|Sk[iİı]pped|Planned|Manual)(?![\p{L}\p{N}_])/gimu)].map(m=>m[1]!.replaceAll('ſ','s').replaceAll('İ','i').replaceAll('ı','i').toLowerCase()));
 const missing=SECTIONS.filter(section=>!found.has(section.toLowerCase()));return missing.length?'в отчёте '+basename(path)+' нет разделов: '+missing.join(', ')+' (контракт Ran / Skipped / Planned / Manual)':null
}
export function evidenceDir(projectRoot:string,thread:string,round:number):string {
 const path=resolveEvidence(projectRoot,(isAbsolute(thread)?thread:'.harness'+sep+'evidence'+sep+thread)+sep+'r'+round);if(!path)throw new JournalError('evidence_outside','путь свидетельства вне проекта: '+thread);return realPath(path).path
}
export class Evidence {
 readonly projectRoot:string;constructor(projectRoot:string){this.projectRoot=projectRoot}
 resolve(path:unknown){return resolveEvidence(this.projectRoot,path)}checkReport(path:string){return checkReport(path)}dir(thread:string,round:number){return evidenceDir(this.projectRoot,thread,round)}
}
