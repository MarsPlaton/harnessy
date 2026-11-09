import test from 'node:test';
import assert from 'node:assert/strict';
import {symlinkSync,linkSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,call} from './test-helpers.ts';
import {PROTO_ENTRY} from './server.ts';

test('191–193: корень не отдаёт старое окно и не берёт адрес перехода из Host или запроса',async t=>{
 const h=await fixture(t);
 for(const path of ['/','/?x=1','/?next=https%3A%2F%2Fany.invalid%2F','http://any.invalid/?next=//other.invalid/'])for(const method of ['GET','HEAD']){
 const root=await call(h.api,path,{method,headers:{Host:'any.invalid'}});
 assert.equal(root.status,302,path);assert.equal(root.headers.location,PROTO_ENTRY);assert.equal(root.headers['cache-control'],'no-store');assert.equal(root.text,method==='HEAD'?'':PROTO_ENTRY+'\n');
 }
 for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']){const root=await call(h.api,'/',{method});assert.equal(root.status,405,method);assert.equal(root.headers.allow,'GET,HEAD');assert.equal(root.headers.location,undefined)}
 const other=await call(h.api,'/any.invalid?next=/');assert.equal(other.status,404);assert.equal(other.headers.location,undefined);
});

test('194: отсутствие папки прототипа не превращает вход движка в ошибку',async t=>{
 const h=await fixture(t);rmSync(h.siteDir,{recursive:true});
 for(const method of ['GET','HEAD']){const root=await call(h.api,'/',{method});assert.equal(root.status,302);assert.equal(root.headers.location,PROTO_ENTRY);assert.equal(root.headers['cache-control'],'no-store');assert.equal(root.text,method==='HEAD'?'':PROTO_ENTRY+'\n')}
 assert.equal((await call(h.api,PROTO_ENTRY)).status,404);
});

test('4/15/20/71: canonical static file, nocache on errors, no listing, encoded paths/symlink boundaries rejected',async t=>{
 const h=await fixture(t);mkdirSync(join(h.dir,'outside'));writeFileSync(join(h.dir,'outside','secret.txt'),'secret');writeFileSync(join(h.dir,'secret.txt'),'secret');symlinkSync(join(h.dir,'outside'),join(h.siteDir,'link'),process.platform==='win32'?'junction':'dir');if(process.platform==='win32')linkSync(join(h.siteDir,'test.js'),join(h.siteDir,'inside.js'));else symlinkSync(join(h.siteDir,'test.js'),join(h.siteDir,'inside.js'));
 for(const path of ['/sketches/test.js?v=9','/sketches/inside.js']){const a=await call(h.api,path,{headers:{Host:'any.invalid'}});assert.equal(a.status,200);assert.equal(a.text,'window.test = "готов";');assert.equal(a.headers['cache-control'],'no-cache')}
 for(const path of ['/sketches','/sketches/','/sketches/missing','/sketches/link/secret.txt','/sketches/link/../secret.txt','/sketches/%2e%2e/secret.txt','/sketches/link%2f..%2fsecret.txt','/sketches/..%5csecret.txt','/sketches2/test.js']){const a=await call(h.api,path);assert.equal(a.status,404,path);assert.equal(a.text,'404: Not Found');assert.equal(a.headers['cache-control'],'no-cache')}
 assert.equal((await call(h.api,'/sketches/test.js',{method:'HEAD'})).text,'');assert.equal((await call(h.api,'/sketches/test.js',{body:{}})).status,405);
});
