import {fixtureSource,fixtureGroups} from './live-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext,runInContext} from 'node:vm';
import {dom} from './ui-dom-test-helpers.ts';
import {fixture,call,deferred,OWNER} from './test-helpers.ts';
import {createApi} from './server.ts';
import {testSite} from './site-test-helpers.ts';
type Data=Record<string,any>;
const live=readFileSync(new URL('../../../ui/deploy/live.js',import.meta.url),'utf8');
const ctxSource=readFileSync(new URL('../../../ui/deploy/ctx.js',import.meta.url),'utf8');
const messages=()=>[{role:'me',text:'Первое сообщение'},{role:'ai',src:'sys',text:'Служебная строка'},{role:'ai',src:'live',who:'Модель',text:'Ответ модели'},{role:'me',text:'Третье <img src=x> сообщение 🧠'}].map((m,i)=>({...m,seq:i+1}));
function ui(send?:(body:Data)=>Promise<Data>){
 const d=dom('<div class="frame cur"><div class="main"><div class="feed"></div><div class="box"><div class="in"></div><div class="bar2"></div></div></div></div>');Object.assign(d.document,{body:d.body,documentElement:d.html});d.html.setAttribute('data-proto','');d.html.setAttribute('data-page','chat');
 const H:Data={on:true,project:'/a',pane:{id:'worker',label:'Воркер',vendor:'claude',model:'w1',mode:'read'},panes:[{id:'worker',label:'Воркер'},{id:'reviewer',label:'Ревьюер'}],active:{worker:'chat-a'}},S:Data={ui:{pane:'worker'},chat:messages(),cx:{folder:'',modes:{},att:[],conn:{},noFolder:false}},requests:Data[]=[],toasts:string[]=[],notices:Data[]=[];
 const ctx:Data={document:d.document,PAGE:'chat',H,S,setTimeout(){},addEventListener:d.window.addEventListener.bind(d.window),esc:(s:unknown)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!)),fmtN:String,paneName:(p:Data)=>p.label,
  quoteBlock:(text:string,index=1)=>text.split('\n').map((line,i)=>(i?'':'['+index+'] ') +'> '+line).join('\n'),modelName:String,warningEvent:()=>false,now:()=>1,laMulti:(_anchor:any,_title:any,_items:any,_label:any,choose:any)=>{ctx.choose=choose},toast:(s:string)=>toasts.push(s),save(){},log(){},hStatus(){},pickPane(){H.pane=H.panes.find((p:Data)=>p.id===S.ui.pane)},loadChat:async()=>{},noteHandoff:(r:Data)=>notices.push(r),
  api:async(path:string,body:Data)=>{assert.equal(path,'/api/handoff');requests.push(JSON.parse(JSON.stringify(body)));return send?send(body):{ok:true,seq:1}},
  render(){d.document.querySelector('.feed')!.innerHTML=S.chat.map((m:Data,i:number)=>ctx.selection.ckBox(m,i)+(m.src==='live'?'<div class="live-acts"><button type="button" data-la="handoff" data-i="'+i+'">передать контекст</button></div>':'')).join('');ctx.selection.selBar()}};
 ctx.window=ctx;const context=createContext(ctx);
 runInContext(fixtureSource(live,fixtureGroups.live_bindingGeneration_to_settingsReady,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_ckBox_to_ckBox,{filename:'live.js',wrapper:0})+
  fixtureSource(live,fixtureGroups.live_SEL_to_document,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_closeLAMenus_to_laMulti,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_hEvent_to_hEvent,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_document_to_document,{filename:'live.js',wrapper:0})+'\nglobalThis.selection={selStart,selBar,selChars,ckBox,hEvent,noteHandoff,sendBinding,bindingCurrent,invalidateBinding,configureSetting};',context);
 ctx.LIVE={H,S,...ctx.selection,api:ctx.api,esc:ctx.esc,save(){},log(){},toast:ctx.toast,paneName:ctx.paneName,hStatus:ctx.hStatus,pickPane:ctx.pickPane,busy:()=>false,loadChat:ctx.loadChat,refreshStatus:async()=>{}};const ta=d.document.createElement('textarea');d.document.querySelector('.in')!.appendChild(ta);(d.document.querySelector('.box') as any).__cx={ta};runInContext(readFileSync(new URL('../../../ui/deploy/cx.js',import.meta.url),'utf8'),context);
 const find=(selector:string)=>{const node=d.document.querySelector(selector);assert.ok(node,selector);return node};
 const select=async(index:number,on=true)=>{const input:any=find('.live-sel-list [data-ck="'+index+'"]');input.checked=on;await input.emit('click')};
 const start=(sw=false)=>ctx.selection.selStart('reviewer',{sw});
 return {...d,H,S,ctx,requests,toasts,notices,find,start,select};
}

