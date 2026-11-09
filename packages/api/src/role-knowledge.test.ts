import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,call,OWNER,FakeProvider,deferred,until} from './test-helpers.ts';
import {createRuntime} from '@harnessy/runtime';

async function setup(t:Parameters<typeof fixture>[0]){
 const h=await fixture(t,{seats:'  lead: {kind: orchestrator, role: orchestrator, label: Ведущий, vendor: claude, model: w1, mode: read}'});
 const p=h.runtime.project,source=p.state.chats.chats[p.state.chats.active.lead!]!;source.documents=[{project:h.dir,path:'claim.md'}];p.state.saveChats(p.registry);
 writeFileSync(join(h.dir,'.harness/MEMORY.md'),'## Цель\nЗащитить права клиента\n\n## Решения\nРаботать с договором');
 h.provider.onRun=async(s,_text,ctx)=>{ctx.modelStarted?.();if(s.id==='lead')assert.equal((await ctx.tools.proposeSeats({seats:[{kind:'worker',label:'Юрист',vendor:'claude',model:'w1',mode:'read',intro:'Проверь договор\nВсе пункты и доказательства'},{kind:'reviewer',label:'Рецензент',vendor:'claude',model:'w1',mode:'read',intro:'Независимая проверка'}]})).ok,true);return {text:'Готов',sessionId:'session'}};
 await h.runtime.runTurn('lead','Составь команду');const q=(await h.runtime.teamProposals(OWNER)).proposals[0]!;
 return {...h,q};
}
test('251 HTTP: knowledge is tied to saved proposal and chat, with memory, documents and effective team states',async t=>{
 const h=await setup(t),created=await call(h.api,'/api/seats/owner',{body:{project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:0,kind:'researcher'}});assert.equal(created.status,200);await h.runtime.idle();
 const result=await call(h.api,'/api/chats/'+created.body.chat),k=result.body.knowledge;assert.equal(result.status,200);assert.equal(k.project,h.dir);assert.equal(k.chat,created.body.chat);assert.equal(k.pane,created.body.pane);
 assert.equal(k.proposalId,h.q.proposalId);assert.match(k.text,/Защитить права клиента/);assert.match(k.text,/claim.md/);assert.match(k.text,/Все пункты и доказательства/);assert.match(k.text,/создана владельцем как researcher/);assert.match(k.text,/предложена · чата ещё нет/);assert.equal(k.team[0].kind,'orchestrator');assert.equal(k.team[1].kind,'researcher');assert.equal(k.team[2].state,'proposed');
 assert.equal((await call(h.api,'/api/chats/'+h.runtime.project.state.chats.active.room)).body.knowledge,undefined);
 const second=await call(h.api,'/api/seats/owner',{body:{project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:1}});assert.equal(second.status,200);await h.runtime.idle();
 const updated=(await call(h.api,'/api/chats/'+created.body.chat)).body.knowledge;assert.equal(updated.team[2].state,'created');assert.equal(updated.team[2].chat,second.body.chat);
});
test('251: foreign proposal project and escaped memory link never become role knowledge',async t=>{
 const h=await setup(t),created=await h.runtime.createOwnerSeat({project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:0},OWNER);await h.runtime.idle();
 const p=h.runtime.project,store=p.state.readProposals() as any;p.state.saveProposals({...store,project:'/foreign'});assert.equal((await call(h.api,'/api/chats/'+created.chat)).status,409);p.state.saveProposals(store);
 const file=join(h.dir,'.harness/MEMORY.md'),outside=h.dir+'-outside-memory';unlinkSync(file);try{symlinkSync(outside,file)}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows file symlink requires privilege');return}throw e}writeFileSync(outside,'FOREIGN');
 try{const result=await call(h.api,'/api/chats/'+created.chat);assert.equal(result.status,409);assert.doesNotMatch(result.text,/FOREIGN/)}finally{unlinkSync(outside)}
});

test('251: owner-created seat waits for bound opening across restart; opening delivers the visible knowledge once',async t=>{
 const h=await setup(t),created=await h.runtime.createOwnerSeat({project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:0},OWNER);await h.runtime.idle();assert.equal(h.provider.calls.filter(c=>c.seat.id===created.pane).length,0);
 const preview=await call(h.api,'/api/chats/'+created.chat);assert.ok(preview.body.knowledge);assert.equal(h.provider.calls.filter(c=>c.seat.id===created.pane).length,0);
 for(const body of [{pane:created.pane},{pane:created.pane,project:'/foreign',chat:created.chat},{pane:created.pane,project:h.dir,chat:'other'}])assert.equal((await call(h.api,'/api/onboard',{body})).status,409);
 await h.runtime.kick(created.pane);assert.equal(h.provider.calls.filter(c=>c.seat.id===created.pane).length,0);await assert.rejects(h.runtime.runTurn(created.pane,'direct'),(e:any)=>e.code==='role_not_opened');
 await h.runtime.close();const provider=new FakeProvider(),r=await createRuntime({...h.deps,providers:{claude:provider}},h.runtime.actions);
 try{await r.idle();assert.equal(provider.calls.length,0);const k=r.chatGet(created.chat,OWNER).knowledge!;assert.equal(k.text,preview.body.knowledge.text);
  await r.onboard(created.pane,OWNER,{project:h.dir,chat:created.chat});await r.idle();assert.equal(provider.calls.length,1);assert.ok(provider.calls[0]!.message.includes(k.text));
  await r.onboard(created.pane,OWNER,{project:h.dir,chat:created.chat});await r.idle();assert.equal(provider.calls.length,1);
  assert.equal(r.journal.read({limit:0}).filter(x=>x.origin==='onboarding'&&x.to.includes(created.pane)).length,1);
 }finally{await r.close()}
});

