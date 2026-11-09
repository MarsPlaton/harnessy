import {fixtureSource,fixtureGroups,fixtureWrapper} from './live-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {setImmediate as immediate} from 'node:timers/promises';
import {join} from 'node:path';
import {fixture,noRepositoryFixture,call,OWNER,deferred,sse,until} from './test-helpers.ts';
import {dom} from './ui-dom-test-helpers.ts';
const live=readFileSync(new URL('../../../ui/deploy/live.js',import.meta.url),'utf8'),cx=readFileSync(new URL('../../../ui/deploy/cx.js',import.meta.url),'utf8');
async function ui(h:Awaited<ReturnType<typeof fixture>>,pause?:(path:string,body:any)=>Promise<void>,options:{prepare?:boolean;pane?:string;page?:string}={}){
 const d=dom('<div class="frame cur"><div class="feed"><div class="col"><div class="main"><span data-cx="role">Роль</span><div class="ai"><div class="live-acts"><button data-la="assign" data-i="0">Назначить</button><button data-la="move" data-i="0">Перенести</button><button data-la="mkdir" data-i="0">Создать проект</button></div></div></div></div></div></div><div id="toast"></div>');Object.assign(d.document,{documentElement:d.html,body:d.body});d.html.setAttribute('data-proto','');d.html.setAttribute('data-page',options.page??'chat');
 if(options.prepare!==false){h.runtime.roomSet({model:'w1'},OWNER);h.runtime.registry.get('room')!.record('me','Юридическая команда')}const paneId=options.pane??'room',chats=h.runtime.chatsList(OWNER),pane=h.runtime.registry.get(paneId)!.settings();
 const H:any={on:true,noProject:false,project:h.dir,active:chats.active,chatList:chats.chats,panes:[pane],pane,roleCatalog:h.runtime.roleCatalog(),models:{claude:[{id:'w1'}]}},S:any={ui:{pane:paneId},chat:[{role:'ai',pane:paneId,text:'Ответ'}],cx:{noFolder:false,modes:{},att:[],conn:{}}},requests:any[]=[],pending=new Set<Promise<any>>();
 const box:any={H,S,knowledgeReset(){},PAGE:options.page??'chat',document:d.document,window:null,location:{href:''},navigator:{},save(){},log(){},esc:(v:any)=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!)),toast(html:string){d.document.querySelector('#toast')!.innerHTML=html},hStatus(){},badges(){},renderWaiting(){},loadChat:async()=>{},pickPane(){H.pane=H.panes.find((p:any)=>p.id===S.ui.pane)},render(){},setTimeout(){},clearTimeout(){},addEventListener:d.window.addEventListener.bind(d.window),removeEventListener:d.window.removeEventListener.bind(d.window),
 api(path:string,body?:any){requests.push({path,body});const job=(async()=>{await pause?.(path,body);return (await call(h.api,path,body?{body}:{})).body})();pending.add(job);job.finally(()=>pending.delete(job));return job},
 async refreshStatus(){H.project=h.runtime.project.dir;H.panes=(await box.api('/api/status')).panes;const c=h.runtime.chatsList(OWNER);H.active=c.active;H.chatList=c.chats;box.pickPane()},closeLAMenus(){d.document.querySelectorAll('.live-menu').forEach(n=>n.remove())},dismissLAMenu(m:any){return ()=>m.remove()},rolesN:(n:number)=>n+' ролей',modelName:(m:string)=>m,paneName:(p:any)=>p.label};
 box.window=box;const context=createContext(box);runInContext(fixtureSource(live,fixtureGroups.live_captureProjectOperation_to_networkWaiting,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_bindingGeneration_to_settingsReady,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_laMenu_to_laPath,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_OPS_to_moveConversation,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_promotionBusy_to_document,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_autopilotText_to_autopilotText,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_guidanceState_to_document,{filename:'live.js',wrapper:0}),context);
 runInContext(fixtureSource(live,fixtureGroups.live_applyStatus_to_refreshStatus,{filename:'live.js',wrapper:0}),context);
 runInContext('globalThis.LIVE={H,S,save,api,esc,toast,log,paneName,hStatus,pickPane,refreshStatus,loadChat,promoteConversation,operationsDraw,operationAttention,sendBinding,bindingCurrent,invalidateBinding,configureSetting,busy:()=>false};',context);runInContext(cx,context);
 const find=(s:string)=>{const n=d.document.querySelector(s);assert.ok(n,s);return n};
 const click=async(entry:string)=>{if(entry==='composer'){await find('[data-cx="role"]').emit('click');await find('[data-cx-newseat="orchestrator"]').emit('click')}else {await find('[data-la="assign"]').emit('click');await find('[data-orchestrator-guidance-accept]').emit('click')}};
 const settle=async()=>{do{await Promise.all([...pending]);await immediate()}while(pending.size)};
 return {...d,H,S,requests,context,click,settle,find};
}
for(const entry of ['reply','composer'])test('154 UI '+entry+': actual menu click reaches HTTP and preserves chat',async t=>{
 const h=await noRepositoryFixture(t),v=await ui(h),id=v.H.active.room;await v.click(entry);await v.settle();await h.runtime.idle();const posts=v.requests.filter(r=>r.path.endsWith('/orchestrator'));assert.equal(posts.length,1);assert.equal(posts[0].body.project,h.dir);assert.equal(typeof posts[0].body.revision,'number');assert.deepEqual(Array.from(posts[0].body.documents),[]);assert.equal(h.runtime.project.state.chats.active.orchestrator,id);assert.equal(v.S.ui.pane,'orchestrator');assert.equal(h.provider.calls.length,1);assert.match(v.find('#toast').textContent,/Оркестратор назначен/);
});
for(const change of ['project','chat','pagehide','setting-failed'])test('154 UI pending '+change+' never promotes the current replacement binding',async t=>{
 const h=await noRepositoryFixture(t),gate=deferred(),entered=deferred();let once=true;const v=await ui(h,async(path,body)=>{if(!body&&path.startsWith('/api/chats/')&&once){once=false;entered.resolve();await gate.promise}});
 if(change==='setting-failed'){runInContext('LIVE.configureSetting(async()=>false)',v.context);await v.click('reply');await v.settle();assert.equal(v.requests.length,0);return}
 const click=v.click('reply');await entered.promise;if(change==='project')v.H.project='/another';else if(change==='chat')v.H.active.room='other';else await v.window.emit('pagehide');gate.resolve();await click;await v.settle();assert.equal(v.requests.filter(r=>r.body).length,0);assert.equal(h.runtime.registry.get('orchestrator'),null);
});


