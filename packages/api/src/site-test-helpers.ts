import {execFileSync} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
let localSite:string|undefined;
// The full runner builds once before workers start. Direct file runs share one
// build within their worker; neither path writes the developer's out/site.
export function buildTestSite():string {
 const directory=mkdtempSync(join(tmpdir(),'harnessy-test-site-')),site=join(directory,'site');
 try{const windows=process.platform==='win32';execFileSync(windows?'python':'python3',[...(windows?['-X','utf8']:[]),'ui/deploy/build.py','--out',site],{cwd:root,stdio:'pipe'})}
 catch(error){rmSync(directory,{recursive:true,force:true});throw error}
 process.on('exit',()=>rmSync(directory,{recursive:true,force:true}));
 return site;
}
export function testSite():string {
 return process.env.HARNESSY_TEST_SITE??(localSite??=buildTestSite());
}
// Mutating guard scenarios always get distinct inodes and their own cleanup.
export function copyTestSite():{site:string;close:()=>void} {
 const directory=mkdtempSync(join(tmpdir(),'harnessy-test-site-copy-')),site=join(directory,'site');
 try{cpSync(testSite(),site,{recursive:true})}catch(error){rmSync(directory,{recursive:true,force:true});throw error}
 return {site,close:()=>rmSync(directory,{recursive:true,force:true})};
}
