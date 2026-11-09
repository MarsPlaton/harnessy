import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync,symlinkSync,appendFileSync,fsyncSync,openSync} from 'node:fs';
import {join} from 'node:path';
import {Journal} from './journal.ts';
import {Channel} from './channel.ts';
import {Policy} from './policy.ts';
import {normalizeReplyTo,type ChannelEvent} from './types.ts';
import {fixture,temp,error,ackPolicy,verdictAckPolicy,template} from './test-support.ts';
function reopen(f:ReturnType<typeof fixture>){const journal=new Journal(f.root),channel=new Channel({...f.deps,journal,policy:new Policy(f.policyPath)});return {journal,channel}}

test('TS-07/98: agent cannot inject attempt metadata or impersonate its trusted decision sender',()=>{
 const f=fixture();try{const input={to:'worker',kind:'note' as const,text:'просто текст',thread:'attempt:forged'},forged={pane:'worker',turnInstanceId:'forged',action:'skip',deliverySeq:1,done:false};
 for(const extra of [{attempt:forged},{from:'harness',origin:'attempt',attempt:forged}])assert.throws(()=>f.agent('assistant',{...input,...extra} as never),error('initiator_invalid','служебные поля записи задаёт ядро'));
 const record=f.agent('assistant',input);assert.equal(record.from,'assistant');assert.equal(Object.hasOwn(record,'attempt'),false);assert.equal(Object.hasOwn(new Journal(f.root).get(record.seq)!,'attempt'),false);
 }finally{f.close()}
});