for(const page of ['chat','new'])test('154 UI '+page+': conflict opens existing conversation without replacing history',async t=>{
 const h=await noRepositoryFixture(t,{seats:'  lead: {kind: orchestrator, role: юрист, vendor: claude, model: w1, mode: read}'});h.runtime.registry.get('lead')!.record('ai','existing answer');const v=await ui(h,undefined,{page}),old=h.runtime.chatsList(OWNER).active.lead;
 await v.click('reply');await v.settle();assert.match(v.find('.live-menu').textContent,/Открыть существующий/);await v.find('.live-menu [data-k="0"]').emit('click');await v.settle();assert.equal(v.S.ui.pane,'lead');assert.equal(h.runtime.project.state.chats.active.lead,old);assert.equal(h.runtime.registry.get('lead')!.transcript[0]!.text,'existing answer');assert.equal(h.provider.calls.length,0);if(page==='new')assert.equal((v.context as any).location.href,'01-chat.html');
});

test('157: tool failure shows a readable reason and preserves escaped technical details',()=>{
 const context:any={H:{cur:null},warningEvent:()=>false,drawLive(){},esc:(v:string)=>v.replaceAll('<','&lt;').replaceAll('>','&gt;')};const vm=createContext(context);
 runInContext(fixtureSource(live,fixtureGroups.live_streams_to_queueDelivered,{filename:'live.js',wrapper:0})+fixtureSource(live,['toolLine'],{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_toolErrorEntry_to_hEvent,{filename:'live.js',wrapper:0})+'globalThis.event=hEvent;globalThis.html=()=>toolLine(H.cur.tools[0]);',vm);
 context.event({type:'toolError',text:JSON.stringify({error:'Документ не прочитан',code:'ENOENT',path:'<script>unsafe</script>'})});assert.match(context.H.cur.tools[0].text,/Документ не прочитан/);assert.match(context.html(),/Технические детали/);assert.match(context.html(),/ENOENT/);assert.doesNotMatch(context.html(),/<script>/);
});


test('154 UI: repeat from partially materialized role uses saved documents and completes the same operation',async t=>{
 const h=await noRepositoryFixture(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);r.registry.get('room')!.record('me','Обсуждение');writeFileSync(h.dir+'/case.txt','original');const list=r.chatsList(OWNER),id=list.active.room!,chat=list.chats.find(c=>c.id===id)!,append=r.journal.append.bind(r.journal);let once=true;
 r.journal.append=(record)=>{const out=append(record);if(once&&record.origin==='onboarding'){once=false;throw Error('after intro')}return out};
 await assert.rejects(r.promoteChat(id,{project:h.dir,revision:chat.revision,documents:[{project:h.dir,path:'case.txt'}]},OWNER),/after intro/);
 const v=await ui(h,undefined,{prepare:false,pane:'orchestrator'});await v.click('composer');await v.settle();await r.idle();assert.equal(r.project.state.chats.active.orchestrator,id);assert.equal(h.provider.calls.length,1);assert.match(v.find('#toast').textContent,/Оркестратор назначен/);assert.equal(r.chatGet(id,OWNER).chat.promotion?.pending,false);
});

test('TS-47.1: reply resumes the current partially materialized promotion with its original identity',async t=>{
 const h=await noRepositoryFixture(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);r.registry.get('room')!.record('me','Обсуждение');const list=r.chatsList(OWNER),id=list.active.room!,chat=list.chats.find(c=>c.id===id)!,append=r.journal.append.bind(r.journal);let once=true;
 r.journal.append=record=>{const out=append(record);if(once&&record.origin==='onboarding'){once=false;throw Error('after intro')}return out};
 await assert.rejects(r.promoteChat(id,{project:h.dir,revision:chat.revision,documents:[]},OWNER),/after intro/);
 const pending=r.chatGet(id,OWNER).chat.promotion!;assert.equal(pending.pending,true);assert.equal(pending.completed,3);const operationId=pending.operationId;
 const v=await ui(h,undefined,{prepare:false,pane:'orchestrator'});await v.find('[data-la="assign"]').emit('click');await v.settle();await r.idle();
 const completed=r.chatGet(id,OWNER).chat;assert.equal(completed.id,id);assert.equal(completed.promotion?.operationId,operationId);assert.equal(completed.promotion?.pending,false);assert.equal(r.project.state.chats.active.orchestrator,id);assert.equal(h.provider.calls.length,1);assert.equal(v.requests.filter(request=>request.path.endsWith('/orchestrator')).length,1);assert.match(v.find('#toast').textContent,/Оркестратор назначен/);
});


test('154 UI: promotion on the new-chat page survives applyStatus selecting room, then navigates to the promoted chat',async t=>{
 const h=await noRepositoryFixture(t),v=await ui(h,undefined,{page:'new'}),id=v.H.active.room;await v.click('composer');await v.settle();await h.runtime.idle();assert.equal(v.context.location.href,'01-chat.html');assert.equal(v.S.ui.pane,'orchestrator');assert.equal(v.H.active.orchestrator,id);assert.equal(v.S.ui.fresh,false);
});

for(const nextChoice of ['other','back','pagehide'])test('154 ОКНА: executed POST reply cannot undo '+nextChoice+' through the real api/boot boundary',async t=>{
 const h=await fixture(t),v=await ui(h),storage=new Map<string,string>(),entered=deferred(),release=deferred();
 await h.runtime.settingsPatch('owner',{projectsRoot:join(h.dir,'projects')},OWNER);v.H.noProject=true;
 Object.assign(v.context,{rememberLive(){},sessionStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,value:string)=>storage.set(k,value)}});
 const proto=readFileSync(new URL('../../../ui/deploy/proto.js',import.meta.url),'utf8');runInContext(fixtureWrapper(proto,0,'proto.js'),v.context);
 const boot=v.context.HARNESS_BOOT;boot.select(h.dir);boot.confirm(h.dir,boot.capture());let sections=0;
 v.context.sectionChanging=()=>{sections++};
 v.context.fetch=async(path:string,opts?:{body:string})=>{const response=await call(h.api,path,opts?{body:JSON.parse(opts.body)}:{});if(path.endsWith('/orchestrator')){await h.runtime.idle();entered.resolve();await release.promise}return {json:async()=>response.body}};
 runInContext('globalThis.api=(()=>{'+fixtureSource(live,fixtureGroups.live_api_to_networkWaiting,{filename:'live.js',wrapper:0})+'return api;})();',v.context);
 const promoting=v.context.LIVE.promoteConversation(v.find('.live-acts'),v.context.LIVE.sendBinding());await entered.promise;
 if(nextChoice==='pagehide')await v.window.emit('pagehide');
 else {
  const next=join(h.dir,'other-project');mkdirSync(next);v.context.LIVE.invalidateBinding();assert.equal((await v.context.api('/api/project',{path:next})).ok,true);await v.context.refreshStatus(true);
  if(nextChoice==='back'){v.context.LIVE.invalidateBinding();assert.equal((await v.context.api('/api/project',{path:h.dir})).ok,true);await v.context.refreshStatus(true)}
 }
 const selected=storage.get('harnessy-live-project-v1'),statusToken=boot.capture(),sectionCount=sections,project=v.H.project;
 release.resolve();assert.equal(await promoting,false);assert.equal(storage.get('harnessy-live-project-v1'),selected);assert.equal(sections,sectionCount);assert.equal(v.H.project,project);
 if(nextChoice!=='pagehide'){assert.equal(boot.confirm(project,statusToken),true);assert.equal((await v.context.refreshStatus(true)).project,project)}
 assert.equal(h.provider.calls.length,1);
});

