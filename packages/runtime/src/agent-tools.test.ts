import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,mkdirSync,symlinkSync,linkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {AgentFiles} from './agent-files.ts';
import {AgentTools} from './agent-tools.ts';
import {agentFixture} from './agent-test-helpers.ts';
import {deferred} from './test-helpers.ts';

test('21b: filesystem reads, lists, searches, writes and edits respect roots and bounded text',t=>{
 const h=agentFixture(t),f=new AgentFiles(h.dir,['src']);f.write('src/a.txt','alpha\nbeta\n');assert.equal(f.read('src/a.txt').text,'alpha\nbeta\n');assert.equal(f.search('beta').matches[0]!.line,2);assert.equal(f.list('src').entries[0]!.name,'a.txt');
 f.edit('src/a.txt','beta','gamma');assert.match(readFileSync(join(h.dir,'src/a.txt'),'utf8'),/gamma/);assert.throws(()=>f.edit('src/a.txt','absent','x'),{code:'edit_ambiguous'});assert.throws(()=>f.write('else.txt','x'),{code:'path_denied'});
 f.write('.harness/evidence/proof.txt','proof');assert.equal(f.read('.harness/evidence/proof.txt').text,'proof');
 writeFileSync(join(h.dir,'src/big.txt'),'a'.repeat(100000));assert.equal(f.read('src/big.txt',20,4).text,'aaaa');assert.equal(f.read('src/big.txt').truncated,true);assert.throws(()=>f.write('src/huge.txt','x'.repeat(1024*1024+1)),{code:'file_too_large'});
 writeFileSync(join(h.dir,'src/binary'),Buffer.from([0,255]));assert.throws(()=>f.read('src/binary'),{code:'file_binary'});assert.equal(f.search('gamma','src').matches.length,1);
 writeFileSync(join(h.dir,'src/unicode'),'🍃'.repeat(40000));const page=f.read('src/unicode');assert.ok(Buffer.byteLength(page.text)<=65536);assert.equal(page.text.includes('\ufffd'),false);assert.ok(page.truncated);assert.equal(f.read('src/unicode',page.nextOffset,2).text,'🍃');
});