test('TS-51.C: context parts use bound facts, report missing data and ignore late foreign snapshots',async()=>{
 let binding:Data={project:'/a',pane:'worker',chat:'chat-a',generation:1,instance:'instance-a'};
 const H:Data={on:true,project:'/a',pane:{id:'worker'},liveStatus:{trace:{instanceId:'instance-a'}}};
 let chat:Data={project:'/a',chat:{id:'chat-a',pane:'worker',active:true,documents:[{project:'/a',path:'docs/one & two.md'}]},messages:[{role:'me',attachments:[{mime:'image/png'}]},{role:'ai',attachments:[{mime:'image/jpeg'}]}]};
 let swarm:Data={ok:true,project:'/a',instance:'instance-a',panes:[{id:'worker',chat:'chat-a',instructionPath:'.harness/roles/worker.md',digest:true}]};
 let metadata:Data={ok:true,project:'/a',path:'.harness/roles/worker.md'};let delay:Promise<void>|null=null;
 const L:Data={H,esc:(s:unknown)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!)),paneName:()=> 'Исполнитель',sendBinding:()=>({...binding}),bindingCurrent:(b:Data)=>['project','pane','chat','generation'].every(k=>b[k]===binding[k]),api:async(path:string)=>{if(path.startsWith('/api/chats/')){if(delay)await delay;return chat}if(path==='/api/swarm')return swarm;if(path.startsWith('/api/project/file?'))return metadata;throw Error(path)}};
 const sandbox:Data={L,Date,Math,URL};const context=createContext(sandbox);
 runInContext(fixtureSource(ctxSource,['fmt','instance','current','contextParts','readFacts'],{filename:'ctx.js',wrapper:0})+'\nglobalThis.views={readFacts,contextParts};',context);
 const card={parts:[{key:'instructions',tokens:2600,est:true}]},facts=await sandbox.views.readFacts(binding),html=sandbox.views.contextParts(facts,card);
 assert.match(html,/Инструкция роли <span>есть/);assert.match(html,/\.harness\/roles\/worker\.md/);assert.match(html,/docs\/one &amp; two\.md/);assert.match(html,/project=%2Fa&amp;path=docs%2Fone%20%26%20two\.md/);
 assert.match(html,/Сохранённые сообщения <span>2/);assert.match(html,/Вложения в сообщениях <span>2/);assert.match(html,/PNG · JPEG/);assert.match(html,/Сводка соседей <span>включена/);assert.match(html,/оценка текста|Оценка текста/);assert.match(html,/не токенизатор модели/);
 chat={project:'/a',chat:{id:'chat-a',pane:'worker',active:true},messages:null};swarm={...swarm,panes:[{...swarm.panes[0],digest:false}]};metadata={ok:false,code:'file_missing'};
 const missing=sandbox.views.contextParts(await sandbox.views.readFacts(binding),{parts:[]});assert.match(missing,/Инструкция роли <span>не найдена/);assert.match(missing,/Выбранные документы <span>нет данных/);assert.match(missing,/Сохранённые сообщения <span>нет данных/);assert.match(missing,/Вложения в сообщениях <span>нет данных/);assert.match(missing,/Сводка соседей <span>выключена/);
 const held=deferred();delay=held.promise;const stale=sandbox.views.readFacts(binding);binding={...binding,chat:'chat-b',generation:2};held.resolve();assert.deepEqual(JSON.parse(JSON.stringify(await stale)),{});
 binding={...binding,chat:'chat-a',generation:3};swarm={...swarm,instance:'other-instance'};delay=null;assert.deepEqual(JSON.parse(JSON.stringify(await sandbox.views.readFacts(binding))),{});
});

