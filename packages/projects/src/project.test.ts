import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {basename,join} from 'node:path';
import {loadTeam,ensureLine} from '@harnessy/team';
import {initProject,defaultModel,uniqueProject,projectsRoot} from './project.ts';
import {projectSlug,projectNameFrom} from './slug.ts';
import {ProjectRegistry} from './registry.ts';
import {validDir,expandUser} from './files.ts';
import {temp,repo} from './test-support.ts';
test('[10,15,28] init own nested git, one orchestrator, default model order without calls',async()=>{
 const t=temp();try{repo(t.root);const path=join(t.root,'child'),catalog={claude:[{id:'claude'}],codex:[{id:'codex'}]};assert.equal(defaultModel({roomModel:'room',catalog}),'room');assert.equal(defaultModel({catalog}),'claude');assert.equal(defaultModel({catalog:{codex:catalog.codex}}),'codex');assert.equal(defaultModel({catalog:{}}),'');
 const result=await initProject(path,{}, {catalog});assert.equal(result.created,true);assert.equal(result.git,true);assert.equal(result.orchestrator,true);assert.equal(existsSync(join(path,'.git')),true);assert.equal(loadTeam(join(path,'.harness')).seats.orchestrator!.model,'claude');
 const again=await initProject(path,{},{catalog});assert.equal(again.created,false);assert.equal(again.orchestrator,false);
 const [a,b]=await Promise.all([uniqueProject(join(t.root,'projects'),'same',{git:false,orchestrator:false}),uniqueProject(join(t.root,'projects'),'same',{git:false,orchestrator:false})]);assert.equal(basename(a.path),'same');assert.equal(basename(b.path),'same-2');
 }finally{t.close()}
});
test('[16] slug agrees with Python examples, time fallback, bounds and first owner message',()=>{
 assert.equal(projectSlug('Давай сделаем бота для записи к врачу на Telegram'),'bota-zapisi-vrachu-telegram');assert.equal(projectSlug("Hello, let's build a landing page for cafe"),'landing-page-cafe');
 assert.equal(projectSlug('!!!',()=>new Date(2026,9,9,3,5)),'proekt-0910-0305');assert.equal(projectSlug('word '.repeat(8)),'word-word-word-word');assert.equal(projectSlug('a'.repeat(100)).length,40);
 assert.equal(projectNameFrom([{role:'ai',text:'no'},{role:'me',text:'магазин книг'}]),'magazin-knig');assert.equal(projectsRoot({projectsRoot:'~/abc'},{}),expandUser('~/abc'));assert.equal(validDir('~'),false);
});
test('[17,21] registry preserves string order, raw closed seats, noLast forbids both files',async()=>{
 const t=temp();try{const a=join(t.root,'a'),b=join(t.root,'b');mkdirSync(a);mkdirSync(b);await ensureLine(a);const h=await ensureLine(b);writeFileSync(join(h,'team.yaml'),'seats: {x: {vendor: foreign}, y: {vendor: codex}}');
 const paths={projects:join(t.root,'known.json'),lastProject:join(t.root,'last')},r=new ProjectRegistry(paths,{noLast:false,currentSeats:()=>7});await Promise.all([r.rememberProject(a),r.rememberProject(b)]);await r.rememberProject(a);const listed=await r.listProjects(a);assert.deepEqual(listed.projects.map(p=>[p.path,p.seats]),[[a,7],[b,2]]);assert.equal(readFileSync(paths.lastProject,'utf8'),a);
 assert.equal(readFileSync(paths.projects,'utf8'),'[\n '+JSON.stringify(a)+',\n '+JSON.stringify(b)+'\n]');
 const before=readFileSync(paths.projects);await new ProjectRegistry(paths,{noLast:true}).rememberProject('/missing');assert.deepEqual(readFileSync(paths.projects),before);
 writeFileSync(join(h,'team.yaml'),'seats: [');assert.equal((await r.listProjects(a)).projects[1]!.seats,null);
 }finally{t.close()}
});

test('[26] project directory write failure returns ProjectError with the original OS cause',async()=>{
 const t=temp();try{const path=join(t.root,'file');writeFileSync(path,'kept');await assert.rejects(initProject(path),e=>e instanceof Error&&'code' in e&&e.code==='write_failed'&&e.message.startsWith('не записано: ')&&e.cause instanceof Error);assert.equal(readFileSync(path,'utf8'),'kept')
 }finally{t.close()}
});
