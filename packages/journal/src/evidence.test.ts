import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Evidence,resolveEvidence,checkReport,evidenceDir} from './evidence.ts';
import {temp,fixture,error} from './test-support.ts';
test('[14] report contract checks four headings, empty/missing/unreadable and strict UTF-8',()=>{
 const f=fixture();try{const relative=f.report(),path=join(f.root,relative),e=new Evidence(f.root);assert.equal(e.checkReport(path),null);
 assert.equal(checkReport(join(f.root,'absent')),'файла отчёта нет: '+join(f.root,'absent'));
 writeFileSync(path,'');assert.equal(checkReport(path),'отчёт пуст: '+path);
 writeFileSync(path,'# Ran\n');assert.equal(checkReport(path),'в отчёте report.md нет разделов: Skipped, Planned, Manual (контракт Ran / Skipped / Planned / Manual)');
 writeFileSync(path,Buffer.from([0xff,0xfe]));assert.equal(checkReport(path),'отчёт не читается: '+path);
 writeFileSync(path,'**ran**\n# SKIPPED\n__Planned\nManual: —');assert.equal(checkReport(path),null)
 }finally{f.close()}
});
test('report heading cannot masquerade as prefix of Unicode word or BOM-stripped text',()=>{
 const f=fixture();try{const rel=f.report('T',1,'# Ranж\n# Skipped\n# Planned\n# Manual'),path=join(f.root,rel);assert.match(checkReport(path)!,/нет разделов: Ran/);
 writeFileSync(path,'\ufeff# Ran\n# Skipped\n# Planned\n# Manual');assert.match(checkReport(path)!,/нет разделов: Ran/)
 }finally{f.close()}
});
test('[39] evidence realpath rejects traversal, external symlinks and dangling external links',()=>{
 const f=fixture(),outside=temp();try{const rel=f.report(),link=join(f.root,'linked');symlinkSync(outside.root,link,process.platform==='win32'?'junction':'dir');writeFileSync(join(outside.root,'report.md'),'# Ran\n# Skipped\n# Planned\n# Manual');
 assert.equal(resolveEvidence(f.root,rel),join(f.root,rel));assert.equal(resolveEvidence(f.root,'linked/report.md'),null);assert.equal(resolveEvidence(f.root,'linked/missing.md'),null);assert.equal(resolveEvidence(f.root,'../escape'),null);
 try{symlinkSync(join(outside.root,'missing.md'),join(f.root,'dangling'));assert.equal(resolveEvidence(f.root,'dangling'),null)}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error}
 assert.equal(evidenceDir(f.root,'T',1),join(f.root,'.harness','evidence','T','r1'));assert.throws(()=>evidenceDir(f.root,'../../../../escape',1),error('evidence_outside'));assert.throws(()=>evidenceDir(f.root,outside.root,1),error('evidence_outside'));
 }finally{f.close();outside.close()}
});

test('symlink then .. uses the referenced filesystem file, never the lexically collapsed internal report',()=>{
 const f=fixture(),outside=temp();try{
 const ext=join(outside.root,'child');mkdirSync(ext);symlinkSync(ext,join(f.root,'link'),process.platform==='win32'?'junction':'dir');
 f.report();writeFileSync(join(f.root,'report.md'),'# Ran\n# Skipped\n# Planned\n# Manual');
 writeFileSync(join(outside.root,'report.md'),'outside report without required sections');
 assert.equal(resolveEvidence(f.root,'link/../report.md'),null);
 const rr=f.request();assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'verdict',text:'9',reply_to:rr.seq,score:9,round:1,evidence:['link/../report.md']}),error('evidence_outside','путь свидетельства вне проекта: link/../report.md'));
 assert.equal(f.journal.read({kinds:['verdict']}).length,0);
 const inner=join(f.root,'child');mkdirSync(inner);symlinkSync(inner,join(f.root,'internal-link'),process.platform==='win32'?'junction':'dir');
 assert.equal(resolveEvidence(f.root,'internal-link/../report.md'),join(f.root,'report.md'));
 assert.equal(checkReport(resolveEvidence(f.root,'internal-link/../report.md')!),null);
 assert.equal(resolveEvidence(f.root,'missing/../report.md'),null);
 assert.equal(resolveEvidence(f.root,'report.md/../report.md'),null);
 }finally{f.close();outside.close()}
});

test('evidence directory does not collapse symlink then .. in the thread before checking the boundary',()=>{
 const f=fixture(),outside=temp();try{
 const ext=join(outside.root,'child');mkdirSync(ext);const parent=join(f.root,'.harness','evidence');mkdirSync(parent,{recursive:true});symlinkSync(ext,join(parent,'link'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>evidenceDir(f.root,'link/../T',1),error('evidence_outside'));
 }finally{f.close();outside.close()}
});