test('[11] wildcard expands live seats plus owner; unknown/self/duplicate recipients preserve Python rules',()=>{
 const f=fixture();try{const rec=f.agent('assistant',{to:'*',kind:'note',text:'all'});assert.deepEqual(rec.to,['worker','reviewer','orchestrator','tester','architect','researcher','owner']);
 assert.throws(()=>f.agent('worker',{to:'unknown',kind:'note',text:'x'}),error('to_unknown','нет такого окна: unknown; есть worker, reviewer, orchestrator, tester, architect, researcher, assistant и owner'));
 assert.throws(()=>f.agent('worker',{to:'worker',kind:'note',text:'x'}),error('self_addressed','запись самому себе не нужна'));
 assert.deepEqual(f.agent('assistant',{to:['worker','worker'],kind:'note',text:'duplicates'}).to,['worker','worker']);
 assert.equal(f.core({to:'*',kind:'note',text:'owner all'}).to.includes('owner'),false)
 }finally{f.close()}
});
test('[12] verdict score/round/reply validation precedes evidence and applies to core too',()=>{
 const f=fixture();try{for(const score of [undefined,null,true,-1,11,1.5,'9'])assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'verdict',text:'x',score,round:1} as never),error('score_invalid','verdict требует score — целое от 0 до 10'));
 for(const round of [undefined,null,true,0,-1,1.2,'1'])assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'verdict',text:'x',score:9,round} as never),error('round_invalid','verdict требует round — целое от 1'));
 assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'verdict',text:'x',score:9,round:1}),error('reply_to_required','verdict — только ответ на review-request (reply_to)'));
 assert.throws(()=>f.core({to:'worker',kind:'verdict',text:'x',score:9,round:1}),error('reply_to_required'));
 }finally{f.close()}
});
test('[13] review-request resolves real SHA only for agents with repository',()=>{
 const f=fixture();try{assert.throws(()=>f.agent('worker',{to:'reviewer',kind:'review-request',text:'x'}),error('sha_required','review-request обязан нести sha коммита вехи (git rev-parse HEAD в своей ветке)'));
 assert.throws(()=>f.agent('worker',{to:'reviewer',kind:'review-request',text:'x',sha:'deadbeef'}),error('sha_unknown','коммита deadbeef нет в репозитории проекта; закоммить и пришли настоящий SHA'));
 assert.equal(f.request().sha,'a'.repeat(40));f.deps.hasRepo=()=>false;assert.equal(f.agent('worker',{to:'reviewer',kind:'review-request',text:'without git'}).sha,undefined)
 }finally{f.close()}
});
test('[14] verdict requires every attachment to exist and one report; inherits target SHA',()=>{
 const f=fixture(),outside=temp();try{const rr=f.request(),base={to:'worker',kind:'verdict' as const,text:'9/10',reply_to:rr.seq,score:9,round:1};
 assert.throws(()=>f.agent('reviewer',base),error('evidence_required','verdict без отчёта не принимается: положи report.md в .harness/evidence/<тред>/r<раунд>/ и укажи путь в evidence'));
 assert.throws(()=>f.agent('reviewer',{...base,evidence:['missing.md']}),error('evidence_missing','файла отчёта нет: '+join(f.root,'missing.md')));
 const bad=f.report('T',1,'# Ran\n');assert.throws(()=>f.agent('reviewer',{...base,evidence:[bad]}),error('evidence_contract'));
 assert.throws(()=>f.agent('reviewer',{...base,evidence:[join(outside.root,'report.md')]}),error('evidence_outside','путь свидетельства вне проекта: '+join(outside.root,'report.md')));
 const good=f.report('T',2);assert.throws(()=>f.agent('reviewer',{...base,evidence:[good,'missing.md']}),error('evidence_missing'));
 const rec=f.agent('reviewer',{...base,evidence:[bad,good],sha:'fake'});assert.equal(rec.sha,rr.sha);assert.equal(rec.accepted,true);assert.equal(rec.thread,'T')
 }finally{f.close();outside.close()}
});
test('[15] report attachments exist; outside paths keep Python evidence_missing text',()=>{
 const f=fixture();try{for(const evidence of ['missing','../outside'])assert.throws(()=>f.agent('tester',{to:'worker',kind:'report',text:'x',evidence:[evidence]}),error('evidence_missing','файла свидетельства нет: '+evidence));
 const report=f.report('T',1,'arbitrary artifact');assert.ok(f.agent('tester',{to:'worker',kind:'report',text:'x',evidence:[report]}));assert.ok(f.agent('tester',{to:'worker',kind:'report',text:'no attachments'}))
 }finally{f.close()}
});
test('[16] owner/harness bypass policy, git/evidence guards; verdict has no new universal review guard',()=>{
 const f=fixture();try{f.deps.policy=null;assert.ok(f.core({to:'worker',kind:'task',text:'owner'}));assert.ok(f.core({to:'worker',kind:'review-request',text:'harness'},'harness'));
 const target=f.core({to:'worker',kind:'question',text:'question',thread:'T'});
 const rec=f.core({to:'worker',kind:'verdict',text:'owner verdict',reply_to:target.seq,score:10,round:1,evidence:['../absent']});assert.equal(rec.kind,'verdict');assert.equal(rec.accepted,false)
 }finally{f.close()}
});
test('[17] absent policy denies agent and durably records exact rejection',()=>{
 const f=fixture();try{f.deps.policy=null;assert.throws(()=>f.agent('worker',{to:'orchestrator',kind:'note',text:'x'}),error('policy_denied','политика связи не читается; исправь comms-policy.yaml'));
 const rec=f.journal.read({kinds:['rejected']})[0]!;assert.equal(rec.text,'worker → orchestrator note: политика связи не читается — записи агентов не проходят');assert.equal(rec.policy,0);assert.deepEqual(f.events.map(e=>e.type),['rejected']);assert.deepEqual(f.journal.pendingFor('orchestrator'),[])
 }finally{f.close()}
});
test('[18] any denied recipient refuses entire send with policy hint and no delivery',()=>{
 const f=fixture();try{assert.throws(()=>f.agent('architect',{to:['orchestrator','worker'],kind:'proposal',text:'x'}),error('policy_denied','политика v1: architect может писать executor только: answer, note, question'));
 assert.deepEqual(f.events.map(e=>e.type),['rejected']);assert.equal(f.journal.read({kinds:['proposal']}).length,0);assert.deepEqual(f.journal.pendingFor('orchestrator'),[])
 }finally{f.close()}
});
test('[19] reply-to trigger rejects wrong kind and a different author',()=>{
 const f=fixture();try{const evidence=[f.report()],q=f.agent('worker',{to:'reviewer',kind:'question',text:'?',thread:'T'}),base={to:'worker',kind:'verdict' as const,text:'x',score:9,round:1,evidence};
 const reason='политика v1: verdict от reviewer — только ответ на review-request от executor (reply_to)';
 assert.throws(()=>f.agent('reviewer',{...base,reply_to:q.seq}),error('policy_denied',reason));
 const foreign=f.core({to:'reviewer',kind:'review-request',text:'owner request',thread:'T'});assert.throws(()=>f.agent('reviewer',{...base,reply_to:foreign.seq}),error('policy_denied',reason))
 }finally{f.close()}
});
test('[20] owner-ack holds, confirms durably then delivers; reject records owner and note sender',()=>{
 const f=fixture(ackPolicy);try{const held=f.agent('tester',{to:'worker',kind:'report',text:'report'});assert.equal(held.ack,'pending');assert.deepEqual(f.events.map(e=>e.type),['posted','pendingAck']);assert.deepEqual(f.journal.pendingFor('worker'),[]);
 const ack=f.channel.confirmAck(held.seq);assert.equal(ack.from,'owner');assert.equal(ack.reply_to,held.seq);assert.equal(ack.text,'подтверждено #'+held.seq);assert.equal(f.events.at(-1)?.type,'delivered');assert.equal((f.events.at(-1) as {deliverySeq:number}).deliverySeq,ack.seq);
 const no=f.agent('tester',{to:'worker',kind:'report',text:'no'});const rejected=f.channel.rejectAck(no.seq);assert.equal(rejected.text,'#'+no.seq+' report от tester отклонено владельцем');assert.deepEqual(rejected.to,['owner']);
 const note=f.journal.read({kinds:['note']}).find(r=>r.origin==='ack')!;assert.equal(note.text,'Запись #'+no.seq+' (report) владелец не подтвердил, она не доставлена.');assert.deepEqual(note.to,['tester']);assert.equal(f.journal.pendingFor('worker').some(e=>e.record.seq===no.seq),false)
 }finally{f.close()}
});
test('[21] verdict bounds reject excess round and set acceptance threshold/bounds',()=>{
 const f=fixture();try{const rr=f.request(),base={to:'worker',kind:'verdict' as const,text:'x',reply_to:rr.seq,evidence:[f.report()],score:8,round:4};
 assert.throws(()=>f.agent('reviewer',base),error('policy_denied','раунд 4 больше max_rounds=3 треда T; эскалируй владельцу'));
 const low=f.agent('reviewer',{...base,round:1});assert.equal(low.accepted,false);assert.deepEqual(low.bounds,{max_rounds:3,accept_score:9});
 assert.equal(f.agent('reviewer',{...base,round:2,score:9}).accepted,true)
 }finally{f.close()}
});
test('[22] thread acceptance is sticky, rounds=max, latest score; restore merges without announcements',()=>{
 const f=fixture();try{const rr=f.request(),base={to:'worker',kind:'verdict' as const,text:'x',reply_to:rr.seq,evidence:[f.report()]};
 f.agent('reviewer',{...base,score:9,round:2});f.agent('reviewer',{...base,score:3,round:1});
 assert.deepEqual(f.channel.threads.get('T'),{rounds:2,accepted:true,lastScore:3,sha:'a'.repeat(40),merged:null});
 f.core({to:'orchestrator',kind:'status',text:'merged',thread:'T',origin:'merge',sha:'a'.repeat(40),merged:'b'.repeat(40)},'harness');
 f.core({to:'orchestrator',kind:'status',text:'old merge',thread:'OLD',origin:'merge',sha:'a'.repeat(40)},'harness');f.deps.mergeCommitFor=()=> 'c'.repeat(40);
 const before=f.journal.lastSeq,{journal,channel}=reopen(f);assert.equal(journal.lastSeq,before);assert.equal(channel.threads.get('T')?.merged,'b'.repeat(40));assert.equal(channel.threads.get('OLD')?.merged,'c'.repeat(40));assert.equal(channel.threads.get('T')?.accepted,true);
 assert.equal(journal.read({kinds:['status']}).filter(r=>r.origin==='verdict').length,2)
 }finally{f.close()}
});
test('[23] policy rejection record/event carries harness owner and snapshot version',()=>{
 const f=fixture();try{assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'task',text:'x'}),error('policy_denied'));
 const rejected=f.journal.read({kinds:['rejected']})[0]!;assert.equal(rejected.from,'harness');assert.deepEqual(rejected.to,['owner']);assert.equal(rejected.policy,1);assert.equal(rejected.text,'reviewer → worker task: политика v1: reviewer может писать executor только: verdict, question, answer, note');
 assert.deepEqual(f.events[0],{type:'rejected',record:rejected,sender:'reviewer',reason:'политика v1: reviewer может писать executor только: verdict, question, answer, note'})
 }finally{f.close()}
});
test('[31] all agent entry paths reject initiator/field/service-kind masquerades before persistence',()=>{
 const f=fixture();try{for(const [key,value] of Object.entries({from:'owner',trust:'owner',accepted:true,bounds:{accept_score:0},ack:'pending',policy:99,origin:'merge',merged:'fake',seq:1,id:'fake',ts:'fake'}))assert.throws(()=>f.agent('worker',{to:'orchestrator',kind:'note',text:'x',[key]:value} as never),error('initiator_invalid'));
 for(const kind of ['ack','policy','rejected','protocol'])assert.throws(()=>f.agent('worker',{to:'orchestrator',kind,text:'x'} as never),error('kind_unknown'));
 for(const initiator of [undefined,{seat:'owner',trust:'agent'},{seat:'harness',trust:'agent'},{seat:'missing',trust:'agent'},{seat:'worker',trust:'owner'}])assert.throws(()=>f.channel.post({to:'orchestrator',kind:'note',text:'x'},initiator as never),error('initiator_invalid'));
 assert.throws(()=>f.channel.postCore({to:'worker',kind:'task',text:'fake core'},{seat:'worker',trust:'harness'}),error('initiator_invalid'));assert.equal(f.journal.lastSeq,0);assert.deepEqual(f.events,[])
 }finally{f.close()}
});
test('[32] late acknowledgement beyond cursor delivers original once across restart',()=>{
 const f=fixture(ackPolicy);try{const held=f.agent('tester',{to:'worker',kind:'report',text:'held'}),later=f.core({to:'worker',kind:'task',text:'later'});f.journal.advance('worker',later.seq);
 const ack=f.channel.confirmAck(held.seq);assert.deepEqual(f.journal.pendingFor('worker').map(e=>[e.record.seq,e.deliverySeq]),[[held.seq,ack.seq]]);
 const reloaded=reopen(f);assert.deepEqual(reloaded.journal.pendingFor('worker').map(e=>e.deliverySeq),[ack.seq]);reloaded.journal.advance('worker',ack.seq);assert.deepEqual(reopen(f).journal.pendingFor('worker'),[])
 }finally{f.close()}
});
test('[33] confirm is idempotent; rejecting closed/nonpending/unknown acknowledgement is typed',()=>{
 const f=fixture(ackPolicy);try{const held=f.agent('tester',{to:'worker',kind:'report',text:'held'}),ack=f.channel.confirmAck(held.seq),seq=f.journal.lastSeq,count=f.events.length;
 assert.equal(f.channel.confirmAck(held.seq),ack);assert.equal(f.journal.lastSeq,seq);assert.equal(f.events.length,count);assert.throws(()=>f.channel.rejectAck(held.seq),error('ack_closed'));
 const rejected=f.agent('tester',{to:'worker',kind:'report',text:'no'});f.channel.rejectAck(rejected.seq);assert.throws(()=>f.channel.rejectAck(rejected.seq),error('ack_closed'));assert.throws(()=>f.channel.confirmAck(rejected.seq),error('ack_closed'));
 assert.throws(()=>f.channel.confirmAck(999),error('reply_to_missing'));const normal=f.core({to:'worker',kind:'note',text:'normal'});assert.throws(()=>f.channel.confirmAck(normal.seq),error('ack_not_pending'));
 const reloaded=reopen(f);assert.equal(reloaded.channel.confirmAck(held.seq).seq,ack.seq);assert.throws(()=>reloaded.channel.confirmAck(rejected.seq),error('ack_closed'))
 }finally{f.close()}
});
test('[34] pending acknowledgements restore exactly undecided records including forged pending file state',()=>{
 const f=fixture(ackPolicy);try{const a=f.agent('tester',{to:'worker',kind:'report',text:'a'}),b=f.agent('tester',{to:'worker',kind:'report',text:'b'}),c=f.agent('tester',{to:'worker',kind:'report',text:'c'});f.channel.confirmAck(a.seq);f.channel.rejectAck(b.seq);
 const manual=f.journal.append({sender:'worker',to:'reviewer',kind:'note',text:'trusted file pending',ack:'pending'});
 assert.deepEqual(reopen(f).channel.pendingAcks().map(r=>r.seq),[c.seq,manual.seq])
 }finally{f.close()}
});
test('[35] pending verdict cannot accept thread live/restarted until durable ack',()=>{
 const f=fixture(verdictAckPolicy);try{const rr=f.request(),rec=f.agent('reviewer',{to:'worker',kind:'verdict',text:'9',reply_to:rr.seq,score:9,round:1,evidence:[f.report()]});
 assert.equal(f.channel.threads.has('T'),false);const restored=reopen(f);assert.equal(restored.channel.threads.has('T'),false);const events:ChannelEvent[]=[];restored.channel.on(e=>events.push(e));
 restored.channel.confirmAck(rec.seq);assert.equal(restored.channel.threads.get('T')?.accepted,true);assert.ok(events.some(e=>e.type==='verdict'));assert.equal(restored.journal.read({kinds:['status']}).filter(r=>r.origin==='verdict').length,1);
 const again=reopen(f);assert.equal(again.channel.threads.get('T')?.accepted,true);assert.equal(again.journal.lastSeq,restored.journal.lastSeq)
 }finally{f.close()}
});
test('[38] deleted/broken policy denies old permissions, restores with one policy record',()=>{
 const f=fixture();try{const old=f.policy.snapshot();unlinkSync(f.policyPath);assert.throws(()=>f.agent('worker',{to:'orchestrator',kind:'note',text:'deleted'}),error('policy_denied'));assert.equal(f.policy.snapshot(),old);
 f.reload('routes: [');assert.throws(()=>f.agent('worker',{to:'orchestrator',kind:'note',text:'broken'}),error('policy_denied'));
 f.reload(template.replace('version: 1','version: 7'));const rec=f.agent('worker',{to:'orchestrator',kind:'note',text:'restored'});assert.equal(rec.policy,7);
 assert.equal(f.events.filter(e=>e.type==='posted'&&e.record.kind==='policy').length,1);assert.equal(f.journal.read({kinds:['policy']}).length,1);assert.equal(f.journal.read({kinds:['policy']})[0]?.text,'политика связи перечитана: версия 7');
 f.agent('worker',{to:'orchestrator',kind:'note',text:'same snapshot'});assert.equal(f.journal.read({kinds:['policy']}).length,1)
 }finally{f.close()}
});
test('[39] symlink to external report is evidence_outside for verdict',t=>{
 const f=fixture(),outside=temp();try{writeFileSync(join(outside.root,'report.md'),'# Ran\n# Skipped\n# Planned\n# Manual');try{symlinkSync(join(outside.root,'report.md'),join(f.root,'linked'))}catch(e){if(process.platform==='win32'&&(e as NodeJS.ErrnoException).code==='EPERM'){t.skip('Windows file symlink requires privilege');return}throw e}const rr=f.request();
 assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'verdict',text:'9',reply_to:rr.seq,score:9,round:1,evidence:['linked']}),error('evidence_outside','путь свидетельства вне проекта: linked'))
 }finally{f.close();outside.close()}
});
test('[40] direct reply_to=0 is refused, tool normalization yields null; system records cannot be targets',()=>{
 const f=fixture();try{const input={to:'orchestrator',kind:'note' as const,text:'x',reply_to:0};assert.throws(()=>f.agent('worker',input),error('reply_to_missing','нет записи #0, на которую можно ответить'));assert.equal(f.agent('worker',normalizeReplyTo(input)).reply_to,null);
 const system=f.journal.append({sender:'harness',to:'owner',kind:'policy',text:'system'});assert.throws(()=>f.agent('worker',{...input,reply_to:system.seq}),error('reply_to_missing'))
 }finally{f.close()}
});
test('[41] mixed normal/late-confirmed queue is ordered and advanced by deliverySeq across restarts',()=>{
 const f=fixture(ackPolicy);try{const a=f.agent('tester',{to:'worker',kind:'report',text:'a'}),b=f.core({to:'worker',kind:'task',text:'b'}),c=f.agent('tester',{to:'worker',kind:'report',text:'c'}),d=f.core({to:'worker',kind:'task',text:'d'}),ackC=f.channel.confirmAck(c.seq),e=f.core({to:'worker',kind:'task',text:'e'}),ackA=f.channel.confirmAck(a.seq);
 assert.deepEqual(f.journal.pendingFor('worker').map(x=>[x.record.seq,x.deliverySeq]),[[b.seq,b.seq],[d.seq,d.seq],[c.seq,ackC.seq],[e.seq,e.seq],[a.seq,ackA.seq]]);
 f.journal.advance('worker',d.seq);let restored=reopen(f);assert.deepEqual(restored.journal.pendingFor('worker').map(x=>x.deliverySeq),[ackC.seq,e.seq,ackA.seq]);restored.journal.advance('worker',ackC.seq);
 restored=reopen(f);assert.deepEqual(restored.journal.pendingFor('worker').map(x=>x.deliverySeq),[e.seq,ackA.seq]);restored.journal.advance('worker',ackA.seq);assert.deepEqual(reopen(f).journal.pendingFor('worker'),[])
 }finally{f.close()}
});
test('[43] unaccepted final round emits exact escalation to owner/orchestrators and normal status',()=>{
 const f=fixture();try{const rr=f.request();f.agent('reviewer',{to:'worker',kind:'verdict',text:'3/10',reply_to:rr.seq,score:3,round:3,evidence:[f.report()]});
 const escalation=f.journal.read({kinds:['escalation']})[0]!;assert.equal(escalation.origin,'verdict');assert.deepEqual(escalation.to,['owner','orchestrator']);assert.equal(escalation.text,'Тред T: раунды ревью исчерпаны (3), веха не принята. Нужно решение владельца.');
 assert.equal(f.journal.read({kinds:['status']})[0]?.text,'Тред T: вердикт #2 от ревьюер, балл 3, раунд 3 из 3 — не принято.');
 assert.equal(reopen(f).journal.read({kinds:['escalation']}).length,1)
 }finally{f.close()}
});
test('multi-recipient pending OR, last nonempty bounds and immutable policy snapshot per send',()=>{
 const source='version: 1\nroutes:\n  - {from: reviewer, to: executor, kinds: verdict, trigger: owner-ack, bounds: {accept_score: 9, max_rounds: 3}}\n  - {from: reviewer, to: orchestrator, kinds: verdict, bounds: {accept_score: 7, max_rounds: 2}}';
 const f=fixture(source);try{const rr=f.core({to:'reviewer',kind:'review-request',text:'review',thread:'T',sha:'a'.repeat(40)});let change=false;
 // Replace the loaded policy in the first route check: the second uses the same snapshot.
 const oldSnapshot=f.policy.snapshot();const check=oldSnapshot.checkSend.bind(oldSnapshot);
 const snapshot={...oldSnapshot,routeFor:oldSnapshot.routeFor.bind(oldSnapshot),allowedKinds:oldSnapshot.allowedKinds.bind(oldSnapshot),canObserve:oldSnapshot.canObserve.bind(oldSnapshot),summaryFor:oldSnapshot.summaryFor.bind(oldSnapshot),checkSend:(from:string,to:string,kind:string)=>{if(!change){change=true;f.reload('version: 8\nroutes: []');f.policy.load()}return check(from,to,kind)}};
 f.policy.snapshot=()=>snapshot as never;
 const rec=f.agent('reviewer',{to:['worker','orchestrator'],kind:'verdict',text:'8',score:8,round:2,reply_to:rr.seq,evidence:[f.report()]});assert.equal(rec.policy,1);assert.equal(rec.accepted,true);assert.deepEqual(rec.bounds,{accept_score:7,max_rounds:2});assert.equal(rec.ack,'pending');assert.deepEqual(f.journal.pendingFor('worker'),[]);assert.equal(f.policy.version,8)
 }finally{f.close()}
});

