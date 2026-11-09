import {fixtureSource,fixtureGroups} from './live-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createContext,runInContext} from 'node:vm';
import {setImmediate as immediate} from 'node:timers/promises';
import {fixture as apiFixture,call,OWNER,deferred} from './test-helpers.ts';
import {CLAUDE_MODELS} from './catalog.ts';
const fixture=(t:Parameters<typeof apiFixture>[0],options:Parameters<typeof apiFixture>[1]={})=>apiFixture(t,{...options,deps:{models:{claude:[...CLAUDE_MODELS,{id:'w1'},{id:'w2'}],codex:[{id:'gpt-test'}]},...options.deps}});
import {dom} from './ui-dom-test-helpers.ts';
const live=readFileSync(new URL('../../../ui/deploy/live.js',import.meta.url),'utf8');
const sketch=readFileSync(new URL('../../../ui/sketches/disarto/19-first-run.html',import.meta.url),'utf8');
async function ui(h:Awaited<ReturnType<typeof fixture>>,pause?:(path:string,body:any)=>Promise<void>,saved:Record<string,any>={},transform?:(path:string,response:any)=>any){
 const d=dom(sketch.slice(sketch.indexOf('<div class="frame"'),sketch.indexOf('<script>')));Object.assign(d.document,{documentElement:d.html,body:d.body});d.html.setAttribute('data-proto','');d.html.setAttribute('data-page','first');d.document.querySelector('.frame')!.classList.add('cur');
 const H:any={on:true,panes:[],active:{},project:h.dir},S:any={ui:{pane:'room'},chat:[],cx:{noFolder:false},...saved},requests:any[]=[],toasts:string[]=[],pending=new Set<Promise<any>>(),streams:any[]=[];
 const c:any={H,S,PAGE:'first',document:d.document,window:null,location:{href:'',pathname:'/19-first-run.html'},AbortController,save(){},log(){},now:Date.now,setTimeout(){},clearTimeout(){},addEventListener:d.window.addEventListener.bind(d.window),removeEventListener:d.window.removeEventListener.bind(d.window),
  esc:(v:any)=>String(v??'').replace(/[&<>"]/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[x]!)),toast:(v:string)=>toasts.push(v),paneName:(p:any)=>p.label,modelName:(id:string)=>id||'модель не выбрана',knowledgeReset(){},hStatus(){},render(){},drawLive(){},scrollEnd(){},cols:()=>d.document.querySelectorAll('.feed .col'),
  pickPane(){H.pane=H.panes.find((p:any)=>p.id===S.ui.pane)||null},async loadChat(){},
  api(path:string,body?:any,operation?:any){requests.push({path,body});const job=(async()=>{await pause?.(path,body);if(operation?.signal?.aborted)throw Object.assign(Error('aborted'),{name:'AbortError'});const response=(await call(h.api,path,body?{body}:{})).body;return transform?transform(path,response):response})();pending.add(job);job.then(()=>pending.delete(job),()=>pending.delete(job));return job},
  async refreshStatus(){const status=await c.api('/api/status');if(H.project!==status.project)H.confirmedProjectGeneration=(H.confirmedProjectGeneration||0)+1;Object.assign(H,{project:status.project,panes:status.panes,models:status.models,turnModes:status.turnModes,active:status.activeChats,liveStatus:status,noProject:status.noProject});const list=h.runtime.chatsList(OWNER);H.chatList=list.chats;c.pickPane();return status},laMenu(){},KN:{data:null}
  ,subscribeLiveEvents(onmessage:any){const stream={onmessage,closed:false,close(){this.closed=true}};streams.push(stream);return stream}
 };
 c.window=c;await c.refreshStatus();const vm=createContext(c);
 runInContext(fixtureSource(live,fixtureGroups.live_captureProjectOperation_to_networkWaiting,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_bindingGeneration_to_settingsReady,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_isDirect_to_ask,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_OPS_to_moveConversation,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_promotionBusy_to_promoteConversation,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_autopilotText_to_autopilotText,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_guidanceState_to_document,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_document_to_document,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_reply_to_onSend,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_TP_to_addEventListener,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_FIRST_to_if,{filename:'live.js',wrapper:0})+'globalThis.first={draw:firstDraw,next:firstNext,send:firstSend,sendNow:onSend,state:FIRST,go:firstGo,binding:sendBinding,invalidate:invalidateBinding,proposals:proposalsFetch,proposalsReset,TP,catalog:firstCatalog,models:FIRST_MODELS,guidance:chatGuidanceDraw,offer:showOrchestratorOffer};',vm);
 const recoveryOpens:any[]=[];c.LIVE={H,esc:c.esc,network:{openAdd:(options:any)=>recoveryOpens.push(options)},networkAdd:{close(){}},firstModelsDraw:c.first.draw};runInContext(readFileSync(new URL('../../../ui/deploy/network-recovery.js',import.meta.url),'utf8'),vm);
 const find=(selector:string)=>{const n=d.document.querySelector(selector);assert.ok(n,selector);return n};
 const settle=async()=>{do{await Promise.all([...pending]);await immediate()}while(pending.size)};
 await settle();return {...d,H,S,c,vm,find,requests,toasts,settle,streams,recoveryOpens,f:c.first};
}
async function connectSelected(v:Awaited<ReturnType<typeof ui>>){await v.find('.st[data-s="1"] [data-go="2"]').emit('click');await v.find('[data-first-connect]').emit('click');await v.settle();assert.equal(v.find('.st[data-s="3"]').classList.contains('on'),true)}

const programs=()=>({ok:true,providers:[['claude','Claude Code'],['codex','Codex'],['antigravity','Antigravity'],['copilot','GitHub Copilot'],['gemini','Gemini CLI']].map(([id,title])=>({id,title,kind:'subscription',installed:true as boolean|null,checking:false,models:[]}))});
function programData(path:string,response:any,catalog=programs()){
 if(path==='/api/providers/catalog')return catalog;
 if(path==='/api/status')return {...response,models:{...response.models,antigravity:[{id:'shared',label:'Gemini'}],copilot:[{id:'shared',label:'Copilot'}],gemini:[{id:'default',label:'по умолчанию программы'}]},turnModes:{...response.turnModes,antigravity:{read:{ok:false,reason:'нет изоляции инструментов'},chat:{ok:true,note:'без инструментов Harnessy'}},copilot:{read:{ok:true},chat:{ok:true}},gemini:{read:{ok:false,reason:'режим чтения не гарантирован'},chat:{ok:true}}}};
 return response;
}

test('313: step two keeps all four sketch blocks and shows each catalogue program with supported modes',async t=>{
 const h=await fixture(t),v=await ui(h,undefined,{},programData);v.f.go(2);
 assert.equal(v.document.querySelectorAll('[data-first-vendor]').length,4);
 for(const row of programs().providers)assert.equal(v.find('[data-first-program="'+row.id+'"] [data-first-title]').textContent,row.title);
 const card=v.find('[data-first-program="antigravity"]'),option=v.find('[data-first-program="antigravity"] option[value="shared"]');assert.equal(option.disabled,true);assert.match(option.textContent,/нет изоляции инструментов/);
 const select=card.querySelector('select')!;select.value='shared';await select.emit('change');assert.notEqual(v.f.state.vendor,'antigravity');
 v.f.state.vendor='antigravity';v.f.state.model='shared';await v.f.next();assert.equal(v.document.querySelector('[data-first-promote]'),null);assert.equal(v.requests.filter(r=>r.body).length,0);assert.equal(h.provider.calls.length+h.codex.calls.length,0);
});

for(const state of ['missing-mode','not-installed','checking'])test('313: '+state+' stays visible and never sends promotion',async t=>{
 const h=await fixture(t),catalog=programs();const row=catalog.providers.find(p=>p.id==='copilot')!;if(state==='not-installed')row.installed=false;if(state==='checking'){row.installed=null;row.checking=true}
 const v=await ui(h,undefined,{},(path,result)=>{const out=programData(path,result,catalog);if(path==='/api/status'&&state==='missing-mode')delete out.turnModes.copilot.read;return out});
 const option=v.find('[data-first-program="copilot"] option[value="shared"]');assert.equal(option.disabled,true);assert.match(option.textContent,state==='checking'?/проверяется/:state==='not-installed'?/не установлена/:/не сообщил поддержку/);
 v.f.state.vendor='copilot';v.f.state.model='shared';await v.f.next();assert.equal(v.document.querySelector('[data-first-promote]'),null);assert.equal(v.requests.filter(r=>r.body).length,0);
});

test('313/TS-34: exact vendor survives an identical model id through room setup',async t=>{
 const h=await fixture(t,{deps:{models:{claude:[{id:'w1'}],codex:[{id:'w1'}]}}});h.codex.models=async()=>[{id:'w1',label:'Codex W1'}];const v=await ui(h);
 const select=v.find('[data-first-program="codex"] select');select.value='w1';await select.emit('change');assert.equal(v.f.state.vendor,'codex');assert.equal(v.requests.filter(r=>r.body).length,0);
 await v.f.next();await v.settle();assert.equal(v.requests.find(r=>r.path==='/api/room').body.vendor,'codex');assert.equal(h.runtime.registry.get('room')!.vendor,'codex');assert.equal(h.runtime.registry.get('orchestrator'),null);assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,0);
});

test('313/TS-34: providers refresh disables an unsupported choice and keeps one subscription',async t=>{
 const h=await fixture(t);let revoked=false;const v=await ui(h,undefined,{},(path,result)=>{const out=programData(path,result);if(path==='/api/status'&&revoked)out.turnModes.claude.read={ok:false,reason:'режим отозван'};return out});
 v.f.go(2);const button=v.find('[data-first-connect]');assert.equal(button.disabled,false);revoked=true;v.streams[0].onmessage({data:JSON.stringify({type:'providers',project:h.dir})});await v.settle();assert.equal(button.disabled,true);assert.match(v.find('[data-first-program="claude"] small').textContent,/режим отозван/);
 assert.equal(v.requests.filter(r=>r.path==='/api/room').length,0);assert.equal(v.streams.length,1);await v.window.emit('pagehide');assert.equal(v.streams[0].closed,true);
});

for(const change of ['project','pane','pagehide'])test('313: late catalogue cannot replace models after '+change,async t=>{
 const h=await fixture(t),v=await ui(h,undefined,{},programData),gate=deferred<any>(),entered=deferred();const api=v.c.api;
 v.c.api=async(path:string,body:any)=>{if(path==='/api/providers/catalog'){entered.resolve();return gate.promise}return api(path,body)};const work=v.f.catalog();await entered.promise;
 if(change==='project')v.H.project='/other';if(change==='pane')v.S.ui.pane='other';if(change==='pagehide')await v.window.emit('pagehide');const rows=v.f.models.rows;
 gate.resolve({ok:true,providers:[{id:'foreign',title:'foreign',kind:'local',installed:true,checking:false}]});await work;assert.equal(v.f.models.rows,rows);assert.equal(v.document.querySelector('[data-first-program="foreign"]'),null);
});

test('313: catalogue text is escaped; failure keeps models from status and offers retry',async t=>{
 const h=await fixture(t),catalog=programs();catalog.providers[0]!.title='<img src=x onerror=x>';let fail=false;const v=await ui(h,undefined,{},(path,result)=>path==='/api/providers/catalog'&&fail?{ok:false,error:'offline <img src=x>'}:programData(path,result,catalog));
 assert.equal(v.find('[data-first-program="claude"] [data-first-title]').textContent,catalog.providers[0]!.title);assert.equal(v.document.querySelector('img'),null);
 fail=true;await v.f.catalog();assert.match(v.find('[data-first-model-error]').textContent,/offline/);assert.ok(v.find('[data-first-program="codex"] option[value="gpt-test"]'));assert.equal(v.document.querySelector('img'),null);
 fail=false;await v.find('[data-first-model-retry]').emit('click');await v.settle();assert.equal((v.find('[data-first-model-error]') as any).hidden,true);
});

test('313: cold catalogue discovery fills previously empty CLI models from fresh status',async t=>{
 const h=await fixture(t);let reads=0;const v=await ui(h,undefined,{},(path,result)=>{const out=programData(path,result);if(path==='/api/status'&&++reads===1)out.models.copilot=[];return out});
 assert.equal(reads,2);assert.equal(v.find('[data-first-program="copilot"] option[value="shared"]').disabled,false);assert.equal(v.requests.filter(r=>r.body).length,0);
});

for(const change of ['project','pane','pagehide'])test('313: late status after catalogue cannot cross '+change,async t=>{
 const h=await fixture(t),v=await ui(h,undefined,{},programData),gate=deferred<any>(),entered=deferred(),api=v.c.api;
 v.c.api=async(path:string,body:any)=>{if(path==='/api/status'){entered.resolve();return gate.promise}return api(path,body)};const work=v.f.catalog();await entered.promise;
 const previous=v.H.models;if(change==='project')v.H.project='/other';if(change==='pane')v.S.ui.pane='other';if(change==='pagehide')await v.window.emit('pagehide');
 gate.resolve({project:h.dir,panes:v.H.panes,models:{foreign:[{id:'late',label:'Late'}]},turnModes:{}});await work;assert.equal(v.H.models,previous);assert.equal(v.document.querySelector('[data-first-program="foreign"]'),null);
});

test('TS-34: every first-run screen has working Back and Simple chat exits',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h);assert.equal(v.document.querySelectorAll('.fr .st[data-s]').length,3);assert.equal(v.document.querySelectorAll('[data-first-simple]').length,3);
 await v.find('.st[data-s="1"] [data-first-simple]').emit('click');assert.equal(v.c.location.href,'10-new-chat.html');v.c.location.href='';
 await v.find('.st[data-s="1"] [data-go="2"]').emit('click');assert.equal(v.find('.st[data-s="2"]').classList.contains('on'),true);await v.find('.st[data-s="2"] [data-first-simple]').emit('click');assert.equal(v.c.location.href,'10-new-chat.html');v.c.location.href='';
 await v.find('.st[data-s="2"] [data-go="1"]').emit('click');assert.equal(v.find('.st[data-s="1"]').classList.contains('on'),true);v.f.go(3);await v.find('.st[data-s="3"] [data-first-simple]').emit('click');assert.equal(v.c.location.href,'10-new-chat.html');v.c.location.href='';
 await v.find('.st[data-s="3"] [data-go="2"]').emit('click');assert.equal(v.find('.st[data-s="2"]').classList.contains('on'),true);v.f.go(1);await v.find('[data-first-back]').emit('click');assert.equal(v.c.location.href,'20-login-pour.html');
 assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,0);assert.equal(h.provider.calls.length+h.codex.calls.length,0);
});

