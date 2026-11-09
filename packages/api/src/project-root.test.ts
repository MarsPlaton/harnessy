import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {RuntimeError} from '@harnessy/runtime';
import {fixture,call,OWNER,deferred} from './test-helpers.ts';

const error={ok:false,code:'path_is_root',error:'это папка всех проектов: выберите или создайте проект внутри'};
function snapshot(path:string):Record<string,string>{const out:Record<string,string>={};for(const name of readdirSync(path,{withFileTypes:true})){if(name.isDirectory())for(const [p,bytes] of Object.entries(snapshot(join(path,name.name))))out[name.name+'/'+p]=bytes;else if(name.isFile())out[name.name]=readFileSync(join(path,name.name)).toString('base64')}return out}

for(const route of ['/api/project','/api/project/create','/api/room/move'])for(const alias of ['literal','symlink','equivalent'])test('118/127: '+route+' refuses '+alias+' projects root before writes or closing',async t=>{
 const h=await fixture(t),root=join(h.dir,'project-folders'),link=join(h.dir,'alias');mkdirSync(root);mkdirSync(join(root,'child'));writeFileSync(join(root,'keep'),'исходные байты');symlinkSync(root,link,process.platform==='win32'?'junction':'dir');
 await h.runtime.settingsPatch('owner',{projectsRoot:root},OWNER);h.runtime.roomSet({model:'w1'},OWNER);const original=h.runtime.project,before=snapshot(root);
 const path=alias==='literal'?root:alias==='symlink'?link:root+'/child/.././';
 const response=await call(h.api,route,{body:{path,create:true,git:true,model:'w1'}});
 assert.equal(response.status,400);assert.deepEqual(response.body,error);assert.equal(h.runtime.project,original);assert.equal(original.closed,false);assert.deepEqual(snapshot(root),before);assert.equal(h.provider.calls.length,0);
 if(route==='/api/room/move'){const opened=await call(h.api,route,{body:{path}});assert.equal(opened.status,400);assert.deepEqual(opened.body,error);assert.deepEqual(snapshot(root),before)}
});

for(const route of ['/api/project','/api/project/create','/api/room/move'])for(const scope of ['owner','project','environment'])test('TS-10 r3: '+route+' retains the '+scope+' root and restores the owner door after a replacement while closing',async t=>{
 const h=await fixture(t),root=join(h.dir,'projects-root'),target=join(h.dir,'valid-project');mkdirSync(root);mkdirSync(target);writeFileSync(join(root,'keep'),'исходные байты');
 if(scope==='environment'){const old=process.env.HARNESS_PROJECTS_ROOT;process.env.HARNESS_PROJECTS_ROOT=root;t.after(()=>{if(old===undefined)delete process.env.HARNESS_PROJECTS_ROOT;else process.env.HARNESS_PROJECTS_ROOT=old})}
 else {if(scope==='project')await h.runtime.settingsPatch('owner',{projectsRoot:join(h.dir,'other-owner-root')},OWNER);await h.runtime.settingsPatch(scope,{projectsRoot:root},OWNER)}
 h.runtime.roomSet({model:'w1'},OWNER);const before=snapshot(root);
 const entered=deferred(),release=deferred(),close=h.provider.close.bind(h.provider);let once=true;t.after(()=>release.resolve());
 h.provider.close=async()=>{if(once){once=false;entered.resolve();await release.promise}return close()};
 const opening=call(h.api,route,{body:{path:target,create:true,git:false,model:'w1'}});await entered.promise;
 renameSync(target,target+'-original');symlinkSync(root,target,process.platform==='win32'?'junction':'dir');release.resolve();const response=await opening;
 assert.equal(response.status,400);assert.deepEqual(response.body,error);assert.deepEqual(snapshot(root),before);assert.equal(existsSync(join(root,'.harness')),false);assert.equal(h.provider.calls.length,0);
 assert.equal(h.runtime.project.dir,h.dir);assert.equal(h.runtime.project.closed,false);assert.equal(h.runtime.registry.get('room')!.model,'w1');
 if(scope==='project')assert.equal(h.runtime.settings.effective().projectsRoot,root);
 const status=await call(h.api,'/api/status');assert.equal(status.status,200);assert.equal(status.body.project,h.dir);
 const reopen=await call(h.api,'/api/project',{body:{path:h.dir}});assert.equal(reopen.status,200);assert.equal(reopen.body.project,h.dir);
 const child=join(root,'safe-child'),create=await call(h.api,'/api/project/create',{body:{path:child,git:false,model:'w1'}});assert.equal(create.status,200);assert.equal(create.body.project,child);assert.ok(existsSync(join(child,'.harness','team.yaml')));assert.equal(existsSync(join(root,'.harness')),false);
});

test('118/127: missing root cannot be materialized; child projects and root navigation remain available',async t=>{
 const h=await fixture(t),root=join(h.dir,'not-created','projects'),original=h.runtime.project;
 await h.runtime.settingsPatch('owner',{projectsRoot:root},OWNER);h.runtime.roomSet({model:'w1'},OWNER);
 for(const route of ['/api/project/create','/api/room/move']){const r=await call(h.api,route,{body:{path:root,create:true,git:false}});assert.equal(r.status,400);assert.deepEqual(r.body,error);assert.equal(existsSync(root),false);assert.equal(h.runtime.project,original)}
 const child=join(root,'child'),made=await call(h.api,'/api/project/create',{body:{path:child,git:false,model:'w1'}});assert.equal(made.status,200);assert.equal(made.body.project,child);assert.ok(existsSync(join(child,'.harness','team.yaml')));assert.equal(existsSync(join(root,'.harness')),false);
 const nav=await call(h.api,'/api/dir?cwd='+encodeURIComponent(root));assert.equal(nav.status,200);assert.deepEqual(nav.body,{ok:true,cwd:root,hasHarness:false});
});

test('118/127: direct open rejects realpath root while the active turn remains alive',async t=>{
 const h=await fixture(t),root=join(h.dir,'project-folders'),link=join(h.dir,'alias'),gate=deferred(),started=deferred();mkdirSync(root);symlinkSync(root,link,process.platform==='win32'?'junction':'dir');await h.runtime.settingsPatch('owner',{projectsRoot:link},OWNER);
 h.provider.onRun=async(_seat,_text,ctx)=>{ctx.modelStarted?.();started.resolve();await gate.promise;return {text:'готово',sessionId:null}};t.after(()=>gate.resolve());
 const original=h.runtime.project,turn=h.runtime.runTurn('worker','продолжай');await started.promise;
 await assert.rejects(h.runtime.openProject(root),e=>e instanceof RuntimeError&&e.code==='path_is_root'&&e.status===400);
 for(const route of ['/api/project','/api/project/create'])assert.deepEqual((await call(h.api,route,{body:{path:link,git:true}})).body,error);
 assert.equal(original.closed,false);assert.equal(h.runtime.project,original);assert.equal(h.provider.calls[0]!.ctx.signal.aborted,false);assert.equal(existsSync(join(root,'.harness')),false);gate.resolve();await turn;
});

test('118/127: absent roomMove path retains its typed refusal instead of opening process cwd',async t=>{
 const h=await fixture(t);h.runtime.roomSet({model:'w1'},OWNER);const original=h.runtime.project;
 for(const create of [false,true]){const r=await call(h.api,'/api/room/move',{body:{create}});assert.equal(r.status,400);assert.match(r.body.error,create?/нужен абсолютный путь/:/папки нет:/);assert.equal(h.runtime.project,original)}
});