test('optional agent metadata cannot carry object/cycle payload through a non-verdict kind',()=>{
 const f=fixture();try{const cycle:Record<string,unknown>={};cycle.self=cycle;
 assert.throws(()=>f.agent('worker',{to:'orchestrator',kind:'note',text:'x',sha:cycle} as never),error('sha_unknown'));
 assert.throws(()=>f.agent('worker',{to:'orchestrator',kind:'note',text:'x',score:true} as never),error('score_invalid'));
 assert.throws(()=>f.agent('worker',{to:'orchestrator',kind:'note',text:'x',round:{}} as never),error('round_invalid'));assert.equal(f.journal.lastSeq,0)
 }finally{f.close()}
});
test('event listener failure cannot turn a durable successful post into a failed send; unsubscribe works',()=>{
 const f=fixture();try{const off=f.channel.on(()=>{throw Error('listener fault')});const rec=f.core({to:'worker',kind:'task',text:'durable'});off();
 assert.equal(f.journal.get(rec.seq)?.text,'durable');assert.equal(f.events.at(-1)?.type,'delivered');assert.equal(f.journal.pendingFor('worker')[0]?.record.seq,rec.seq)
 }finally{f.close()}
});

test('Channel refusal priority stays form, kind, recipients, verdict, target, evidence, policy',()=>{
 const f=fixture();try{
 assert.throws(()=>f.agent('reviewer',{to:[],kind:'ack',text:'x'} as never),error('to_invalid'));
 assert.throws(()=>f.agent('reviewer',{to:'unknown',kind:'ack',text:'x'} as never),error('kind_unknown'));
 assert.throws(()=>f.agent('reviewer',{to:'unknown',kind:'verdict',text:'x',score:true,round:1} as never),error('to_unknown'));
 assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'verdict',text:'x',score:true,round:1,reply_to:999} as never),error('score_invalid'));
 assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'verdict',text:'x',score:9,round:1,reply_to:999}),error('reply_to_missing'));
 const rr=f.request();f.deps.policy=null;assert.throws(()=>f.agent('reviewer',{to:'worker',kind:'verdict',text:'x',score:9,round:1,reply_to:rr.seq}),error('evidence_required'))
 }finally{f.close()}
});


