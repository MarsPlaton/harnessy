import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,realpathSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureLine} from '@harnessy/team';
import {compatJson} from '@harnessy/journal';
import {projectSection,readProjectSection,SECTION_LIMITS,type ProjectSection} from './sections.ts';
import type {TestContext} from 'node:test';
const parts:ProjectSection[]=['docs','artifacts','memory','research'];
function fixture(t:TestContext){const dir=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-sections-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir}
const put=(dir:string,path:string,text:string|Buffer)=>{const file=join(dir,'.harness',path);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,text);return file};
const refusal=(code:string)=>(e:any)=>e.code===code&&e.status===(code==='section_outside'?403:409);
const link=(t:TestContext,target:string,path:string,directory=false)=>{try{symlinkSync(target,path,process.platform==='win32'&&directory?'junction':directory?'dir':'file');return true}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows file symlink privilege is unavailable');return false}throw e}};

test('136/140: all four missing sections are empty, read-only and available without a team',async t=>{
 const dir=fixture(t);for(const section of parts){const r=await readProjectSection(dir,section);assert.equal(r.empty,true);assert.deepEqual(r.items,[]);assert.deepEqual(r.limited,[])}
 assert.throws(()=>readFileSync(join(dir,'.harness','team.yaml')));
 for(const value of ['__proto__','constructor','../docs','DOCS',''])assert.throws(()=>projectSection(value),(e:any)=>e.code==='section_invalid'&&e.status===400);
});

test('136/87: files sort by project-relative path; only actual document directories are stages; binary stays visible',async t=>{
 const dir=fixture(t);put(dir,'docs/02 Проект/смета.md','# Смета\nнастоящая');put(dir,'docs/01 Начало/договор.txt','условия');put(dir,'docs/root.md','общие');put(dir,'docs/image.png',Buffer.from([0,255,1]));put(dir,'evidence/report.json','{"result":true}');put(dir,'research/источники.md','https://example.test');
 const docs=await readProjectSection(dir,'docs');assert.equal(docs.empty,false);assert.deepEqual(docs.items.map(i=>i.stage),['01 Начало','02 Проект',null,null]);assert.equal(docs.items[0]!.path,'.harness/docs/01 Начало/договор.txt');assert.equal(docs.items[1]!.text,'# Смета\nнастоящая');assert.equal(docs.items[2]!.format,'binary');assert.equal(docs.items[2]!.text,null);assert.ok(docs.items.every(i=>Number.isFinite(Date.parse(i.modifiedAt))));
 assert.equal((await readProjectSection(dir,'artifacts')).items[0]!.name,'report.json');assert.equal((await readProjectSection(dir,'research')).items[0]!.name,'источники.md');
});

test('137: initial ensureLine memory ignores whitespace, not real decisions; the entire later memory is returned',async t=>{
 const dir=fixture(t);await ensureLine(dir,{now:()=>new Date(2026,9,11,12)});const p=join(dir,'.harness','MEMORY.md'),initial=readFileSync(p,'utf8');
 for(const text of [initial,initial.replace(/\s+/g,' ')]){writeFileSync(p,text);const r=await readProjectSection(dir,'memory');assert.equal(r.empty,true);assert.equal(r.memoryState,'template')}
 const text=initial+'\n## Другой раздел\nРешение владельца: работаем без кода.';writeFileSync(p,text);const r=await readProjectSection(dir,'memory');assert.equal(r.empty,false);assert.equal(r.memoryState,'content');assert.equal(r.items[0]!.text,text);
 writeFileSync(p,' \n');assert.equal((await readProjectSection(dir,'memory')).memoryState,'empty');rmSync(p);assert.equal((await readProjectSection(dir,'memory')).memoryState,'missing');
});

for(const path of ['.harness','.harness/docs','.harness/docs/file.txt','.harness/docs/nested','.harness/evidence','.harness/MEMORY.md','.harness/research'])test('136: refuses outside symlink at '+path+' including a sibling with the same prefix',async t=>{
 const dir=fixture(t),outside=dir+'-other';mkdirSync(outside);t.after(()=>rmSync(outside,{recursive:true,force:true}));writeFileSync(join(outside,'secret.txt'),'must not leave the other project');
 mkdirSync(join(dir,path,'..'),{recursive:true});const file=path.endsWith('.txt')||path.endsWith('.md');if(!link(t,file?join(outside,'secret.txt'):outside,join(dir,path),!file))return;
 const section:ProjectSection=path.includes('evidence')?'artifacts':path.includes('MEMORY')?'memory':path.includes('research')?'research':'docs';await assert.rejects(readProjectSection(dir,section),refusal('section_outside'));
});

test('136: allowed internal links and a symlink to the project itself remain readable',async t=>{
 const dir=fixture(t);put(dir,'docs/real.txt','real');if(!link(t,join(dir,'.harness','docs','real.txt'),join(dir,'.harness','docs','alias.txt')))return;const alias=dir+'-link';if(!link(t,dir,alias,true))return;t.after(()=>process.platform==='win32'?rmdirSync(alias):rmSync(alias));
 const r=await readProjectSection(alias,'docs');assert.deepEqual(r.items.map(i=>i.text),['real','real']);
});

test('136: dangling links, unreadable text and invalid memory are failures, never an empty section',async t=>{
 const dir=fixture(t);mkdirSync(join(dir,'.harness','docs'),{recursive:true});const broken=join(dir,'.harness','docs','broken');if(!link(t,join(dir,'missing'),broken))return;await assert.rejects(readProjectSection(dir,'docs'),refusal('section_unreadable'));rmSync(broken);
 if(!link(t,join(dir,'.harness','docs'),join(dir,'.harness','docs','loop'),true))return;await assert.rejects(readProjectSection(dir,'docs'),refusal('section_unreadable'));if(process.platform==='win32')rmdirSync(join(dir,'.harness','docs','loop'));else rmSync(join(dir,'.harness','docs','loop'));
 if(process.platform!=='win32'){const p=put(dir,'docs/locked.txt','private');chmodSync(p,0);try{await assert.rejects(readProjectSection(dir,'docs'),refusal('section_unreadable'))}finally{chmodSync(p,0o600)}}
 put(dir,'MEMORY.md',Buffer.from([0xff,0]));await assert.rejects(readProjectSection(dir,'memory'),refusal('section_unreadable'));
});

test('136: per-file UTF-8 prefix is bounded without corrupting a partial character',async t=>{
 const dir=fixture(t);put(dir,'docs/long.md','a'+'я'.repeat(SECTION_LIMITS.textBytes));const r=await readProjectSection(dir,'docs');assert.equal(r.items[0]!.format,'text');assert.equal(r.items[0]!.truncated,true);assert.ok(Buffer.byteLength(r.items[0]!.text!)<=SECTION_LIMITS.textBytes);assert.doesNotMatch(r.items[0]!.text!,/�/);
});

test('136/137: truncated whitespace memory cannot claim there are no decisions beyond the preview',async t=>{
 const dir=fixture(t);put(dir,'MEMORY.md',' '.repeat(SECTION_LIMITS.textBytes)+'\n## Решения\nРешение после предела');const r=await readProjectSection(dir,'memory');
 assert.equal(r.empty,false);assert.equal(r.memoryState,'content');assert.equal(r.items[0]!.truncated,true);
});

test('136: file count, depth and actual ASCII JSON response have explicit limits, never empty',async t=>{
 const dir=fixture(t);for(let i=0;i<=SECTION_LIMITS.files;i++)put(dir,'docs/'+String(i).padStart(4,'0')+'.txt','');
 let r=await readProjectSection(dir,'docs');assert.equal(r.items.length,1000);assert.deepEqual(r.limited,['files']);assert.equal(r.empty,false);
 put(dir,'research/'+Array.from({length:17},()=> 'nested').join('/')+'/deep.txt','deep');r=await readProjectSection(dir,'research');assert.deepEqual(r.limited,['depth']);assert.equal(r.empty,false);
 for(let i=0;i<7;i++)put(dir,'evidence/'+i+'.txt','я'.repeat(SECTION_LIMITS.textBytes/2));r=await readProjectSection(dir,'artifacts');assert.deepEqual(r.limited,['response']);assert.equal(r.empty,false);assert.equal(r.items.at(-1)!.truncated,true);
 const wire=compatJson({ok:true,project:dir,section:'artifacts',...r,orchestrator:{pane:'lead',label:'Оркестратор'}}).replace(/[\u0080-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));assert.ok(Buffer.byteLength(wire)<=SECTION_LIMITS.responseBytes);
});
