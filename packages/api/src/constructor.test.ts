import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {withPathLock,SEAT_KINDS} from '@harnessy/team';
import {createRuntime,diskIO} from '@harnessy/runtime';
import {completedActions} from '../../runtime/src/test-helpers.ts';
import {fixture,call,deferred,until,OWNER,FakeProvider} from './test-helpers.ts';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const seats='  lead: {kind: orchestrator, role: ведущий, vendor: claude, model: w1, mode: read}\n  worker: {kind: worker, role: executor, vendor: claude, model: w1, mode: read, instructions: roles/shared.md}\n  reviewer: {kind: reviewer, role: reviewer, vendor: claude, model: w1, mode: read, instructions: roles/shared.md}';
async function setup(t:Parameters<typeof fixture>[0]){return fixture(t,{seats,before(dir){mkdirSync(join(dir,'.harness/roles'));writeFileSync(join(dir,'.harness/roles/shared.md'),'Original instruction')}})}
const file=(h:{dir:string})=>join(h.dir,'.harness/roles/shared.md');
const get=(h:Awaited<ReturnType<typeof setup>>)=>call(h.api,'/api/project/file?text=1&project='+encodeURIComponent(h.dir)+'&path=.harness%2Froles%2Fshared.md');
const binding=(h:{dir:string;runtime:any})=>({project:h.dir,instance:h.runtime.project.trace.instanceId});
const update=(h:Awaited<ReturnType<typeof setup>>,body:object={})=>call(h.api,'/api/panes/worker/instruction',{body:{...binding(h),text:'New instruction',expectedHash:hash('Original instruction'),...body}});
const own=(h:{dir:string;runtime:any},extra:object={})=>({...binding(h),opId:'own-role-0001',label:'Свой аналитик',kind:'worker',vendor:'claude',model:'w1',mode:'read',intro:'Анализируй условия договора.',...extra});
async function enable(h:Awaited<ReturnType<typeof setup>>){const status=(await call(h.api,'/api/status')).body;const response=await call(h.api,'/api/autopilot',{body:{...binding(h),revision:status.autopilot.revision,on:true,until:'reply',conditions:{operations:['answer_question'],maxSpendPercent:5}}});assert.equal(response.status,200,response.text);return response.body.autopilot}

test('39.2: instruction receipt/shared file, owner write and next-turn text survive restart; supplied path is ignored',async t=>{
 const h=await setup(t),before=await get(h);assert.equal(before.status,200,before.text);assert.equal(before.body.hash,hash('Original instruction'));assert.deepEqual(before.body.sharedWith,['worker','reviewer']);
 const permission=await enable(h),result=await update(h,{path:'README.md'});assert.equal(result.status,200,result.text);assert.equal(result.body.hash,hash('New instruction'));assert.equal(readFileSync(file(h),'utf8'),'New instruction');assert.equal(h.runtime.settings.autopilot().on,false);assert.ok(h.runtime.settings.autopilot().generation>permission.generation);
 const intent=h.runtime.journal.read({limit:0}).filter(r=>r.origin==='instruction-update');assert.equal(intent.length,1);assert.match(intent[0]!.text,new RegExp(hash('Original instruction')+' → '+hash('New instruction')));assert.doesNotMatch(intent[0]!.text,/Original instruction|New instruction/);
 await h.runtime.runTurn('worker','Check');assert.match(h.provider.calls.at(-1)!.ctx.roleNote!,/New instruction/);
 await h.runtime.close();const next=await createRuntime(h.deps,completedActions);t.after(()=>next.close());assert.equal(next.instructionFile('.harness/roles/shared.md')!.hash,hash('New instruction'));
});