for(const restart of [false,true])test('ack written but fsync failed resumes delivered exactly once'+(restart?' after restart':''),()=>{
 let armed=false,kind='';const f=fixture(ackPolicy,{fs:{appendFileSync:(...args:Parameters<typeof appendFileSync>)=>{kind=(JSON.parse(String(args[1]).trim()) as {kind:string}).kind;appendFileSync(...args)},fsyncSync:fd=>{fsyncSync(fd);if(armed&&kind==='ack'){armed=false;throw Error('ack fsync fault')}}}});
 try{
 const held=f.agent('tester',{to:'worker',kind:'report',text:'held'});f.events.length=0;armed=true;
 assert.throws(()=>f.channel.confirmAck(held.seq),error('write_failed'));assert.deepEqual(f.events,[]);
 assert.deepEqual(f.channel.pendingAcks().map(r=>r.seq),[held.seq]);
 const target=restart?reopen(f):{journal:f.journal,channel:f.channel};const events:ChannelEvent[]=restart?[]:f.events;
 if(restart)target.channel.on(e=>events.push(e));
 const ack=target.channel.confirmAck(held.seq);assert.equal(ack.kind,'ack');
 assert.deepEqual(events.filter(e=>e.type==='delivered').map(e=>[e.record.seq,e.deliverySeq]),[[held.seq,ack.seq]]);
 assert.equal(target.journal.read({kinds:['ack']}).length,1);assert.deepEqual(target.channel.pendingAcks(),[]);
 const count=events.length;target.channel.confirmAck(held.seq);assert.equal(events.length,count);
 const again=reopen(f),after:ChannelEvent[]=[];again.channel.on(e=>after.push(e));again.channel.confirmAck(held.seq);assert.deepEqual(after,[]);
 assert.deepEqual(again.journal.pendingFor('worker').map(e=>e.deliverySeq),[ack.seq]);
 }finally{f.close()}
});

