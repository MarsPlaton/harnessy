import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,symlinkSync,unlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderCatalog,CLI_DESCRIPTORS,cliEntry} from './catalog.ts';
import {geminiFixture} from './gemini-test-helpers.ts';
import {geminiVersion,GEMINI,GEMINI_UNAVAILABLE,GEMINI_MODELS_UNAVAILABLE} from './gemini.ts';
import {readCliMetadata} from './cli/query.ts';

test('264: Gemini version comes from the process, not the inventory; no prompt is sent',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'harnessy-gemini-version-')),binary=join(dir,'gemini.cjs');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(binary,'#!'+process.execPath+'\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(["--version"]))process.exit(93);console.log("0.55.1");',{mode:0o700});
 assert.equal(await readCliMetadata(binary,[],geminiVersion,{cwd:dir}),'0.55.1');
 writeFileSync(binary,'#!'+process.execPath+'\nconsole.log("0.56.0-preview.2");',{mode:0o700});assert.equal(await readCliMetadata(binary,[],geminiVersion,{cwd:dir}),'0.56.0-preview.2');
 await assert.rejects(readCliMetadata(join(dir,'absent'),[],geminiVersion,{cwd:dir}),{code:'no_binary'});
});
test('264: prompt-like, absent and malformed version output never indicates a ready Gemini',()=>{
 for(const stdout of ['', 'answer 0.55.1', '0.55.1\nsecret', '{}'])assert.throws(()=>geminiVersion.parse({stdout,stderr:'',code:0,signal:null}),{code:'protocol'});
});

test('285: saved Google account is unknown, never verified; models and probe report the missing capabilities',async t=>{
 const h=geminiFixture(t),catalog=new ProviderCatalog([h.entry]);writeFileSync(h.account,JSON.stringify({active:'alice@example.test',old:['old@example.test'],ignored:'FIXTURE-SECRET'}));
 const defaults=[{id:'default',label:'по умолчанию программы'}];const bytes=readFileSync(h.account),r=await catalog.read('gemini');assert.equal(r.row.installed,true);assert.equal(r.row.version,'0.55.1');assert.equal(r.row.login.state,'unknown');assert.equal(r.row.login.reason,'сохранён аккаунт, вход не проверен');assert.equal(r.row.login.account,'a•••@example.test');assert.equal(r.identity,null);assert.deepEqual(r.row.models,defaults);assert.equal(r.row.modelsReason,GEMINI_MODELS_UNAVAILABLE);assert.equal(r.row.reason,undefined);assert.equal(r.row.capabilities.mcp,true);assert.equal(r.row.capabilities.limits,false);assert.equal(r.row.limits,undefined);assert.deepEqual(catalog.limitsEntries(),[]);assert.ok(CLI_DESCRIPTORS.includes(GEMINI));
 assert.doesNotMatch(JSON.stringify(r.row),/alice|old@example|FIXTURE-SECRET/);assert.deepEqual(readFileSync(h.account),bytes);assert.deepEqual(await h.entry.models(),defaults);assert.equal(h.capture().length,1);assert.equal(h.capture()[0].home,process.env.HOME);assert.equal(h.capture()[0].apiKey,false);assert.equal(h.capture()[0].paneToken,false);
 await assert.rejects(h.entry.runTurn(undefined as never,'do not run',undefined as never),{code:'protocol'});assert.equal(h.capture().length,1);
 writeFileSync(h.account,JSON.stringify({active:'bob@example.test'}));const updated=await catalog.read('gemini');assert.equal(updated.changed,true);assert.equal(updated.row.login.account,'b•••@example.test');assert.equal(updated.identity,null);
});
for(const data of [null,{}, {active:null},{active:''}])test('285: absent active account is none: '+JSON.stringify(data),async t=>{
 const h=geminiFixture(t);if(data!==null)writeFileSync(h.account,JSON.stringify(data));const r=(await new ProviderCatalog([h.entry]).read('gemini')).row;assert.equal(r.login.state,'none');assert.equal(r.login.account,undefined);assert.deepEqual(r.models,[{id:'default',label:'по умолчанию программы'}]);assert.equal(r.modelsReason,GEMINI_MODELS_UNAVAILABLE);assert.deepEqual(h.capture().map(c=>c.args),[['--version']]);
});
for(const data of ['[1]', '{', '{"active":true}', '{"active":"FIXTURE-SECRET"}', '{"active":"alice@@example.test"}', Buffer.from([0xff]), 'x'.repeat(65537)])test('285: corrupted account file is error without raw data or a model call: '+String(data).slice(0,35),async t=>{
 const h=geminiFixture(t);writeFileSync(h.account,data);const before=readFileSync(h.account),r=(await new ProviderCatalog([h.entry]).read('gemini')).row;assert.equal(r.login.state,'error');assert.equal(r.login.account,undefined);assert.deepEqual(r.models,[{id:'default',label:'по умолчанию программы'}]);assert.doesNotMatch(JSON.stringify(r),/FIXTURE-SECRET|alice@@/);assert.deepEqual(readFileSync(h.account),before);assert.deepEqual(h.capture().map(c=>c.args),[['--version']]);
});
test('285: account metadata symlink/directory is an error; neighbouring OAuth/settings files are not used',async t=>{
 const h=geminiFixture(t),oauth=join(h.config,'oauth_creds.json');writeFileSync(oauth,JSON.stringify({active:'secret@example.test',access_token:'FIXTURE-SECRET'}));writeFileSync(join(h.config,'settings.json'),JSON.stringify({mcpServers:{foreign:{command:'do-not-run'}}}));
 const catalog=new ProviderCatalog([h.entry]);let linked=true;try{symlinkSync(oauth,h.account)}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM')linked=false;else throw e}
 if(linked){assert.equal((await catalog.read('gemini')).row.login.state,'error');unlinkSync(h.account)}
 mkdirSync(h.account);assert.equal((await catalog.read('gemini')).row.login.state,'error');assert.match(readFileSync(oauth,'utf8'),/FIXTURE-SECRET/);assert.deepEqual(h.capture().map(c=>c.args),linked?[['--version'],['--version']]:[['--version']]);
});
test('285: missing binary stays distinct from absent account metadata',async t=>{
 const h=geminiFixture(t),entry=cliEntry({...h.description,binary:join(h.dir,'missing')},{env:h.env,cwd:h.dir}),row=(await new ProviderCatalog([entry]).read('gemini')).row;assert.equal(row.installed,false);assert.equal(row.login.state,'unknown');assert.equal(row.version,null);assert.equal(h.capture().length,0);
});
