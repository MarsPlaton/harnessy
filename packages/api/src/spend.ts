import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseCompat} from '@harnessy/journal';
import {priceUsage,type ModelPrice} from '@harnessy/projects';
import {providerId} from '@harnessy/providers';
import {RuntimeError,type Runtime} from '@harnessy/runtime';
import {text} from './responses.ts';

type Outcome='ok'|'interrupted'|'error'|'unknown';
type Period='7'|'30'|'90'|'all';
type Row=Record<string,unknown>;
type Vendor=string|null;
const knownVendor=(r:Runtime,v:unknown):v is string=>providerId(v)&&(v==='claude'||v==='codex'||v.startsWith('api:')||r.providerOperations.catalog.ids().includes(v));
interface Candidate {message:Row;pane:string;chat:string;title:string}
interface Turn {turnInstanceId:string;pane:string;chat:string;title:string;ts:number|null;vendor:Vendor;model:string|null;usage:{input:number|null;output:number|null;cacheRead:number|null};durationMs:number|null;outcome:Outcome;usageIncomplete?:true;cost:number|null;currency:string|null;costReason:string|null}
function object(value:unknown):value is Row {return !!value&&typeof value==='object'&&!Array.isArray(value)}
const number=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const measured=(value:unknown)=>number(value)?value:null;
const pair=(vendor:string|null,model:string|null)=>JSON.stringify([vendor,model]);
const fail=(reason:string):never=>{throw new RuntimeError('spend_unreadable','chats.json не читается: '+reason,409)};
function price(turn:Omit<Turn,'cost'|'currency'|'costReason'>,prices:Map<string,ModelPrice>){
 return priceUsage(turn,prices.get(pair(turn.vendor,turn.model)));
}
// Both public views use this immutable disk snapshot, never the mutable current pane's model/vendor.
async function readSpend(runtime:Runtime,query:URLSearchParams){
 const raw=query.get('period')??'all';if(query.getAll('period').length>1||!['7','30','90','all'].includes(raw))throw new RuntimeError('period_invalid','period: ожидается 7, 30, 90 или all',400);
 const period=raw as Period,p=runtime.project,now=runtime.clock.now(),since=period==='all'?null:(now-Number(period)*86_400_000)/1000;
 const prices=new Map(runtime.settings.priceList().map(entry=>[pair(entry.vendor,entry.model),entry]));
 let data:unknown;
 // Windows readers can hold chats.json open across an await and prevent atomic rename by the turn writer.
 try{const path=join(p.dir,'.harness','state','chats.json'),bytes=process.platform==='win32'?readFileSync(path):await readFile(path);data=parseCompat(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')data={chats:{}};else return fail(text(error))}
 if(p.closed||runtime.project!==p)throw new RuntimeError('project_changed','проект сменился',409);
 if(!object(data)||!object(data.chats))return fail('неверная форма');
 const local=new Map<string,Candidate>();let transferred=0,unknownOrigin=0,undated=0;
 const inPeriod=(message:Row)=>{const ts=message.ts;if(!number(ts)||ts===0){undated++;return period==='all'}return ts<=now/1000&&(since===null||ts>=since)};
 for(const [id,value] of Object.entries(data.chats)){
  if(!object(value)||typeof value.pane!=='string'||!Array.isArray(value.transcript)||value.turns!==undefined&&!Array.isArray(value.turns))return fail('неверная форма чата '+id);
  const pane=value.pane,title=typeof value.title==='string'?value.title:'';
  for(const rawMessage of value.transcript){
   if(!object(rawMessage)||typeof rawMessage.role!=='string'||typeof rawMessage.text!=='string')return fail('неверная форма реплики '+id);
   if(rawMessage.role!=='ai')continue;
   const rt=object(rawMessage.runtime)?rawMessage.runtime:null;
   if(rawMessage.origin!=='transferred'&&rt&&typeof rt.turnInstanceId==='string'&&rt.turnInstanceId&&Number.isSafeInteger(rawMessage.deliverySeq)&&Number(rawMessage.deliverySeq)>=0)local.set(rt.turnInstanceId,{message:rawMessage,pane,chat:id,title});
   else if(inPeriod(rawMessage)){if(rawMessage.origin==='transferred')transferred++;else unknownOrigin++}
  }
  for(const turn of value.turns??[]){
   if(!object(turn)||typeof turn.turnInstanceId!=='string'||!turn.turnInstanceId||turn.outcome!=='error'||typeof turn.errorCode!=='string'||!turn.errorCode||!number(turn.ts)||typeof turn.model!=='string')return fail('неверная форма хода '+id);
   if(!local.has(turn.turnInstanceId))local.set(turn.turnInstanceId,{message:turn,pane,chat:id,title});
  }
 }
 const turns:Turn[]=[];
 for(const [turnInstanceId,{message,pane,chat,title}] of local){
  if(!inPeriod(message))continue;const u=object(message.usage)?message.usage:{};
  const row:Omit<Turn,'cost'|'currency'|'costReason'>={turnInstanceId,pane,chat,title,ts:number(message.ts)&&message.ts>0?message.ts:null,
   vendor:knownVendor(runtime,message.vendor)?message.vendor:null,model:typeof message.model==='string'&&message.model?message.model:null,
   ...(message.usageIncomplete===true?{usageIncomplete:true as const}:{}),usage:{input:measured(u.input),output:measured(u.output),cacheRead:measured(u.cacheRead)},durationMs:measured(message.durationMs),
   outcome:message.outcome==='ok'||message.outcome==='interrupted'||message.outcome==='error'?message.outcome:'unknown'};
  turns.push({...row,...price(row,prices)});
 }
 return {meta:{ok:true,project:p.dir,period,since,generatedAt:now/1000,source:'chats.json',timeZone:'UTC',errorRateUnit:'ratio',pricingSource:'owner.priceList',pricingBasis:'current',pricingLabel:'Стоимость по текущему прайс-листу владельца'},turns,transferred,unknownOrigin,undated,labels:new Map([...p.registry.panes.values()].map(p=>[p.id,p.label]))};
}
function sum(a:number,b:number){const value=a+b;return Number.isFinite(value)?value:fail('сумма измерений вне числового диапазона')}
function metrics(rows:Turn[]){
 const durations:number[]=[],outcomes={ok:0,interrupted:0,error:0,unknown:0},costs=new Map<string,number>(),reasons=new Map<string,number>();
 let input=0,output=0,cacheRead=0,durationMs=0,missingMeasurements=0,pricedTurns=0;
 for(const row of rows){
  outcomes[row.outcome]++;input=sum(input,row.usage.input??0);output=sum(output,row.usage.output??0);cacheRead=sum(cacheRead,row.usage.cacheRead??0);
  if(row.durationMs!==null){durations.push(row.durationMs);durationMs=sum(durationMs,row.durationMs)}
  if(row.usageIncomplete||row.durationMs===null||Object.values(row.usage).some(v=>v===null))missingMeasurements++;
  if(row.cost!==null&&row.currency!==null){pricedTurns++;costs.set(row.currency,sum(costs.get(row.currency)??0,row.cost))}
  else if(row.costReason)reasons.set(row.costReason,(reasons.get(row.costReason)??0)+1);
 }
 durations.sort((a,b)=>a-b);const percentile=(p:number)=>durations.length?durations[Math.ceil(durations.length*p)-1]!:null;
 const costByCurrency=[...costs].sort(([a],[b])=>compare(a,b)).map(([currency,cost])=>({currency,cost})),known=rows.length-outcomes.unknown;
 const costReasons=[...reasons].map(([reason,n])=>reason+': '+n);if(costs.size>1)costReasons.push('разные валюты — итоги раздельно');
 return {turns:rows.length,input,output,cacheRead,durationMs,averageDurationMs:durations.length?durationMs/durations.length:null,durationSamples:durations.length,
  p50DurationMs:percentile(.5),p95DurationMs:percentile(.95),outcomes,errorRate:known?outcomes.error/known:null,missingMeasurements,
  cost:costByCurrency.length===1?costByCurrency[0]!.cost:null,currency:costByCurrency.length===1?costByCurrency[0]!.currency:null,
  pricedTurns,unpricedTurns:rows.length-pricedTurns,costReason:costReasons.join('; ')||null,costByCurrency};
}
function groups<T extends object>(rows:Turn[],key:(row:Turn)=>string,label:(row:Turn)=>T){
 const buckets=new Map<string,{label:T;rows:Turn[]}>();for(const row of rows){const id=key(row);let bucket=buckets.get(id);if(!bucket){bucket={label:label(row),rows:[]};buckets.set(id,bucket)}bucket.rows.push(row)}
 return [...buckets.values()].map(({label,rows})=>({...label,...metrics(rows)}));
}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
function day(ts:number){const date=new Date(ts*1000);if(!Number.isFinite(date.getTime()))return fail('дата вне диапазона');return date.toISOString().slice(0,10)}
export async function spend(runtime:Runtime,query:URLSearchParams){
 const {meta,turns,transferred,unknownOrigin,undated,labels}=await readSpend(runtime,query),totals=metrics(turns);
 const days=new Map<string,Turn[]>();if(meta.since!==null){for(let d=Math.floor(meta.since/86400);d<=Math.floor(meta.generatedAt/86400);d++)days.set(day(d*86400),[])}
 for(const row of turns)if(row.ts!==null){const key=day(row.ts);if(!days.has(key))days.set(key,[]);days.get(key)!.push(row)}
 return {...meta,totals,
  byPane:groups(turns,r=>r.pane,r=>({pane:r.pane,label:labels.get(r.pane)??r.pane})),byChat:groups(turns,r=>r.chat,r=>({chat:r.chat,pane:r.pane,title:r.title})),
  byModel:groups(turns,r=>JSON.stringify(r.model),r=>({model:r.model})),byVendor:groups(turns,r=>JSON.stringify(r.vendor),r=>({vendor:r.vendor})),
  byModelVendor:groups(turns,r=>pair(r.vendor,r.model),r=>({model:r.model,vendor:r.vendor})),byDay:[...days].sort(([a],[b])=>compare(a,b)).map(([day,rows])=>({day,...metrics(rows)})),
  transferred,unknownOrigin,undated,cost:totals.cost,currency:totals.currency,pricedTurns:totals.pricedTurns,unpricedTurns:totals.unpricedTurns,costReason:totals.costReason,costByCurrency:totals.costByCurrency};
}
type Cursor=[number|null,string];
const cursor=(row:Turn):Cursor=>[row.ts,row.turnInstanceId];
const compareCursor=(a:Cursor,b:Cursor)=>(a[0]??0)-(b[0]??0)||compare(a[1],b[1]);
const encode=(value:Cursor)=>Buffer.from(JSON.stringify(value)).toString('base64url');
export async function spendTurns(runtime:Runtime,query:URLSearchParams){
 const invalid=(key:string,reason:string):never=>{throw new RuntimeError(key+'_invalid',key+': '+reason,400)};
 for(const key of ['vendor','model','before','limit'])if(query.getAll(key).length>1)invalid(key,'повтор параметра');
 const vendor=query.get('vendor'),model=query.get('model'),rawLimit=query.get('limit')??'50',limit=Number(rawLimit),before=query.get('before');
 if(vendor!==null&&vendor!=='null'&&!knownVendor(runtime,vendor))invalid('vendor','ожидается id программы или null');
 if(model!==null&&!model.trim())invalid('model','ожидается непустая модель или null');
 if(!/^\d+$/.test(rawLimit)||!Number.isSafeInteger(limit)||limit<1||limit>200)invalid('limit','ожидается целое число от 1 до 200');
 let boundary:Cursor|null=null;
 if(before!==null){try{const v:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(before,'base64url')));if(!Array.isArray(v)||v.length!==2||!(v[0]===null||number(v[0])&&v[0]>0)||typeof v[1]!=='string'||!v[1]||encode(v as Cursor)!==before)throw Error();boundary=v as Cursor}catch{invalid('before','ожидается курсор ts/turnInstanceId')}}
 const {meta,turns}=await readSpend(runtime,query);
 const filtered=turns.filter(row=>(vendor===null||row.vendor===(vendor==='null'?null:vendor))&&(model===null||row.model===(model==='null'?null:model))&&(!boundary||compareCursor(cursor(row),boundary)<0)).sort((a,b)=>compareCursor(cursor(b),cursor(a)));
 const page=filtered.slice(0,limit);
 return {...meta,items:page.map(({title:_,costReason:__,...row})=>row),next:filtered.length>limit?encode(cursor(page.at(-1)!)):null};
}