const electron=process.env.HARNESSY_TEST_ELECTRON||fileURLToPath(new URL('../../../ui/desktop/node_modules/.bin/electron',import.meta.url));
test('TS-51.C: real context card and transfer history fit four sizes with isolated engine data',{timeout:process.platform==='win32'?180_000:60_000,skip:existsSync(electron)?false:'Electron is not installed'},async t=>{
 const h=await fixture(t,{seats:'  worker: {role: executor, vendor: claude, label: Исполнитель, model: w1, mode: read, digest: true, instructions: roles/worker.md}',before:dir=>{mkdirSync(join(dir,'.harness','roles'),{recursive:true});mkdirSync(join(dir,'docs'));writeFileSync(join(dir,'.harness','roles','worker.md'),'Инструкция роли');writeFileSync(join(dir,'docs','пример.md'),'Документ');}}),r=h.runtime,pane=r.registry.get('worker')!;
 await r.settingsPatch('owner',{releaseUnderstood_0_1_0_alpha:true},OWNER);pane.record('me','Первый вопрос');pane.record('ai','Сохранённый ответ');
 const image=await call(h.api,'/api/attachments',{body:{base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}});assert.equal(image.status,201);pane.transcript[0]!.attachments=[image.body];r.project.state.saveChats(r.registry);const cid=r.project.state.chats.active.worker!;
 r.project.state.chats.chats[cid]!.documents=[{project:h.dir,path:'docs/пример.md'}];pane.record('peer','[от харнесс] контекст передан новой модели');
 pane.transcript.at(-1)!.contextTransfer={project:h.dir,chat:cid,turnInstanceId:'fixture-transfer',messages:2,verbatim:1,compressed:true,tokens:90,content:'Сохранённый текст',enabled:true};
 pane.record('peer','[от харнесс] контекст не передан');pane.transcript.at(-1)!.contextTransfer={project:h.dir,chat:cid,turnInstanceId:'fixture-failed',messages:0,verbatim:0,compressed:false,tokens:0,content:'',enabled:true,failure:{code:'unavailable',reason:'Не удалось прочитать историю'}};r.project.state.saveChats(r.registry);
 const api=createApi({runtime:r,siteDir:join(testSite(),'sketches'),port:0});await api.listen();t.after(()=>api.close());h.deps.appUrl=api.url;
 const env:NodeJS.ProcessEnv={...process.env,HARNESSY_TEST_WINDOW:'hidden',CONTEXT_BROWSER_BASE:api.url,CONTEXT_BROWSER_USER_DATA:join(h.dir,'electron-profile')};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(electron,[fileURLToPath(new URL('./context-facts-browser-driver.cjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM')});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});assert.equal(exit,0,stderr+'\n'+stdout);assert.match(stdout,/CONTEXT_BROWSER_OK/);assert.equal(h.provider.calls.length,0);
});

test('259: dialog opens with concrete messages, none checked, zero volume and disabled Send',async()=>{
 const v=ui();v.start();assert.equal(v.document.querySelectorAll('.live-sel-list input').length,3);assert.equal(v.document.querySelectorAll('[data-ck][checked]').length,0);
 assert.match(v.find('.live-selbar .n').textContent,/0 из 3 сообщений/);assert.equal(v.find('.live-selbar .ch').textContent,'0 знаков');assert.equal(v.find('[data-sel="go"]').disabled,true);
 await v.find('[data-sel="go"]').emit('click');assert.equal(v.requests.length,0);assert.match(v.find('.live-sel-list').textContent,/Третье <img src=x> сообщение/);assert.equal(v.document.querySelector('img'),null);assert.doesNotMatch(v.find('.live-sel-list').textContent,/Служебная/);
});