test('TS-34: no connected program still opens an empty chat without network work',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h,undefined,{},(path,result)=>path==='/api/providers/catalog'?{ok:true,providers:[]}:path==='/api/status'?{...result,models:{},turnModes:{}}:result);
 v.f.go(2);assert.equal(v.find('[data-first-connect]').disabled,true);await v.find('[data-first-simple]').emit('click');assert.equal(v.c.location.href,'10-new-chat.html');assert.equal(v.requests.filter(r=>r.body).length,0);assert.equal(h.provider.calls.length+h.codex.calls.length,0);
});

test('TS-34: selected exact vendor configures the room and advances without an orchestrator',async t=>{
 const h=await fixture(t,{seats:'  {}',deps:{models:{claude:[{id:'w1'}],codex:[{id:'w1'}]}}});h.codex.models=async()=>[{id:'w1',label:'Codex W1'}];const v=await ui(h);
 const select=v.find('[data-first-program="codex"] select');select.value='w1';await select.emit('change');assert.equal(v.f.state.vendor,'codex');await connectSelected(v);
 const setting=v.requests.find(r=>r.path==='/api/room');assert.equal(setting.body.vendor,'codex');assert.equal(setting.body.model,'w1');assert.equal(setting.body.folder,true);assert.equal(h.runtime.registry.get('room')!.vendor,'codex');assert.equal(h.runtime.registry.get('orchestrator'),null);assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,0);assert.equal(h.provider.calls.length+h.codex.calls.length,0);
});