for(const returns of [false,true])test('154 round 3 ОКНА: another client confirms '+(returns?'A → B → A':'B')+' before a delayed promotion reply',async t=>{
 const h=await noRepositoryFixture(t),v=await ui(h),storage=new Map<string,string>(),entered=deferred(),release=deferred();
 Object.assign(v.context,{rememberLive(){},sessionStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,value:string)=>storage.set(k,value)}});
 const proto=readFileSync(new URL('../../../ui/deploy/proto.js',import.meta.url),'utf8');runInContext(fixtureWrapper(proto,0,'proto.js'),v.context);
 const boot=v.context.HARNESS_BOOT;boot.select(h.dir);boot.confirm(h.dir,boot.capture());let sections=0;v.context.sectionChanging=()=>sections++;
 v.context.fetch=async(path:string,opts?:{body:string})=>{const response=await call(h.api,path,opts?{body:JSON.parse(opts.body)}:{});if(path.endsWith('/orchestrator')){await h.runtime.idle();entered.resolve();await release.promise}return {json:async()=>response.body}};
 runInContext('globalThis.api=(()=>{'+fixtureSource(live,fixtureGroups.live_api_to_networkWaiting,{filename:'live.js',wrapper:0})+'return api;})();',v.context);
 const promoting=v.context.LIVE.promoteConversation(v.find('.live-acts'),v.context.LIVE.sendBinding());await entered.promise;
 // This HTTP client never calls this window's api(), boot.select() or invalidateBinding().
 const next=join(h.dir,'other-project');mkdirSync(next);assert.equal((await call(h.api,'/api/project',{body:{path:next}})).status,200);await v.context.refreshStatus(true);
 assert.equal(v.H.project,next);assert.equal(storage.get('harnessy-live-project-v1'),next);
 if(returns){assert.equal((await call(h.api,'/api/project',{body:{path:h.dir}})).status,200);await v.context.refreshStatus(true)}
 const project=v.H.project,selected=storage.get('harnessy-live-project-v1'),beforeSections=sections;
 release.resolve();assert.equal(await promoting,false);assert.equal(storage.get('harnessy-live-project-v1'),selected);assert.equal(sections,beforeSections);assert.equal(v.H.project,project);
 assert.equal(boot.confirm(project,boot.capture()),true);assert.equal((await v.context.refreshStatus(true)).project,project);assert.equal(h.provider.calls.length,1);
});

