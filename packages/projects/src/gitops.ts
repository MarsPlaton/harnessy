import {execFile} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,relative,sep,join} from 'node:path';
import {canonicalPath,withPathLock,assertPathLock,type PathLock} from '@harnessy/team';
import {ProjectError,type ProjectCode} from './errors.ts';
import {writeDirectory} from './files.ts';
import type {GitRunner,CommandResult} from './types.ts';
export function execute(binary:string,args:string[],cwd:string|undefined,timeoutMs:number):Promise<CommandResult>{return new Promise((done,fail)=>{
 execFile(binary,args,{...(cwd?{cwd}:{}),timeout:timeoutMs,encoding:'utf8',maxBuffer:16*1024*1024},(error,stdout,stderr)=>{
 if(error){const e=error as NodeJS.ErrnoException&{killed?:boolean};if(e.code==='ENOENT')return fail(new ProjectError('tool_missing',binary+': '+e.message,500,e));if(e.killed||e.code==='ETIMEDOUT')return fail(new ProjectError('tool_timeout',binary+': время ожидания истекло',500,e))}
 done({code:error?typeof error.code==='number'?error.code:1:0,stdout,stderr})
 })
})}
const systemGit:GitRunner=async(args,cwd,timeout=60)=>{const r=await execute('git',args,cwd,timeout*1000);return {...r,stdout:r.stdout.trim(),stderr:r.stderr.trim()}};
export interface MergeFacts {head:string;sha:string;branch:string;alreadyMerged:boolean;mergeSha:string|null}
export type BeforeMerge=(facts:Readonly<MergeFacts>)=>void;
type MergeRecovery={recovery?:'aborted'|'committed'|'unchanged'|'failed';cause?:{code:ProjectCode;vendorText:string}};
export type MergeResult=({ok:true;mergeSha:string|null;sha:string;alreadyMerged?:true}|{ok:false;code:'merge_failed';error:string})&MergeRecovery;
class LockedGitOps {
 private runner:GitRunner;private lock:PathLock;
 constructor(runner:GitRunner,lock:PathLock){this.runner=runner;this.lock=lock}
 async run(args:string[],cwd:string,timeout=60):Promise<CommandResult>{assertPathLock(this.lock);const result=await this.runner(args,cwd,timeout);assertPathLock(this.lock);return result}
 async isRepo(path:string){const r=await this.run(['rev-parse','--is-inside-work-tree'],path);return r.code===0&&r.stdout==='true'}
 async repoRoot(path:string){const r=await this.run(['rev-parse','--show-toplevel'],path);return r.code===0?canonicalPath(r.stdout):null}
 async ownRepo(path:string){const root=await this.repoRoot(path);return root!==null&&canonicalPath(root)===canonicalPath(path)}
 async head(path:string){const r=await this.run(['rev-parse','HEAD'],path);return r.code===0?r.stdout:null}
 async currentBranch(path:string){const r=await this.run(['rev-parse','--abbrev-ref','HEAD'],path);return r.code===0?r.stdout:null}
 async branchExists(root:string,branch:string){return (await this.run(['show-ref','--verify','--quiet','refs/heads/'+branch],root)).code===0}
 async commitExists(root:string,sha:string){return /^[0-9a-f]{7,40}$/.test(sha)&&(await this.run(['cat-file','-e',sha+'^{commit}'],root)).code===0}
 async resolveSha(root:string,sha:string){const r=await this.run(['rev-parse','--verify','--end-of-options',sha+'^{commit}'],root);return r.code===0?r.stdout:null}
 private async common(root:string){const r=await this.run(['rev-parse','--git-common-dir'],root);return r.code===0?canonicalPath(isAbsolute(r.stdout)?r.stdout:join(root,r.stdout)):null}
 async ensureExclude(root:string,pattern:string):Promise<void>{assertPathLock(this.lock,root);
 const common=await this.common(root);if(!common)return;const path=join(common,'info','exclude');try{mkdirSync(dirname(path),{recursive:true});const text=existsSync(path)?readFileSync(path,'utf8'):'';
 if(!text.split(/\r?\n/).includes(pattern))writeFileSync(path,text+(text&&!text.endsWith('\n')?'\n':'')+pattern+'\n')
 }catch(e){throw new ProjectError('write_failed','не записано: '+String(e),500,e)}
 }
 async ensureWorktree(root:string,seat:string,relPath:string,baseBranch:string):Promise<{path:string|null;note:string|null}>{assertPathLock(this.lock,root);
 const canonicalRoot=canonicalPath(root),path=canonicalPath(root+sep+relPath),rel=relative(canonicalRoot,path),branch='seat/'+seat;
 if(isAbsolute(relPath)||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))return {path:null,note:'worktree '+relPath+' вне проекта'};
 const belongs=async()=>{const top=await this.repoRoot(path);if(!top||canonicalPath(top)!==path||await this.common(root)!==await this.common(path)||await this.currentBranch(path)!==branch)return false;
 const listed=await this.run(['worktree','list','--porcelain','-z'],root);return listed.code===0&&listed.stdout.split('\0').some(line=>line.startsWith('worktree ')&&canonicalPath(line.slice(9))===path)};
 if(existsSync(path)){if(await belongs())return {path,note:null};return {path:null,note:relPath+' существует, но это не worktree этого репозитория'}}
 if(!await this.branchExists(root,baseBranch))return {path:null,note:'нет ветки '+baseBranch+': сделай первый коммит, потом worktree появятся'};
 await this.run(['worktree','prune'],root);writeDirectory(dirname(path));
 const args=await this.branchExists(root,branch)?['worktree','add',path,branch]:['worktree','add','-b',branch,path,baseBranch];
 const result=await this.run(args,root);if(result.code!==0)return {path:null,note:'worktree '+relPath+' не создан: '+(result.stderr.split('\n').at(-1)||'ошибка git')};
 if(!await belongs())return {path:null,note:relPath+' существует, но это не worktree этого репозитория'};
 await this.ensureExclude(root,relPath.includes('/')?relPath.split('/')[0]+'/':relPath);return {path,note:null}
 }
 async mergeCommitFor(root:string,sha:string,branch:string):Promise<string|null>{
 if((await this.run(['merge-base','--is-ancestor',sha,branch],root)).code!==0)return null;
 const r=await this.run(['rev-list','--merges','--ancestry-path','--reverse',sha+'..'+branch],root);return r.code===0?r.stdout.split(/\s+/)[0]||sha:sha
 }
 async mergeInto(root:string,sha:string,branch:string,message:string,beforeMerge?:BeforeMerge):Promise<MergeResult>{assertPathLock(this.lock,root);
 const failure=(error:string):MergeResult=>({ok:false,code:'merge_failed',error});const br=await this.currentBranch(root);
 if(br!==branch)return failure('корень проекта на ветке '+(br??'None')+', а не '+branch+'; переключи ветку и повтори');
 const status=await this.run(['status','--porcelain','--untracked-files=no'],root);if(status.code!==0)return failure('git status не отвечает');if(status.stdout)return failure('в корне проекта есть незакоммиченные правки; сначала закоммить или убери их');
 const full=await this.resolveSha(root,sha);if(!full)return failure('коммита '+sha+' нет в репозитории');
 const already=(await this.run(['merge-base','--is-ancestor',full,branch],root)).code===0;
 const mergeSha=already?await this.mergeCommitFor(root,full,branch):null;
 const before=await this.head(root);if(!before)return failure('слияние не подтверждено: HEAD не найден');
 // Synchronous callback: no await between authority/persistence and the first mutation.
 beforeMerge?.(Object.freeze({head:before,sha:full,branch,alreadyMerged:already,mergeSha}));
 if(already)return {ok:true,sha:full,alreadyMerged:true,mergeSha};
 try{
 const r=await this.run(['merge','--no-ff','--no-edit','-m',message,full],root);
 if(r.code!==0)return await this.recoverMerge(root,before,full,branch,new ProjectError('tool_failed',r.stderr.split('\n').at(-1)||'конфликт'));
 return await this.verifyMerge(root,before,full,branch)
 }catch(e){return this.recoverMerge(root,before,full,branch,e)}
 }
 async confirmMerge(root:string,before:string,full:string,branch:string):Promise<string|null>{
 const history=await this.run(['rev-list','--merges',branch],root);if(history.code!==0)return null;
 for(const sha of history.stdout.split(/\s+/).filter(Boolean)){const parents=await this.run(['rev-list','--parents','-n','1',sha],root);if(parents.code===0&&parents.stdout===[sha,before,full].join(' '))return sha}
 return null
 }
 private async verifyMerge(root:string,before:string,full:string,branch:string):Promise<MergeResult>{
 const failure=(error:string):MergeResult=>({ok:false,code:'merge_failed',error:'слияние не подтверждено: '+error});
 const after=await this.head(root),current=await this.currentBranch(root),parents=after?await this.run(['rev-list','--parents','-n','1',after],root):null;
 if(current!==branch)return failure('текущая ветка '+String(current)+', ожидалась '+branch);
 if(!after||after===before)return failure('HEAD не изменился');
 if(!parents||parents.code!==0||parents.stdout!==[after,before,full].join(' '))return failure('родители HEAD не совпадают с прежним HEAD и sha');
 return {ok:true,mergeSha:after,sha:full}
 }
 private async recoverMerge(root:string,before:string,full:string,branch:string,error:unknown):Promise<MergeResult>{
 const reason=error instanceof ProjectError?{code:error.code,vendorText:error.vendorText}:{code:'tool_failed' as const,vendorText:error instanceof Error?error.message:String(error)};
 const failure=(text:string,recovery:NonNullable<MergeRecovery['recovery']>):MergeResult=>({ok:false,code:'merge_failed',error:text,recovery,cause:reason});
 try{
 const pending=await this.run(['rev-parse','--verify','--quiet','MERGE_HEAD'],root);
 if(pending.code===0){
 const abort=await this.run(['merge','--abort'],root);
 if(abort.code!==0)return failure('слияние не прошло, откат не удался: '+(abort.stderr.split('\n').at(-1)||'ошибка git'),'failed');
 const stillPending=await this.run(['rev-parse','--verify','--quiet','MERGE_HEAD'],root),head=await this.head(root),current=await this.currentBranch(root),status=await this.run(['status','--porcelain','--untracked-files=no'],root);
 if(stillPending.code!==1||head!==before||current!==branch||status.code!==0||status.stdout)return failure('слияние не прошло, откат не удался: состояние репозитория не восстановлено','failed');
 return failure('слияние не прошло, откачено: '+reason.vendorText,'aborted')
 }
 if(pending.code!==1)return failure('слияние не прошло, откат не удался: состояние MERGE_HEAD не определено','failed');
 const verified=await this.verifyMerge(root,before,full,branch);
 if(verified.ok)return {...verified,recovery:'committed',cause:reason};
 const head=await this.head(root),current=await this.currentBranch(root),status=await this.run(['status','--porcelain','--untracked-files=no'],root);
 if(head===before&&current===branch&&status.code===0&&!status.stdout)return failure('слияние не прошло: '+reason.vendorText,'unchanged');
 return failure(verified.error,'failed')
 }catch(e){return failure('слияние не прошло, откат не удался: '+(e instanceof Error?e.message:String(e)),'failed')}

 }
}
const runners=new WeakMap<GitOps,GitRunner>();
// Internal composition port; not exported by the package entry point.
export function withGitLock<T>(git:GitOps,root:string,fn:(git:LockedGitOps,lock:PathLock)=>T|Promise<T>):Promise<T>{
 const runner=runners.get(git);if(!runner)throw Error('неизвестный экземпляр GitOps');
 return withPathLock(root,lock=>fn(new LockedGitOps(runner,lock),lock))
}
export class GitOps {
 constructor(runner:GitRunner=systemGit){runners.set(this,runner)}
 private withLock<T>(root:string,fn:(git:LockedGitOps,lock:PathLock)=>T|Promise<T>):Promise<T>{return withGitLock(this,root,fn)}
 run(args:string[],cwd:string,timeout=60){return this.withLock(cwd,g=>g.run(args,cwd,timeout))}
 isRepo(path:string){return this.withLock(path,g=>g.isRepo(path))}
 repoRoot(path:string){return this.withLock(path,g=>g.repoRoot(path))}
 ownRepo(path:string){return this.withLock(path,g=>g.ownRepo(path))}
 head(path:string){return this.withLock(path,g=>g.head(path))}
 currentBranch(path:string){return this.withLock(path,g=>g.currentBranch(path))}
 branchExists(root:string,branch:string){return this.withLock(root,g=>g.branchExists(root,branch))}
 commitExists(root:string,sha:string){return this.withLock(root,g=>g.commitExists(root,sha))}
 resolveSha(root:string,sha:string){return this.withLock(root,g=>g.resolveSha(root,sha))}
 ensureExclude(root:string,pattern:string){return this.withLock(root,g=>g.ensureExclude(root,pattern))}
 ensureWorktree(root:string,seat:string,relPath:string,baseBranch:string){return this.withLock(root,g=>g.ensureWorktree(root,seat,relPath,baseBranch))}
 mergeCommitFor(root:string,sha:string,branch:string){return this.withLock(root,g=>g.mergeCommitFor(root,sha,branch))}
 mergeInto(root:string,sha:string,branch:string,message:string,beforeMerge?:BeforeMerge){return this.withLock(root,g=>g.mergeInto(root,sha,branch,message,beforeMerge))}
 confirmMerge(root:string,before:string,full:string,branch:string){return this.withLock(root,g=>g.confirmMerge(root,before,full,branch))}
}
export const gitops=new GitOps();
export const run=gitops.run.bind(gitops),isRepo=gitops.isRepo.bind(gitops),ownRepo=gitops.ownRepo.bind(gitops),repoRoot=gitops.repoRoot.bind(gitops),head=gitops.head.bind(gitops),currentBranch=gitops.currentBranch.bind(gitops),branchExists=gitops.branchExists.bind(gitops),commitExists=gitops.commitExists.bind(gitops),resolveSha=gitops.resolveSha.bind(gitops),ensureExclude=gitops.ensureExclude.bind(gitops),ensureWorktree=gitops.ensureWorktree.bind(gitops),mergeCommitFor=gitops.mergeCommitFor.bind(gitops),mergeInto=gitops.mergeInto.bind(gitops);
