import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {dom} from './ui-dom-test-helpers.ts';
import {testSite} from './site-test-helpers.ts';

const sketch=readFileSync(new URL('../../../ui/sketches/disarto/40-sidebar.html',import.meta.url),'utf8');
const design=readFileSync(new URL('../../../ui/sketches/disarto/00-design-code.html',import.meta.url),'utf8');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const electron=process.env.HARNESSY_TEST_ELECTRON||join(root,'ui/desktop/node_modules/.bin/electron');

test('TS-48.1: A1 shows the current project as a folder with its chats before other groups',()=>{
  const start=sketch.indexOf('  const I=');
  const end=sketch.indexOf('  // A1 · рейка 56',start);
  assert.ok(start>=0&&end>start,'A1 sketch generator exists');
  const context:{panel?:string}={};
  runInNewContext(sketch.slice(start,end)+'\nglobalThis.panel=panelA1();',context);
  const d=dom('<main>'+context.panel+'</main>');
  const row=d.document.querySelector('.ps2-current-project');
  const chats=d.document.querySelector('.ps2-current-chats');
  assert.ok(row&&chats);
  assert.match(row.textContent,/Alpha-Test.*2 роли.*⋯/);
  assert.ok(row.querySelector('svg'));
  assert.equal(row.querySelector('.ps2-current-toggle')?.getAttribute('aria-expanded'),'true');
  assert.equal(row.querySelector('.ps2-current-toggle')?.getAttribute('aria-controls'),chats.getAttribute('id'));
  assert.equal(row.querySelector('.ps2-current-menu')?.getAttribute('aria-label'),'Меню проекта Alpha-Test');
  assert.equal(row.querySelector('.ps2-current-menu')?.getAttribute('aria-haspopup'),'menu');
  assert.equal(row.querySelector('.ps2-pmenu')?.getAttribute('popover'),'manual');
  assert.equal(row.querySelectorAll('[role="menuitem"]').length,9);
  assert.equal(chats.querySelectorAll('.ps-chat').length,3);
  const rendered=context.panel!;
  assert.ok(rendered.indexOf('ps2-current-project')<rendered.indexOf('ps2-current-chats'));
  assert.ok(rendered.indexOf('ps2-current-chats')<rendered.indexOf('чаты без проекта'));
  assert.ok(rendered.indexOf('чаты без проекта')<rendered.indexOf('Другие проекты'));
  assert.doesNotMatch(rendered,/чаты · Alpha-Test/);
});

test('TS-48.1: design-code specimen preserves the project, standalone and other-project order',()=>{
  const start=design.indexOf('TS-48 · открытый проект в списке');
  const end=design.indexOf('TS-43 · композер и проекты',start);
  assert.ok(start>=0&&end>start);
  const sample=design.slice(start,end);
  const d=dom('<main>'+sample+'</main>');
  assert.equal(d.document.querySelectorAll('.ps2-current-project').length,2);
  assert.equal(d.document.querySelectorAll('.ps2-current-chats .ps-chat').length,3);
  assert.equal(d.document.querySelectorAll('.ps2-current-toggle[aria-expanded="true"]').length,1);
  assert.equal(d.document.querySelectorAll('.ps2-current-toggle[aria-expanded="false"]').length,1);
  assert.equal((sample.match(/class="app ps2-a1" style="width:232px/g)||[]).length,2);
  assert.ok(sample.indexOf('ps2-current-project')<sample.indexOf('чаты без проекта'));
  assert.ok(sample.indexOf('чаты без проекта')<sample.indexOf('Другие проекты'));
});

test('TS-48.1: folder keyboard and unclipped menu in four viewports',
 {timeout:process.platform==='win32'?180_000:60_000,skip:existsSync(electron)?false:'Electron is not installed; set HARNESSY_TEST_ELECTRON'},async t=>{
  const profile=mkdtempSync(join(tmpdir(),'harnessy-sidebar-browser-'));
  t.after(()=>rmSync(profile,{recursive:true,force:true}));
  const env:NodeJS.ProcessEnv={...process.env,HARNESSY_TEST_WINDOW:'hidden',SIDEBAR_SITE:testSite(),SIDEBAR_BROWSER_USER_DATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(new URL('./sidebar-design-browser.cjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM')});
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk});
  const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(exit,0,'browser regression failed: '+stderr+'\n'+stdout);
  assert.match(stdout,/390x844: 232px/);
});
