import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,call,OWNER} from './test-helpers.ts';
import {sectionRoutes} from './routes-sections.ts';
const sections=['docs','artifacts','memory','research'];

test('136/140: actual HTTP sections bind to the project, with no roles, no reads starting a model, and filled/empty forms',async t=>{
 const h=await fixture(t,{seats:'  {}'}),channel=h.runtime.journal.channelPath,before=readFileSync(channel);
 for(const section of sections){const r=await call(h.api,'/api/project/sections/'+section);assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(r.body.project,h.dir);assert.equal(r.body.section,section);assert.equal(r.body.empty,true);assert.equal(r.body.orchestrator,null);assert.deepEqual(r.body.limited,[])}
 mkdirSync(join(h.dir,'.harness','docs','Юристы'),{recursive:true});writeFileSync(join(h.dir,'.harness','docs','Юристы','иск.md'),'# Иск\nПроект');const r=await call(h.api,'/api/project/sections/docs');assert.equal(r.body.items[0].stage,'Юристы');assert.equal(r.body.items[0].text,'# Иск\nПроект');assert.equal(h.provider.calls.length,0);assert.deepEqual(readFileSync(channel),before);
 for(const section of ['unknown','__proto__']){const r=await call(h.api,'/api/project/sections/'+section);assert.equal(r.status,400);assert.equal(r.body.code,'section_invalid')}
});

test('136: outside and unreadable HTTP failures have shape J instead of false empty data',async t=>{
 const h=await fixture(t),p=join(h.dir,'.harness','docs');symlinkSync(h.dir+'-missing',p,process.platform==='win32'?'junction':'dir');let r=await call(h.api,'/api/project/sections/docs');assert.equal(r.status,409);assert.equal(r.body.code,'section_unreadable');assert.equal(r.body.empty,undefined);
 symlinkSync(join(h.dir,'..'),join(h.dir,'.harness','research'),process.platform==='win32'?'junction':'dir');r=await call(h.api,'/api/project/sections/research');assert.equal(r.status,403);assert.equal(r.body.code,'section_outside');assert.equal(r.body.ok,false);
});

test('138: one confirmed request journals once to the registered orchestrator, not a supplied pane',async t=>{
 const h=await fixture(t,{seats:'  lead: {role: orchestrator, label: Руководитель, vendor: claude, model: w1, mode: read}'});h.runtime.halt(true,OWNER);
 const read=await call(h.api,'/api/project/sections/research');assert.deepEqual(read.body.orchestrator,{pane:'lead',label:'Руководитель'});assert.equal(h.provider.calls.length,0);
 const before=h.runtime.journal.lastSeq,r=await call(h.api,'/api/project/sections/research/request',{body:{project:h.dir,text:'Исследуй вопрос владельца',pane:'worker',kind:'answer'}});assert.equal(r.status,200);assert.equal(r.body.seq,before+1);assert.equal(r.body.pane,'lead');
 const records=h.runtime.journal.read({since:before});assert.equal(records.length,1);assert.equal(records[0]!.from,'owner');assert.deepEqual(records[0]!.to,['lead']);assert.equal(records[0]!.kind,'task');assert.equal(records[0]!.text,'Исследуй вопрос владельца');
 for(const project of [null,undefined,h.dir+'-other']){const r=await call(h.api,'/api/project/sections/docs/request',{body:{project,text:'не отправлять'}});assert.equal(r.status,409);assert.equal(r.body.code,'project_changed')}
 for(const text of ['',null,{},' \n']){const r=await call(h.api,'/api/project/sections/docs/request',{body:{project:h.dir,text}});assert.equal(r.status,400);assert.equal(r.body.code,'text_empty')}
 assert.equal(h.runtime.journal.lastSeq,before+1);assert.equal(h.provider.calls.length,0);
});

test('138: no orchestrator never posts to a made-up seat',async t=>{
 const h=await fixture(t,{seats:'  {}'}),seq=h.runtime.journal.lastSeq;
 for(const section of sections){const r=await call(h.api,'/api/project/sections/'+section+'/request',{body:{project:h.dir,text:'сделай'}});assert.equal(r.status,409);assert.equal(r.body.code,'orchestrator_missing');assert.match(r.body.error,/исходный разговор/)}
 assert.equal(h.runtime.journal.lastSeq,seq);assert.equal(h.provider.calls.length,0);
});

test('136/140: a closed captured project during asynchronous reading yields project_changed, including a reader failure',async t=>{
 for(const broken of [false,true]){const h=await fixture(t);if(broken)symlinkSync(h.dir+'-missing',join(h.dir,'.harness','docs'),process.platform==='win32'?'junction':'dir');const route=sectionRoutes(h.runtime)[0]!,p=h.runtime.project;
 const response=route.handle({params:{section:'docs'},body:{},query:new URLSearchParams(),request:null as any});p.closed=true;
 try{await assert.rejects(Promise.resolve(response),(e:any)=>e.code==='project_changed'&&e.status===409)}finally{p.closed=false}}
});