test('TS-34: connection failure names the reason and keeps Back plus Simple chat',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h,undefined,{},(path,result)=>path==='/api/room'?{ok:false,error:'вход программы не подтверждён'}:result);v.f.go(2);await v.find('[data-first-connect]').emit('click');await v.settle();
 const failure=v.find('.first-failure');assert.match(failure.textContent,/вход программы не подтверждён/);assert.ok(failure.querySelector('[data-go="1"]'));assert.ok(failure.querySelector('[data-first-simple]'));assert.equal(v.find('.st[data-s="3"]').classList.contains('on'),false);assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,0);
 await failure.querySelector('[data-first-simple]')!.emit('click');assert.equal(v.c.location.href,'10-new-chat.html');
});

for(const change of ['project','pagehide'])test('TS-34: delayed room configuration cannot advance after '+change,async t=>{
 const h=await fixture(t,{seats:'  {}'}),entered=deferred(),gate=deferred(),v=await ui(h,async path=>{if(path==='/api/room'){entered.resolve();await gate.promise}});v.f.go(2);const work=v.find('[data-first-connect]').emit('click');await entered.promise;
 if(change==='project')v.H.project='/other';else await v.window.emit('pagehide');gate.resolve();await work;await v.settle();assert.equal(v.find('.st[data-s="3"]').classList.contains('on'),false);assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,0);assert.equal(h.provider.calls.length,0);
});

