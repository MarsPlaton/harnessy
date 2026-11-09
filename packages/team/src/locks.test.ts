import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setImmediate as tick} from 'node:timers/promises';
import {atomicWrite,canonicalPath,renameWithRetry,withPathLock,assertPathLock,type PathLock} from './locks.ts';
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

test('Windows atomic replacement survives a short-lived reader in another process',async()=>{
 if(process.platform!=='win32')return;
 const root=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-rename-'))),path=join(root,'state.json');
 writeFileSync(path,'before');
 const child=spawn(process.execPath,['-e',"const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('ready\\n');setTimeout(()=>fs.closeSync(fd),200)",path],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 const exited=once(child,'exit');
 try{
  await once(child.stdout!,'data');
  atomicWrite(path,'after');
  assert.equal(readFileSync(path,'utf8'),'after');
  const [code]=await exited;assert.equal(code,0);
  const source=join(root,'repair.json');writeFileSync(source,'repaired');
  const holder=spawn(process.execPath,['-e',"const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('ready\\n');setTimeout(()=>fs.closeSync(fd),200)",path],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const holderExited=once(holder,'exit');
  try{await once(holder.stdout!,'data');renameWithRetry(source,path);assert.equal(readFileSync(path,'utf8'),'repaired');const [exit]=await holderExited;assert.equal(exit,0)}finally{if(holder.exitCode===null)holder.kill()}
 }finally{if(child.exitCode===null)child.kill();rmSync(root,{recursive:true,force:true})}
});
