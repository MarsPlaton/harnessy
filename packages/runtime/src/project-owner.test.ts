import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeError} from './index.ts';
import {harness,OWNER,deferred,until} from './test-helpers.ts';
const target=(t:Parameters<typeof harness>[0])=>{const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'harnessy-owner-project-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir};

for(const action of ['set','create'])test('65: '+action+' checks real busy turn after queued owner operation without cancelling it',async t=>{
 const {runtime:r,provider:f}=await harness(t),original=r.project,dir=target(t),gate=deferred<{text:string;sessionId:null}>();f.onRun=async(_s,_m,c)=>{c.modelStarted?.();c.signal.addEventListener('abort',()=>gate.resolve({text:'',sessionId:null}),{once:true});return gate.promise};
 const noop=r.projectSet(original.dir,{},OWNER),switching=action==='set'?r.projectSet(dir,{},OWNER):r.projectCreate({path:join(dir,'new')},OWNER);
 const result=r.runTurn('worker','занято');void result.catch(()=>{});await noop;await assert.rejects(switching,(e:unknown)=>e instanceof RuntimeError&&e.code==='busy'&&e.status===409);await until(()=>f.calls.length===1);
 assert.equal(r.project,original);assert.equal(f.calls[0]!.ctx.signal.aborted,false);assert.equal(existsSync(join(dir,'new')),false);gate.resolve({text:'готово',sessionId:null});await result;
});

test('65: owner switch preserves exact no-op/open forms and rejects agent before mutation',async t=>{
 const {runtime:r}=await harness(t),dir=target(t),old=r.project.dir;
 await assert.rejects(r.projectSet(dir,{}, {seat:'worker',trust:'agent'}),(e:unknown)=>e instanceof RuntimeError&&e.code==='policy_denied');assert.equal(r.project.dir,old);
 assert.deepEqual(await r.projectSet(old,{},OWNER),{ok:true,project:old,changed:false});const result=await r.projectSet(dir,{},OWNER);assert.equal(result.changed,true);assert.equal(result.project,dir);assert.ok('lineErrors' in result&&'panes' in result);
 await assert.rejects(r.projectSet(join(dir,'missing'),{},OWNER),(e:unknown)=>e instanceof RuntimeError&&e.code==='path_invalid'&&e.status===400);
});

test('65: project creation initializes actual git and manifest, then opens that project',async t=>{
 const {runtime:r}=await harness(t),dir=target(t),path=join(dir,'new');
 await assert.rejects(r.projectCreate({path},{seat:'worker',trust:'agent'}),(e:unknown)=>e instanceof RuntimeError&&e.code==='policy_denied');assert.equal(existsSync(path),false);
 // 102: owner cancelled automatic orchestration; creation only opens a conversation.
 const result=await r.projectCreate({path,model:'w1'},OWNER);assert.equal(result.created,true);assert.equal(result.git,true);assert.equal(result.orchestrator,false);assert.equal(result.seats,0);
 assert.equal(r.project.dir,path);assert.ok(existsSync(join(path,'.git')));assert.ok(existsSync(join(path,'.harness','team.yaml')));
});
