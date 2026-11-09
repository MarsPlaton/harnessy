import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,symlinkSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {Settings} from './settings.ts';
import {parseCompat,compatJson,orderedClone} from '@harnessy/journal';
import {temp,failure} from './test-support.ts';
test('[19,30,36] settings precedence, whole-patch validation, Unicode, deletion and list contents',async()=>{
 const t=temp();try{const project=join(t.root,'project');mkdirSync(project);const path=join(t.root,'settings.json'),s=new Settings(path,()=>project,()=>1234000);
 await s.patch('owner',{defaultMode:'edit',quietHours:[23,8],array:[null,{nested:true}],язык:'русский'});await s.patch('project',{defaultMode:'check'});assert.equal(s.effective().defaultMode,'check');assert.deepEqual(s.effective().array,[null,{nested:true}]);await s.patch('project',{defaultMode:null});assert.equal(s.effective().defaultMode,'edit');
 const before=readFileSync(path);
 for(const [scope,patch,text] of [['x',{a:1},'scope: owner или project; patch — объект ключ → значение'],['owner',{},'scope: owner или project; patch — объект ключ → значение'],['owner',{___:1},"ключ '___' не годится"],['owner',{good:1,'bad key!':1},"ключ 'bad key!' не годится"],['owner',{a:{}},'значение a: только строка, число, флаг или список'],['owner',{defaultMode:'root'},'defaultMode: all, ask, chat, check, edit, read, web']] as const)await assert.rejects(s.patch(scope,patch),failure('invalid_settings',text));
 assert.deepEqual(readFileSync(path),before);await assert.rejects(new Settings(path).patch('project',{a:1}),failure('invalid_settings','папка не открыта'));
 await s.patch('owner',{['𐐀'.repeat(40)]:1,'½':2});await assert.rejects(s.patch('owner',{['𐐀'.repeat(41)]:1}),failure('invalid_settings'));
 await Promise.all([s.patch('owner',{first:1}),new Settings(path).patch('owner',{second:2})]);assert.equal(s.effective().first,1);assert.equal(s.effective().second,2);
 }finally{t.close()}
});
test('[21] owner JSON golden bytes retain Unicode, numeric keys, float spelling, indent1 and no LF',()=>{
 const text=readFileSync(new URL('./fixtures/owner.json',import.meta.url),'utf8'),value=parseCompat(text);assert.equal(compatJson(value,1),text);assert.equal(compatJson(orderedClone(value as Record<string,unknown>),1),text);
});

test('[19,26,30] nonprintable key errors use Python repr and owner write failure is typed',async()=>{
 const t=temp();try{const s=new Settings(join(t.root,'settings.json'));
 for(const [key,repr] of [['a\u200db',"'a\\u200db'"],['a\u0085b',"'a\\x85b'"],['a\nb',"'a\\nb'"]])await assert.rejects(s.patch('owner',{[key!]:1}),failure('invalid_settings','ключ '+repr+' не годится'));
 const directory=join(t.root,'directory');mkdirSync(directory);await assert.rejects(new Settings(directory).patch('owner',{key:1}),e=>failure('write_failed')(e)&&(e as Error).message.startsWith('не записано: '));
 }finally{t.close()}
});

test('[r2:3] parallel settings patches via a file symlink preserve the link and both updates',async ctx=>{
 const t=temp();try{const real=join(t.root,'real.json'),alias=join(t.root,'alias.json');writeFileSync(real,'{"existing": true}');try{symlinkSync('real.json',alias)}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){ctx.skip('Windows file symlink privilege is unavailable');return}throw e}
 await Promise.all([new Settings(alias).patch('owner',{first:1}),new Settings(real).patch('owner',{second:2})]);
 assert.equal(lstatSync(alias).isSymbolicLink(),true);assert.deepEqual(readFileSync(alias),readFileSync(real));assert.deepEqual(new Settings(real).effective(),{existing:true,first:1,second:2});
 const target=join(t.root,'new','target.json'),dangling=join(t.root,'dangling.json');symlinkSync(target,dangling);await new Settings(dangling).patch('owner',{created:1});assert.equal(lstatSync(dangling).isSymbolicLink(),true);assert.deepEqual(readFileSync(dangling),readFileSync(target));
 }finally{t.close()}
});


test('23d r2: provider network generations persist across writers and never return after A-B-A or deletion',async()=>{
 const t=temp();try{const path=join(t.root,'settings.json'),a=new Settings(path),b=new Settings(path);
 const initial=a.networkGeneration('claude');await a.changeNetwork(async c=>{c.exits.p={id:'p',type:'proxy',label:'Proxy',url:'http://127.0.0.1:1'};c.chains.claude=['p'];return {result:undefined}});const first=a.networkGeneration('claude');assert.notEqual(first,initial);assert.equal(b.networkGeneration('claude'),first);
 for(const port of [2,1])await b.changeNetwork(async c=>{const exit=c.exits.p!;if(exit.type==='proxy')exit.url='http://127.0.0.1:'+port;return {result:undefined}});assert.notEqual(a.networkGeneration('claude'),first);const restored=a.networkGeneration('claude');
 await b.changeNetwork(async c=>{c.exits.other={id:'other',type:'direct',label:'Direct'};c.chains.codex=['other'];return {result:undefined}});assert.equal(a.networkGeneration('claude'),restored);
 await b.changeNetwork(async c=>{delete c.chains.claude;return {result:undefined}});assert.notEqual(a.networkGeneration('claude'),initial);const deleted=a.networkGeneration('claude');await a.changeNetwork(async()=>({result:undefined}));assert.equal(a.networkGeneration('claude'),deleted);
 }finally{t.close()}
});