for(const scenario of ['late','early','foreign','round-trip','wrong-operation','missing-operation'])test('154 round 4: promotion binding classifies '+scenario+' status before its POST receipt',async t=>{
 const h=await fixture(t),v=await ui(h),storage=new Map<string,string>(),entered=deferred(),release=deferred();await h.runtime.settingsPatch('owner',{projectsRoot:join(h.dir,'projects')},OWNER);v.H.noProject=true;
 Object.assign(v.context,{rememberLive(){},sessionStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,value:string)=>storage.set(k,value)}});
 const proto=readFileSync(new URL('../../../ui/deploy/proto.js',import.meta.url),'utf8');runInContext(fixtureWrapper(proto,0,'proto.js'),v.context);const boot=v.context.HARNESS_BOOT;boot.select(h.dir);boot.confirm(h.dir,boot.capture());
 v.context.fetch=async(path:string,opts?:{body:string})=>{const response=await call(h.api,path,opts?{body:JSON.parse(opts.body)}:{});if(path.endsWith('/orchestrator')){await h.runtime.idle();entered.resolve();await release.promise}return {json:async()=>response.body}};
 runInContext('globalThis.api=(()=>{'+fixtureSource(live,fixtureGroups.live_api_to_networkWaiting,{filename:'live.js',wrapper:0})+'return api;})();',v.context);
 const promoting=v.context.LIVE.promoteConversation(v.find('.live-acts'),v.context.LIVE.sendBinding());await entered.promise;const created=h.runtime.project.dir;assert.notEqual(created,h.dir);
 if(scenario!=='late')await v.context.refreshStatus(true);
 if(['foreign','round-trip'].includes(scenario)){const other=join(h.dir,'unrelated');mkdirSync(other);assert.equal((await call(h.api,'/api/project',{body:{path:other}})).status,200);await v.context.refreshStatus(true);if(scenario==='round-trip'){assert.equal((await call(h.api,'/api/project',{body:{path:created}})).status,200);await v.context.refreshStatus(true)}}
 if(scenario==='wrong-operation')v.H.liveStatus.promotions[0].sourceRevision++;
 if(scenario==='missing-operation')delete v.H.liveStatus.promotions;
 const selected=storage.get('harnessy-live-project-v1');release.resolve();const result=await promoting;
 if(['early','late'].includes(scenario)){assert.equal(result,true);assert.equal(v.H.project,created);assert.equal(v.S.ui.pane,'orchestrator');assert.equal(v.H.active.orchestrator,h.runtime.chatsList(OWNER).active.orchestrator)}
 else{assert.equal(result,false);assert.equal(storage.get('harnessy-live-project-v1'),selected);assert.equal(boot.confirm(v.H.project,boot.capture()),true)}
 assert.equal(h.provider.calls.length,1);
});