for(const retry of ['reject','confirm'] as const)for(const restart of [false,true])for(const fault of ['before-note','note-fsync'] as const)
 test('rejected decision resumes missing notification: '+fault+', '+retry+(restart?', restart':''),()=>{
 let armed=false,kind='';const f=fixture(ackPolicy,{fs:{appendFileSync:(...args:Parameters<typeof appendFileSync>)=>{
 kind=(JSON.parse(String(args[1]).trim()) as {kind:string}).kind;
 if(armed&&kind==='note'&&fault==='before-note'){armed=false;throw Error('note append fault')}appendFileSync(...args)
 },fsyncSync:fd=>{fsyncSync(fd);if(armed&&kind==='note'&&fault==='note-fsync'){armed=false;throw Error('note fsync fault')}}}});
 try{
 const held=f.agent('tester',{to:'worker',kind:'report',text:'held'});f.events.length=0;armed=true;
 assert.throws(()=>f.channel.rejectAck(held.seq),error('write_failed'));
 assert.equal(f.events.filter(e=>e.type==='rejected').length,1);assert.equal(f.events.filter(e=>e.type==='delivered').length,0);
 assert.deepEqual(f.channel.pendingAcks().map(r=>r.seq),[held.seq]);
 const target=restart?reopen(f):{journal:f.journal,channel:f.channel},events:ChannelEvent[]=restart?[]:f.events;
 if(restart)target.channel.on(e=>events.push(e));
 const resolution=retry==='reject'?target.channel.rejectAck(held.seq):target.channel.confirmAck(held.seq);
 assert.equal(resolution.kind,'rejected');assert.equal(target.journal.read({kinds:['rejected']}).length,1);
 const notes=target.journal.read({kinds:['note']}).filter(r=>r.origin==='ack');assert.equal(notes.length,1);const note=notes[0]!;
 assert.equal(note.reply_to,held.seq);assert.deepEqual(note.to,['tester']);assert.equal(note.text,'Запись #'+held.seq+' (report) владелец не подтвердил, она не доставлена.');
 assert.deepEqual(events.filter(e=>e.type==='delivered').map(e=>e.record.seq),[note.seq]);
 assert.equal(events.filter(e=>e.type==='rejected').length,restart?0:1);assert.deepEqual(target.channel.pendingAcks(),[]);
 assert.throws(()=>target.channel.rejectAck(held.seq),error('ack_closed'));assert.throws(()=>target.channel.confirmAck(held.seq),error('ack_closed'));
 const again=reopen(f);assert.deepEqual(again.channel.pendingAcks(),[]);assert.throws(()=>again.channel.confirmAck(held.seq),error('ack_closed'));
 assert.equal(again.journal.pendingFor('worker').some(e=>e.record.seq===held.seq),false);assert.equal(again.journal.pendingFor('tester').filter(e=>e.record.seq===note.seq).length,1);
 }finally{f.close()}
});

