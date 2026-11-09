import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {SharedLimitsCache} from './limits-cache.ts';
import {LimitsStore} from './limits.ts';
import {harness,FakeProvider,deferred} from './test-helpers.ts';
const moduleURL=new URL('./limits-cache.ts',import.meta.url).href;

test('214: two processes atomically reserve one network attempt; abandoned reservations recover after the interval',async t=>{
 const h=await harness(t),dir=join(h.dir,'shared'),cache=new SharedLimitsCache(dir,()=>h.clock.now()/1000);const children=[];
 for(let i=0;i<2;i++){
  const ready=deferred(),done=deferred<any>();const child=spawn(process.execPath,['--input-type=module','-e',`import {SharedLimitsCache} from ${JSON.stringify(moduleURL)};const cache=new SharedLimitsCache(process.argv[1],()=>Number(process.argv[2]));process.stdout.write('ready\\n');process.stdin.once('data',()=>{process.stdout.write(JSON.stringify(cache.claim('claude',false,null))+'\\n');process.stdin.destroy()});`,dir,String(h.clock.now()/1000)],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;if(stdout.includes('ready\n'))ready.resolve()});child.stderr.on('data',data=>stderr+=data);child.on('error',done.reject);child.on('close',code=>code===0?done.resolve(JSON.parse(stdout.trim().split('\n').at(-1)!)):done.reject(Error(stderr)));t.after(()=>child.kill());children.push({child,ready,done});
 }
 await Promise.all(children.map(c=>c.ready.promise));for(const c of children)c.child.stdin.end('go');const results=await Promise.all(children.map(c=>c.done.promise));assert.equal(results.filter(r=>r.token!==null).length,1);const owner=results.find(r=>r.token)!;assert.equal(cache.load('claude')!.pending,owner.token);
 assert.equal(cache.claim('claude',true,null).token,null);h.clock.advance(300000);const recovered=cache.claim('claude',false,null);assert.ok(recovered.token);assert.notEqual(recovered.token,owner.token);
 cache.complete('claude',owner.token,{ok:false,code:'limits_rate_limited',reason:''});assert.equal(cache.load('claude')!.pending,recovered.token,'late previous owner cannot overwrite the replacement');
});

test('214: shared-cache symlinks cannot redirect writes and corrupted or foreign snapshots cannot supply percentages',async t=>{
 const h=await harness(t),outside=join(h.dir,'outside.json');writeFileSync(outside,'untouched');let reads=0;const provider=Object.assign(new FakeProvider(),{limits:async()=>{reads++;return {ok:true as const,plan:null,source:'fixture',fetchedAt:h.clock.now()/1000,windows:[{label:'5 ч',percentUsed:18,windowMinutes:300,resetsAt:null}]}}});
 const unsafe=join(h.dir,'unsafe');mkdirSync(unsafe);let linked=true;try{symlinkSync(outside,join(unsafe,'claude.json'))}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM')linked=false;else throw e}
 if(linked){const store=new LimitsStore(h.dir,h.clock,{claude:provider},()=>{},unsafe);t.after(()=>store.close());await store.refresh();assert.equal(reads,0);assert.equal(store.snapshot().providers[0]!.code,'limits_storage');assert.equal(readFileSync(outside,'utf8'),'untouched')}
 const corrupt=join(h.dir,'corrupt');mkdirSync(corrupt);for(const raw of ['broken',JSON.stringify({version:1,vendor:'claude',attemptedAt:h.clock.now()/1000,retryAt:null,backoff:0,pending:null,code:null,value:null}),JSON.stringify({version:1,vendor:'codex',attemptedAt:h.clock.now()/1000,retryAt:null,backoff:0,pending:null,code:null,value:{vendor:'claude',plan:null,fetchedAt:h.clock.now()/1000,windows:[{label:'5 ч',percentUsed:99}]}})]){
  writeFileSync(join(corrupt,'claude.json'),raw);const fresh=new LimitsStore(h.dir,h.clock,{claude:provider},()=>{},corrupt);await fresh.refresh();assert.equal(fresh.snapshot().providers[0]!.windows[0]!.percentUsed,18);fresh.close();
 }
 assert.equal(reads,3);
});
