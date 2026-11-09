import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {temp} from './test-support.ts';
import {ProjectRegistry} from './registry.ts';

test('TS-43: registered projects expose saved chat metadata without switching or exposing transcripts',async()=>{
 const t=temp();try{
  const paths=['current','other','empty','broken','link'].map(name=>join(t.root,name));for(const p of paths)mkdirSync(join(p,'.harness/state'),{recursive:true});
  const [current,other,,broken,link]=paths as [string,string,string,string,string],registry=join(t.root,'projects.json');writeFileSync(registry,JSON.stringify(paths));
  writeFileSync(join(other,'.harness/state/chats.json'),JSON.stringify({chats:{c1:{id:'c1',pane:'worker',title:'Смета дома',created:1,sessionId:'secret-session',carry:'private',transcript:[{text:'private-body'}]},c2:{id:'c2',pane:'reviewer',title:'Сверка',created:2}},active:{worker:'c1'}}));
  writeFileSync(join(broken,'.harness/state/chats.json'),'{broken');
  if(process.platform==='win32'){rmdirSync(join(link,'.harness/state'));symlinkSync(join(other,'.harness/state'),join(link,'.harness/state'),'junction')}
  else symlinkSync(join(other,'.harness/state/chats.json'),join(link,'.harness/state/chats.json'));
  const r=new ProjectRegistry({projects:registry,lastProject:join(t.root,'last')},{noLast:true}),data=await r.listProjects(current);
  assert.equal(data.current,current);assert.deepEqual(data.projects.find(p=>p.path===other)?.chats,[{id:'c2',pane:'reviewer',title:'Сверка',created:2},{id:'c1',pane:'worker',title:'Смета дома',created:1}]);
  assert.deepEqual(data.projects[2]!.chats,[]);for(const i of [3,4]){assert.equal(data.projects[i]!.chats,null);assert.match(data.projects[i]!.chatError!,/Не удалось прочитать/)}
  assert.doesNotMatch(JSON.stringify(data),/secret-session|private-body|transcript|carry/);
  assert.deepEqual((await r.listProjects(current)).projects.find(p=>p.path===other)?.chats,data.projects[1]!.chats);
 }finally{t.close()}
});