for(const held of ['/api/room','/api/chats/new'])for(const exit of ['back','simple'])test('TS-34 r2: '+exit+' exits immediately while '+held+' is pending and ignores its late reply',async t=>{
 const h=await fixture(t,{seats:'  {}'}),entered=deferred(),gate=deferred(),v=await ui(h,async path=>{if(path===held){entered.resolve();await gate.promise}});v.f.go(2);if(held==='/api/chats/new'){v.H.active.room=null;v.f.invalidate()}
 const beforeChats=h.runtime.chatsList(OWNER).chats.length,beforeRoom=h.runtime.registry.get('room')?.settings();
 const work=v.find('[data-first-connect]').emit('click');await entered.promise;assert.equal(v.f.state.busy,true);
 if(exit==='back'){await v.find('.st[data-s="2"] [data-go="1"]').emit('click');assert.equal(v.find('.st[data-s="1"]').classList.contains('on'),true)}else {await v.find('.st[data-s="2"] [data-first-simple]').emit('click');assert.equal(v.c.location.href,'10-new-chat.html')}
 assert.equal(v.f.state.busy,false);const operation=v.f.state.operation;gate.resolve();await work;await v.settle();assert.equal(v.f.state.operation,operation);assert.equal(v.f.state.busy,false);assert.equal(v.document.querySelector('.first-failure'),null);
 if(exit==='back')assert.equal(v.find('.st[data-s="1"]').classList.contains('on'),true);else assert.equal(v.c.location.href,'10-new-chat.html');if(held==='/api/chats/new'){assert.equal(v.S.firstRoomCreations?.[h.dir],undefined);assert.equal(h.runtime.chatsList(OWNER).chats.length,beforeChats)}else assert.deepEqual(h.runtime.registry.get('room')?.settings(),beforeRoom);assert.equal(h.provider.calls.length,0);
});