test('TS-50.B: a failed partial answer is never offered for context transfer, even with a sequence number',async()=>{
 const v=ui();v.S.chat.push({seq:99,role:'ai',src:'live',failed:true,text:'Незавершённый ответ'});v.start();
 assert.equal(v.document.querySelector('[data-ck="99"]'),null);assert.doesNotMatch(v.find('.live-sel-list').textContent,/Незавершённый ответ/);assert.ok(v.document.querySelector('[data-ck="3"]'));
});

test('259: selecting two sends exactly those two through HTTP; the next dialog is empty again',async t=>{
 const h=await fixture(t,{seats:'  worker: {role: worker, vendor: claude, model: w1, mode: read}\n  reviewer: {role: reviewer, vendor: claude, model: w1, mode: read}'});
 for(const m of messages())h.runtime.registry.get('worker')!.record(m.src==='sys'?'peer':m.role,m.text);const chat=h.runtime.chatsList({seat:'owner',trust:'owner'}).active.worker;
 const v=ui(async body=>{const r=await call(h.api,'/api/handoff',{body});assert.equal(r.status,200);return r.body});v.H.active.worker=chat;v.start();await v.select(1);await v.select(4);
 const count=[...messages()[0]!.text,...messages()[3]!.text].length;assert.equal(v.find('.live-selbar .ch').textContent,count+' знаков');assert.match(v.find('.live-selbar .n').textContent,/2 из 3/);assert.equal(v.find('[data-sel="go"]').disabled,false);
 await v.find('[data-sel="go"]').emit('click');await h.runtime.idle();assert.equal(v.requests.length,1);assert.deepEqual(v.requests[0]!.seqs,[1,4]);assert.equal(Object.hasOwn(v.requests[0]!,'text'),false);assert.doesNotMatch(h.runtime.journal.get(1)!.text,/Ответ модели|Служебная/);assert.match(h.runtime.journal.get(1)!.text,/Третье <img src=x> сообщение/);assert.equal(h.provider.calls.length,1);assert.match(h.provider.calls[0]!.message,/Первое сообщение/);assert.equal(v.document.querySelector('.live-selbar'),null);
 v.start();assert.equal(v.find('[data-sel="go"]').disabled,true);assert.equal(v.document.querySelectorAll('[data-ck][checked]').length,0);
});

test('TS-27: selected quote sends no whole messages and cancellation sends nothing',async()=>{
 const v=ui();v.ctx.selection.selStart('reviewer',{sw:false,quotes:[{seq:3,text:'Ответ модели',comment:'',source:'из ответа Модель, 15.10.2026 08:20'}]});assert.equal(v.document.querySelectorAll('.live-sel-list').length,0);assert.match(v.find('.live-sel-quotes pre').textContent,/\[1\] > Ответ модели/);
 const comment:any=v.find('[data-quote-comment]');comment.value='Проверить вывод';await comment.emit('input');await v.find('[data-sel="go"]').emit('click');assert.equal(v.requests.length,1);assert.deepEqual(v.requests[0]!.quotes,[{seq:3,text:'Ответ модели',comment:'Проверить вывод'}]);assert.equal(v.requests[0]!.prompt,'');assert.equal(Object.hasOwn(v.requests[0]!,'seqs'),false);
 const cancelled=ui();cancelled.ctx.selection.selStart('reviewer',{sw:false,quotes:[{seq:3,text:'Ответ модели',comment:'',source:'из ответа Модель'}]});await cancelled.find('[data-sel="cancel"]').emit('click');assert.equal(cancelled.requests.length,0);assert.equal(cancelled.document.querySelector('.live-selbar'),null);
});

test('259: Select all is explicit; unchecking one sends all except that message',async()=>{
 const v=ui();v.start();await v.find('[data-sel="all"]').emit('click');assert.match(v.find('.live-selbar .n').textContent,/3 из 3/);await v.select(3,false);
 assert.match(v.find('.live-selbar .n').textContent,/2 из 3/);await v.find('[data-sel="go"]').emit('click');assert.equal(v.requests.length,1);assert.deepEqual(v.requests[0]!.seqs,[1,4]);
});

