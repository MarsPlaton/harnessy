import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverProgramPath} from './path-recovery.ts';
import {claudeBinary} from './env.ts';
import type {spawnSync} from 'node:child_process';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';

test('TS-33: bare Finder PATH gets the login-shell PATH once, then known program directories',()=>{
 let calls=0;const run=((file:string,args:string[],options:any)=>{calls++;assert.equal(file,'/bin/zsh');assert.deepEqual(args,['-lc','printf %s "$PATH"']);assert.equal(options.timeout,3000);assert.equal(options.killSignal,'SIGKILL');return {status:0,stdout:'/test/home/.local/bin:/usr/bin'}}) as unknown as typeof spawnSync;
 const value=recoverProgramPath({HOME:'/test/home',SHELL:'/bin/zsh',PATH:'/usr/bin:/bin'},run,'darwin');
 assert.equal(calls,1);assert.equal(value.source,'login-shell');assert.equal(value.searched[0],'/test/home/.local/bin');assert.ok(value.searched.includes('/opt/homebrew/bin'));
 assert.equal(value.path.split(':').filter(x=>x==='/usr/bin').length,1);
});

test('TS-33: shell timeout falls back to known directories; complete PATH never starts a shell',()=>{
 const fail=((_file:string,_args:string[],options:any)=>{assert.equal(options.timeout,3000);assert.equal(options.killSignal,'SIGKILL');return {status:null,stdout:''}}) as unknown as typeof spawnSync;
 const fallback=recoverProgramPath({HOME:'/test/home',PATH:'/usr/bin:/bin'},fail,'darwin');assert.equal(fallback.source,'known-directories');assert.ok(fallback.searched.includes('/test/home/.local/bin'));
 const complete=recoverProgramPath({HOME:'/test/home',PATH:'/test/home/.local/bin:/usr/bin'},(()=>{throw Error('shell must not run')}) as typeof spawnSync,'darwin');assert.equal(complete.source,'existing');
});

test('Windows PATH recovery preserves drive letters and spaces without invoking a shell',()=>{
 const require=createRequire(import.meta.url),desktop=require('../../../ui/desktop/path-recovery.js') as {recoverProgramPath:typeof recoverProgramPath};
 const env={USERPROFILE:'C:\\Users\\Test Owner',LOCALAPPDATA:'C:\\Users\\Test Owner\\AppData\\Local',APPDATA:'C:\\Users\\Test Owner\\AppData\\Roaming',PATH:'C:\\Program Files\\Claude;C:\\Windows\\System32'};
 const forbidden=(()=>{throw Error('Windows recovery must not start a shell')}) as typeof spawnSync;
 for(const recover of [recoverProgramPath,desktop.recoverProgramPath]){
  const result=recover(env,forbidden,'win32');assert.equal(result.searched[0],'C:\\Program Files\\Claude');assert.ok(result.searched.includes('C:\\Users\\Test Owner\\AppData\\Local\\Microsoft\\WinGet\\Links'));assert.equal(result.path.split(';').length,result.searched.length);
 }
});

test('Windows Claude binary discovery finds a native executable on PATH',{skip:process.platform!=='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'harnessy-claude-bin-')),directory=join(root,'Program Files');t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(directory);const binary=join(directory,'claude.exe');writeFileSync(binary,'fixture');
 assert.equal(await claudeBinary({USERPROFILE:root,PATH:directory},'win32'),binary);
});

test('TS-33: a login shell ignoring SIGTERM cannot hold either PATH recovery beyond its deadline',{skip:process.platform==='win32'},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'harnessy-path-deadline-')),shell=join(dir,'shell');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(shell,'#!/bin/sh\ntrap "" TERM\nwhile :; do /bin/sleep 1; done\n',{mode:0o700});
 for(const kind of ['providers','desktop']){
  const file=kind==='providers'?new URL('./path-recovery.ts',import.meta.url).href:new URL('../../../ui/desktop/path-recovery.js',import.meta.url).pathname;
  const code=kind==='providers'?`import {recoverProgramPath} from ${JSON.stringify(file)}; console.log(JSON.stringify(recoverProgramPath()));`:`const {recoverProgramPath}=require(${JSON.stringify(file)}); console.log(JSON.stringify(recoverProgramPath()));`;
  const started=Date.now(),output=await new Promise<string>((resolve,reject)=>{
   const args=kind==='providers'?['--input-type=module','-e',code]:['-e',code];
   const child=spawn(process.execPath,args,{env:{HOME:dir,SHELL:shell,PATH:'/usr/bin:/bin'},detached:true,stdio:['ignore','pipe','pipe']});
   let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
   const watchdog=setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}reject(Error(kind+' PATH lookup exceeded its deadline'))},6500);
   child.once('error',error=>{clearTimeout(watchdog);reject(error)});
   child.once('close',(status,signal)=>{clearTimeout(watchdog);if(child.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}status===0?resolve(stdout):reject(Error(kind+' PATH lookup failed: '+signal+' '+stderr))});
  });
  assert.ok(Date.now()-started<5500,kind+' exceeded the 3s shell timeout');
  const recovered=JSON.parse(output);assert.equal(recovered.source,'known-directories');assert.ok(recovered.searched.includes(join(dir,'.local/bin')));
 }
});