test('TS-34: first question runs in the room and never promotes it',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h);await connectSelected(v);h.provider.onRun=async(_seat,text,ctx)=>{ctx.modelStarted?.();return {text:'первый ответ на '+text,sessionId:'s1'}};
 const input=v.find('.st[data-s="3"] .live-in');input.value='Первый вопрос';await v.find('[data-first-send]').emit('click');await v.settle();await h.runtime.idle();
 assert.equal(h.provider.calls.length,1);assert.equal(h.provider.calls[0]!.seat.id,'room');assert.equal(h.provider.calls[0]!.message,'Первый вопрос');assert.equal(h.runtime.registry.get('orchestrator'),null);assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,0);
});

test('TS-34: an existing orchestrator does not take over first-run model choice',async t=>{
 const h=await fixture(t,{seats:'  lead: {kind: orchestrator, role: orchestrator, model: w1, vendor: claude, mode: read}'}),v=await ui(h);assert.equal(v.S.ui.pane,'room');assert.equal(v.H.pane,null);await connectSelected(v);assert.equal(v.H.pane.id,'room');assert.equal(v.find('.st[data-s="3"]').classList.contains('on'),true);assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,0);
});

test('TS-34: empty chat model hint is dismissible for that chat while the composer stays available',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h);v.c.PAGE='chat';v.f.go(3);v.f.guidance();const card=v.find('[data-model-guidance]');assert.match(card.textContent,/Подключите модель, когда захотите/);assert.ok(v.find('.st[data-s="3"] .live-in'));
 await v.find('[data-model-guidance-close]').emit('click');assert.equal(v.document.querySelector('[data-model-guidance]'),null);v.f.guidance();assert.equal(v.document.querySelector('[data-model-guidance]'),null);
});