test('252: snapshot freezes before model start; a concurrently created role is reported on the next turn only',async t=>{
 const h=await setup(t),first=await h.runtime.createOwnerSeat({project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:0},OWNER),gate=deferred();
 let hold=true;h.provider.onRun=async(_s,_text,ctx)=>{if(hold){hold=false;await gate.promise}ctx.modelStarted?.();return {text:'Ответ',sessionId:'session'}};
 await h.runtime.onboard(first.pane,OWNER,{project:h.dir,chat:first.chat});await until(()=>h.provider.calls.some(c=>c.seat.id===first.pane));
 const second=await h.runtime.createOwnerSeat({project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:1,kind:'researcher'},OWNER);gate.resolve();await h.runtime.idle();
 assert.match(h.provider.calls.find(c=>c.seat.id===first.pane)!.message,/предложена · чата ещё нет/);assert.equal(h.provider.calls.some(c=>c.seat.id===second.pane),false);
 await h.runtime.runTurn(first.pane,'Следующий вопрос');const message=h.provider.calls.at(-1)!.message;assert.match(message,/изменения в команде:[\s\S]*создана владельцем как researcher/);assert.doesNotMatch(message,/Что знает эта роль/);
 await h.runtime.runTurn(first.pane,'Без изменений');assert.doesNotMatch(h.provider.calls.at(-1)!.message,/изменения в команде|Что знает эта роль/);
});

for(const bad of ['missing','foreign-chat','foreign-project'] as const)test('251 absence: '+bad+' first-opening marker never silently starts a model',async t=>{
 const h=await setup(t),out=await h.runtime.createOwnerSeat({project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:0},OWNER),c=h.runtime.project.state.chats.chats[out.chat]!;
 if(bad==='missing')delete c.firstOpen;else (c.firstOpen as any)[bad==='foreign-chat'?'chat':'project']='foreign';
 const before=h.provider.calls.length;const result=await call(h.api,'/api/onboard',{body:{project:h.dir,pane:out.pane,chat:out.chat}});assert.equal(result.status,409);assert.match(result.body.error,/ожидание первого открытия/);await assert.rejects(h.runtime.onboard(out.pane,OWNER,{project:h.dir,chat:out.chat}),(e:any)=>e.code==='chat_invalid');await h.runtime.kick(out.pane);assert.equal(h.provider.calls.length,before);
});
test('251/252 + TS-26: pre-start failure preserves knowledge for explicit retry; simultaneous opening creates it once',async t=>{
 const h=await setup(t),out=await h.runtime.createOwnerSeat({project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:0},OWNER);h.provider.onRun=async()=>{throw Error('provider unavailable')};
 await Promise.all([h.runtime.onboard(out.pane,OWNER,{project:h.dir,chat:out.chat}),h.runtime.onboard(out.pane,OWNER,{project:h.dir,chat:out.chat})]);await h.runtime.idle();const pane=h.runtime.registry.get(out.pane)!;assert.equal(pane.transcript.some(m=>m.teamKnowledge),false);
 h.provider.onRun=async(_s,text,c)=>{assert.match(text,/Что знает эта роль/);c.modelStarted?.();return {text:'готово',sessionId:'s'}};await h.runtime.kick(out.pane);await h.runtime.idle();assert.equal(pane.transcript.some(m=>m.teamKnowledge),false);const waiting=h.runtime.waiting(out.pane)!;assert.equal(waiting.status,'unsent');await h.runtime.attempt(out.pane,{project:h.dir,turnInstanceId:waiting.turnInstanceId,action:'retry'},OWNER);await h.runtime.idle();assert.equal(pane.transcript.filter(m=>m.teamKnowledge).length,1);assert.equal(h.runtime.journal.read({limit:0}).filter(r=>r.origin==='onboarding'&&r.to.includes(out.pane)).length,1);
});

test('251 paths: a new conversation cannot bypass the first owner opening of the created role',async t=>{
 const h=await setup(t),out=await h.runtime.createOwnerSeat({project:h.dir,proposalId:h.q.proposalId,version:1,seatIndex:0},OWNER),before=h.provider.calls.length;
 const next=await call(h.api,'/api/chats/new',{body:{pane:out.pane,carry:'none'}});assert.equal(next.status,200);assert.notEqual(next.body.chat.id,out.chat);
 await h.runtime.kick(out.pane);await h.runtime.idle();assert.equal(h.provider.calls.length,before);
 const card=await call(h.api,'/api/chats/'+next.body.chat.id);assert.equal(card.body.firstOpenPending,true);assert.ok(card.body.knowledge);
 await h.runtime.onboard(out.pane,OWNER,{project:h.dir,chat:next.body.chat.id});await h.runtime.idle();assert.equal(h.provider.calls.length,before+1);assert.ok(h.provider.calls.at(-1)!.message.includes(card.body.knowledge.text));
});
