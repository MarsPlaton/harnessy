import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,rmSync,rmdirSync,unlinkSync,mkdirSync,symlinkSync,existsSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadTeam,ensureLine,seedOrchestrator,addSeat,instructionsFor,roleOf,TeamError,TEMPLATES,TEAM_HEADER,dumpYaml,parseYaml,withPathLock} from './index.ts';
const temp=()=>realpathSync(mkdtempSync(join(tmpdir(),'harnessy-team-'))),failure=(code:string,text?:string)=>(e:unknown)=>e instanceof TeamError&&e.code===code&&(!text||e.message===text);
const defaults={vendor:'claude' as const,model:'model',mode:'read' as const};
test('[1-6,26] manifest form, names, modes, paths and exact errors; empty model is preserved',async()=>{
 const root=temp();try{const h=await ensureLine(root),file=join(h,'team.yaml'),put=(s:string)=>writeFileSync(file,s);
 for(const [source,message] of [
 ['seats: []','team.yaml: нужен раздел seats (таблица мест; может быть пустой)'],['seats: {owner: {}}','team.yaml: недопустимое имя места «owner» (латиница, цифры, - и _; не owner/harness/all)'],
 ['seats: {worker: x}','team.yaml: место worker должно быть таблицей'],['seats: {worker: {role: executor, vendor: claude, mode: wrong}}','team.yaml: у места worker режим «wrong», допустимы chat, read, check, web, ask, edit, all'],
 ['seats: {worker: {role: executor, vendor: codex, write_paths: [a..b]}}','team.yaml: write_paths у места worker — список относительных путей без ..'],['seats: {worker: {role: executor, vendor: codex, worktree: /tmp}}','team.yaml: worktree у места worker — относительный путь внутри проекта'],
 ['seats: {}\nmerge_roles: nope','team.yaml: merge_roles — список ролей']
 ]){put(source!);assert.throws(()=>loadTeam(h),failure('team_invalid',message))}
 put('seats:\n  worker: {vendor: codex, model: null, write_paths: [src/], role: executor}\n  foreign: {vendor: bad/id, mode: BAD}');const t=loadTeam(h);assert.equal(t.seats.worker!.model,'');assert.deepEqual(t.seats.worker!.writePaths,['src']);assert.equal(roleOf(t,'worker'),'worker');assert.equal(roleOf(t,'absent'),null);assert.equal(t.warnings[0],'место foreign: вендор «bad/id» здесь не ведётся (нужен id программы каталога) — место пропущено');
 put('seats: {foreign: {vendor: bad/id}}');assert.throws(()=>loadTeam(h),e=>e instanceof TeamError&&e.message.startsWith('team.yaml: нет ни одного места, которое здесь можно вести'));
 for(const source of ['seats: [','!!python/object/apply:os.system [bad]','version: nope\nseats: {}']){put(source);assert.throws(()=>loadTeam(h),failure('team_yaml'))}
 writeFileSync(file,Buffer.from([0xff]));assert.throws(()=>loadTeam(h),failure('team_yaml'));unlinkSync(file);assert.throws(()=>loadTeam(h),failure('team_missing'));await assert.rejects(seedOrchestrator(h,'claude','m'),failure('team_missing'));
 mkdirSync(file);assert.throws(()=>loadTeam(h),failure('team_unreadable'));
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('[7,8,21,32] templates never overwrite, missing template preflight, seed has exact Python bytes',async()=>{
 const root=temp();try{const project=join(root,'проект'),h=await ensureLine(project,{now:()=>new Date(2026,9,9,12)});assert.match(readFileSync(join(h,'MEMORY.md'),'utf8'),/Создан 09.10.2026/);
 assert.deepEqual(readFileSync(join(h,'team.yaml')),readFileSync(join(TEMPLATES,'team-empty.yaml')));writeFileSync(join(h,'roles','reviewer.md'),'owner edit');await ensureLine(project);assert.equal(readFileSync(join(h,'roles','reviewer.md'),'utf8'),'owner edit');
 assert.deepEqual(await seedOrchestrator(h,'claude','model'),{seeded:true});const bytes=readFileSync(join(h,'team.yaml'));assert.equal(bytes.toString('utf8'),readFileSync(new URL('./fixtures/seed.yaml',import.meta.url),'utf8')+'    kind: orchestrator\n');
 assert.deepEqual(await seedOrchestrator(h,'codex','other'),{seeded:false,reason:'seats_present'});assert.deepEqual(readFileSync(join(h,'team.yaml')),bytes);
 const broken=join(root,'templates');cpSync(TEMPLATES,broken,{recursive:true});unlinkSync(join(broken,'roles','tester.md'));await assert.rejects(ensureLine(join(root,'new'),{templatesDir:broken}),failure('template_missing','шаблон не найден: roles/tester.md'));assert.equal(existsSync(join(root,'new','.harness')),false);
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('[9,23,27,35] concurrent seats, canonical lock, specialization isolation and write rollback',async()=>{
 const root=temp();try{const h=await ensureLine(root),alias=root+'-link';symlinkSync(root,alias,process.platform==='win32'?'junction':'dir');try{
 const base=readFileSync(join(h,'roles','reviewer.md'),'utf8');const one=await addSeat(h,{...defaults,role:'reviewer',specialization:{title:'Юрист',text:'Проверяй договор'}}),two=await addSeat(h,{...defaults,role:'reviewer'});
 const team=loadTeam(h);assert.equal(one.instructions,'roles/seats/reviewer.md');assert.equal(one.label,'Юрист');assert.equal(two.label,'ревьюер 2');assert.equal(instructionsFor(team,one),base+'\n\nПроверяй договор');assert.equal(instructionsFor(team,two),base);
 const calls=await Promise.allSettled([addSeat(h,{...defaults,role:'tester'}),addSeat(join(alias,'.harness'),{...defaults,role:'tester'})]);assert.equal(calls.filter(r=>r.status==='fulfilled').length,1);assert.equal((calls.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'role_taken');
 await Promise.all([addSeat(h,{...defaults,role:'executor'}),addSeat(h,{...defaults,role:'executor'})]);assert.ok(loadTeam(h).seats.executor2);
 const before=readFileSync(join(h,'team.yaml'));await assert.rejects(addSeat(h,{...defaults,role:'architect',specialization:{title:'A',text:'B'}},{replace:()=>{throw Error('rename fault')}}),failure('write_failed'));assert.equal(existsSync(join(h,'roles','seats','architect.md')),false);assert.deepEqual(readFileSync(join(h,'team.yaml')),before);
 writeFileSync(join(h,'roles','seats','architect.md'),'foreign');await assert.rejects(addSeat(h,{...defaults,role:'architect',specialization:{title:'A',text:'B'}}),failure('seat_file_exists'));assert.equal(readFileSync(join(h,'roles','seats','architect.md'),'utf8'),'foreign');
 for(const specialization of [{title:'',text:'x'},{title:'x',text:''},{title:'x'.repeat(61),text:'x'},{title:'x',text:'x'.repeat(20001)}])await assert.rejects(addSeat(h,{...defaults,role:'researcher',specialization}),failure('specialization_invalid'));
 }finally{if(process.platform==='win32')rmdirSync(alias);else unlinkSync(alias)}}finally{rmSync(root,{recursive:true,force:true})}
});
test('[23] seed and ensureLine share a lock; retained unsupported vendors count for numbering and collision refuses',async()=>{
 const root=temp();try{const h=await ensureLine(root);await Promise.all([ensureLine(root),seedOrchestrator(h,'claude','m')]);assert.ok(loadTeam(h).seats.orchestrator);
 writeFileSync(join(h,'team.yaml'),'seats:\n  foreign: {role: reviewer, vendor: kimi}\n  reviewer2: {role: tester, vendor: claude}');await assert.rejects(addSeat(h,{...defaults,role:'reviewer'}),failure('seat_exists','место reviewer2 уже есть в team.yaml'));
 let active=0,peak=0;await Promise.all([1,2].map(()=>withPathLock(root,async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(r=>setImmediate(r));active--})));assert.equal(peak,1);
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('[21] PyYAML golden edge fields preserve multiline, wrapping, numeric key order and y',()=>{
 const expected=readFileSync(new URL('./fixtures/edge.yaml',import.meta.url),'utf8');assert.equal(TEAM_HEADER+dumpYaml(parseYaml(expected)),expected);
 const value=parseYaml('seats: {}\nflags: [yes, no, y, n, on, off]') as Map<string,unknown>;assert.deepEqual(value.get('flags'),[true,false,'y','n',true,false]);
});

test('[21] PyYAML scalar corpus keeps numeric strings, control characters and multiline mapping keys',()=>{
 const expected=readFileSync(new URL('./fixtures/scalars.yaml',import.meta.url),'utf8');assert.equal(dumpYaml(parseYaml(expected)),expected);
 const parsed=parseYaml('seats: {}\nvalues: [1e3, 1.0e3, 08, 0xdead, 1.0e+3, 1:20]') as Map<string,unknown>;
 assert.deepEqual(parsed.get('values'),['1e3','1.0e3','08',57005,1000,80]);
});
