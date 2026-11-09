import {promotionInput} from '../../runtime/src/test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProjectRegistry,ownerPaths} from '@harnessy/projects';
import {testOwnerEnvironment} from '../../projects/src/test-helpers.ts';
import {fixture,call,OWNER,deferred} from './test-helpers.ts';

for(const route of ['set','create','room-open','room-create','conversation','restore-set','restore-create','restore-room'])test('148/150: HARNESS_NO_LAST=1 protects both owner files through '+route+' despite noLast:false',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'harnessy-no-last-')),env={...testOwnerEnvironment(directory),HARNESS_NO_LAST:'1'},previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
 Object.assign(process.env,env);t.after(()=>{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(directory,{recursive:true,force:true})});
 const paths=ownerPaths();writeFileSync(paths.projects,'["/owner/project"]\n');writeFileSync(paths.lastProject,'/owner/project\n');const before=[readFileSync(paths.projects),readFileSync(paths.lastProject)];
 const registry=new ProjectRegistry(undefined,{noLast:false}),h=await fixture(t,{deps:{projectRegistry:registry}});
 const target=join(h.dir,'new-project'),root=join(h.dir,'projects-root');mkdirSync(root);await h.runtime.settingsPatch('owner',{projectsRoot:root},OWNER);
 await call(h.api,'/api/room',{body:{model:'w1',folder:route!=='conversation'}});
 let response;
 if(route==='set'||route==='room-open'){mkdirSync(target);response=await call(h.api,route==='set'?'/api/project':'/api/room/move',{body:{path:target}})}
 else if(route==='create'||route==='room-create')response=await call(h.api,route==='create'?'/api/project/create':'/api/room/move',{body:{path:target,create:true,git:false,model:'w1'}});
 else if(route==='conversation'){
  await call(h.api,'/api/chat',{body:{pane:'room',message:'Создание искового заявления'}});await h.runtime.idle();response=await call(h.api,'/api/assign',{body:{...promotionInput(h.runtime),role:'orchestrator'}});assert.equal(response.body.created,true);
 }else{
  mkdirSync(target);const entered=deferred(),release=deferred(),close=h.provider.close.bind(h.provider);let once=true;t.after(()=>release.resolve());
  h.provider.close=async()=>{if(once){once=false;entered.resolve();await release.promise}return close()};
  const endpoint=route==='restore-set'?'/api/project':route==='restore-create'?'/api/project/create':'/api/room/move';
  const opening=call(h.api,endpoint,{body:{path:target,create:true,git:false,model:'w1'}});await entered.promise;renameSync(target,target+'-old');symlinkSync(root,target,process.platform==='win32'?'junction':'dir');release.resolve();response=await opening;
  assert.equal(response.status,400);assert.equal(response.body.code,'path_is_root');assert.equal((await call(h.api,'/api/status')).body.project,h.dir);assert.equal((await call(h.api,'/api/project',{body:{path:h.dir}})).status,200);
 }
 if(!route.startsWith('restore-'))assert.equal(response.status,200,JSON.stringify(response.body));
 assert.deepEqual([readFileSync(paths.projects),readFileSync(paths.lastProject)],before);
 // The ordinary writer still works when both sources of the prohibition are absent.
 delete process.env.HARNESS_NO_LAST;await registry.rememberProject('/ordinary/project');assert.equal(readFileSync(paths.lastProject,'utf8'),'/ordinary/project');assert.ok(JSON.parse(readFileSync(paths.projects,'utf8')).includes('/ordinary/project'));
});
