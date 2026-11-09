import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,mkdirSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withPathLock,ensureLine,addSeatLocked,TeamError,loadTeam,type PathLock} from './index.ts';
const args={role:'executor',vendor:'claude' as const,model:'m',mode:'read' as const,specialization:{title:'эксперт',text:'Задача.'}};
async function setup(t:test.TestContext){const root=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-seat-')));t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,h:await ensureLine(root)}}
test('54: addSeatLocked requires the exact live project acquisition, not a forged or released token',async t=>{
 const {root,h}=await setup(t);assert.throws(()=>addSeatLocked({path:root} as PathLock,h,args),/блокировка пути не действует/);let old!:PathLock;await withPathLock(root,lock=>{old=lock;const seat=addSeatLocked(lock,h,args);assert.equal(seat.id,'executor')});
 assert.throws(()=>addSeatLocked(old,h,{...args,role:'reviewer'}),/блокировка пути не действует/);assert.equal(loadTeam(h).seats.reviewer,undefined);
});
test('53/54: saved specialization recovers own exact file and cleans only a file it created on manifest failure',async t=>{
 const {root,h}=await setup(t),path='roles/seats/executor.md',content=readFileSync(join(h,'roles/executor.md'),'utf8')+'\n\nЗадача.';mkdirSync(join(h,'roles/seats'));writeFileSync(join(h,path),content);
 const material={sid:'executor',instructions:path,file:{path,content},acceptExisting:true};
 await assert.rejects(withPathLock(root,lock=>addSeatLocked(lock,h,args,{replace(){throw Error('manifest cut')}},material)),e=>e instanceof TeamError&&e.code==='write_failed');assert.equal(readFileSync(join(h,path),'utf8'),content);assert.equal(loadTeam(h).seats.executor,undefined);
 const seat=await withPathLock(root,lock=>addSeatLocked(lock,h,args,{},material));assert.equal(seat.instructions,path);assert.equal(loadTeam(h).seats.executor!.label,'эксперт');
 await assert.rejects(withPathLock(root,lock=>addSeatLocked(lock,h,{...args,specialization:{title:'второй',text:'x'}},{replace(){throw Error('manifest cut')}})),/manifest cut/);assert.equal(existsSync(join(h,'roles/seats/executor2.md')),false);assert.equal(readFileSync(join(h,path),'utf8'),content);
});
test('53/54: mismatched existing file and symlink specialization are never accepted as owned',async t=>{
 const {root,h}=await setup(t);mkdirSync(join(h,'roles/seats'));const path='roles/seats/executor.md';writeFileSync(join(h,path),'foreign');
 const material={sid:'executor',instructions:path,file:{path,content:'saved'},acceptExisting:true};await assert.rejects(withPathLock(root,lock=>addSeatLocked(lock,h,args,{},material)),e=>e instanceof TeamError&&e.code==='seat_file_exists');assert.equal(readFileSync(join(h,path),'utf8'),'foreign');
 rmSync(join(h,path));writeFileSync(join(root,'external.md'),'saved');await t.test('file symlink specialization is rejected',async sub=>{try{symlinkSync(join(root,'external.md'),join(h,path))}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){sub.skip('Windows file symlink requires privilege');return}throw e}await assert.rejects(withPathLock(root,lock=>addSeatLocked(lock,h,args,{},material)),e=>e instanceof TeamError&&e.code==='seat_file_exists')});assert.equal(loadTeam(h).seats.executor,undefined);
});