test('TS-34: sending without a model explains the next action and keeps the draft',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h);v.c.PAGE='chat';const input=v.find('.st[data-s="3"] .live-in');input.value='Не потеряй это';assert.equal(await v.f.sendNow(input.value,input,v.f.binding()),false);assert.equal(v.toasts.at(-1),'Сначала выберите модель');assert.equal(input.value,'Не потеряй это');assert.equal(v.S.draft,'Не потеряй это');assert.equal(h.provider.calls.length+h.codex.calls.length,0);
});

test('TS-34: malformed remembered guidance and a stale selected pane cannot hide the empty-chat card',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h,undefined,{chatGuidance:{model:[],orchestrator:[]}});v.c.PAGE='chat';v.H.pane={id:'lead',model:'w1'};v.S.ui.pane='room';v.f.go(3);v.f.guidance();
 assert.match(v.find('[data-model-guidance]').textContent,/Подключите модель, когда захотите/);assert.equal(Array.isArray(v.S.chatGuidance.model),false);assert.equal(Array.isArray(v.S.chatGuidance.orchestrator),false);
});

test('TS-34: first model answer offers an orchestrator; Not now is per chat and Assign role restores the card',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h);await connectSelected(v);const binding=v.f.binding();v.S.chat=[{role:'ai',src:'live',pane:'room',who:'Без роли',model:v.H.pane.model,text:'Ответ',html:'<p>Ответ</p>',t:Date.now()}];v.f.guidance();assert.ok(v.find('[data-orchestrator-guidance]'));
 await v.find('[data-orchestrator-guidance-later]').emit('click');assert.equal(v.document.querySelector('[data-orchestrator-guidance]'),null);v.f.guidance();assert.equal(v.document.querySelector('[data-orchestrator-guidance]'),null);
 h.provider.onRun=async(_seat,text,ctx)=>{ctx.modelStarted?.();return {text:'продолжение '+text,sessionId:'s2'}};const input=v.find('.st[data-s="3"] .live-in');input.value='Продолжим';assert.equal(await v.f.send(),true);await v.settle();await h.runtime.idle();assert.equal(h.provider.calls.at(-1)?.message,'Продолжим');
 const assign=v.document.createElement('span');assign.setAttribute('data-la','assign');assign.setAttribute('data-i','0');v.find('.feed .col').appendChild(assign);await assign.emit('click');assert.ok(v.find('[data-orchestrator-guidance]'));assert.equal(v.f.binding().chat,binding.chat);assert.equal(v.requests.filter(r=>r.path.endsWith('/orchestrator')).length,0);
});

test('TS-34: pending send becomes a draft and first run never replays it',async t=>{
 const h=await fixture(t),v=await ui(h,undefined,{pending:{text:'старый запрос'},first:{place:'HARNESS',model:'выдуманная модель'}});assert.equal(v.S.pending,null);assert.equal(v.S.draft,'старый запрос');assert.equal(v.S.first,undefined);assert.equal(v.requests.filter(r=>r.body).length,0);assert.equal(h.provider.calls.length,0);
});

test('TS-34: folder control still creates the selected project without a model turn',async t=>{
 const h=await fixture(t,{seats:'  {}'}),v=await ui(h);runInContext(fixtureSource(live,fixtureGroups.live_projectPathValue_to_projectPathValue,{filename:'live.js',wrapper:0})+'globalThis.LIVE={H,S,save,api,esc,toast,log,paneName,hStatus,pickPane,refreshStatus,loadChat,sendBinding,bindingCurrent,invalidateBinding,operationsDraw,projectPathValue};',v.vm);runInContext(readFileSync(new URL('../../../ui/deploy/cx.js',import.meta.url),'utf8'),v.vm);
 const target=join(h.dir,'first-project');await v.find('[data-cx="folder"]').emit('click');await v.settle();await v.find('[data-cx-nav="mkdir"]').emit('click');v.find('input.cx-path').value=target;await v.find('[data-cx-mkdir]').emit('click');await v.settle();v.f.draw();assert.equal(h.runtime.project.dir,target);assert.equal(v.H.project,target);assert.match(v.find('.st[data-s="1"] .pick small').textContent,/first-project/);assert.equal(h.provider.calls.length,0);
});

