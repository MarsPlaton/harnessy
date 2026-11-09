import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {memorySections,onboarding,roleNote,handoffPrompt,transcriptText,digest,estTokens,contextWindow,contextCard,DIGEST_MARK,type SeatView,type RoleNoteDeps,type OnboardingDeps,type TranscriptMessage,type DigestViewer,type DigestPane,type CardPane,type CardDeps} from './index.ts';
import {pythonRound} from './tokens.ts';
interface Golden {
 memory:{text:string;expected:[string,string][]}[];
 roleNotes:{name:string;seat:SeatView;deps:RoleNoteDeps;expected:string}[];
 onboarding:{name:string;seat:SeatView;how:string;deps:Omit<OnboardingDeps,'now'>&{now:string};expected:string}[];
 transcripts:{transcript:TranscriptMessage[];limit:number;expected:string}[];
 digests:{name:string;viewer:DigestViewer;others:DigestPane[];allowed:string[];expected:{text:string;nextSeen:Record<string,number>}}[];
 cards:{name:string;pane:CardPane;deps:CardDeps;expected:unknown}[];
 rounds:{value:number;digits:number;expected:number}[]
}
const golden=JSON.parse(readFileSync(new URL('./fixtures/python.json',import.meta.url),'utf8')) as Golden;
function freeze<T>(value:T):T {if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value)}return value}
for(const [i,c] of golden.memory.entries())test('[39] Python memory sections '+i+': placeholders, duplicate headings, order and Unicode',()=>{assert.deepEqual([...memorySections(c.text)],c.expected)});
for(const c of golden.roleNotes)test('[39] Python roleNote '+c.name,()=>{const note=roleNote(freeze(c.seat),freeze(c.deps));/* 156 adds the team-tool instructions to the orchestrator; historical fixture bytes stay unchanged. */assert.equal(note.replace(/ Команду создавай через propose_seats:.*$/,''),c.expected)});
for(const c of golden.onboarding)test('[18,39,45] Python onboarding '+c.name,()=>{const deps={...c.deps,now:new Date(c.deps.now)};/* 231 adds the artifact contract; the Python baseline is immutable. */const expected=c.expected.replace('Твоя модель:', 'Артефакты клади в artifacts/ проекта и ссылайся на них относительным путём; таблицы — Markdown.\n\nТвоя модель:').replaceAll(c.deps.projectDir+'/.harness/MEMORY.md',join(c.deps.projectDir,'.harness','MEMORY.md')).replaceAll(c.deps.projectDir+'/.harness/state/channel.ndjson',join(c.deps.projectDir,'.harness','state','channel.ndjson'));assert.equal(onboarding(freeze(c.seat),c.how,freeze(deps)),expected)});
for(const [i,c] of golden.transcripts.entries())test('[39,46] Python transcript '+i+' with empty result skipped',()=>{assert.equal(transcriptText(freeze(c.transcript),c.limit),c.expected)});
for(const c of golden.digests)test('[29,39,46] Python digest '+c.name+' returns unconsumed nextSeen',()=>{const before=structuredClone(c.viewer);assert.deepEqual(digest(freeze(c.viewer),freeze(c.others),(_,target)=>c.allowed.includes(target)),c.expected);assert.deepEqual(c.viewer,before)});
for(const c of golden.cards)test('[21,39] Python contextCard '+c.name,()=>{
 const baseline=c.expected as {parts:{key:string;label:string;tokens:number|null;est:boolean;count?:number;residual?:boolean}[]};
 // TS-51.D: a table-derived free value is an estimate; unknown free is explicit.
 const parts=baseline.parts.map(part=>part.key==='free'?{...part,est:true}:part);
 if(contextWindow(c.pane.model)===null)parts.push({key:'free',label:'свободно',tokens:null,est:false});
 assert.deepEqual(contextCard(freeze(c.pane),freeze(c.deps)),{...baseline,parts})
});
for(const c of golden.rounds)test('[21,39] Python rounding '+c.value+'/'+c.digits,()=>{assert.equal(pythonRound(c.value,c.digits),c.expected)});