test('39.2: stale hash, parallel saves, missing field and foreign project/instance fail without overwriting',async t=>{
 const h=await setup(t);for(const bad of [{project:'/foreign'},{instance:'foreign'},{expectedHash:undefined}])assert.equal((await update(h,bad)).body.ok,false);
 const responses=await Promise.all([update(h,{text:'first'}),update(h,{text:'second'})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(responses.find(r=>r.status===409)!.body.code,'file_changed');assert.equal(h.runtime.journal.read({limit:0}).filter(r=>r.origin==='instruction-update').length,1);
 const lock=deferred(),entered=deferred(),blocked=withPathLock(h.dir,async()=>{entered.resolve();await lock.promise});await entered.promise;
 const waiting=h.runtime.updateInstruction('worker',{...binding(h),text:'last',expectedHash:hash(readFileSync(file(h),'utf8'))},OWNER);const project=h.runtime.project;project.closed=true;lock.resolve();await blocked;await assert.rejects(waiting,{code:'project_changed'});project.closed=false;
});

test('39.2: only the configured missing instruction may be created; absent parent and unconfigured role stay typed',async t=>{
 const h=await setup(t);unlinkSync(file(h));const missing=await get(h);assert.equal(missing.body.code,'instruction_missing');assert.equal(missing.body.canCreate,true);assert.equal(missing.body.hash,null);assert.deepEqual(missing.body.sharedWith,['worker','reviewer']);assert.equal((await update(h,{expectedHash:null})).status,200);
 unlinkSync(join(h.dir,'.harness/roles/orchestrator.md'));const noPath=await call(h.api,'/api/panes/lead/instruction',{body:{...binding(h),text:'bad',expectedHash:null}});assert.equal(noPath.body.code,'instruction_missing');assert.equal(noPath.body.canCreate,false);
 renameSync(join(h.dir,'.harness/roles'),join(h.dir,'.harness/old-roles'));assert.equal((await get(h)).body.code,'instruction_missing');assert.equal((await get(h)).body.canCreate,false);
});

for(const swap of ['outside','parent','intent-failure'])test('39.2: '+swap+' cannot redirect a versioned instruction write',async t=>{
 const h=await setup(t),outside=await fixture(t),foreign=join(outside.dir,'untouched.md');writeFileSync(foreign,'Secret');
 if(swap==='outside'){unlinkSync(file(h));try{symlinkSync(foreign,file(h))}catch(error){if(process.platform==='win32'&&(error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows file symlink privilege unavailable');return}throw error}assert.equal((await get(h)).body.code,'file_outside');assert.equal((await update(h)).body.code,'file_outside')}
 else{const append=h.runtime.journal.append.bind(h.runtime.journal);let once=true;h.runtime.journal.append=input=>{const r=append(input);if(once&&input.origin==='instruction-update'){once=false;if(swap==='intent-failure')throw Error('lost before file write');renameSync(join(h.dir,'.harness/roles'),join(h.dir,'.harness/saved'));symlinkSync(outside.dir,join(h.dir,'.harness/roles'),process.platform==='win32'?'junction':'dir')}return r};const r=await update(h);assert.equal(r.body.ok,false);if(swap==='parent')assert.equal(r.body.code,'target_changed');else assert.equal((await get(h)).body.hash,hash('Original instruction'))}
 assert.equal(readFileSync(foreign,'utf8'),'Secret');
});

test('39.2: owner-created role uses the proposal store; repeat/concurrent POST, op conflict and restart stay singular',async t=>{
 const h=await setup(t),permission=await enable(h),body=own(h),[a,b]=await Promise.all([call(h.api,'/api/seats/propose',{body}),call(h.api,'/api/seats/propose',{body})]);assert.equal(a.status,200,a.text);assert.equal(b.status,200,b.text);assert.equal(a.body.proposalId,b.body.proposalId);assert.equal(a.body.pane,b.body.pane);assert.equal(h.runtime.registry.ids.length,4);assert.equal(h.provider.calls.length,0,'creating a role waits for its first open');
 const q=(await call(h.api,'/api/seats/proposals')).body.proposals[0];assert.equal(q.from,'owner');assert.equal(q.confirmed,true);assert.equal(q.questionSeq,null);assert.equal(q.ownerSeats['0'].created,true);assert.ok(h.runtime.settings.autopilot().generation>permission.generation);
 assert.equal((await call(h.api,'/api/seats/propose',{body:{...body,label:'Another'}})).body.code,'op_conflict');
 const knowledge=(await call(h.api,'/api/chats/'+a.body.chat)).body.knowledge;assert.match(knowledge.text,/Анализируй условия договора/);await h.runtime.onboard(a.body.pane,OWNER,{project:h.dir,chat:a.body.chat});await h.runtime.idle();assert.match(h.provider.calls.at(-1)!.message,/Анализируй условия договора/);
 await h.runtime.close();const next=await createRuntime(h.deps,completedActions);t.after(()=>next.close());const again=await next.proposeOwnerSeat({...body,instance:next.project.trace.instanceId},OWNER);assert.equal(again.pane,a.body.pane);assert.equal(next.registry.ids.length,4);
});

test('39.2: seven owner classes use the existing materializer; occupied orchestrator and bad inputs write no proposal',async t=>{
 const h=await fixture(t,{seats:'  worker: {kind: worker, role: executor, vendor: claude, model: w1, mode: read}'});
 for(const kind of SEAT_KINDS){const res=await call(h.api,'/api/seats/propose',{body:own(h,{kind,opId:'new-kind-'+kind})});assert.equal(res.status,200,res.text);assert.equal(h.runtime.registry.get(res.body.pane)!.kind,kind)}
 const count=(await call(h.api,'/api/seats/proposals')).body.proposals.length;assert.equal(count,7);
 const occupied=await call(h.api,'/api/seats/propose',{body:own(h,{kind:'orchestrator',opId:'new-orchestrator-2'})});assert.equal(occupied.body.code,'role_taken');
 for(const bad of [{kind:'admin'},{opId:undefined},{model:'missing'},{instance:'foreign'},{project:'/foreign'},{intro:''}])assert.equal((await call(h.api,'/api/seats/propose',{body:own(h,bad)})).body.ok,false);
 assert.equal((await call(h.api,'/api/seats/proposals')).body.proposals.length,count);
});

test('39.2: recorded owner intent completes after interruption without duplicate materialization',async t=>{
 let armed=true;const h=await fixture(t,{deps:{stateIO:{...diskIO,write(path,text){diskIO.write(path,text);if(armed&&path.endsWith('team-proposals.json')&&JSON.parse(text).proposals.some((q:any)=>q.ownerOperation)){armed=false;throw Error('intent durable; response lost')}}}}}),body=own(h);
 assert.equal((await call(h.api,'/api/seats/propose',{body})).body.ok,false);await h.runtime.close();const next=await createRuntime(h.deps,completedActions);t.after(()=>next.close());const made=await next.proposeOwnerSeat({...body,instance:next.project.trace.instanceId},OWNER);assert.equal(made.already,true);assert.equal(next.registry.ids.filter(id=>id.startsWith('worker-')).length,1);assert.equal((await next.teamProposals(OWNER)).proposals.length,1);
});

test('39.2: pane credentials cannot enter either owner door; generation guard is rechecked after waiting',async t=>{
 const h=await setup(t);for(const [path,body] of [['/api/seats/propose',own(h)],['/api/panes/worker/instruction',{...binding(h),text:'forged',expectedHash:hash('Original instruction')}]] as const){for(const headers of [{'X-Harness-Pane':'worker'},{'X-Pane-Token':'agent-token'},{'X-Harness-Pane':'worker','X-Pane-Token':'agent-token'}]){const res=await call(h.api,path,{body,headers});assert.equal(res.status,403,res.text);assert.equal(res.body.code,'owner_only')}}
 assert.equal(h.runtime.registry.ids.length,3);assert.equal((await call(h.api,'/api/seats/proposals')).body.proposals.length,0);assert.equal(readFileSync(file(h),'utf8'),'Original instruction');
 const permission=await enable(h),held=deferred(),release=deferred();const guarded=h.runtime.withAutopilotGeneration(permission.generation,async()=>{held.resolve();await release.promise});await held.promise;
 for(const invoke of [()=>h.runtime.proposeOwnerSeat(own(h),OWNER),()=>h.runtime.updateInstruction('worker',{...binding(h),text:'x',expectedHash:hash('Original instruction')},OWNER)])await assert.rejects(invoke,{code:'autopilot_busy'});release.resolve();await guarded;
});

test('39.2: simultaneous orchestrator proposals reserve the class before releasing the intent lock',async t=>{
 const h=await fixture(t),responses=await Promise.all(['first','second'].map(n=>call(h.api,'/api/seats/propose',{body:own(h,{opId:'concurrent-'+n,kind:'orchestrator'})})));assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(responses.find(r=>r.status===409)!.body.code,'role_taken');assert.equal((await call(h.api,'/api/seats/proposals')).body.proposals.length,1);
});

test('39.2: both owner effects recheck autopilot permission after the project lock; failed effects do not end until-reply',async t=>{
 const h=await setup(t),permission=await enable(h),projectGate=deferred(),projectHeld=deferred(),callbackGate=deferred(),callbackHeld=deferred();
 const locked=withPathLock(h.dir,async()=>{projectHeld.resolve();await projectGate.promise});await projectHeld.promise;
 const failures=Promise.all([assert.rejects(h.runtime.proposeOwnerSeat(own(h),OWNER),{code:'autopilot_busy'}),assert.rejects(h.runtime.updateInstruction('worker',{...binding(h),expectedHash:hash('Original instruction'),text:'denied'},OWNER),{code:'autopilot_busy'})]);
 const applying=h.runtime.withAutopilotGeneration(permission.generation,async()=>{callbackHeld.resolve();await callbackGate.promise});await callbackHeld.promise;projectGate.resolve();await locked;await failures;callbackGate.resolve();await applying;
 assert.equal(h.runtime.settings.autopilot().on,true);assert.equal(h.runtime.settings.autopilot().generation,permission.generation);assert.equal(readFileSync(file(h),'utf8'),'Original instruction');assert.equal((await call(h.api,'/api/seats/proposals')).body.proposals.length,0);
});
