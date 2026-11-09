import {createHash} from 'node:crypto';
import {closeSync,constants,existsSync,fsyncSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,statSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {assertPrivateFile,canonicalPath,hardenPrivateDirectory,withPathLock} from '@harnessy/team';
import {RuntimeError} from './errors.ts';

export type AutopilotDecisionStage='intent'|'applied'|'failed'|'uncertain'|'cancelled'|'partial'|'irreversible';
export type AutopilotCancellationState='intent'|'cancelled'|'partial'|'irreversible';
export interface AutopilotCancellation {
 state:AutopilotCancellationState;effectVersion:string;
 code?:string;reason?:string;nextStep?:string;result?:Record<string,unknown>;
}
export interface AutopilotDecisionParty {seat:string;model:string;role:'orchestrator'|'reviewer'}
export interface AutopilotDecisionQuestion {id:string;kind:string;text:string}
export interface AutopilotDecisionCost {currency:'USD';amount:number|null;status:'measured'|'unavailable'}
export interface AutopilotDecisionBase {
 decisionId:string;issueHash:string;proposalHash:string;generation:number;operation:string;
 capability:Record<string,unknown>;proposal:Record<string,unknown>;round:1|2;
 question:AutopilotDecisionQuestion;council:{orchestrator:AutopilotDecisionParty;reviewer:AutopilotDecisionParty};
}
export type AutopilotDecisionEntry=AutopilotDecisionBase&(
 |{state:'intent';cost:AutopilotDecisionCost}
 |{state:'applied';cost:AutopilotDecisionCost;receipt:{result:Record<string,unknown>;effectVersion:string}}
 |{state:'failed'|'uncertain';cost:AutopilotDecisionCost;code:string;reason:string}
);
export interface AutopilotDecisionRecord {version:1;project:string;at:string;entry:AutopilotDecisionEntry;cancellation?:AutopilotCancellation}
interface CancellationRecord {version:2;project:string;at:string;decisionId:string;cancellation:AutopilotCancellation}
interface DiskLine {prev:string;hash:string;record:AutopilotDecisionRecord|CancellationRecord}
const HASH=/^[0-9a-f]{64}$/;
const ZERO='0'.repeat(64);
const isObject=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(message:string):never=>{throw new RuntimeError('decision_invalid',message,409)};
const canonical=(v:unknown):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v as object).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
export const autopilotDecisionHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const autopilotDecisionId=(project:string,question:AutopilotDecisionQuestion,proposal:Record<string,unknown>,generation:number)=>autopilotDecisionHash({project,question,proposal,generation});
const stable=(entry:AutopilotDecisionEntry)=>({decisionId:entry.decisionId,issueHash:entry.issueHash,proposalHash:entry.proposalHash,generation:entry.generation,operation:entry.operation,capability:entry.capability,proposal:entry.proposal,round:entry.round,question:entry.question,council:entry.council});
function checked(entry:unknown,project:string):AutopilotDecisionEntry {
 if(!isObject(entry)||!HASH.test(String(entry.decisionId))||!HASH.test(String(entry.issueHash))||!HASH.test(String(entry.proposalHash))||!Number.isSafeInteger(entry.generation)||Number(entry.generation)<1||typeof entry.operation!=='string'||!entry.operation||!isObject(entry.capability)||!isObject(entry.proposal)||![1,2].includes(Number(entry.round))||!isObject(entry.question)||typeof entry.question.id!=='string'||!entry.question.id||typeof entry.question.kind!=='string'||typeof entry.question.text!=='string'||!isObject(entry.council)||!isObject(entry.council.orchestrator)||!isObject(entry.council.reviewer)||!isObject(entry.cost))return fail('Запись решения Автопилота повреждена');
 const question=entry.question as unknown as AutopilotDecisionQuestion,council=entry.council as unknown as AutopilotDecisionBase['council'];
 if(typeof entry.capability.id!=='string'||!HASH.test(entry.capability.id)||entry.capability.operation!==entry.operation||!isObject(entry.capability.parameters)||autopilotDecisionHash({operation:entry.operation,parameters:entry.capability.parameters})!==entry.capability.id||entry.proposal.requestHash!==entry.issueHash||entry.proposal.capability!==entry.capability.id||typeof entry.proposal.reason!=='string'||entry.proposal.answer!==null&&typeof entry.proposal.answer!=='string')return fail('Полномочие и предложение решения не совпадают');
 for(const [role,p] of Object.entries(council))if((role!=='orchestrator'&&role!=='reviewer')||!isObject(p)||p.role!==role||typeof p.seat!=='string'||!p.seat||typeof p.model!=='string'||!p.model)return fail('Состав консилиума не подтверждён');
 if(council.orchestrator.seat===council.reviewer.seat)return fail('Оркестратор и ревьюер должны быть разными местами');
 const cost=entry.cost;if(cost.currency!=='USD'||!['measured','unavailable'].includes(String(cost.status))||cost.status==='measured'&&!(typeof cost.amount==='number'&&Number.isFinite(cost.amount)&&cost.amount>=0)||cost.status==='unavailable'&&cost.amount!==null)return fail('Стоимость консилиума повреждена');
 if(autopilotDecisionId(project,question,entry.proposal,Number(entry.generation))!==entry.decisionId||autopilotDecisionHash(entry.proposal)!==entry.proposalHash)return fail('Идентификатор решения не связан с вопросом и предложением');
 if(!['intent','applied','failed','uncertain'].includes(String(entry.state)))return fail('Этап решения неизвестен');
 if(entry.state==='applied'&&(!isObject(entry.receipt)||!isObject(entry.receipt.result)||typeof entry.receipt.effectVersion!=='string'||!entry.receipt.effectVersion))return fail('Квитанция эффекта повреждена');
 if((entry.state==='failed'||entry.state==='uncertain')&&(typeof entry.code!=='string'||!entry.code||typeof entry.reason!=='string'||!entry.reason))return fail('Причина отказа повреждена');
 return structuredClone(entry) as unknown as AutopilotDecisionEntry;
}
function checkedCancellation(raw:unknown):AutopilotCancellation {
 if(!isObject(raw)||!['intent','cancelled','partial','irreversible'].includes(String(raw.state))||typeof raw.effectVersion!=='string'||!raw.effectVersion)return fail('Запись отмены решения повреждена');
 if(raw.state==='intent'){
  if(Object.keys(raw).some(key=>!['state','effectVersion'].includes(key)))return fail('Намерение отмены содержит результат');
 }else if(Object.keys(raw).some(key=>!['state','effectVersion','code','reason','nextStep','result'].includes(key))||typeof raw.code!=='string'||!raw.code||typeof raw.reason!=='string'||!raw.reason||typeof raw.nextStep!=='string'||!raw.nextStep||!isObject(raw.result))return fail('Исход отмены решения повреждён');
 return structuredClone(raw) as unknown as AutopilotCancellation;
}