test('[21] model windows and estimate match test_context, including code points and unknown models',()=>{
 for(const [model,size] of [['claude-haiku-4-5-20251001',200000],['gpt-5.3-codex-spark',128000],['gpt-6-astra',400000],['qwen3-coder:cloud',128000],['GLM-test',128000],['prefix/kimi-test',256000],['deepseek-test',128000],['mystery-model',null],['',null]] as const)assert.equal(contextWindow(model),size);
 assert.equal(estTokens(''),0);assert.equal(estTokens('а'.repeat(32)),11);assert.equal(estTokens('😀'.repeat(32)),11)
});
test('TS-51.D: empty and invalid provider counters do not fabricate a measured zero',()=>{
 const fixture=golden.cards.find(c=>c.name==='measured')!;
 for(const tokens of [null,{}, {input:null,output:null,cacheRead:null},{input:NaN,output:Infinity,cacheRead:-1},{input:'17' as unknown as number}]){
  const card=contextCard({...fixture.pane,tokens},fixture.deps);
  assert.equal(card.measured,false);assert.equal(card.last,null);assert.equal(card.cache,null);assert.equal(card.parts.some(part=>part.key==='system'),false);
  assert.equal(card.used,card.parts.filter(part=>part.key!=='free').reduce((n,part)=>n+(part.tokens??0),0));
 }
});
test('TS-51.D: partial counters preserve nulls and do not claim a measured total',()=>{
 const fixture=golden.cards.find(c=>c.name==='measured')!;
 for(const [tokens,last,cache] of [
  [{input:0},{input:0,output:null,cacheRead:null},{hitPct:null,cached:null,new:0}],
  [{input:120,cacheRead:40},{input:120,output:null,cacheRead:40},{hitPct:25,cached:40,new:120}],
  [{output:5},{input:null,output:5,cacheRead:null},null]
 ] as const){const card=contextCard({...fixture.pane,tokens},fixture.deps);assert.equal(card.measured,false);assert.deepEqual(card.last,last);assert.deepEqual(card.cache,cache);assert.equal(card.parts.some(part=>part.key==='system'),false);assert.equal(card.parts.find(part=>part.key==='free')?.est,true)}
});
test('TS-51.D: complete zero is measured; unknown window and estimated residual remain honest',()=>{
 const fixture=golden.cards.find(c=>c.name==='measured')!,zero=contextCard({...fixture.pane,tokens:{input:0,output:0,cacheRead:0}},fixture.deps);
 assert.equal(zero.measured,true);assert.equal(zero.used,0);assert.equal(zero.pct,0);assert.deepEqual(zero.last,{input:0,output:0,cacheRead:0});assert.deepEqual(zero.cache,{hitPct:null,cached:0,new:0});assert.equal(zero.parts.find(part=>part.key==='system')?.est,true);assert.equal(zero.parts.find(part=>part.key==='system')?.residual,true);
 const unknown=contextCard({...fixture.pane,model:'unknown-model',tokens:{input:10,output:5,cacheRead:2}},fixture.deps);
 assert.equal(unknown.window,null);assert.equal(unknown.pct,null);assert.equal(unknown.parts.find(part=>part.key==='free')?.tokens,null);assert.equal(unknown.parts.find(part=>part.key==='free')?.est,false);assert.equal(unknown.parts.find(part=>part.key==='system')?.est,true);assert.equal(unknown.parts.find(part=>part.key==='system')?.residual,true);
});
test('[39] handoff prompt retains the source label and room phrase',()=>{
 assert.equal(handoffPrompt({id:'room',label:'другое имя'}),'Прочитай контекст чата от разговора без роли и жди команду.');assert.equal(handoffPrompt({id:'reviewer',label:'Юрист'}),'Прочитай контекст чата от Юрист и жди команду.')
});
test('[29,39] denied digest never reads a forbidden transcript and disabled digest never observes',()=>{
 const hidden:DigestPane={id:'hidden',label:'hidden',vendor:'codex',model:'gpt',mode:'ask',get transcript():readonly TranscriptMessage[]{throw Error('forbidden transcript')}};
 assert.deepEqual(digest({id:'me',digest:true,seen:{}},[hidden],()=>false),{text:'',nextSeen:{}});
 assert.deepEqual(digest({id:'me',digest:false,seen:{hidden:1}},[hidden],()=>{throw Error('must not observe')}),{text:'',nextSeen:{hidden:1}})
});
test('[39] digest preserves the historical block budget rather than clipping the entire result',()=>{
 const c=golden.digests.find(c=>c.name==='limit')!,r=digest(c.viewer,c.others,()=>true);assert.equal(r.text,c.expected.text);assert.ok([...r.text].length>6000);assert.ok(r.text.startsWith(DIGEST_MARK));assert.equal(r.nextSeen.a,9);assert.equal(r.nextSeen.b,undefined)
});

test('156: proposal instructions follow kind, with legacy role fallback; another kind gains no team authority',()=>{
 const fixture=golden.roleNotes.find(x=>x.seat.role==='orchestrator')!;
 for(const seat of [{...fixture.seat,kind:'orchestrator' as const,role:'юрист'},{...fixture.seat}]){const note=roleNote(seat,fixture.deps);assert.match(note,/propose_seats: явно укажи kind, label, vendor, model, mode/);assert.match(note,/после подтверждения этой версии владельцем в окне вызывай create_seats/)}
 assert.doesNotMatch(roleNote({...fixture.seat,kind:'worker',role:'orchestrator'},fixture.deps),/propose_seats|create_seats/);
});