test('259: clear and cancel do not preserve a selection; feed checkboxes and summary stay in sync',async()=>{
 const v=ui();v.start();const feed:any=v.find('.feed [data-ck="3"]');feed.checked=true;await feed.emit('click');assert.equal((v.find('.live-sel-list [data-ck="3"]') as any).checked,true);assert.equal(v.find('[data-sel="go"]').disabled,false);
 await v.find('[data-sel="none"]').emit('click');assert.equal(v.find('[data-sel="go"]').disabled,true);await v.select(4);await v.find('[data-sel="cancel"]').emit('click');v.start();assert.equal(v.document.querySelectorAll('[data-ck][checked]').length,0);assert.equal(v.requests.length,0);
});

test('TS-47.4 r2: selecting and clearing all preserves the focused controls and synchronizes both lists',async()=>{
 const v=ui();v.start();const all=v.find('[data-sel="all"]'),none=v.find('[data-sel="none"]'),prompt=v.find('.live-f');prompt.value='Сохранить вводную';
 all.focus();await all.emit('click');assert.equal(v.document.activeElement,all);assert.equal(v.find('[data-sel="all"]'),all);assert.equal(v.find('.live-f'),prompt);assert.equal(prompt.value,'Сохранить вводную');assert.match(v.find('.live-selbar .n').textContent,/3 из 3/);assert.ok([...v.document.querySelectorAll('[data-ck]')].every((n:any)=>n.checked));assert.equal(v.find('[data-sel="go"]').disabled,false);
 none.focus();await none.emit('click');assert.equal(v.document.activeElement,none);assert.equal(v.find('[data-sel="none"]'),none);assert.match(v.find('.live-selbar .n').textContent,/0 из 3/);assert.ok([...v.document.querySelectorAll('[data-ck]')].every((n:any)=>!n.checked));assert.equal(v.find('[data-sel="go"]').disabled,true);
});

test('259: selection and volume refer to the visible snapshot, not new or edited messages',async()=>{
 const v=ui();v.start();v.S.chat[0].text='Changed after opening';v.S.chat.push({role:'ai',src:'live',text:'New answer'});
 await v.find('[data-sel="all"]').emit('click');assert.match(v.find('.live-selbar .n').textContent,/3 из 3/);assert.equal(v.document.querySelector('[data-ck="5"]'),null);
 const prompt=v.find('.live-f');prompt.value='Только выбранное';await prompt.emit('input');await v.find('[data-sel="none"]').emit('click');assert.equal(v.find('.live-f').value,'Только выбранное');await v.select(1);await v.find('[data-sel="go"]').emit('click');assert.equal(v.requests[0]!.prompt,'Только выбранное');assert.deepEqual(v.requests[0]!.seqs,[1]);assert.equal(Object.hasOwn(v.requests[0]!,'text'),false);
});

for(const change of ['project','chat','pagehide'])test('259: '+change+' discards selection and cannot send the previous conversation',async()=>{
 const v=ui();v.start();await v.select(1);const send=v.find('[data-sel="go"]');if(change==='project')v.H.project='/b';if(change==='chat')v.H.active.worker='chat-b';await v.window.emit(change==='pagehide'?'pagehide':'live:status');await send.emit('click');assert.equal(v.requests.length,0);
 if(change!=='pagehide'){v.start();assert.equal(v.find('[data-sel="go"]').disabled,true)}
});

test('259: one transfer is in flight; a late receipt cannot switch a changed chat',async()=>{
 const gate=deferred<Data>();const v=ui(async()=>gate.promise);v.start(true);await v.select(1);const first=v.find('[data-sel="go"]').emit('click');await v.find('[data-sel="go"]').emit('click');assert.equal(v.requests.length,1);
 v.H.active.worker='chat-b';await v.window.emit('live:status');gate.resolve({ok:true,seq:1});await first;assert.equal(v.S.ui.pane,'worker');assert.equal(v.notices.length,0);
});

test('259: a failed transfer keeps the explicit choice for retry; a fabricated seq is ignored',async()=>{
 const v=ui(async()=>({ok:false,error:'temporary failure'}));v.start();const input:any=v.find('.live-sel-list input');input.dataset.ck='999';input.checked=true;await input.emit('click');assert.equal(v.find('[data-sel="go"]').disabled,true);
 input.dataset.ck='1';await input.emit('click');await v.find('[data-sel="go"]').emit('click');assert.match(v.toasts.at(-1)!,/temporary failure/);assert.equal(v.find('[data-sel="go"]').disabled,false);assert.match(v.find('.live-selbar .n').textContent,/1 из 3/);
});

