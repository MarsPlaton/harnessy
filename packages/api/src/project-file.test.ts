import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,symlinkSync,linkSync,truncateSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,call} from './test-helpers.ts';
import {projectFileRoutes,PROJECT_FILE_LIMIT} from './project-file.ts';
import {promotionIntro} from '../../context/src/onboarding.ts';
const url=(project:string,path:string,extra='')=>'/api/project/file?project='+encodeURIComponent(project)+'&path='+encodeURIComponent(path)+extra;

test('230: project files retain binary bytes, MIME, size, HEAD and escaped filename; reads never run a model',async t=>{
 const h=await fixture(t);mkdirSync(join(h.dir,'artifacts'));mkdirSync(join(h.dir,'docs'));
 for(const [name,type,data] of [['image.png','image/png',Buffer.from('89504e470d0a1a0a','hex')],['clip.mp4','video/mp4',Buffer.from([0,0,0,24,102,116,121,112])],['report.pdf','application/pdf',Buffer.from('%PDF-1.7')],['таблица.csv','text/csv; charset=utf-8',Buffer.from('роль,имя\nworker,Юрист')]] as const){writeFileSync(join(h.dir,'artifacts',name),data);const meta=await call(h.api,url(h.dir,'artifacts/'+name,'&meta=1'));assert.equal(meta.status,200);assert.equal(meta.body.size,data.length);assert.equal(meta.body.type,type);const res=await fetch(h.api.url+url(h.dir,'artifacts/'+name));assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),type);assert.deepEqual(Buffer.from(await res.arrayBuffer()),data);assert.match(res.headers.get('content-security-policy')!,/sandbox/)}
 const name=process.platform==='win32'?'quote & amp.md':'<script>.md';writeFileSync(join(h.dir,'docs',name),'## Цель\n<script>bad()</script>');const p=url(h.dir,'docs/'+name);const head=await call(h.api,p,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.text,'');assert.equal(head.headers['content-type'],'text/plain; charset=utf-8');assert.match(String(head.headers['content-disposition']),process.platform==='win32'?/%26/:/%3Cscript%3E/);const text=await call(h.api,p+'&text=1');assert.equal(text.body.text,'## Цель\n<script>bad()</script>');assert.equal(h.provider.calls.length,0);
});

test('230: absent, foreign, traversing, symlinked, directory, too large and unknown-project requests fail without cache',async t=>{
 const h=await fixture(t);mkdirSync(join(h.dir,'artifacts'));writeFileSync(join(h.dir,'artifacts','ok.md'),'ok');symlinkSync(tmpdir(),join(h.dir,'artifacts','outside'),process.platform==='win32'?'junction':'dir');if(process.platform==='win32')linkSync(join(h.dir,'artifacts','ok.md'),join(h.dir,'artifacts','alias.md'));else symlinkSync(join(h.dir,'artifacts','ok.md'),join(h.dir,'artifacts','alias.md'));
 for(const [project,path,status] of [[h.dir,'',400],[h.dir,'../outside.md',403],[h.dir,h.dir+'-other/no.md',process.platform==='win32'?400:403],[h.dir,'artifacts/outside',403],[h.dir,'artifacts',400],[h.dir,'missing.md',404],['/other','artifacts/ok.md',409],['','artifacts/ok.md',409],[h.dir,'bad\0.md',400]] as const){const r=await call(h.api,url(project,path));assert.equal(r.status,status,path);assert.equal(r.body.ok,false);assert.equal(r.headers['cache-control'],'no-store')}
 assert.equal((await call(h.api,url(h.dir,'artifacts/alias.md'))).text,'ok');writeFileSync(join(h.dir,'artifacts','huge.mp4'),'');truncateSync(join(h.dir,'artifacts','huge.mp4'),PROJECT_FILE_LIMIT+1);assert.equal((await call(h.api,url(h.dir,'artifacts/huge.mp4'))).status,413);
 writeFileSync(join(h.dir,'artifacts','page.html'),'<script>bad()</script>');const html=await call(h.api,url(h.dir,'artifacts/page.html'));assert.equal(html.headers['content-type'],'application/octet-stream');assert.match(String(html.headers['content-disposition']),/^attachment/);assert.equal(html.headers['x-content-type-options'],'nosniff');
});

test('230: project change during async file reading cannot disclose the old project',async t=>{
 const h=await fixture(t);writeFileSync(join(h.dir,'x.md'),'private A');const p=h.runtime.project,route=projectFileRoutes(h.runtime)[0]!;
 const response=route.handle({request:null as any,params:{},body:{},query:new URLSearchParams({project:h.dir,path:'x.md'})});p.closed=true;try{const reply=await response;assert.equal(reply.status,409);assert.equal((reply.value as any).code,'project_changed');assert.equal(reply.bytes,undefined)}finally{p.closed=false}
});

test('231: promoted role receives the Markdown/artifact contract beside its actual conversation',()=>{
 const intro=promotionIntro('/project','Обсудили цель',[]);assert.match(intro,/артефакты клади в artifacts\/ проекта/i);assert.match(intro,/относительным путём; таблицы — Markdown/);assert.match(intro,/Обсудили цель/);
});

for(const replacement of ['outside','inside'])test('230: file replacement between boundary check and read refuses '+replacement,{skip:process.platform==='win32'&&replacement==='outside'?'file symlink test requires Windows Developer Mode':false},async t=>{
 const h=await fixture(t),path=join(h.dir,'report.md');writeFileSync(path,'original');let replaced=false;
 class Query extends URLSearchParams {override get(name:string){if(name==='meta'&&!replaced){replaced=true;renameSync(path,path+'.saved');if(replacement==='outside')symlinkSync(tmpdir(),path,'dir');else writeFileSync(path,'replacement')}return super.get(name)}}
 const response=await projectFileRoutes(h.runtime)[0]!.handle({request:null as any,params:{},body:{},query:new Query({project:h.dir,path:'report.md'})});assert.equal(response.status,replacement==='outside'?403:409);assert.equal(response.bytes,undefined);assert.equal((response.value as any).ok,false);
});