for(const entry of ['reply','composer'])test('223: '+entry+' shows progress before delayed POST; a repeat focuses the same card and sends once',async t=>{
 const h=await noRepositoryFixture(t),entered=deferred(),gate=deferred(),v=await ui(h,async(path,body)=>{if(body&&path.endsWith('/orchestrator')){entered.resolve();await gate.promise}});
 const clicking=v.click(entry);await entered.promise;assert.match(v.find('[data-live-operations]').textContent,/Harnessy создаёт оркестратора…/);assert.match(v.find('[data-live-operations]').textContent,/шаг 1 из 4/);assert.equal(v.find('[data-la="assign"]').disabled,true);assert.match(v.find('[data-cx="role"]').textContent,/Создаём оркестратора/);
 await v.find('[data-la="assign"]').emit('click');await v.find('[data-cx="role"]').emit('click');assert.match(v.find('[data-live-operations]').textContent,/уже идёт/);assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,1);assert.equal(v.find('[data-live-operations]').querySelectorAll('[data-operation]').length,1);
 gate.resolve();await clicking;await v.settle();assert.equal(v.S.ui.pane,'orchestrator');assert.equal(v.document.querySelector('[data-live-operations]'),null);assert.equal(v.find('[data-la="assign"]').disabled,false);
});

