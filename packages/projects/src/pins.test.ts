import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,symlinkSync,readFileSync,rmSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {Pins} from './pins.ts';
import {temp,failure} from './test-support.ts';
test('[18,21,31] folder/chat pins enforce canonical project and server chat metadata, toggles and exact errors',async()=>{
 const t=temp();try{const current=join(t.root,'current'),other=join(t.root,'other'),alias=join(t.root,'alias'),path=join(t.root,'pins.json');mkdirSync(current);mkdirSync(other);symlinkSync(current,alias,process.platform==='win32'?'junction':'dir');
 const pins=new Pins(path,()=>current,id=>id==='chat'?{title:'real 😀',label:'воркер',pane:'worker'}:null);
 await pins.set({kind:'folder',path:other});assert.equal(pins.get().pins[0]!.current,false);
 assert.equal((await pins.set({kind:'folder',path:other})).on,false);await pins.set({kind:'folder',path:other,on:true});await pins.set({kind:'folder',path:other,on:true});assert.equal(pins.get().pins.length,1);
 const r=await pins.set({kind:'chat',path:alias+'/../alias',chat:'chat',title:'spoof'} as never);assert.equal(r.pins[1]!.path,current);assert.equal(r.pins[1]!.title,'real 😀');assert.equal(pins.get().pins[1]!.current,true);assert.equal(readFileSync(path,'utf8').includes('current'),true);assert.equal(readFileSync(path,'utf8').includes('"current":'),false);
 for(const [input,text,status] of [
 [{kind:'x',path:current},'kind: folder или chat; path обязателен',400],[{kind:'folder'},'kind: folder или chat; path обязателен',400],[{kind:'folder',path:join(t.root,'missing')},'нет такой папки',404],
 [{kind:'chat',path:current},'для чата нужен chat (id)',400],[{kind:'chat',path:other,chat:'chat'},'закрепить можно только чат открытой папки',400],[{kind:'chat',path:current,chat:'missing'},'нет такого чата',404]
 ] as const)await assert.rejects(pins.set(input),e=>failure('invalid_pin',text)(e)&&(e as {status:number}).status===status);
 }finally{t.close()}
});

test('TS-15e r2/1: only a missing file is empty; invalid bytes, shape and read failures never get overwritten',async()=>{
 const t=temp();try{const path=join(t.root,'pins.json'),pins=new Pins(path),unreadable=(e:any)=>e.code==='pins_unreadable'&&e.status===409;
 assert.deepEqual(pins.get().pins,[]);assert.equal(existsSync(path),false);
 for(const bytes of [Buffer.from('[{"kind":"folder",'),Buffer.from('{}'),Buffer.from('[null]'),Buffer.from('[{"kind":["folder"],"path":"/saved"}]'),Buffer.from('[{"kind":"chat","path":"/saved"}]'),Buffer.concat([Buffer.from('[{"kind":"folder","path":"/'),Buffer.from([0xff]),Buffer.from('"}]')])]){
  writeFileSync(path,bytes);assert.throws(()=>pins.get(),unreadable);
  for(const on of [false,true,undefined]){await assert.rejects(pins.set({kind:'folder',path:t.root,on}),unreadable);assert.deepEqual(readFileSync(path),bytes)}
 }
 rmSync(path);mkdirSync(path);assert.throws(()=>pins.get(),unreadable);await assert.rejects(pins.set({kind:'folder',path:t.root,on:false}),unreadable);assert.ok(statSync(path).isDirectory());
 }finally{t.close()}
});

test('172/186: explicit unpin survives missing folders/chats and preserves the same chat id in another project',async()=>{
 const t=temp();try{const a=join(t.root,'a'),b=join(t.root,'b');mkdirSync(a);mkdirSync(b);let current=a,exists=true;
 const pins=new Pins(join(t.root,'pins.json'),()=>current,()=>exists?{title:'saved',label:'role',pane:'worker'}:null);
 await pins.set({kind:'chat',path:a,chat:'same',on:true});await pins.set({kind:'folder',path:a,on:true});current=b;await pins.set({kind:'chat',path:b,chat:'same',on:true});exists=false;rmSync(a,{recursive:true});
 await pins.set({kind:'chat',path:a,chat:'same',on:false});await pins.set({kind:'chat',path:a,chat:'same',on:false});assert.equal(pins.get().pins.length,2);assert.ok(pins.get().pins.some(p=>p.kind==='chat'&&p.path===b));
 await pins.set({kind:'folder',path:a,on:false});await pins.set({kind:'chat',path:b,chat:'same',on:false});assert.deepEqual(pins.get().pins,[]);
 await assert.rejects(pins.set({kind:'folder',path:a,on:true}),failure('invalid_pin','нет такой папки'));await assert.rejects(pins.set({kind:'chat',path:b,chat:'same',on:true}),failure('invalid_pin','нет такого чата'));
 await assert.rejects(pins.set({kind:'chat',path:b,on:false}),failure('invalid_pin','для чата нужен chat (id)'));
 }finally{t.close()}
});
