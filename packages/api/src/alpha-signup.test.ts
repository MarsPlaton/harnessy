import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root=new URL('../../../',import.meta.url),read=(path:string)=>readFileSync(new URL(path,root),'utf8');

test('TS-37: alpha endpoint accepts, deduplicates, traps bots, rate-limits and records owner decisions in one suite server',()=>{
 const run=process.platform==='win32'?spawnSync('python',['-X','utf8','-m','unittest','ui/deploy/auth/test_auth_alpha.py'],{cwd:root,encoding:'utf8'}):spawnSync('python3',['-m','unittest','ui/deploy/auth/test_auth_alpha.py'],{cwd:root,encoding:'utf8'});
 assert.equal(run.status,0,`${run.stdout}\n${run.stderr}`);
});

test('TS-37: article and design code share the bilingual alpha form states',()=>{
 const article=read('ui/sketches/disarto/42-article.html'),design=read('ui/sketches/disarto/00-design-code.html'),css=read('ui/sketches/disarto/article.css'),privacy=read('ui/deploy/privacy.html');
 for(const field of ['name','email','github','tools','mac','consent'])assert.match(article,new RegExp(`(?:name|data-alpha-field)=["']${field}["']`));
 assert.match(article,/fetch\('\/auth\/alpha'/);assert.match(article,/data-alpha-status aria-live="polite"/);assert.match(article,/name="company" tabindex="-1"/);
 for(const state of ['ошибка поля','отправка','принято','та же почта','сервер не ответил'])assert.ok(design.includes(state),state);
 assert.match(css,/\.art-alpha-form/);assert.match(css,/@media \(max-width:600px\)/);
 assert.match(privacy,/Заявки на альфа-тест/);assert.match(privacy,/Alpha requests/);assert.match(privacy,/ответьте на письмо/);
});