test('223: failed promotion keeps the reason and retry uses the saved operation once',async t=>{
 const h=await noRepositoryFixture(t),v=await ui(h),original=h.runtime.promoteChat.bind(h.runtime);let once=true;
 h.runtime.promoteChat=async(...args:Parameters<typeof original>)=>{if(once){once=false;throw Error('temporary fixture failure <img src=x>')}return original(...args)};
 await v.click('reply');await v.settle();assert.match(v.find('[data-live-operations]').textContent,/temporary fixture failure/);assert.equal(v.find('[data-live-operations]').querySelector('img'),null);assert.equal(v.find('[data-la="assign"]').disabled,false);
 await v.find('[data-operation-retry]').emit('click');await v.settle();await h.runtime.idle();assert.equal(v.document.querySelector('[data-live-operations]'),null);assert.equal(v.S.ui.pane,'orchestrator');assert.equal(h.provider.calls.length,1);
});

for(const change of ['project','chat','pagehide'])test('223: delayed POST after '+change+' cannot leave a progress card in another binding',async t=>{
 const h=await noRepositoryFixture(t),entered=deferred(),gate=deferred(),v=await ui(h,async(path,body)=>{if(body&&path.endsWith('/orchestrator')){entered.resolve();await gate.promise}});const clicking=v.click('reply');await entered.promise;
 if(change==='project')v.H.project='/other';else if(change==='chat')v.H.active.room='other';else await v.window.emit('pagehide');v.context.LIVE.operationsDraw();assert.equal(v.document.querySelector('[data-live-operations]'),null);
 gate.resolve();await clicking;await v.settle();assert.equal(v.document.querySelector('[data-live-operations]'),null);assert.equal(v.find('[data-la="assign"]').disabled,false);assert.notEqual(v.S.ui.pane,'orchestrator');
});


test('221/223: saved progress arrives through SSE before POST receipt; status restores the same failed operation',async t=>{
 const h=await noRepositoryFixture(t),v=await ui(h),gate=deferred(),stream=await sse(h.api);t.after(()=>stream.close());const original=v.context.api;
 v.context.api=async(path:string,body:any)=>{const out=await original(path,body);if(path.endsWith('/orchestrator'))await gate.promise;return out};
 const click=v.click('reply');await until(()=>stream.frames.some(e=>e.type==='promotion'&&e.promotion.completed===4));
 const events=stream.frames.filter(e=>e.type==='promotion');assert.deepEqual(events.map(e=>e.promotion.completed),[1,2,3,4]);const first=events[0]!;
 v.context.operationsEvent({...first,promotion:{...first.promotion,sourceRevision:first.promotion.sourceRevision+1,completed:3,step:4}});assert.match(v.find('[data-live-operations]').textContent,/шаг 1 из 4/);
 v.context.operationsEvent({...first,promotion:{...first.promotion,stepCount:undefined}});assert.match(v.find('[data-live-operations]').textContent,/шаг 1 из 4/);
 for(const event of events){v.context.operationsEvent(event);assert.match(v.find('[data-live-operations]').textContent,new RegExp('шаг '+event.promotion.step+' из 4'))}assert.match(v.find('[data-live-operations]').textContent,/Готово/);v.context.operationsEvent(first);assert.match(v.find('[data-live-operations]').textContent,/Готово/);
 gate.resolve();await click;await v.settle();assert.equal(v.document.querySelector('[data-live-operations]'),null);
 const status=(await call(h.api,'/api/status')).body,done=status.promotions.find((p:any)=>p.chat===first.promotion.chat);assert.equal(done.completed,4);assert.equal(done.stepCount,4);assert.equal(done.error,null);
});

