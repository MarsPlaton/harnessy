import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ProjectError} from './errors.ts';
export const failure=(code:string,text?:string)=>(e:unknown)=>e instanceof ProjectError&&e.code===code&&(!text||e.message===text);
export function temp(){const root=realpathSync.native(mkdtempSync(join(tmpdir(),'harnessy-projects-')));return {root,close:()=>rmSync(root,{recursive:true,force:true})}}
export function git(root:string,...args:string[]){return execFileSync('git',args,{cwd:root,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}}).trim()}
export function repo(root:string){git(root,'init','-q','-b','main');git(root,'config','user.email','test@example.invalid');git(root,'config','user.name','Test');git(root,'config','commit.gpgsign','false');writeFileSync(join(root,'base.txt'),'base\n');git(root,'add','.');git(root,'commit','-qm','base');return git(root,'rev-parse','HEAD')}
const seeds=new Map<string,{root:string;close:()=>void;sha:string}>();
process.once('exit',()=>{for(const seed of seeds.values())seed.close()});
// Copy files, index and objects, never hard-link them: each consumer owns its
// Git state and may branch, create worktrees, merge and restart independently.
export function seedRepo(root:string,files:Record<string,string>={'base.txt':'base\n'}):string {
 if(existsSync(join(root,'.git')))throw Error('seed target already has Git metadata');
 const entries=Object.entries(files).sort(([a],[b])=>a.localeCompare(b)),key=JSON.stringify(entries);
 for(const [name,content] of entries){
  if(name.startsWith('/')||name.split('/').some(part=>part==='..'||part==='.git'))throw Error('invalid seed path');
  const target=join(root,name);if(existsSync(target)&&readFileSync(target,'utf8')!==content)throw Error('seed target has different contents: '+name);
 }
 let seed=seeds.get(key);
 if(!seed){
  const source=temp();try{
   git(source.root,'init','-q','-b','main');git(source.root,'config','user.email','test@example.invalid');git(source.root,'config','user.name','Test');git(source.root,'config','commit.gpgsign','false');
   for(const [name,content] of entries){const path=join(source.root,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content)}
   git(source.root,'add','--',...entries.map(([name])=>name));git(source.root,'commit','-qm','base');
   seed={...source,sha:git(source.root,'rev-parse','HEAD')};seeds.set(key,seed);
  }catch(error){source.close();throw error}
 }
 cpSync(seed.root,root,{recursive:true});return seed.sha;
}
export const response=(stdout='',code=0,stderr='')=>({code,stdout,stderr});
