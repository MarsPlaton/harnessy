import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ProviderCatalog,cliEntry,builtinEntries} from './catalog.ts';
import {LoginTerminal} from './login-terminal.ts';
import {executeCli} from './cli/process.ts';
import {cliFixture} from './cli/test-support.ts';
import {ProviderError} from './types.ts';
import {CatalogCache} from './catalog-cache.ts';

test('268: CLI descriptor exposes public metadata; unavailable/malformed source is explicit, never a fake login',async t=>{
 const f=await cliFixture(t),entry=cliEntry(f.description,{env:f.env,cwd:f.dir,temporaryDirectory:f.dir}),catalog=new ProviderCatalog([entry]);t.after(()=>catalog.close());const {row}=await catalog.read(entry.id);assert.equal(row.installed,true);assert.equal(row.login.account,'f•••@example.test');assert.equal(row.models[0]!.id,'test-model');assert.equal(JSON.stringify(row).includes('secret'),false);assert.equal(f.capture().some(v=>v.action==='turn'||v.action==='login'),false);
 const bad=new ProviderCatalog([{...entry,auth:async()=>{throw Error('password=SENSITIVE')}}]);const broken=await bad.read(entry.id);assert.equal(broken.row.login.state,'error');assert.equal(JSON.stringify(broken).includes('SENSITIVE'),false);
 const absent=new ProviderCatalog([{...entry,version:async()=>{throw new ProviderError('no_binary','missing')}}]);assert.equal((await absent.read(entry.id)).row.installed,false);assert.throws(()=>new ProviderCatalog([entry,entry]),{code:'protocol'});
});

test('268: metadata reads serialize per program; same public account mask still has a distinct private identity',async t=>{
 const f=await cliFixture(t);let email='alice@example.test',release!:()=>void,seen!:()=>void,hold=true;const gate=new Promise<void>(r=>{release=r}),started=new Promise<void>(r=>{seen=r});const entry={...cliEntry(f.description,{env:f.env,cwd:f.dir}),auth:async()=>{const value={loggedIn:true,email};if(hold){hold=false;seen();await gate}return value}},catalog=new ProviderCatalog([entry]);t.after(()=>catalog.close());const first=catalog.read(entry.id);await started;assert.equal(catalog.peek(entry.id).installed,null);assert.equal(catalog.peek(entry.id).checking,true);email='amy@example.test';const second=catalog.read(entry.id);release();const [a,b]=await Promise.all([first,second]);assert.equal(a.row.checking,true,'a queued read keeps checking active');assert.equal(b.row.checking,false);assert.equal(catalog.peek(entry.id).checking,false);assert.equal(a.row.login.account,b.row.login.account);assert.notEqual(a.identity,b.identity);assert.equal(b.changed,true);assert.equal((await catalog.read(entry.id)).identity,b.identity);
});

test('269: terminal script safely quotes literal arguments and cleans its private file when executed',{skip:process.platform==='win32'?'macOS Terminal script':false},async t=>{
 const f=await cliFixture(t),file=join(f.dir,'login-helper.mjs'),output=join(f.dir,'login-result.json');writeFileSync(file,'import {writeFileSync} from "node:fs";writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),key:process.env.TEST_API_KEY??null}))');
 const entry={...cliEntry(f.description,{env:f.env,cwd:f.dir}),login:{args:[file,output,"a' ; touch SHOULD-NOT-EXIST ; echo '",'$(touch ALSO-NOT)']}};
 const paths:string[]=[],terminal=new LoginTerminal({platform:'darwin',temporaryDirectory:f.dir,open:async path=>{paths.push(path);const r=await executeCli({binary:'/bin/sh',args:[path],cwd:f.dir,env:{...f.env,TEST_API_KEY:'fake-secret'},timeoutMs:3000,maxBytes:1000},new AbortController().signal);assert.equal(r.code,0)}});t.after(()=>terminal.close());await terminal.launch(entry);assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),{args:entry.login.args.slice(2),key:null});assert.equal(existsSync(join(f.dir,'SHOULD-NOT-EXIST')),false);assert.equal(existsSync(join(f.dir,'ALSO-NOT')),false);assert.equal(existsSync(paths[0]!),false);
 const failed=new LoginTerminal({platform:'darwin',temporaryDirectory:f.dir,open:async()=>{throw Error('launch denied')}});await assert.rejects(failed.launch(entry),{code:'login_terminal_failed'});assert.equal(readdirSync(f.dir).some(n=>n.startsWith('harnessy-login-')),false);
});

test('268: existing Claude/Codex metadata use their provider ports without changing their implementations',async()=>{
 let turns=0;const provider:any={auth:async()=>({loggedIn:true,email:'a@test'}),models:async()=>[],runTurn:async()=>{turns++;return {text:'ok',sessionId:null}}},entries=builtinEntries({claude:provider},{claude:[{id:'existing-model'}]},{execute:async()=>({code:0,signal:null,stdout:'existing-cli 1\n',stderr:''})}),catalog=new ProviderCatalog(entries);const rows=await catalog.list();assert.equal(rows[0]!.row.title,'Claude Code');assert.equal(rows[0]!.row.models[0]!.id,'existing-model');assert.equal(turns,0);
});

test('24a: a safe image capability survives the public catalog disk snapshot',async t=>{
 const f=await cliFixture(t),cache=join(realpathSync(f.dir),'catalog-cache'),base=cliEntry(f.description,{env:f.env,cwd:f.dir,temporaryDirectory:f.dir}),entry={...base,models:async()=>[{id:'vision-model',label:'Vision model',images:true}]};
 const first=new ProviderCatalog([entry],()=>1791500000125,{cacheDir:cache});const observed=(await first.read(entry.id)).row;assert.equal(observed.capabilities.images,true);await first.close();
 if(!existsSync(join(cache,entry.id+'.json'))){new CatalogCache(cache,()=>1791500000125).save(observed);assert.fail('automatic catalog save did not produce its snapshot')}
 const saved=JSON.parse(readFileSync(join(cache,entry.id+'.json'),'utf8'));assert.equal(saved.models[0]?.images,true);
 const restored=new ProviderCatalog([entry],()=>1791500001125,{cacheDir:cache});t.after(()=>restored.close());assert.equal(restored.peek(entry.id).models[0]?.images,true);assert.equal(restored.peek(entry.id).capabilities.images,true);
});