for(const answers of [1,2])test('260: footer with '+answers+' answers opens an empty selector before any request',async()=>{
 const v=ui();v.S.chat=[{seq:1,role:'me',text:'Личное'},...Array.from({length:answers},(_,i)=>({seq:i+2,role:'ai',src:'live',text:'Ответ '+i}))];
 const button=v.document.createElement('button');button.setAttribute('data-la','handoff');button.setAttribute('data-i','1');const actions=v.document.createElement('div');actions.className='live-acts';actions.appendChild(button);v.body.appendChild(actions);await button.emit('click');
 await v.find('.la.multi [data-k="0"]').emit('click');await v.find('.la.multi [data-go]').emit('click');assert.equal(v.requests.length,0);assert.match(v.find('.live-selbar .n').textContent,new RegExp('0 из '+(answers+1)));assert.equal(v.find('[data-sel="go"]').disabled,true);
});

test('260: an SSE note trims the feed but never changes a selected seq or its count',async()=>{
 const v=ui();v.S.chat=[{seq:1,role:'me',text:'Личное владельца'},...Array.from({length:40},(_,i)=>({seq:i+2,role:'ai',src:'live',text:'Ответ '+i}))];v.start();await v.select(2);
 v.ctx.selection.hEvent({type:'note',text:'сдвиг ленты'});assert.equal(v.S.chat[0].seq,3);assert.match(v.find('.live-selbar .n').textContent,/1 из 41/);
 const visible:any=v.find('.feed [data-ck="3"]');visible.checked=true;await visible.emit('click');assert.match(v.find('.live-selbar .n').textContent,/2 из 41/);
 await v.find('[data-sel="go"]').emit('click');assert.deepEqual(v.requests[0]!.seqs,[2,3]);assert.equal(Object.hasOwn(v.requests[0]!,'text'),false);
});

test('260: HTTP refuses empty, foreign, unknown or malformed seqs and text injection without posting',async t=>{
 const h=await fixture(t,{seats:'  worker: {role: worker, vendor: claude, model: w1, mode: read}\n  reviewer: {role: reviewer, vendor: claude, model: w1, mode: read}'}),r=h.runtime;
 r.registry.get('worker')!.record('me','не выбранное');r.registry.get('worker')!.record('ai','выбранное');
 const other=r.registry.get('reviewer')!;for(let i=0;i<3;i++)other.record('ai','чужое '+i);const active=r.chatsList({seat:'owner',trust:'owner'}).active;
 const valid={from:'worker',to:'reviewer',chat:active.worker,seqs:[2]},before=r.journal.lastSeq;
 for(const change of [{seqs:[]},{seqs:undefined},{seqs:[3]},{seqs:[99]},{seqs:[2,99]},{seqs:['2']},{seqs:[2,2]},{seqs:[-1]},{seqs:[null]},{chat:active.reviewer},{chat:'absent'},{chat:'__proto__'},{text:'поддельная стенограмма'}]){
  const response=await call(h.api,'/api/handoff',{body:{...valid,...change}});assert.equal(response.status,400,JSON.stringify(change));assert.equal(r.journal.lastSeq,before);assert.equal(h.provider.calls.length,0);
 }
 const receipt=await call(h.api,'/api/handoff',{body:valid});assert.equal(receipt.status,200);await r.idle();const sent=r.journal.get(receipt.body.seq)!.text;assert.match(sent,/Ответ: выбранное/);assert.doesNotMatch(sent,/не выбранное|чужое/);assert.equal(h.provider.calls.length,1);
});