test('ack event receipt failure cannot publish delivered twice on retry or after repaired restart',()=>{
 let armed=false,receiptFd=-1;const f=fixture(ackPolicy,{fs:{openSync:(...args:Parameters<typeof openSync>)=>{const fd=openSync(...args);if(String(args[0]).endsWith('ack-events.json.tmp'))receiptFd=fd;return fd},fsyncSync:fd=>{fsyncSync(fd);if(armed&&fd===receiptFd){armed=false;throw Error('receipt fsync fault')}}}});
 try{
 const held=f.agent('tester',{to:'worker',kind:'report',text:'held'});f.events.length=0;armed=true;
 assert.throws(()=>f.channel.confirmAck(held.seq),error('write_failed'));assert.equal(f.events.filter(e=>e.type==='delivered').length,1);
 const ack=f.channel.confirmAck(held.seq);assert.equal(f.events.filter(e=>e.type==='delivered').length,1);
 const again=reopen(f),events:ChannelEvent[]=[];again.channel.on(e=>events.push(e));assert.equal(again.channel.confirmAck(held.seq).seq,ack.seq);assert.deepEqual(events,[]);
 }finally{f.close()}
});

for(const outcome of ['handled','rejected'] as const)test('steer '+outcome+' is absent from every pending queue/counter across restart; ordinary tasks remain',()=>{
 const f=fixture();try{
 const steer=f.core({to:'worker',kind:'task',text:'owner interruption',origin:'steer'});
 f.journal.append({sender:outcome==='handled'?'worker':'harness',to:['owner'],kind:outcome==='handled'?'status':'rejected',text:outcome,reply_to:steer.seq,origin:'steer'});
 for(const seat of [...f.deps.liveSeats(),'owner'])assert.equal(f.journal.pendingFor(seat).length,0);
 assert.equal(f.journal.cursors.worker??0,0);assert.equal(reopen(f).journal.pendingFor('worker').length,0);
 const ordinary=f.core({to:'worker',kind:'task',text:'ordinary'});
 f.core({to:'*',kind:'note',text:'out-of-queue',origin:'steer'});
 assert.deepEqual(f.journal.pendingFor('worker').map(e=>e.record.seq),[ordinary.seq]);
 const again=reopen(f);assert.deepEqual(again.journal.pendingFor('worker').map(e=>e.record.seq),[ordinary.seq]);assert.equal(again.journal.cursors.worker??0,0);
 again.journal.advance('worker',ordinary.seq);assert.equal(reopen(f).journal.pendingFor('worker').length,0);
 f.journal.append({sender:'owner',to:['worker'],kind:'note',text:'steer cannot make owner card',origin:'steer',ack:'pending'});assert.deepEqual(f.channel.pendingAcks(),[]);
 }finally{f.close()}
});