for(const bad of [null,[],{binding:{project:'/wrong',pane:'room',chat:null},chat:'known'},{binding:{project:'self',pane:'worker',chat:null},chat:'known'},{binding:{project:'self',pane:'room',chat:null},chat:'<script>'}])test('TS-34: malformed persisted room creation cannot create another chat '+JSON.stringify(bad),async t=>{
 const h=await fixture(t),entry=JSON.parse(JSON.stringify(bad));if(entry?.binding?.project==='self')entry.binding.project=h.dir;
 const v=await ui(h,undefined,{firstRoomCreations:Array.isArray(bad)?bad:{[h.dir]:entry}});await v.f.next();assert.equal(v.requests.filter(r=>r.body).length,0);assert.match(v.find('.first-failure').textContent,/Не удалось прочитать созданный разговор/);assert.equal(h.provider.calls.length,0);
});

const missingCreation=(project:string,chat='c-missing')=>({firstRoomCreations:{[project]:{binding:{project,pane:'room',chat:null},chat}}});
test('TS-34: confirmed missing room offers restart, Back and Simple chat',async t=>{
 const h=await fixture(t),v=await ui(h,undefined,missingCreation(h.dir));assert.equal((await call(h.api,'/api/chats/c-missing')).status,404);await v.f.next();const door=v.find('[data-first-door]');
 assert.match(door.textContent,/Разговор не найден/);assert.ok(door.querySelector('[data-first-restart]'));assert.ok(door.querySelector('[data-go="1"]'));assert.ok(door.querySelector('[data-first-simple]'));assert.equal(v.S.firstRoomCreations[h.dir].chat,'c-missing');assert.equal(v.requests.filter(r=>r.body).length,0);
});

for(const change of ['project','aba','pagehide'])test('TS-34: delayed missing-room read cannot cross '+change,async t=>{
 const h=await fixture(t),entered=deferred(),gate=deferred(),v=await ui(h,async path=>{if(path==='/api/chats'){entered.resolve();await gate.promise}},missingCreation(h.dir));const work=v.f.next();await entered.promise;
 if(change==='project')v.H.project='/other';else if(change==='aba')v.f.invalidate();else await v.window.emit('pagehide');gate.resolve();await work;assert.equal(v.document.querySelector('[data-first-restart]'),null);assert.equal(v.S.firstRoomCreations[h.dir].chat,'c-missing');assert.equal(v.requests.filter(r=>r.body).length,0);assert.equal(h.provider.calls.length,0);
});


function restoredLifecycle(v:Awaited<ReturnType<typeof ui>>){
 Object.assign(v.c,{CustomEvent:class {type:string;constructor(type:string){this.type=type}},dispatchEvent:(event:any)=>v.window.emit(event.type,event),setTimeout:(fn:()=>void)=>queueMicrotask(fn),PS:{alive:true,generation:0},JR:{epoch:0},SP:{generation:0},sectionChanging(){},sectionDraw(){},liveFirstPaint(){},badges(){},renderWaiting(){},sideChats:async()=>{}});v.f.TP.project=v.H.project;
 runInContext(fixtureSource(live,fixtureGroups.live_applyStatus_to_refreshStatus,{filename:'live.js',wrapper:0})+fixtureSource(live,fixtureGroups.live_suspendPage_to_addEventListener,{filename:'live.js',wrapper:0}),v.vm);
}

