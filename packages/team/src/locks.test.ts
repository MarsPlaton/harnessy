import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as tick} from 'node:timers/promises';
import {canonicalPath,withPathLock,assertPathLock,type PathLock} from './locks.ts';
import {ensureLineLocked} from './templates.ts';

test('[r2:1] detached child cannot inherit ownership after release; expired and forged tokens refuse',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-lock-')));try{
 let releaseChild!:()=>void;const ready=new Promise<void>(r=>{releaseChild=r});let child!:Promise<void>,entered=false,saved!:PathLock;
 await withPathLock(root,lock=>{saved=lock;assertPathLock(lock,root);child=(async()=>{await ready;return withPathLock(root,()=>{entered=true})})()});
 assert.throws(()=>ensureLineLocked(saved,root),/блокировка пути не действует/);
 assert.throws(()=>assertPathLock({path:root} as PathLock),/блокировка пути не действует/);
 await withPathLock(root,async()=>{releaseChild();await tick();assert.equal(entered,false)});
 await child;assert.equal(entered,true);
 }finally{rmSync(root,{recursive:true,force:true})}
});

test('Windows mixed separators identify the same path before its final directory exists',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-lock-path-')));try{
  const native=join(root,'future','child');
  const mixed=root+'\\future/child';
  if(process.platform==='win32')assert.equal(canonicalPath(mixed),canonicalPath(native));
 }finally{rmSync(root,{recursive:true,force:true})}
});