test('221: a saved partial promotion reappears with its reason and retries the same identity',async t=>{
 const h=await noRepositoryFixture(t),r=h.runtime;r.roomSet({model:'w1'},OWNER);r.registry.get('room')!.record('me','Обсуждение');const row=r.chatsList(OWNER).chats.find(c=>c.pane==='room')!,append=r.journal.append.bind(r.journal);let once=true;
 r.journal.append=(record)=>{const out=append(record);if(once&&record.origin==='onboarding'){once=false;throw Error('fixture interrupted after intro')}return out};
 await assert.rejects(r.promoteChat(row.id,{project:h.dir,revision:row.revision,documents:[]},OWNER),/fixture interrupted/);
 const status=(await call(h.api,'/api/status')).body,progress=status.promotions.find((p:any)=>p.chat===row.id);assert.equal(progress.completed,3);assert.match(progress.error,/fixture interrupted/);
 const v=await ui(h,undefined,{prepare:false,pane:'orchestrator'});v.H.liveStatus=status;await v.window.emit('live:status');assert.match(v.find('[data-live-operations]').textContent,/fixture interrupted/);
 await v.find('[data-operation-retry]').emit('click');await v.settle();await r.idle();assert.equal(r.project.state.chats.active.orchestrator,row.id);assert.equal(h.provider.calls.length,1);assert.equal(v.document.querySelector('[data-live-operations]'),null);assert.equal((await call(h.api,'/api/status')).body.promotions.find((p:any)=>p.chat===row.id).error,null);
});

for(const create of [false,true])test('222: delayed '+(create?'create-and-move':'move')+' uses the same component, prevents duplicates and completes once',async t=>{
 const h=await fixture(t),entered=deferred(),gate=deferred(),v=await ui(h,async(path)=>{if(path==='/api/room/move'){entered.resolve();await gate.promise}}),path=join(h.dir,'destination');if(!create)mkdirSync(path);
 const input={path,create,git:false},moving=v.context.moveConversation(v.find('.live-acts'),input);await entered.promise;assert.match(v.find('[data-live-operations]').textContent,/Harnessy переносит разговор/);assert.equal(v.find('[data-la="move"]').disabled,true);
 assert.equal(await v.context.moveConversation(v.find('.live-acts'),input),false);assert.equal(v.requests.filter(r=>r.path==='/api/room/move').length,1);gate.resolve();assert.equal(await moving,true);assert.equal(v.H.project,path);assert.equal(v.document.querySelector('[data-live-operations]'),null);assert.equal(v.find('[data-la="move"]').disabled,false);
});


for(const create of [false,true])test('222: the '+(create?'mkdir':'move')+' menu reaches HTTP, retains failures for retry and ignores a late reply',async t=>{
 const h=await fixture(t),v=await ui(h),path=join(h.dir,'target');if(!create)mkdirSync(path);const original=v.context.api;let writes=0;v.context.api=async(p:string,body:any)=>p==='/api/projects'?{projects:[{name:'target',path,seats:0}]}:p==='/api/room/move'&&++writes===1?{ok:false,error:'fixture move failed'}:original(p,body);
 await v.find('[data-la="'+(create?'mkdir':'move')+'"]').emit('click');if(create){v.find('.live-menu input').value=path;await v.find('.live-menu [data-ok]').emit('click')}else await v.find('.live-menu [data-k="0"]').emit('click');await v.settle();assert.match(v.find('[data-live-operations]').textContent,/fixture move failed/);assert.equal(v.find('[data-la="move"]').disabled,false);
 const gate=deferred<any>();v.context.api=async()=>{writes++;return gate.promise};await v.find('[data-operation-retry]').emit('click');v.H.project='/foreign';v.context.LIVE.operationsDraw();gate.resolve({ok:true,project:path,carried:true});await immediate();await immediate();assert.equal(v.document.querySelector('[data-live-operations]'),null);assert.equal(v.H.project,'/foreign');assert.equal(writes,2);
});