test('260: the actual role-switch context door opens empty and sends only explicitly selected ids',async()=>{
 const v=ui();await v.find('[data-cx="role"]').emit('click');await v.find('[data-cx-seat="reviewer"]').emit('click');await v.find('[data-cx-sw="ctx"]').emit('click');
 assert.equal(v.requests.length,0);assert.equal(v.find('[data-sel="go"]').disabled,true);await v.select(3);await v.find('[data-sel="go"]').emit('click');assert.deepEqual(v.requests[0]!.seqs,[3]);assert.equal(v.requests[0]!.chat,'chat-a');assert.equal(v.S.ui.pane,'reviewer');
});

test('261: streamed owner and model replies retain engine ids for selection; an unbound result is not selectable',async()=>{
 const v=ui();Object.assign(v.ctx,{mdFiles:new Map(),now:()=>1,md:String,mdMessageArtifacts:()=>'',toolLine:()=>''});
 runInContext(fixtureSource(live,fixtureGroups.live_statNumber_to_messageUsage,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_finish_to_updateTurn,{filename:'live.js',wrapper:0})+'globalThis.finish=finish;',v.ctx);
 v.S.chat=[{role:'me',text:'Новый вопрос'}];v.H.cur={text:'Новый ответ',tools:[]};v.ctx.finish({type:'done',chat:'chat-a',seq:9,messages:[{role:'me',text:'Новый вопрос',seq:8}]});v.start();await v.find('[data-sel="all"]').emit('click');await v.find('[data-sel="go"]').emit('click');assert.deepEqual(v.requests[0]!.seqs,[8,9]);
 v.S.chat=[];v.H.cur={text:'Без привязки',tools:[]};v.ctx.finish({type:'done',seq:10});v.start();assert.equal(v.document.querySelector('.live-selbar'),null);assert.equal(v.requests.length,1);
});

test('TS-47.4 F09: recipient controls restore focus and a transfer receipt is shown once',async()=>{
 const gate=deferred<Data>(),v=ui(async()=>gate.promise);v.H.panes.push({id:'tester',label:'Тестер'});v.ctx.render();const opener=v.find('[data-la="handoff"]');opener.focus();await opener.emit('click');
 let recipient=v.find('.la.multi [data-k="0"]');assert.equal(recipient.tagName,'BUTTON');assert.equal(recipient.getAttribute('role'),'checkbox');assert.equal(recipient.getAttribute('aria-checked'),'false');assert.equal(v.document.activeElement,recipient);
 await recipient.emit('click');recipient=v.find('.la.multi [data-k="0"]');assert.equal(recipient.getAttribute('aria-checked'),'true');assert.equal(v.document.activeElement,recipient);const second=v.find('.la.multi [data-k="1"]');second.focus();await second.emit('click');assert.equal(v.find('.la.multi [data-k="1"]').getAttribute('aria-checked'),'true');assert.match(v.find('.la.multi [data-go]').textContent,/\(2\)/);
 await v.find('.la.multi [data-x]').emit('click');assert.equal(v.document.activeElement,opener);
 await opener.emit('click');await v.find('.la.multi [data-k="0"]').emit('click');await v.find('.la.multi [data-go]').emit('click');await v.find('[data-sel="cancel"]').emit('click');assert.equal(v.document.activeElement,v.find('[data-la="handoff"]'));
 const current=v.find('[data-la="handoff"]');current.focus();await current.emit('click');await v.find('.la.multi [data-k="0"]').emit('click');await v.find('.la.multi [data-go]').emit('click');await v.select(3);
 const sending=v.find('[data-sel="go"]').emit('click');v.ctx.selection.hEvent({type:'note',text:'контекст передан: Ревьюер · запись №31'});assert.equal(v.S.chat.some((m:Data)=>String(m.text).includes('запись №31')),false);gate.resolve({ok:true,seq:31,names:'Ревьюер'});await sending;
 v.ctx.selection.hEvent({type:'note',text:'контекст передан: Ревьюер · запись №31'});assert.equal(v.S.chat.filter((m:Data)=>m.handoffSeq==='31').length,1);assert.equal(v.document.activeElement,v.find('[data-la="handoff"]'));
 v.S.chat.push({role:'ai',src:'sys',text:'[от харнесс] контекст передан: Ревьюер · запись №32'});v.ctx.selection.noteHandoff({seq:32,names:'Ревьюер'});assert.equal(v.S.chat.filter((m:Data)=>String(m.text).includes('запись №32')).length,1);
 v.H.active.worker='chat-b';v.S.chat=[];v.ctx.selection.hEvent({type:'note',text:'контекст передан: Ревьюер · запись №31'});assert.equal(v.S.chat.length,0,'an unbound late event cannot appear in another chat');
});

