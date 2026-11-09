import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {GitOps,execute,withGitLock} from './gitops.ts';
import {openProjectGit,writableRoots} from './project.ts';
import {temp,repo,seedRepo,git,failure,response} from './test-support.ts';
import {canonicalPath,withPathLock,type Seat} from '@harnessy/team';
import {setImmediate as tick} from 'node:timers/promises';
import {ProjectError} from './errors.ts';
const seat:Seat={id:'executor',role:'executor',kind:'worker',label:'воркер',vendor:'codex',model:'model',mode:'ask',digest:false,writePaths:[],instructions:null,worktree:'.worktrees/executor'};
test('TS-45.3: copied Git seeds retain independent indexes, objects and branches',()=>{
 const first=temp(),second=temp();try{
  const base=seedRepo(first.root);assert.equal(seedRepo(second.root),base);
  assert.equal(canonicalPath(git(first.root,'rev-parse','--show-toplevel')),first.root);
  assert.equal(canonicalPath(git(second.root,'rev-parse','--show-toplevel')),second.root);
  const object=join('.git','objects',base.slice(0,2),base.slice(2));
  for(const path of ['base.txt','.git/index',object])assert.notEqual(statSync(join(first.root,path)).ino,statSync(join(second.root,path)).ino,path);
  writeFileSync(join(first.root,'base.txt'),'changed');git(first.root,'add','base.txt');git(first.root,'commit','-qm','different');
  assert.notEqual(git(first.root,'rev-parse','HEAD'),base);assert.equal(git(second.root,'rev-parse','HEAD'),base);
  assert.equal(readFileSync(join(second.root,'base.txt'),'utf8'),'base\n');assert.equal(git(second.root,'status','--porcelain'),'');
  assert.throws(()=>seedRepo(first.root),/already has Git metadata/);
 }finally{first.close();second.close()}
});
test('[10-12,22] real worktree ownership, branch, symlink boundary and repeated opening',async()=>{
 const t=temp(),outside=temp(),g=new GitOps();try{
 git(t.root,'init','-q','-b','main');assert.equal((await g.ensureWorktree(t.root,'executor','.worktrees/executor','main')).note,'нет ветки main: сделай первый коммит, потом worktree появятся');repo(t.root);
 const opened=await openProjectGit(t.root,[seat,{...seat,id:'orchestrator',worktree:null}],'main',g);assert.deepEqual(opened.lineErrors,[]);assert.equal(opened.branchBySeat.executor,'seat/executor');assert.equal(opened.cwdBySeat.orchestrator,t.root);
 assert.deepEqual((await openProjectGit(t.root,[seat],'main',g)).worktreeBySeat, {executor:join(t.root,'.worktrees/executor')});
 assert.match(readFileSync(join(t.root,'.git/info/exclude'),'utf8'),/\.worktrees\//);assert.deepEqual(writableRoots(t.root,true),[join(t.root,'.git'),join(t.root,'.harness/evidence')]);assert.deepEqual(writableRoots(null,true),[]);
 const wt=opened.cwdBySeat.executor!;git(wt,'checkout','-q','--detach');assert.match((await g.ensureWorktree(t.root,'executor','.worktrees/executor','main')).note!,/не worktree этого репозитория/);git(wt,'checkout','-q','seat/executor');
 const foreign=join(t.root,'foreign');mkdirSync(foreign);seedRepo(foreign);assert.match((await g.ensureWorktree(t.root,'foreign','foreign','main')).note!,/не worktree этого репозитория/);
 mkdirSync(join(t.root,'plain'));assert.match((await g.ensureWorktree(t.root,'plain','plain','main')).note!,/не worktree/);
 symlinkSync(outside.root,join(t.root,'outside'),process.platform==='win32'?'junction':'dir');assert.equal((await g.ensureWorktree(t.root,'outside','outside/new','main')).note,'worktree outside/new вне проекта');
 const nested=join(t.root,'plain'),o=await openProjectGit(nested,[seat],'main',g);assert.equal(o.repoRoot,null);assert.ok(o.lineErrors.some(x=>x.includes('чужого git-репозитория')));
 }finally{t.close();outside.close()}
});
test('[13,14,25,34] merge validates parents, repeated merge is idempotent, tracked dirt and conflict refuse',async()=>{
 const t=temp(),g=new GitOps();try{const base=seedRepo(t.root);git(t.root,'checkout','-qb','feature');writeFileSync(join(t.root,'feature.txt'),'feature');git(t.root,'add','.');git(t.root,'commit','-qm','feature');const sha=git(t.root,'rev-parse','HEAD');
 assert.equal((await g.mergeInto(t.root,sha,'main','merge')).ok,false);git(t.root,'checkout','-q','main');
 assert.equal(await g.mergeCommitFor(t.root,sha,'main'),null);writeFileSync(join(t.root,'base.txt'),'dirty');const dirty=await g.mergeInto(t.root,sha,'main','merge');assert.equal(dirty.ok,false);git(t.root,'checkout','--','base.txt');
 assert.equal((await g.mergeInto(t.root,'deadbeef','main','merge')).ok,false);writeFileSync(join(t.root,'untracked.txt'),'allowed');const merged=await g.mergeInto(t.root,sha,'main','merge');assert.equal(merged.ok,true);if(!merged.ok)return;
 assert.deepEqual(git(t.root,'rev-list','--parents','-n','1','HEAD').split(' '),[merged.mergeSha,base,sha]);assert.equal(await g.mergeCommitFor(t.root,sha,'main'),merged.mergeSha);
 const repeat=await g.mergeInto(t.root,sha,'main','again');assert.equal(repeat.ok&&repeat.alreadyMerged,true);assert.equal(git(t.root,'rev-parse','HEAD'),merged.mergeSha);
 git(t.root,'checkout','-qb','conflict',base);writeFileSync(join(t.root,'base.txt'),'left');git(t.root,'commit','-qam','left');const conflict=git(t.root,'rev-parse','HEAD');git(t.root,'checkout','-q','main');writeFileSync(join(t.root,'base.txt'),'right');git(t.root,'commit','-qam','right');const before=git(t.root,'rev-parse','HEAD');
 const failed=await g.mergeInto(t.root,conflict,'main','conflict');assert.ok(!failed.ok&&failed.error.startsWith('слияние не прошло, откачено:'));assert.equal(git(t.root,'rev-parse','HEAD'),before);assert.equal(git(t.root,'status','--porcelain','--untracked-files=no'),'');
 }finally{t.close()}
});
test('[25] abort failure and successful git with wrong parents never claim success',async()=>{
 const t=temp();try{for(const mode of ['abort','parents'] as const){let merged=false;const g=new GitOps(async args=>{
 if(args[0]==='rev-parse'&&args[1]==='--abbrev-ref')return response('main');if(args[0]==='status')return response();if(args.at(-1)==='MERGE_HEAD')return response('b'.repeat(40),mode==='abort'?0:1);if(args[0]==='rev-parse'&&args[1]==='--verify')return response('b'.repeat(40));if(args[0]==='merge-base')return response('',1);
 if(args[0]==='rev-parse')return response((merged?'c':'a').repeat(40));if(args[0]==='merge'){if(mode==='abort')return response('',1,args[1]==='--abort'?'abort failed':'conflict');merged=true;return response()}
 return response('c'.repeat(40)+' '+'a'.repeat(40)+' '+'d'.repeat(40))});
 const r=await g.mergeInto(t.root,'bbb','main','m');assert.equal(r.ok,false);if(!r.ok)assert.match(r.error,mode==='abort'?/откат не удался: abort failed/:/слияние не подтверждено: родители/)}
 }finally{t.close()}
});
test('[26] missing tool and real bounded subprocess timeout are typed',async()=>{
 await assert.rejects(execute('/nonexistent/harnessy-tool',[],undefined,100),failure('tool_missing'));
 await assert.rejects(execute(process.execPath,['-e','setInterval(()=>{},1000)'],undefined,25),failure('tool_timeout'));
});

test('[25] concurrent merges from two instances and a symlink share the canonical root lock',async()=>{
 const t=temp();try{const base=seedRepo(t.root),sha:string[]=[];
 for(const name of ['one','two']){git(t.root,'checkout','-qb',name,base);writeFileSync(join(t.root,name+'.txt'),name);git(t.root,'add','.');git(t.root,'commit','-qm',name);sha.push(git(t.root,'rev-parse','HEAD'))}
 git(t.root,'checkout','-q','main');const alias=join(t.root,'alias');symlinkSync(t.root,alias,process.platform==='win32'?'junction':'dir');
 const [one,two]=await Promise.all([new GitOps().mergeInto(t.root,sha[0]!,'main','one'),new GitOps().mergeInto(alias,sha[1]!,'main','two')]);
 assert.ok(one.ok&&two.ok);if(!one.ok||!two.ok)return;
 assert.deepEqual(git(t.root,'rev-list','--parents','-n','1',one.mergeSha!).split(' '),[one.mergeSha,base,sha[0]]);
 assert.deepEqual(git(t.root,'rev-list','--parents','-n','1',two.mergeSha!).split(' '),[two.mergeSha,one.mergeSha,sha[1]]);
 assert.equal(git(t.root,'rev-parse','HEAD'),two.mergeSha);
 }finally{t.close()}
});

test('[r2:1] public merges inside a parent acquisition queue until release and never overlap git',async()=>{
 const t=temp();try{const base=seedRepo(t.root),sha:string[]=[];
 for(const name of ['one','two']){git(t.root,'checkout','-qb',name,base);writeFileSync(join(t.root,name+'.txt'),name);git(t.root,'add','.');git(t.root,'commit','-qm',name);sha.push(git(t.root,'rev-parse','HEAD'))}
 git(t.root,'checkout','-q','main');let active=0,peak=0,calls=0;
 const g=new GitOps(async(args,cwd,timeout=60)=>{active++;calls++;peak=Math.max(peak,active);try{const r=await execute('git',args,cwd,timeout*1000);return {...r,stdout:r.stdout.trim(),stderr:r.stderr.trim()}}finally{active--}});
 let pending!:Promise<Awaited<ReturnType<GitOps['mergeInto']>>[]>;
 await withPathLock(t.root,async()=>{pending=Promise.all(sha.map((s,i)=>g.mergeInto(t.root,s,'main',String(i))));await tick();assert.equal(calls,0)});
 const result=await pending;assert.ok(result.every(r=>r.ok));assert.equal(peak,1);
 const one=result[0]!,two=result[1]!;assert.ok(one.ok&&two.ok);if(one.ok&&two.ok){assert.deepEqual(git(t.root,'rev-list','--parents','-n','1',one.mergeSha!).split(' '),[one.mergeSha,base,sha[0]]);assert.deepEqual(git(t.root,'rev-list','--parents','-n','1',two.mergeSha!).split(' '),[two.mergeSha,one.mergeSha,sha[1]])}
 }finally{t.close()}
});

test('[r2:2] exceptions after real merge recover conflict, recognize a committed merge and verify abort',async t=>{
 for(const mode of ['conflict','committed','inspection','abort_lies','unchanged'] as const)await t.test(mode,async()=>{
 const f=temp();try{const base=seedRepo(f.root);git(f.root,'checkout','-qb','feature');writeFileSync(join(f.root,mode==='conflict'||mode==='abort_lies'?'base.txt':'feature.txt'),'feature');git(f.root,'add','.');git(f.root,'commit','-qm','feature');const sha=git(f.root,'rev-parse','HEAD');git(f.root,'checkout','-q','main');
 if(mode==='conflict'||mode==='abort_lies'){writeFileSync(join(f.root,'base.txt'),'main');git(f.root,'commit','-qam','main')}
 const before=git(f.root,'rev-parse','HEAD');let injected=false,merged=false,aborts=0;
 const g=new GitOps(async(args,cwd,timeout=60)=>{
 if(args[0]==='merge'&&args[1]==='--abort'){aborts++;if(mode==='abort_lies')return response()}
 if(args[0]==='merge'&&args[1]==='--no-ff'&&!injected){
 const r=mode!=='unchanged'?await execute('git',args,cwd,timeout*1000):response();merged=true;
 if(mode!=='inspection'){injected=true;throw new ProjectError('tool_timeout','git: время ожидания истекло',500)}
 return {...r,stdout:r.stdout.trim(),stderr:r.stderr.trim()}
 }
 if(merged&&mode==='inspection'&&!injected&&args[0]==='rev-parse'&&args[1]==='HEAD'){injected=true;throw new ProjectError('tool_failed','HEAD inspection failed',500)}
 const r=await execute('git',args,cwd,timeout*1000);return {...r,stdout:r.stdout.trim(),stderr:r.stderr.trim()}
 });
 const result=await g.mergeInto(f.root,sha,'main','merge');assert.equal(result.cause?.code,mode==='inspection'?'tool_failed':'tool_timeout');
 if(mode==='committed'||mode==='inspection'){assert.equal(result.ok,true);assert.equal(result.recovery,'committed');assert.equal(aborts,0);assert.deepEqual(git(f.root,'rev-list','--parents','-n','1','HEAD').split(' '),[git(f.root,'rev-parse','HEAD'),before,sha]);assert.equal((await g.mergeInto(f.root,sha,'main','retry')).ok,true)}
 else if(mode==='abort_lies'){assert.equal(result.ok,false);assert.equal(result.recovery,'failed');if(!result.ok)assert.match(result.error,/откат не удался/);assert.equal(existsSync(join(f.root,'.git/MERGE_HEAD')),true);git(f.root,'merge','--abort')}
 else{assert.equal(result.ok,false);assert.equal(result.recovery,mode==='conflict'?'aborted':'unchanged');assert.equal(existsSync(join(f.root,'.git/MERGE_HEAD')),false);assert.equal(git(f.root,'status','--porcelain','--untracked-files=no'),'');assert.equal(git(f.root,'rev-parse','HEAD'),before);assert.equal(aborts,mode==='conflict'?1:0);
 git(f.root,'checkout','-qb','next',base);writeFileSync(join(f.root,'next.txt'),'next');git(f.root,'add','.');git(f.root,'commit','-qm','next');const next=git(f.root,'rev-parse','HEAD');git(f.root,'checkout','-q','main');assert.equal((await g.mergeInto(f.root,next,'main','next')).ok,true)}
 }finally{f.close()}
 })
});

test('[r2:1] an escaped internal git operation loses ownership when its acquisition ends',async()=>{
 const t=temp();try{seedRepo(t.root);const g=new GitOps();let escaped!:()=>Promise<string|null>;
 await withGitLock(g,t.root,scoped=>{escaped=()=>scoped.head(t.root)});
 await assert.rejects(escaped(),/блокировка пути не действует/);assert.ok(await g.head(t.root));
 }finally{t.close()}
});


test('64: beforeMerge sees actual HEAD under lock; a thrown persistence/scope check forbids mutation',async()=>{
 const t=temp(),g=new GitOps();try{const base=seedRepo(t.root);git(t.root,'checkout','-qb','feature');writeFileSync(join(t.root,'new.txt'),'new');git(t.root,'add','.');git(t.root,'commit','-qm','new');const sha=git(t.root,'rev-parse','HEAD');git(t.root,'checkout','-q','main');
 await assert.rejects(g.mergeInto(t.root,sha,'main','m',facts=>{assert.deepEqual(facts,{head:base,sha,branch:'main',alreadyMerged:false,mergeSha:null});throw Error('intent write failed')}),/intent write failed/);assert.equal(git(t.root,'rev-parse','HEAD'),base);assert.equal(existsSync(join(t.root,'.git/MERGE_HEAD')),false);
 let checked=0;const r=await g.mergeInto(t.root,sha,'main','m',()=>{checked++});assert.ok(r.ok&&r.mergeSha);assert.equal(checked,1);if(r.ok)assert.equal(await g.confirmMerge(t.root,base,sha,'main'),r.mergeSha);
 const repeat=await g.mergeInto(t.root,sha,'main','m',facts=>{assert.equal(facts.alreadyMerged,true);checked++});assert.ok(repeat.ok&&repeat.alreadyMerged);assert.equal(checked,2);assert.equal(await g.confirmMerge(t.root,base,'a'.repeat(40),'main'),null);
 }finally{t.close()}
});