for(const restart of [false,true])for(const fault of ['receipt','before-escalation','escalation-fsync'] as const)
test('verdict confirmation resumes durable effects without new deliverySeq: '+fault+(restart?', restart':''),()=>{
 let armed=false,kind='',receiptFd=-1;
 const f=fixture(verdictAckPolicy,{fs:{
 openSync:(...args:Parameters<typeof openSync>)=>{const fd=openSync(...args);if(String(args[0]).endsWith('ack-events.json.tmp'))receiptFd=fd;return fd},
 appendFileSync:(...args:Parameters<typeof appendFileSync>)=>{kind=(JSON.parse(String(args[1]).trim()) as {kind:string}).kind;if(armed&&fault==='before-escalation'&&kind==='escalation'){armed=false;throw Error('escalation append fault')}appendFileSync(...args)},
 fsyncSync:fd=>{fsyncSync(fd);if(armed&&(fault==='receipt'&&fd===receiptFd||fault==='escalation-fsync'&&kind==='escalation')){armed=false;throw Error(fault+' fault')}}
 }});
 try{
 const request=f.request(),verdict=f.agent('reviewer',{to:'worker',kind:'verdict',text:'3/10',reply_to:request.seq,score:3,round:3,evidence:[f.report()]});
 armed=true;assert.throws(()=>f.channel.confirmAck(verdict.seq),error('write_failed'));assert.equal(armed,false);
 const ack=f.journal.read({kinds:['ack']})[0]!,before=f.journal.read({kinds:['status','escalation']}).filter(r=>r.origin==='verdict');
 assert.deepEqual(before.map(r=>r.kind),fault==='before-escalation'?['status']:['status','escalation']);
 assert.ok(before.every(r=>r.reply_to===verdict.seq&&r.thread===verdict.thread));
 if(fault!=='receipt'){assert.equal(f.journal.ackEventRecorded(ack,'confirmed'),false);assert.deepEqual(f.channel.pendingAcks().map(r=>r.seq),[verdict.seq])}
 const last=f.journal.lastSeq;f.journal.advance('orchestrator',last);f.journal.advance('owner',last);
 const target=restart?reopen(f):{journal:f.journal,channel:f.channel},events:ChannelEvent[]=[];target.channel.on(e=>events.push(e));
 assert.equal(target.channel.confirmAck(verdict.seq).seq,ack.seq);
 const after=target.journal.read({kinds:['status','escalation']}).filter(r=>r.origin==='verdict');
 assert.deepEqual(after.map(r=>r.kind),['status','escalation']);assert.equal(after[0]!.seq,before[0]!.seq);
 if(before[1])assert.equal(after[1]!.seq,before[1].seq);
 assert.ok(after.every(r=>r.reply_to===verdict.seq&&r.thread===verdict.thread));
 const expected=fault==='before-escalation'?[after[1]!.seq]:[];
 assert.deepEqual(target.journal.pendingFor('orchestrator').map(e=>e.deliverySeq),expected);
 assert.deepEqual(target.journal.pendingFor('owner').map(e=>e.deliverySeq),expected);
 if(fault!=='receipt')assert.equal(events.filter(e=>e.type==='delivered'&&e.record.kind==='escalation').length,1);
 assert.equal(target.journal.ackEventRecorded(ack,'confirmed'),true);assert.deepEqual(target.channel.pendingAcks(),[]);
 const seq=target.journal.lastSeq,count=events.length;target.channel.confirmAck(verdict.seq);assert.equal(target.journal.lastSeq,seq);assert.equal(events.length,count);
 const again=reopen(f);again.channel.confirmAck(verdict.seq);assert.equal(again.journal.lastSeq,seq);assert.deepEqual(again.channel.pendingAcks(),[]);
 assert.deepEqual(again.journal.pendingFor('orchestrator').map(e=>e.deliverySeq),expected);
 assert.deepEqual(again.journal.pendingFor('owner').map(e=>e.deliverySeq),expected);
 }finally{f.close()}
});