test('320: persisted page restore rereads first-run models after project confirmation and renews one subscription',async t=>{
 const h=await fixture(t),gate=deferred(),seen=deferred();t.after(()=>gate.resolve());let checking=true,hold=false;
 const v=await ui(h,async path=>{if(hold&&path==='/api/status'){seen.resolve();await gate.promise}}, {},(path,response)=>{const catalog=programs(),row=catalog.providers.find(p=>p.id==='copilot')!;row.checking=checking;row.installed=checking?null:true;return programData(path,response,catalog)});restoredLifecycle(v);v.f.go(2);
 const option=()=>v.find('[data-first-program="copilot"] option[value="shared"]');assert.equal(option().disabled,true);const reads=v.requests.filter(r=>r.path==='/api/providers/catalog').length;
 await v.window.emit('pagehide',{persisted:true});assert.equal(v.streams.filter(s=>!s.closed).length,0);checking=false;hold=true;
 const showing=v.window.emit('pageshow',{persisted:true});await seen.promise;assert.equal(v.H.snapshotOnly,true);assert.equal(v.requests.filter(r=>r.path==='/api/providers/catalog').length,reads);assert.equal(v.streams.filter(s=>!s.closed).length,0);
 hold=false;gate.resolve();await showing;await v.settle();assert.equal(option().disabled,false);assert.equal(v.streams.filter(s=>!s.closed).length,1);
 const refreshed=v.requests.filter(r=>r.path==='/api/providers/catalog').length;for(const stream of v.streams.filter(s=>!s.closed))stream.onmessage({data:JSON.stringify({type:'providers',project:h.dir})});await v.settle();assert.equal(v.requests.filter(r=>r.path==='/api/providers/catalog').length,refreshed+1);
 await v.window.emit('pagehide',{persisted:true});await v.window.emit('pageshow',{persisted:true});await v.settle();assert.equal(v.streams.filter(s=>!s.closed).length,1);assert.equal(h.provider.calls.length+h.codex.calls.length,0);
});

test('320: an old catalogue response cannot replace ready models after persisted restore',async t=>{
 const h=await fixture(t),gate=deferred(),seen=deferred();t.after(()=>gate.resolve());let checking=true;
 const v=await ui(h,undefined,{},(path,response)=>{const catalog=programs(),row=catalog.providers.find(p=>p.id==='copilot')!;row.checking=checking;row.installed=checking?null:true;return programData(path,response,catalog)});restoredLifecycle(v);
 const api=v.c.api;let hold=true;v.c.api=async(path:string,body:any)=>{const result=await api(path,body);if(hold&&path==='/api/providers/catalog'){hold=false;seen.resolve();await gate.promise}return result};
 const old=v.f.catalog();await seen.promise;await v.window.emit('pagehide',{persisted:true});checking=false;await v.window.emit('pageshow',{persisted:true});await v.settle();
 assert.equal(v.find('[data-first-program="copilot"] option[value="shared"]').disabled,false);gate.resolve();await old;assert.equal(v.find('[data-first-program="copilot"] option[value="shared"]').disabled,false);assert.equal(v.streams.filter(s=>!s.closed).length,1);
});

for(const action of ['use','save','changed'])test('TS-23e: first run keeps recovery in model step; '+action,async t=>{
 const h=await fixture(t);let checked=false;const v=await ui(h,undefined,{},(path,response)=>{
  if(path==='/api/providers/catalog'){const rows=programs();return {...rows,providers:rows.providers.map(p=>({...p,login:{state:checked?'ok':'unknown',command:'login',...(p.id==='claude'&&!checked?{failure:'region'}:{})}}))}}
  if(path==='/api/providers/claude/check'){checked=true;return {ok:true,login:{state:'ok',command:'login'}}}return response;
 });v.f.go(2);assert.equal(v.find('.st[data-s="2"]').classList.contains('on'),true);assert.equal(v.document.querySelectorAll('.st[data-s]').length,3);assert.match(v.find('[data-login-recovery="claude"]').textContent,/регион/);
 assert.equal(v.find('[data-first-connect]').getAttribute('aria-disabled'),'true');await v.find('[data-first-connect]').emit('click');assert.equal(v.document.querySelector('[data-first-promote]'),null);
 await v.find('[data-login-connect="claude"]').emit('click');assert.equal(v.recoveryOpens[0].provider,'claude');
 if(action==='changed'){await v.find('[data-login-other="claude"]').emit('click');assert.equal(v.document.activeElement?.getAttribute('data-first-model'),'')}
 v.recoveryOpens[0].onSaved({ok:true},{usedFor:action==='save'?null:'claude'});await v.settle();
 assert.equal(v.requests.filter(r=>r.path==='/api/providers/claude/check').length,action==='use'?1:0);
 assert.equal(v.requests.filter(r=>r.body&&/orchestrator|\/probe|\/send/.test(r.path)).length,0);
 if(action==='use')assert.equal(v.document.querySelector('[data-login-recovery]'),null);
});