export class AutopilotDecisionLedger {
 readonly path:string;readonly project:string;
 private readonly publish:((event:{type:'autopilotDecision';decisionId:string;state:AutopilotDecisionStage})=>void)|undefined;
 private readonly now:()=>number;
 constructor(project:string,publish?:(event:{type:'autopilotDecision';decisionId:string;state:AutopilotDecisionStage})=>void,now:()=>number=Date.now){this.project=canonicalPath(project);this.path=join(this.project,'.harness','state','autopilot-decisions.ndjson');this.publish=publish;this.now=now}
 private safeDirectory(create=false):void {
  const harness=join(this.project,'.harness'),state=join(harness,'state');
  for(const path of [harness,state]){let info;try{info=lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(!create)return;mkdirSync(path,{mode:0o700});info=lstatSync(path)}if(!info.isDirectory()||info.isSymbolicLink())fail('Каталог журнала решений небезопасен');if(process.platform==='win32'){try{hardenPrivateDirectory(path)}catch{return fail('Каталог журнала решений небезопасен')}}else if(info.uid!==process.getuid?.())fail('Каталог журнала решений небезопасен')}
 }
 private read():DiskLine[]{
  this.safeDirectory();let data:string;try{if(statSync(this.path).size>32*1024*1024)return fail('Журнал решений превышает предел чтения');const info=lstatSync(this.path);if(!info.isFile()||info.isSymbolicLink())return fail('Файл журнала решений небезопасен');if(process.platform==='win32'){try{assertPrivateFile(this.path)}catch{return fail('Файл журнала решений небезопасен')}}else if(info.uid!==process.getuid?.()||(info.mode&0o077)!==0)return fail('Файл журнала решений небезопасен');data=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(this.path))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];if(error instanceof RuntimeError)throw error;throw new RuntimeError('decision_unreadable','Журнал решений Автопилота не читается',409,{cause:error})}
  if(data&&!data.endsWith('\n'))return fail('Последняя запись журнала решений не завершена');
  if(Buffer.byteLength(data)>32*1024*1024)return fail('Журнал решений превышает предел чтения');
  const lines:DiskLine[]=[],latest=new Map<string,AutopilotDecisionEntry>(),cancellations=new Map<string,AutopilotCancellation>(),issues=new Map<string,string>();let prev=ZERO;
  for(const line of data.split('\n').filter(Boolean)){
   let raw:unknown;try{raw=JSON.parse(line)}catch{return fail('JSON журнала решений повреждён')}
   if(!isObject(raw)||raw.prev!==prev||!HASH.test(String(raw.hash))||!isObject(raw.record)||raw.record.project!==this.project||typeof raw.record.at!=='string'||!Number.isFinite(Date.parse(raw.record.at)))return fail('Цепочка журнала решений повреждена');
   const hash=autopilotDecisionHash({prev,record:raw.record});if(raw.hash!==hash)return fail('Хэш журнала решений не совпал');
   if(raw.record.version===1){
    if(!isObject(raw.record.entry)||Object.hasOwn(raw.record,'cancellation'))return fail('Запись решения повреждена');
    const record=raw.record as unknown as AutopilotDecisionRecord,entry=checked(record.entry,this.project),older=latest.get(entry.decisionId);
    if(entry.state==='intent'?!!older||!!issues.get(entry.issueHash):!older||older.state!=='intent'||autopilotDecisionHash(stable(older))!==autopilotDecisionHash(stable(entry)))return fail('Этапы решения Автопилота не связаны');
    if(entry.state==='intent')issues.set(entry.issueHash,entry.decisionId);
    latest.set(entry.decisionId,entry);lines.push({prev,hash,record});
   }else if(raw.record.version===2){
    const record=raw.record as unknown as CancellationRecord,entry=latest.get(String(record.decisionId)),cancel=checkedCancellation(record.cancellation),before=cancellations.get(record.decisionId);
    if(!HASH.test(String(record.decisionId))||!entry||entry.state!=='applied'||entry.receipt.effectVersion!==cancel.effectVersion)return fail('Отмена не связана с применённым эффектом');
    if(cancel.state==='intent'?!!before:!before||before.state!=='intent'||before.effectVersion!==cancel.effectVersion)return fail('Этапы отмены не связаны');
    cancellations.set(record.decisionId,cancel);lines.push({prev,hash,record});
   }else return fail('Версия записи решения неизвестна');
   prev=hash;
  }
  return lines;
 }
 private append(entry:AutopilotDecisionEntry,lines:DiskLine[]):AutopilotDecisionRecord {
  const record:AutopilotDecisionRecord={version:1,project:this.project,at:new Date(this.now()).toISOString(),entry:checked(entry,this.project)};
  this.appendRecord(record,lines);
  try{this.publish?.({type:'autopilotDecision',decisionId:entry.decisionId,state:entry.state})}catch{/* The durable record remains authoritative if an event listener fails. */}return record;
 }
 private appendRecord(record:AutopilotDecisionRecord|CancellationRecord,lines:DiskLine[]):void {
  const prev=lines.at(-1)?.hash??ZERO,hash=autopilotDecisionHash({prev,record}),line=JSON.stringify({prev,hash,record})+'\n';
  this.safeDirectory(true);
  if(existsSync(this.path)){const stat=lstatSync(this.path);if(!stat.isFile()||stat.isSymbolicLink())return fail('Файл журнала решений небезопасен');if(process.platform==='win32'){try{assertPrivateFile(this.path)}catch{return fail('Файл журнала решений небезопасен')}}else if(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)return fail('Файл журнала решений небезопасен')}
  let fd:number|undefined;try{fd=openSync(this.path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);const stat=fstatSync(fd);if(!stat.isFile())return fail('Файл журнала решений небезопасен');if(process.platform==='win32'){try{const pathStat=assertPrivateFile(this.path);if(pathStat.dev!==stat.dev||pathStat.ino!==stat.ino)return fail('Файл журнала решений небезопасен')}catch{return fail('Файл журнала решений небезопасен')}}else if(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)return fail('Файл журнала решений небезопасен');const bytes=Buffer.from(line);for(let at=0;at<bytes.length;){const n=writeSync(fd,bytes,at,bytes.length-at);if(n<=0)throw Error('не записано');at+=n}fsyncSync(fd)}catch(error){if(error instanceof RuntimeError)throw error;throw new RuntimeError('write_failed','Решение Автопилота не записано',500,{cause:error})}finally{if(fd!==undefined)closeSync(fd)}
 }
 list():AutopilotDecisionRecord[]{const latest=new Map<string,AutopilotDecisionRecord>();for(const line of this.read()){const record=line.record;if(record.version===1)latest.set(record.entry.decisionId,record);else{const prior=latest.get(record.decisionId);if(prior)latest.set(record.decisionId,{...prior,cancellation:record.cancellation})}}return [...latest.values()].map(value=>structuredClone(value))}
 get(id:string):AutopilotDecisionEntry|null {if(!HASH.test(id))return null;return this.list().find(row=>row.entry.decisionId===id)?.entry??null}
 cancellation(id:string):AutopilotCancellation|null {if(!HASH.test(id))return null;return this.list().find(row=>row.entry.decisionId===id)?.cancellation??null}
 findByIssue(issueHash:string):AutopilotDecisionEntry|null {const found=this.list().filter(row=>row.entry.issueHash===issueHash);if(found.length>1)return fail('Один вопрос связан с несколькими решениями');return found[0]?.entry??null}
 async intent(entry:Omit<Extract<AutopilotDecisionEntry,{state:'intent'}>,'state'>):Promise<void>{await this.put({...entry,state:'intent'})}
 async applied(entry:Omit<Extract<AutopilotDecisionEntry,{state:'applied'}>,'state'>):Promise<void>{await this.put({...entry,state:'applied'})}
 async failed(entry:Extract<AutopilotDecisionEntry,{state:'failed'|'uncertain'}>):Promise<void>{await this.put(entry)}
 async beginCancellation(id:string,effectVersion:string):Promise<AutopilotCancellation>{return withPathLock(this.path,()=>{
  if(!HASH.test(id)||!effectVersion)throw new RuntimeError('decision_unknown','Решение Автопилота не найдено',404);
  const lines=this.read(),applied=[...lines].reverse().find(line=>line.record.version===1&&line.record.entry.decisionId===id)?.record;
  if(!applied||applied.version!==1)throw new RuntimeError('decision_unknown','Решение Автопилота не найдено',404);
  if(applied.entry.state!=='applied')throw new RuntimeError('cancel_unavailable','Решение ещё не применено',409);
  if(applied.entry.receipt.effectVersion!==effectVersion)throw new RuntimeError('effect_changed','Эффект решения изменился — обновите карточку',409);
  const before=[...lines].reverse().find(line=>line.record.version===2&&line.record.decisionId===id)?.record;
  if(before&&before.version===2)return before.cancellation;
  const cancellation:AutopilotCancellation={state:'intent',effectVersion};this.appendCancellation(id,cancellation,lines);return cancellation;
 })}
 async finishCancellation(id:string,cancellation:AutopilotCancellation):Promise<AutopilotCancellation>{return withPathLock(this.path,()=>{
  const done=checkedCancellation(cancellation);if(done.state==='intent')return fail('Исход отмены не указан');
  const lines=this.read(),before=[...lines].reverse().find(line=>line.record.version===2&&line.record.decisionId===id)?.record;
  if(!before||before.version!==2||before.cancellation.effectVersion!==done.effectVersion)throw new RuntimeError('cancel_unavailable','Намерение отмены не найдено',409);
  if(before.cancellation.state!=='intent')return before.cancellation;
  this.appendCancellation(id,done,lines);return done;
 })}
 private appendCancellation(id:string,cancellation:AutopilotCancellation,lines:DiskLine[]):void {
  const record:CancellationRecord={version:2,project:this.project,at:new Date(this.now()).toISOString(),decisionId:id,cancellation};this.appendRecord(record,lines);
  try{this.publish?.({type:'autopilotDecision',decisionId:id,state:cancellation.state==='intent'?'applied':cancellation.state})}catch{/* The durable record remains authoritative. */}
 }
 private put(entry:AutopilotDecisionEntry):Promise<void>{return withPathLock(this.path,()=>{checked(entry,this.project);const lines=this.read(),conflict=lines.find(row=>row.record.version===1&&row.record.entry.issueHash===entry.issueHash&&row.record.entry.decisionId!==entry.decisionId);
   if(conflict)throw new RuntimeError('decision_conflict','Для этого вопроса уже сохранено другое решение Автопилота',409);
   const prior=[...lines].reverse().find(row=>row.record.version===1&&row.record.entry.decisionId===entry.decisionId)?.record;
   const previous=prior?.version===1?prior.entry:null;
   if(previous){if(autopilotDecisionHash(previous)===autopilotDecisionHash(entry))return;if(previous.state!=='intent'||entry.state==='intent'||autopilotDecisionHash(stable(previous))!==autopilotDecisionHash(stable(entry)))return fail('Решение уже записано с другим содержимым')}
   else if(entry.state!=='intent')return fail('Квитанция не имеет сохранённого намерения');
   this.append(entry,lines);
  })}
}