test('58: internal agent effects preserve identity/policy/ack while ordinary send cannot forge origin',()=>{
 const f=fixture(ackPolicy);try{
 const ask=f.channel.postAgentEffect({to:'architect',kind:'question',text:'вопрос'},{seat:'worker',trust:'agent'},'ask');assert.equal(ask.from,'worker');assert.equal(ask.origin,'ask');
 const auto=f.channel.postAgentEffect({to:'worker',kind:'answer',text:'ответ',reply_to:ask.seq},{seat:'architect',trust:'agent'},'auto');assert.equal(auto.from,'architect');assert.equal(auto.origin,'auto');
 const pending=f.channel.postAgentEffect({to:'worker',kind:'answer',text:'ждёт'},{seat:'tester',trust:'agent'},'auto');assert.equal(pending.ack,'pending');
 assert.throws(()=>f.channel.postAgentEffect({to:'worker',kind:'task',text:'нельзя'},{seat:'reviewer',trust:'agent'},'auto'),error('policy_denied'));
 assert.throws(()=>f.agent('worker',{to:'architect',kind:'question',text:'подделка',origin:'ask'} as never),error('initiator_invalid'));
 assert.throws(()=>f.channel.postAgentEffect({to:'worker',kind:'note',text:'подделка'},{seat:'harness',trust:'agent'},'auto'),error('initiator_invalid'));
 assert.throws(()=>f.channel.postAgentEffect({to:'worker',kind:'note',text:'подделка'},{seat:'tester',trust:'agent'},'merge' as never),error('initiator_invalid'));
 }finally{f.close()}
});

test('59: rejection of a removed sender completes without an undeliverable note',()=>{
 const f=fixture(ackPolicy);try{const r=f.agent('tester',{to:'worker',kind:'report',text:'ждёт'});delete f.roles.tester;const rejected=f.channel.rejectAck(r.seq);assert.equal(rejected.kind,'rejected');assert.equal(f.channel.pendingAcks().length,0);assert.equal(f.journal.repliesTo(r.seq).filter(r=>r.origin==='ack').length,0);assert.throws(()=>f.channel.rejectAck(r.seq),error('ack_closed'))}finally{f.close()}
});


test('R2/2: internal auto denial links rejection to source and seat; ordinary send cannot forge it',()=>{
 const f=fixture('version: 1\nroutes: [{from: "*", to: "*", kinds: [question]}]\nobserve: {}\n');try{
 const q=f.agent('assistant',{to:'worker',kind:'question',text:'вопрос',thread:'Q'});
 assert.throws(()=>f.channel.postAgentEffect({to:'assistant',kind:'answer',text:'ответ',reply_to:q.seq},{seat:'worker',trust:'agent'},'auto'),error('policy_denied'));
 const rejected=f.journal.repliesTo(q.seq)[0]!;assert.equal(rejected.from,'harness');assert.equal(rejected.kind,'rejected');assert.equal(rejected.origin,'auto:worker');assert.equal(rejected.thread,'Q');
 const seq=f.journal.lastSeq;assert.throws(()=>f.agent('worker',{to:'assistant',kind:'answer',text:'подделка',reply_to:q.seq,origin:'auto:worker'} as never),error('initiator_invalid'));assert.equal(f.journal.lastSeq,seq);
 }finally{f.close()}
});
