import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {withPathLock} from '@harnessy/team';
import {Settings} from './settings.ts';
import {temp,failure} from './test-support.ts';
const row={vendor:'claude',model:'same',inputPerM:1,outputPerM:2,cacheReadPerM:0,currency:'USD'};

test('176 r2: queued owner patch reads the captured canonical file when its symlink changes',async t=>{
 const h=temp();t.after(h.close);const a=join(h.root,'a.json'),b=join(h.root,'b.json'),link=join(h.root,'owner.json');
 writeFileSync(a,JSON.stringify({keep:'OWNER_A',defaultMode:'read'}));writeFileSync(b,JSON.stringify({other:'FILE_B',defaultMode:'all'}));try{symlinkSync(a,link)}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows file symlink requires privilege');return}throw e}const beforeB=readFileSync(b);
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);t.after(()=>release());
 const lock=withPathLock(a,async()=>{entered();await held});await ready;
 const pending=new Settings(link).patch('owner',{priceList:[row]});unlinkSync(link);symlinkSync(b,link);release();await lock;const reply=await pending;
 const expected={keep:'OWNER_A',defaultMode:'read',priceList:[row]};assert.deepEqual(JSON.parse(readFileSync(a,'utf8')),expected);assert.deepEqual(reply.saved,expected);
 assert.deepEqual(readFileSync(b),beforeB);assert.deepEqual(readFileSync(link),beforeB);
});

test('176: prices are owner-only, zero is known; project disk data cannot override the owner',async t=>{
 const h=temp();t.after(h.close);const project=join(h.root,'project');mkdirSync(join(project,'.harness','state'),{recursive:true});const s=new Settings(join(h.root,'owner'),()=>project);
 assert.deepEqual(s.priceList(),[]);await s.patch('owner',{priceList:[row,{...row,vendor:'codex',currency:'EUR'}]});assert.equal(s.get().owner.priceList instanceof Array,true);assert.equal(s.priceList()[0]!.cacheReadPerM,0);
 writeFileSync(join(project,'.harness','state','settings.json'),JSON.stringify({priceList:[{...row,inputPerM:999}],defaultMode:'read'}));assert.deepEqual(s.effective().priceList,s.priceList());assert.equal(s.get().effective.defaultMode,'read');
 await assert.rejects(s.patch('project',{priceList:[]}),failure('invalid_settings'));await assert.rejects(s.patch('project',{priceList:null}),failure('invalid_settings'));
 await s.patch('owner',{priceList:null});assert.deepEqual(s.priceList(),[]);assert.equal(s.get().effective.priceList,undefined);
});

test('176: whole price patch validation rejects duplicates, missing fields, malformed and nonfinite rates before writing',async t=>{
 const h=temp();t.after(h.close);const path=join(h.root,'owner'),s=new Settings(path);await s.patch('owner',{keep:true,priceList:[row]});const before=readFileSync(path);
 const invalid:unknown[]=[{},'x',[null],[row,row],[{...row,vendor:''}],[{...row,model:' '}],[{...row,currency:''}]];
 for(const key of ['inputPerM','outputPerM','cacheReadPerM'])for(const value of [undefined,null,-1,Infinity,NaN,'3'])invalid.push([{...row,[key]:value}]);
 for(const key of ['vendor','model','currency'])invalid.push([{...row,[key]:undefined}]);
 for(const priceList of invalid){await assert.rejects(s.patch('owner',{keep:false,priceList}),failure('invalid_settings'));assert.deepEqual(readFileSync(path),before)}
});

test('176: corrupt prices fail explicitly, valid replacement repairs the table without deleting adjacent settings',async t=>{
 const h=temp();t.after(h.close);const path=join(h.root,'owner'),s=new Settings(path);
 for(const content of [Buffer.from([0xff]),Buffer.from('{'),Buffer.from('[]'),Buffer.from(JSON.stringify({keep:1,priceList:[{...row,inputPerM:-1}]}))]){
  writeFileSync(path,content);assert.throws(()=>s.priceList(),failure('pricelist_unreadable'));assert.throws(()=>s.get(),failure('pricelist_unreadable'));assert.doesNotThrow(()=>s.effective());await assert.rejects(s.patch('owner',{other:1}),failure('pricelist_unreadable'));assert.deepEqual(readFileSync(path),content);
 }
 await s.patch('owner',{priceList:[row]});assert.equal(s.get().owner.keep,1);assert.deepEqual(s.priceList(),[row]);
});

test('176: a queued patch persists its validated price snapshot, concurrent unrelated settings survive',async t=>{
 const h=temp();t.after(h.close);const path=join(h.root,'owner'),s=new Settings(path);let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{entered=r});t.after(()=>release());
 const lock=withPathLock(path,async()=>{entered();await held});await ready;
 const priceList=[{...row}],pending=s.patch('owner',{priceList});priceList[0]!.inputPerM=-1;priceList.push({...row});release();await lock;await pending;
 await Promise.all([s.patch('owner',{first:1}),s.patch('owner',{second:2})]);assert.deepEqual(s.priceList(),[row]);assert.equal(s.get().owner.first,1);assert.equal(s.get().owner.second,2);
});