test('TS-47.4 r2: late receipt never steals focus from a new draft',async()=>{
 const gate=deferred<Data>(),v=ui(()=>gate.promise);v.ctx.render();v.start();await v.select(1);const go=v.find('[data-sel="go"]');go.focus();const sending=go.emit('click');assert.equal(v.document.activeElement,v.find('.live-selbar'));
 const input=v.find('.box textarea');input.focus();input.value='Новый черновик';gate.resolve({ok:true,seq:42,names:'Ревьюер'});await sending;assert.equal(v.document.activeElement,input);assert.equal(input.value,'Новый черновик');
});

for(const moved of [false,true])test('TS-47.4 r2: failed transfer '+(moved?'respects an external focus':'focuses retry inside the operation'),async()=>{
 const gate=deferred<Data>(),v=ui(()=>gate.promise);v.start();await v.select(1);const go=v.find('[data-sel="go"]');go.focus();const sending=go.emit('click');const input=v.find('.box textarea');if(moved)input.focus();gate.resolve({ok:false,error:'Временный отказ'});await sending;
 assert.equal(v.document.activeElement,moved?input:v.find('[data-sel="go"]'));assert.equal(v.find('[data-sel="go"]').disabled,false);assert.match(v.find('.live-selbar .n').textContent,/1 из 3/);
});

test('TS-47.4 r3: an SSE redraw keeps the focused introduction and its caret',async()=>{
 const v=ui();v.start();const prompt=v.find('.live-selbar .live-f');prompt.focus();prompt.value='Личная вводная';prompt.setSelectionRange(3,7);await prompt.emit('input');
 v.ctx.selection.hEvent({type:'note',text:'событие во время ввода'});const restored=v.find('.live-selbar .live-f');assert.notEqual(restored,prompt);assert.equal(v.document.activeElement,restored);assert.equal(restored.value,'Личная вводная');assert.equal(restored.selectionStart,3);assert.equal(restored.selectionEnd,7);
});

for(const ok of [false,true])for(const moved of [false,true])test('TS-47.4 r3: SSE during '+(ok?'success':'refusal')+' '+(moved?'does not steal the draft focus':'keeps the operation focus'),async()=>{
 const gate=deferred<Data>(),v=ui(()=>gate.promise);v.ctx.render();const opener=v.find('[data-la="handoff"]');opener.focus();v.start();await v.select(1);const go=v.find('[data-sel="go"]');go.focus();const sending=go.emit('click');
 const input=v.find('.box textarea');if(moved){await input.emit('pointerdown');input.focus();input.value='Новый черновик';await input.emit('focusin')}
 const old=v.find('.live-selbar');v.ctx.selection.hEvent({type:'note',text:'событие во время передачи'});assert.notEqual(v.find('.live-selbar'),old);assert.equal(v.document.activeElement,moved?input:v.find('.live-selbar'));
 gate.resolve(ok?{ok:true,seq:44,names:'Ревьюер'}:{ok:false,error:'Временный отказ'});await sending;
 assert.equal(v.document.activeElement,moved?input:ok?v.find('[data-la="handoff"]'):v.find('[data-sel="go"]'));if(moved)assert.equal(input.value,'Новый черновик');
});

test('TS-47.4 r3: an outside pointer action revokes focus ownership even without a focusout',async()=>{
 const gate=deferred<Data>(),v=ui(()=>gate.promise);v.start();await v.select(1);const go=v.find('[data-sel="go"]');go.focus();const sending=go.emit('click');
 await v.find('.box').emit('pointerdown');v.ctx.selection.hEvent({type:'note',text:'событие после действия вне панели'});gate.resolve({ok:false,error:'Временный отказ'});await sending;
 assert.notEqual(v.document.activeElement,v.find('[data-sel="go"]'));
});
