import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertPrivateDirectory,assertPrivateFile,hardenPrivateDirectory,validatePrivateAcl} from './private-path.ts';

test('private storage rejects inherited Windows access and protects a directory before creating files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'harnessy-private-'));
 try{
  if(process.platform==='win32')assert.throws(()=>assertPrivateDirectory(dir),/unsafe Windows permissions/);
  hardenPrivateDirectory(dir);
  assert.equal(assertPrivateDirectory(dir).isDirectory(),true);
  const file=join(dir,'private.json');writeFileSync(file,'fixture',{mode:0o600,flag:'wx'});
  assert.equal(assertPrivateFile(file).isFile(),true);
  if(process.platform==='win32'){
   assert.notEqual(statSync(file).mode&0o777,0o600);
   execFileSync('icacls.exe',[dir,'/grant','*S-1-1-0:R'],{windowsHide:true});
   assert.throws(()=>assertPrivateDirectory(dir),/unsafe Windows permissions/);
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Windows ACL validation refuses a different owner and a foreign allow entry',()=>{
 const sid='S-1-5-21-100-200-300-1001';
 const base={current:sid,owner:sid,protected:true,rules:[{sid,type:'Allow',rights:2032127,inherited:false}]};
 assert.doesNotThrow(()=>validatePrivateAcl(base,true));
 assert.throws(()=>validatePrivateAcl({...base,owner:'S-1-5-21-100-200-300-1002'},true),/unsafe Windows permissions/);
 assert.throws(()=>validatePrivateAcl({...base,rules:[...base.rules,{sid:'S-1-1-0',type:'Allow',rights:1,inherited:false}]},true),/unsafe Windows permissions/);
});
