import {safeDiagnostic} from '../diagnostic.ts';
import {limitsReason} from '../limits-reason.ts';
import {nodeChildEnv} from '../node-child.ts';
import {stripElectronServiceEnv} from '../env.ts';
import {mkdtemp,writeFile,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {ProviderError,record,type ProviderLimits,type Usage} from '../types.ts';
import {waitWithSignal} from '../cancellation.ts';
import {executeCli} from './process.ts';
import {readCliFileMetadata} from './query.ts';
import {CliStateStore} from './state.ts';
import {assertPrivateFile,hardenPrivateDirectory} from '@harnessy/team';
import type {CliAuth,CliCommand,CliContext,CliDecoder,CliDependencies,CliDescriptor,CliEvent,CliMcpServer,CliProbe,CliProcessResult,CliSeat,CliTurnInput} from './types.ts';

const protocol=(text:string)=>new ProviderError('protocol','CLI: '+text);
const text=(v:unknown):v is string=>typeof v==='string'&&!v.includes('\0');
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(text);
function command(c:CliCommand):CliCommand{if(!record(c)||!strings(c.args)||c.input!==undefined&&!text(c.input)||c.rpcMethod!==undefined&&(!['auth.getStatus','models.list','account.getQuota'].includes(c.rpcMethod)||c.input!==undefined))throw protocol('неверная команда');return {args:[...c.args],...(c.input!==undefined?{input:c.input}:{}),...(c.rpcMethod?{rpcMethod:c.rpcMethod}:{})}}
function probe<T>(p:CliProbe<T>):CliProbe<T>{if(!p||typeof p.parse!=='function'||p.exitCodes!==undefined&&(!Array.isArray(p.exitCodes)||!p.exitCodes.length||p.exitCodes.some(c=>!Number.isInteger(c)||c<0||c>255)))throw protocol('неверный описатель чтения');return {command:command(p.command),...(p.privateConfig?{privateConfig:true}:{}),exitCodes:[...(p.exitCodes??[0])],parse:p.parse}}
function descriptor(d:CliDescriptor):CliDescriptor{
 if(!d||!text(d.id)||!/^[a-z][a-z0-9-]*$/.test(d.id)||['claude','codex'].includes(d.id)||!text(d.name)||!d.name||!text(d.binary)||!d.binary||!record(d.modes)||!strings(d.forbiddenEnv)||!d.turn||!['json','stream-json','text'].includes(d.turn.format)||typeof d.turn.command!=='function'||d.turn.format!=='text'&&typeof d.turn.decode!=='function'&&typeof d.turn.decoder!=='function'||(!d.mcp&&!d.noHarnessMcp)||(d.mcp&&(typeof d.mcp.args!=='function'||typeof d.mcp.serialize!=='function'))||d.resume!==undefined&&typeof d.resume!=='function')throw protocol('неверный описатель провайдера');
 for(const [mode,value] of Object.entries(d.modes))if(!['chat','read','check','web','ask','edit','all'].includes(mode)||typeof value!=='function')throw protocol('неверное соответствие режима '+mode);
 if(d.turnUnavailableReason!==undefined&&(!text(d.turnUnavailableReason)||!d.turnUnavailableReason.trim()))throw protocol('нет причины недоступности хода');
 if(d.turn.sessionFile&&(typeof d.turn.sessionFile.args!=='function'||typeof d.turn.sessionFile.parse!=='function'))throw protocol('неверный описатель экспорта сессии');
 if(d.state&&(!/^[a-z][a-z0-9-]*$/.test(d.state.namespace)||typeof d.state.args!=='function'))throw protocol('неверный описатель состояния');
 if(!d.auth||!('file'in d.auth)&&!('command'in d.auth)&&!('unavailableReason'in d.auth))throw protocol('нет проверки входа');
 if('unavailableReason'in d.auth&&(!text(d.auth.unavailableReason)||!d.auth.unavailableReason.trim()||/[\x00-\x1f\x7f]/.test(d.auth.unavailableReason)))throw protocol('нет причины недоступности проверки входа');
 return {...d,login:command(d.login),version:probe(d.version),auth:'file'in d.auth||'unavailableReason'in d.auth?{...d.auth}:probe(d.auth),models:'list'in d.models?{list:d.models.list.map(m=>({...m})),reason:d.models.reason}:probe(d.models),modes:{...d.modes},forbiddenEnv:[...d.forbiddenEnv],turn:{...d.turn},...(d.mcp?{mcp:{...d.mcp}}:{}),...(d.state?{state:{...d.state}}:{}),...(d.limits?{limits:probe(d.limits)}:{}),...(d.sessions?{sessions:{...d.sessions}}:{})};
}
function inputSnapshot(seat:CliSeat,message:string,ctx:CliContext,vendor:string):CliTurnInput{
 if(!seat||seat.vendor!==vendor||!text(seat.id)||!/^[A-Za-z0-9_-]{1,80}$/.test(seat.id)||!text(seat.label)||!text(seat.cwd)||!isAbsolute(seat.cwd)||!text(seat.model)||!seat.model||!strings(seat.writePaths)||!(seat.worktree===null||text(seat.worktree))||!(seat.sessionId===null||text(seat.sessionId)&&!!seat.sessionId)||!['chat','read','check','web','ask','edit','all'].includes(seat.mode)||!text(message))throw protocol('неверное место или сообщение');
 if(!ctx||!ctx.signal||typeof ctx.signal.addEventListener!=='function'||!record(ctx.env)||!record(ctx.tools)||!strings(ctx.writableRoots)||!text(ctx.roleNote)||!text(ctx.appUrl)||!Array.isArray(ctx.peers)||ctx.peers.some(p=>!p||!text(p.id)||!/^[A-Za-z0-9_-]{1,80}$/.test(p.id)||!text(p.label)||!text(p.vendor))||['publish','session','setHandle','registerProcessToken','revokeProcessToken'].some(k=>typeof (ctx as unknown as Record<string,unknown>)[k]!=='function'))throw protocol('неверный контекст');
 const value={seat:{...seat,writePaths:[...seat.writePaths]},message,roleNote:ctx.roleNote,peers:ctx.peers.map(p=>({...p})),writableRoots:[...ctx.writableRoots]};
 Object.freeze(value.seat.writePaths);Object.freeze(value.seat);value.peers.forEach(Object.freeze);Object.freeze(value.peers);Object.freeze(value.writableRoots);return Object.freeze(value);
}
function usage(value:unknown):Usage{
 if(value===undefined)return {input:null,output:null,cacheRead:null};
 if(!record(value)||['input','output','cacheRead'].some(k=>value[k]!==null&&(typeof value[k]!=='number'||!Number.isFinite(value[k])||value[k]<0)))throw protocol('неверный учёт токенов');
 return value as unknown as Usage;
}

export class CliProvider {
 readonly vendor:string;private d:CliDescriptor;private deps:CliDependencies;
 private active=new Map<string,{abort:AbortController;done:Promise<void>}>();private closed=false;
 constructor(description:CliDescriptor,deps:Partial<CliDependencies>={}){
  this.d=descriptor(description);this.vendor=this.d.id;this.deps={execute:executeCli,env:{...process.env},cwd:process.cwd(),temporaryDirectory:tmpdir(),probeTimeoutMs:15000,loginTimeoutMs:60000,turnTimeoutMs:3600000,maxBytes:16*1024*1024,...deps};
  this.deps.env={...this.deps.env};for(const k of ['probeTimeoutMs','loginTimeoutMs','turnTimeoutMs','maxBytes'] as const)if(!Number.isSafeInteger(this.deps[k])||this.deps[k]<=0)throw protocol('неверный предел '+k);
 }
 private environment(route:NodeJS.ProcessEnv={}){const env:NodeJS.ProcessEnv={...this.deps.env,...route};for(const key of [...this.d.forbiddenEnv,'PANE_TOKEN','PANE_ID','APP_URL','SEATS'])delete env[key];return stripElectronServiceEnv(env)}
 private async query<T>(p:CliProbe<T>,signal:AbortSignal=AbortSignal.timeout(this.deps.probeTimeoutMs),cwd=this.deps.cwd,stateArgs?:string[],route:CliContext['env']={},timeoutMs=this.deps.probeTimeoutMs):Promise<T>{
  let temporary='';try{const args=stateArgs??(p.privateConfig?['--config-dir',temporary=await mkdtemp(join(this.deps.temporaryDirectory,'harnessy-cli-metadata-'))]:[]);
  const cmd=command(p.command),r=await waitWithSignal(()=>this.deps.execute({...cmd,args:[...cmd.args,...args],binary:this.d.binary,cwd,env:this.environment(route),timeoutMs,maxBytes:1024*1024},signal),signal);
  if(r.signal)throw new ProviderError('transport_lost','CLI: чтение прервано');if(r.code===null||!(p.exitCodes??[0]).includes(r.code))throw protocol('команда чтения завершилась с ошибкой');
  try{return p.parse(r)}catch(e){if(e instanceof ProviderError)throw e;throw protocol('неверный ответ чтения')}
  }finally{if(temporary)await rm(temporary,{recursive:true,force:true})}
 }
 async version(signal?:AbortSignal){const v=await this.query(this.d.version,signal);if(!text(v)||!v.trim()||v.length>128)throw protocol('версия не получена');return v.trim()}
 async auth(signal?:AbortSignal,route:CliContext['env']={},timeoutMs=this.deps.probeTimeoutMs):Promise<CliAuth>{
  const stop=signal??AbortSignal.timeout(this.deps.probeTimeoutMs);let value:unknown;
  if('unavailableReason'in this.d.auth){value={loggedIn:false,state:'unknown',reason:this.d.auth.unavailableReason}}else if('file'in this.d.auth){value=await readCliFileMetadata(this.d.auth,this.deps.env)}else value=await this.query(this.d.auth,stop,undefined,undefined,route,timeoutMs);
  if(!record(value)||typeof value.loggedIn!=='boolean'||['email','plan'].some(k=>value[k]!==undefined&&value[k]!==null&&!text(value[k])))throw protocol('неверный статус входа');
  return {loggedIn:value.loggedIn,...(value.state==='unknown'?{state:'unknown' as const,reason:String(value.reason??'вход не проверен')}:{}),...(value.email!==undefined?{email:value.email as string|null}:{}),...(value.plan!==undefined?{plan:value.plan as string|null}:{})};
 }
 // Login before a turn has its own budget; catalog reads keep their short deadline.
 private async turnAuth(signal:AbortSignal,route:CliContext['env'],warning?:(code:string)=>void):Promise<CliAuth>{
  for(let attempt=0;attempt<2;attempt++){
   const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),this.deps.loginTimeoutMs);
   try{return await waitWithSignal(()=>this.auth(AbortSignal.any([signal,deadline.signal]),route,this.deps.loginTimeoutMs),AbortSignal.any([signal,deadline.signal]))}
   catch(e){if(signal.aborted)throw new ProviderError('cancelled','ход отменён');
    if(!deadline.signal.aborted&&!(e instanceof ProviderError&&e.code==='transport_lost'))throw e;
    if(attempt===0)warning?.(deadline.signal.aborted?'login_timeout':e instanceof ProviderError?e.code:'login_timeout');
    if(attempt===1)throw new ProviderError('login_timeout',this.d.name+' не ответил на проверку входа');
   }finally{clearTimeout(timer)}
  }throw protocol('проверка входа не завершена');
 }
 async models(signal?:AbortSignal,route:CliContext['env']={}){const values='list'in this.d.models?this.d.models.list:await this.query(this.d.models,signal,undefined,undefined,route);if(!Array.isArray(values)||values.some(v=>!v||!text(v.id)||!v.id||!text(v.label))||new Set(values.map(v=>v.id)).size!==values.length)throw new ProviderError('models_unavailable','CLI: список моделей не прочитан');return values.map(v=>({id:v.id,label:v.label}))}
 async inspect(){try{return {id:this.vendor,name:this.d.name,binary:this.d.binary,login:command(this.d.login),installed:true,version:await this.version(),auth:await this.auth()}}catch(e){if(e instanceof ProviderError&&e.code==='no_binary')return {id:this.vendor,name:this.d.name,binary:this.d.binary,login:command(this.d.login),installed:false,version:null,auth:null};throw e}}
 async limits(signal?:AbortSignal):Promise<ProviderLimits>{
  if(!this.d.limits)return {ok:false,code:'limits_unsupported',reason:this.d.name+': CLI не отдаёт лимиты'};
  try{const r=await this.query(this.d.limits,signal);if(!r||typeof r.ok!=='boolean')throw protocol('неверные лимиты');
   if(!r.ok){if(!['limits_unlimited','limits_unsupported','limits_not_applicable','limits_auth','limits_rate_limited','limits_unavailable','limits_invalid','limits_timeout','limits_storage'].includes(r.code)||!text(r.reason))throw protocol('неверные лимиты');return {...r,reason:limitsReason(r.code,r.reason)}}
   if(!(r.plan===null||text(r.plan))||!text(r.source)||!Number.isFinite(r.fetchedAt)||!Array.isArray(r.windows)||r.windows.some(w=>!w||!text(w.label)||!Number.isFinite(w.percentUsed)||w.percentUsed<0||w.percentUsed>100||!(w.windowMinutes===null||Number.isFinite(w.windowMinutes)&&w.windowMinutes>0)||!(w.resetsAt===null||Number.isFinite(w.resetsAt)&&w.resetsAt>0)))throw protocol('неверные лимиты');return r;
  }catch(e){const code=signal?.aborted||e instanceof ProviderError&&e.code==='cancelled'?'limits_timeout':'limits_invalid';return {ok:false,code,reason:limitsReason(code,e instanceof ProviderError?e.message:undefined)}}
 }
 async listSessions(cwd:string){if(!this.d.sessions)throw new ProviderError('capability_unsupported','CLI не предоставляет список сессий');return this.query(this.d.sessions.list(cwd),undefined,cwd)}
 async sessionMessages(cwd:string,id:string){if(!this.d.sessions)throw new ProviderError('capability_unsupported','CLI не предоставляет историю сессии');return this.query(this.d.sessions.messages(cwd,id),undefined,cwd)}
 /** Optional preparation runs inside the active turn; final binding checks still follow all its awaits. */
 async runTurn(seat:CliSeat,message:string,original:CliContext){
  if(this.d.turnUnavailableReason)throw new ProviderError('capability_unsupported',this.d.turnUnavailableReason,seat?.sessionId??null);
  const input=inputSnapshot(seat,message,original,this.vendor);seat=input.seat;
  if(this.closed)throw new ProviderError('cancelled','провайдер закрыт');if(this.active.has(seat.id))throw new ProviderError('busy','место занято',seat.sessionId);
  const abort=new AbortController(),signal=AbortSignal.any([original.signal,abort.signal]),ctx={...original,peers:input.peers,env:{...original.env},signal};let release!:()=>void;
  const active={abort,done:new Promise<void>(r=>{release=r})};this.active.set(seat.id,active);
  let sessionId=seat.sessionId,answer='',pending='',pendingText='',directory='',token='',registered=false,terminal=false,result:Extract<CliEvent,{type:'done'}>|null=null,lease:ReturnType<CliStateStore['acquire']>|undefined;
  let decodeValue:CliDecoder|undefined,lifecycleStarted=false,processStarted=false,successful=false;
  let prepared:Awaited<ReturnType<NonNullable<NonNullable<CliDescriptor['mcp']>['prepare']>>>|undefined;
  const started=Date.now(),calls=new Map<string,string>(),secrets=this.d.forbiddenEnv.map(k=>this.deps.env[k]).filter((v):v is string=>!!v);
  const clean=(s:string)=>[...secrets,token].filter(Boolean).reduce((out,secret)=>out.replaceAll(secret,'[redacted]'),s);
  // Keep a short suffix so credentials split across process chunks cannot leak through deltas.
  const delta=(chunk:string,flush=false)=>{if(chunk)ctx.modelResponded?.();pendingText+=chunk;const keys=[...secrets,token].filter(Boolean),width=Math.max(1,...keys.map(s=>s.length));let end=flush?pendingText.length:Math.max(0,pendingText.length-width+1);
   for(const key of keys){let at=pendingText.indexOf(key);while(at>=0){if(at<end&&at+key.length>end)end=at;at=pendingText.indexOf(key,at+1)}}
   const out=clean(pendingText.slice(0,end));pendingText=pendingText.slice(end);if(out){answer+=out;ctx.publish({type:'delta',text:out})}};
  const safe=(v:unknown):unknown=>typeof v==='string'?clean(v):Array.isArray(v)?v.map(safe):record(v)?Object.fromEntries(Object.entries(v).map(([k,value])=>[clean(k),safe(value)])):v;
  const dispose=async()=>{try{if(registered){ctx.revokeProcessToken(token);registered=false}}finally{try{if(prepared){const current=prepared;prepared=undefined;await current.dispose()}}finally{if(directory){await rm(directory,{recursive:true,force:true});directory=''}}}};
  const session=(id:string)=>{if(!text(id)||!id||clean(id)!==id||sessionId!==null&&sessionId!==id)throw protocol('несовпадение сессии');if(sessionId===null){sessionId=id;ctx.session(id)}};
  const consume=(events:CliEvent[])=>{
   if(!Array.isArray(events))throw protocol('неверный поток событий');
   for(const e of events){if(!e||typeof e.type!=='string'||result)throw protocol('событие после результата');
    if(e.type==='response')ctx.modelResponded?.();
    else if(e.type==='session')session(e.id);
    else if(e.type==='delta'){if(!text(e.text))throw protocol('неверный текст');delta(e.text)}
    else if(e.type==='tool.call'){if(!text(e.id)||!e.id||!text(e.name)||!e.name||calls.has(e.id))throw protocol('неверный вызов инструмента');calls.set(e.id,e.name);ctx.publish({type:'tool',name:clean(e.name),detail:clean(JSON.stringify(e.input??{})).slice(0,300)});ctx.traceEvent?.({id:clean(e.id),name:clean(e.name),phase:'call',data:safe(e.input)})}
    else if(e.type==='tool.result'){const name=calls.get(e.id);if(!name||!['ok','failed','rejected','timeout','cancelled'].includes(e.outcome))throw protocol('неверный результат инструмента');ctx.traceEvent?.({id:clean(e.id),name:clean(name),phase:'result',data:safe(e.output),outcome:e.outcome,...(e.reason?{reason:clean(e.reason)}:{})});calls.delete(e.id);if(e.outcome!=='ok')ctx.publish({type:'toolError',text:clean(e.reason||'инструмент завершился: '+e.outcome)})}
    else if(e.type==='error'){if(!text(e.text)||!['not_logged_in','session_missing','model_unsupported','protocol','transport_lost','cancelled','busy','cwd_changed','turn_failed','unknown_request','models_unavailable','mode_unsupported','permission_denied','capability_unsupported'].includes(e.code))throw protocol('неверная ошибка провайдера');throw new ProviderError(e.code,clean(e.text),sessionId)}
    else if(e.type==='done'){if(e.sessionId!==undefined&&e.sessionId!==null)session(e.sessionId);if(e.text!==undefined&&!text(e.text))throw protocol('неверный ответ');usage(e.usage);if(e.text)ctx.modelResponded?.();result=e}
    else throw protocol('неизвестное событие');
   }
  };
  const decode=(value:unknown)=>{try{consume(decodeValue!(value))}catch(e){if(e instanceof ProviderError)throw e;throw protocol('неверный вывод провайдера')}};
  const stream=(chunk:string)=>{if(this.d.turn.format==='text'){delta(chunk);return}if(this.d.turn.format!=='stream-json')return;pending+=chunk;let i:number;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i).trim();pending=pending.slice(i+1);if(line)parse(line)}if(pending.length>1024*1024)throw protocol('строка потока слишком велика')};
  const parse=(raw:string)=>{let v:unknown;try{v=JSON.parse(raw)}catch{throw protocol('неверный JSON потока')}decode(v)};
  try{
   decodeValue=this.d.turn.decoder?.(seat.sessionId)??this.d.turn.decode!;
   ctx.setHandle({interrupt:async()=>{abort.abort();await active.done},steer:async()=>{throw new ProviderError('capability_unsupported','CLI не поддерживает вмешательство в активный ход',sessionId)}});
   if(signal.aborted)throw new ProviderError('cancelled','ход отменён',sessionId);
   const mode=this.d.modes[seat.mode];if(!mode)throw new ProviderError(this.d.state?'capability_unsupported':'mode_unsupported','CLI: режим '+seat.mode+' не поддерживается',sessionId);
   const permissions=mode(input);if(!strings(permissions)||!permissions.length)throw protocol('нет флагов разрешений');
   if(seat.sessionId&&!this.d.resume)throw new ProviderError('capability_unsupported','CLI не поддерживает возобновление',sessionId);
   const resume=seat.sessionId?this.d.resume!(seat.sessionId):[];if(!strings(resume))throw protocol('неверное возобновление');
   const auth=await this.turnAuth(signal,ctx.env,code=>ctx.traceEvent?.({id:'login-retry',name:'login.retry',phase:'warning',reason:code,error:'Первая проверка входа не ответила; повторяем'}));if(!auth.loggedIn&&!(this.d.allowUnverifiedLogin&&auth.state==='unknown'))throw new ProviderError('not_logged_in',this.d.name+': выполните вход через программу',sessionId);
   const models=await waitWithSignal(()=>this.models(signal,ctx.env),signal);if(!models.some(m=>m.id===seat.model))throw new ProviderError('model_unsupported','CLI: модель отсутствует в каталоге',sessionId);
   const state=this.d.state;if(state){const project=ctx.stateProjectDir??ctx.projectDir;if(!project)throw protocol('нет привязки проекта для состояния CLI');lease=new CliStateStore(state.namespace,this.deps.stateRoot).acquire(project,seat.id)}
   const stateArgs=lease?state!.args(lease.path):[];if(!strings(stateArgs))throw protocol('неверные флаги состояния');
   if(signal.aborted)throw new ProviderError('cancelled','ход отменён',sessionId);
   let mcpArgs:string[]=[],configEnv:NodeJS.ProcessEnv={};
   if(this.d.mcp){
    token=randomBytes(32).toString('hex');ctx.registerProcessToken(token);registered=true;
    directory=await mkdtemp(join(this.deps.temporaryDirectory,'harnessy-cli-'));hardenPrivateDirectory(directory);const path=join(directory,'mcp.json');
    const server:CliMcpServer={command:process.execPath,args:[fileURLToPath(new URL('../../bin/pane-mcp.mjs',import.meta.url))],env:nodeChildEnv({PANE_ID:seat.id,APP_URL:ctx.appUrl,PANE_TOKEN:token,SEATS:input.peers.map(p=>p.id+':'+p.label.replace(/[;\r\n]/g,' ')).join(';')})};
    const config=this.d.mcp.serialize(server,input);mcpArgs=this.d.mcp.args(path,server,input);configEnv=this.d.mcp.env?.(path)??{};
    if(!text(config)||!config||!strings(mcpArgs))throw protocol('нет конфигурации MCP');
    await writeFile(path,config,{encoding:'utf8',mode:0o600,flag:'wx'});
    assertPrivateFile(path);
    if(this.d.mcp.prepare){prepared=await this.d.mcp.prepare(path,input,this.deps.env,this.deps.stateRoot);configEnv={...configEnv,...prepared.env}}
   }
   let sessionFile='',sessionArgs:string[]=[];
   if(this.d.turn.sessionFile){
    if(!directory){directory=await mkdtemp(join(this.deps.temporaryDirectory,'harnessy-cli-'));hardenPrivateDirectory(directory)}
    sessionFile=join(directory,'turn.json');sessionArgs=this.d.turn.sessionFile.args(sessionFile);
    if(!strings(sessionArgs)||!sessionArgs.length)throw protocol('неверные флаги экспорта сессии');
   }
   const c=command(this.d.turn.command(input));
   if(lease){lease.validate();if(!('command'in this.d.auth))throw protocol('изолированный вход должен проверяться программой');const current=await this.query(this.d.auth,signal,seat.cwd,stateArgs,ctx.env);if(!current.loggedIn||!current.email||current.email!==auth.email)throw new ProviderError('login_changed','Вход приватного состояния отличается; подтвердите вход заново')}
   if(ctx.beforeModel)await waitWithSignal(()=>ctx.beforeModel!({provider:this.vendor,model:seat.model}),signal);
   if(signal.aborted)throw new ProviderError('cancelled','ход отменён',sessionId);
   lease?.validate(); // No await between the final path check and process creation.
   prepared?.validate();
   // Register the attempt immediately before process creation; no other turn can
   // observe its counters in the gap before the asynchronous spawn callback.
   lifecycleStarted=true;decodeValue?.started?.();
   const onStarted=()=>{if(processStarted)return;processStarted=true;ctx.modelStarted?.()};
   const exit=await this.deps.execute({...c,binary:this.d.binary,args:[...c.args,...permissions,...resume,...stateArgs,...mcpArgs,...sessionArgs],cwd:seat.cwd,env:this.environment({...ctx.env,...configEnv}),timeoutMs:this.deps.turnTimeoutMs,maxBytes:this.deps.maxBytes},signal,{stdout:chunk=>{onStarted();stream(chunk)},started:onStarted});
   if(signal.aborted)throw new ProviderError('cancelled','ход отменён',sessionId);
   if(exit.code!==0||exit.signal){const failure=this.d.failure?.(exit);throw new ProviderError(failure?.code??'transport_lost',clean(failure?.text??('CLI: процесс завершился '+(exit.signal?'по сигналу '+exit.signal:'с кодом '+exit.code)+(exit.stderr.trim()?': '+safeDiagnostic(clean(exit.stderr)):' · stderr пуст'))),sessionId)}
   if(sessionFile){
    let id:string;
    try{const fd=await open(sessionFile,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{
     const stat=await fd.stat();if(!stat.isFile()||stat.size>this.deps.maxBytes)throw Error();
     const bytes=Buffer.alloc(this.deps.maxBytes+1),{bytesRead}=await fd.read(bytes,0,bytes.length,0);if(bytesRead>this.deps.maxBytes)throw Error();
     id=this.d.turn.sessionFile!.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead)));
    }finally{await fd.close()}}catch{throw protocol('сессия не получена из результата хода')}
    if(signal.aborted)throw new ProviderError('cancelled','ход отменён',sessionId);session(id);
   }
   if(this.d.turn.format==='json')parse(exit.stdout);else if(this.d.turn.format==='stream-json'&&pending.trim())parse(pending.trim());else if(this.d.turn.format==='text')result={type:'done'};
   const done=result as Extract<CliEvent,{type:'done'}>|null;if(!done)throw new ProviderError('transport_lost','CLI: поток завершился без результата',sessionId);
   if(calls.size)throw protocol('нет результата вызванного инструмента');
   delta('',true);
   if(!answer&&done.text){answer=clean(done.text);ctx.publish({type:'delta',text:answer})}
   await dispose();terminal=true;ctx.publish({type:'done',sessionId,model:seat.model,durationMs:Date.now()-started,usage:usage(done.usage)});successful=true;return {text:answer,sessionId};
  }catch(e){const error=signal.aborted?new ProviderError('cancelled','ход отменён',sessionId):e instanceof ProviderError?new ProviderError(e.code,safeDiagnostic(clean(e.vendorText)),sessionId):protocol('ход не выполнен');if(!terminal){terminal=true;ctx.publish({type:'error',text:error.vendorText})}throw error}
  finally{try{if(lifecycleStarted)decodeValue?.finished?.(successful)}finally{abort.abort();try{await dispose()}finally{try{lease?.release()}finally{this.active.delete(seat.id);try{ctx.setHandle(null)}finally{release()}}}}}
 }
 async reset(){const turns=[...this.active.values()];for(const a of turns)a.abort.abort();await Promise.all(turns.map(a=>a.done))}
 async close(){this.closed=true;await this.reset()}
}