test('21b: traversal, symlink parent/leaf, protected metadata and hardlinked writes fail without changing the target',t=>{
 const h=agentFixture(t),outside=agentFixture(t),secret=join(outside.dir,'target');writeFileSync(secret,'unchanged');mkdirSync(join(h.dir,'.harness'));writeFileSync(join(h.dir,'.harness','team.yaml'),'protected');
 symlinkSync(outside.dir,join(h.dir,'escape'),process.platform==='win32'?'junction':'dir');assert.throws(()=>new AgentFiles(join(h.dir,'escape')),{code:'path_symlink'});
 const linkFile=(path:string)=>{try{symlinkSync(secret,path);return true}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM')return false;throw e}};
 const hasFileSymlink=linkFile(join(h.dir,'link'));linkSync(secret,join(h.dir,'hard'));const f=new AgentFiles(h.dir);
 for(const path of [secret,'../target','escape/target',...(hasFileSymlink?['link']:[]),'.harness/team.yaml','.git/config']){assert.throws(()=>f.read(path));assert.throws(()=>f.write(path,'bad'))}assert.throws(()=>f.write('hard','bad'),{code:'path_linked'});assert.equal(readFileSync(secret,'utf8'),'unchanged');assert.equal(readFileSync(join(h.dir,'.harness/team.yaml'),'utf8'),'protected');
 const stamp=f.stamp('new');if(linkFile(join(h.dir,'new')))assert.throws(()=>f.write('new','bad',stamp));assert.equal(readFileSync(secret,'utf8'),'unchanged');
});

for(const mode of ['chat','read','edit','ask','all','check','web'] as const)test('21b/21e: '+mode+' exposes only its allowed file, web and shell capabilities',async t=>{
 const h=agentFixture(t);h.seat.mode=mode;let shell=0,approval=0;h.ctx.askApproval=async()=>{approval++;return true};
 const tools=new AgentTools(h.seat,h.ctx,h.controller.signal,async()=>{shell++;return {stdout:'ok',stderr:'',code:0,signal:null}});
 const names=tools.definitions.map(t=>t.name);assert.ok(names.includes('send'));assert.equal(names.includes('read_file'),mode!=='chat');assert.equal(names.includes('write_file'),['edit','ask','all'].includes(mode));assert.equal(names.includes('shell'),['all','check'].includes(mode));assert.equal(names.includes('web_fetch'),mode==='web');
 const write=await tools.call('write_file',{path:'a',text:'x'});assert.equal(write.ok,['edit','ask','all'].includes(mode));assert.equal(existsSync(join(h.dir,'a')),write.ok);assert.equal(approval,mode==='ask'?1:0);
 const shellResult=await tools.call('shell',{command:'pwd'});assert.equal(shellResult.ok,process.platform==='darwin'&&['all','check'].includes(mode));assert.equal(shell,process.platform==='darwin'&&['all','check'].includes(mode)?1:0);
 if(process.platform!=='darwin'&&['all','check'].includes(mode)){assert.equal(shellResult.ok,false);if(!shellResult.ok)assert.equal(shellResult.code,'sandbox_unavailable')}
 const web=await tools.call('web_fetch',{url:'http://127.0.0.1:3777'});assert.equal(web.ok,false);if(!web.ok)assert.equal(web.code,mode==='web'?'web_url_denied':'tool_denied');
});

test('21b: pending permission cannot write after cancellation, denial or an intervening file change',async t=>{
 for(const action of ['cancel','deny','change']){const h=agentFixture(t);h.seat.mode='ask';writeFileSync(join(h.dir,'a'),'old');const entered=deferred(),answer=deferred<boolean>();h.ctx.askApproval=()=>{entered.resolve();return answer.promise};const tools=new AgentTools(h.seat,h.ctx,h.controller.signal),pending=tools.call('write_file',{path:'a',text:'new'});await entered.promise;
  if(action==='cancel')h.controller.abort();if(action==='change')writeFileSync(join(h.dir,'a'),'other');answer.resolve(action!=='deny');const result=await pending;assert.equal(result.ok,false);assert.equal(readFileSync(join(h.dir,'a'),'utf8'),action==='change'?'other':'old');
 }
});

const darwinTest=process.platform==='darwin'?test:test.skip;
darwinTest('21b: shell receives a clean environment and enforces actual time/output limits; peer tools preserve role denials',async t=>{
 const h=agentFixture(t);h.seat.mode='all';h.ctx.env={HTTPS_PROXY:'http://fixture-secret.invalid'};const seen:any[]=[];const fake=new AgentTools(h.seat,h.ctx,h.controller.signal,async(req)=>{seen.push(req);return {stdout:'ok',stderr:'',code:0,signal:null}});
 await fake.call('shell',{command:'pwd',timeout_ms:50});assert.equal(seen[0].cwd,h.dir);assert.deepEqual(Object.keys(seen[0].env).sort(),['HOME','LANG','PATH','TEMP','TMP','TMPDIR']);assert.equal(seen[0].binary,'/usr/bin/sandbox-exec');assert.deepEqual(seen[0].args.slice(2),['/bin/sh','-c','pwd']);assert.equal(seen[0].maxBytes,65536);assert.equal(seen[0].timeoutMs,50);
 const real=new AgentTools(h.seat,h.ctx,h.controller.signal);assert.equal((await real.call('shell',{command:'while :; do :; done',timeout_ms:10})).ok,false);assert.equal((await real.call('shell',{command:'yes overflow',timeout_ms:3000})).ok,false);
 h.ctx.tools.createSeats=async()=>({ok:false,code:'role_denied',error:'только оркестратор'});assert.deepEqual(await real.call('create_seats',{proposalId:'p123456',version:1}),{ok:false,code:'role_denied',error:'только оркестратор'});
 assert.equal((await real.call('write_file',{path:'a',text:'x',extra:true})).ok,false);assert.equal(existsSync(join(h.dir,'a')),false);
});

if(process.platform==='win32')test('21b: Windows shell fails closed without running a command',async t=>{
 const h=agentFixture(t);h.seat.mode='all';let starts=0;
 const tools=new AgentTools(h.seat,h.ctx,h.controller.signal,async()=>{starts++;return {stdout:'unexpected',stderr:'',code:0,signal:null}});
 const result=await tools.call('shell',{command:'echo should-not-run'});
 assert.equal(result.ok,false);if(!result.ok)assert.equal(result.code,'sandbox_unavailable');assert.equal(starts,0);
});

test('21b: a hanging peer cannot prevent cancellation or publish a late tool result',async t=>{
 const h=agentFixture(t),entered=deferred(),answer=deferred<any>();h.ctx.tools.ask=()=>{entered.resolve();return answer.promise};const tools=new AgentTools(h.seat,h.ctx,h.controller.signal),pending=tools.call('ask',{to:'reviewer',text:'question'});await entered.promise;h.controller.abort();assert.equal((await pending).ok,false);const before=h.events.length;answer.resolve({ok:true,text:'late'});await Promise.resolve();assert.equal(h.events.length,before);
});
