import {turnUsage} from './turn-usage.ts';
import {contextChange,appendContextChange} from './context-changed.ts';
import {instructionFile,updateInstruction} from './instructions.ts';
import {TaskStore} from './tasks.ts';
import {NetworkStats} from './network-stats.ts';
import {NetworkProviderChecks} from './network-provider-checks.ts';
import {NetworkRelay,NetworkError,type NetworkTurn} from './network-relay.ts';
import {turnFailure} from './turn-failure.ts';
import {SshTunnels} from './ssh-tunnels.ts';
import {ApiAgent,apiRoute,API_MODES} from './api-agent.ts';
import {createLlmService,LlmError,keySlot,MacKeyStore,routeModels,type KeyStore,type LlmDependencies,type ProviderConfig} from '@harnessy/llm';
import {TraceStore,currentTrace,traceReason,type TraceContext} from './trace.ts';
import {ProviderOperations} from './provider-operations.ts';
import {AutopilotDecisionLedger} from './autopilot-decisions.ts';
import {cancelAutopilotDecision} from './autopilot-cancel.ts';
import {ProviderCatalog,catalogCacheDirectory,LoginTerminal,builtinEntries,CLI_DESCRIPTORS,cliEntry,ollamaEntry,OLLAMA_URL,safeDiagnostic} from '@harnessy/providers';
import {promoteChat,restorePromotions,type PromotionInput} from './promotion.ts';
import {propose,proposals,confirm,create,createOwnerSeat,proposeOwner,restoreProposals,type ProposalInput,type ProposalRef,type OwnerSeatInput} from './proposals.ts';
import {reserve,free,waiting,waitingError,locked} from './operations.ts';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {homedir} from 'node:os';
import {AttachmentStore,expandUser,initProject,projectsRoot} from '@harnessy/projects';
import {pyTruthy} from '@harnessy/team';
import {askDeliveryDepth} from './action-state.ts';
import {makeRoom,makeRoomIn,roomSet,roomMove,assignRoomRole} from './rooms.ts';
import {createSeat,ensureSeatMaterialized,onboard,restoreAssignments,roleCatalog,firstOpenPending,type CreateSeatInput} from './roles.ts';
import {roleKnowledge} from './proposals.ts';
import {teamKnowledgeChanges,isTeamSnapshot} from '@harnessy/context';
import {chatsList,chatGet,chatsNew,chatsOpen,meta,transferSnapshot} from './chats.ts';
import {handoff} from './handoff.ts';
import {chat} from './owner-chat.ts';
import {execFileSync} from 'node:child_process';
import {accessSync,chmodSync,lstatSync,mkdtempSync,realpathSync,rmSync,writeFileSync,constants} from 'node:fs';
import {access,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {ensureLineLocked,withPathLock,loadTeam,instructionsFor,canonicalPath,type Vendor} from '@harnessy/team';
import {ATTACHMENT_MAX_COUNT,Journal,Channel,Policy,JournalError,normalizeAttachments,pythonTrim,type AgentPostInput,type AttachmentRef,type Initiator,type Record_,type DeliveryEntry,type ChannelEvent} from '@harnessy/journal';
import {NetworkChecks,NetworkSettings,openProjectGit,writableRoots,Connections,ProjectRegistry,Settings,Pins,gitops,type AutopilotPermissionSnapshot} from '@harnessy/projects';
import {digest,roleNote,contextCard,conversationTransfer,transferSettings,transferLabel,TRANSFER_DEFAULTS,type ConversationTransfer} from '@harnessy/context';
import {ProviderError,type TurnAttachment,type TurnContext,type PeerTools,type SendArgs,type AskArgs,type ReadPaneArgs,type MergeArgs,type AssignRoleArgs} from '@harnessy/providers';
import {Pane,Registry,validDir} from './pane.ts';
import {EventBus,type Selector} from './events.ts';
import {StateStore,diskIO,timestampMessage,artifactPaths,type ResultMessage,type TranscriptMessage,type ObservedToolEvent,type ToolReceipt} from './state.ts';
import {LimitsStore} from './limits.ts';
import {ProviderLimitsStore} from './provider-limits.ts';
import {Scopes,ProcessTokens} from './scope.ts';
import {renderInbox,queueNote} from './inbox.ts';
import {RuntimeError,message,slice,deepFreeze,object} from './errors.ts';
import {systemClock,type RuntimeDeps,type RuntimeActions,type ProjectState,type TurnScope,type ActiveTurn,type ActionContext,type RuntimeEvent,type TurnRecords,type BridgeSendArgs,type BridgeFailure,type SendResult,type ReadPaneResult,type AskResult,type MergeResult,type AssignRoleResult} from './types.ts';
import {RuntimeAutopilotEngine} from './autopilot-engine.ts';
import type {AutopilotAgentReply,AutopilotAgentRequest} from './autopilot-council.ts';
const OWNER:Initiator & {trust:'owner'}={seat:'owner',trust:'owner'},HARNESS:Initiator & {trust:'harness'}={seat:'harness',trust:'harness'};
// Only valid inside withAutopilotGeneration. Existing owner API checks still apply.
export const AUTOPILOT_OWNER:Initiator=Object.freeze({seat:'owner',trust:'owner',source:'autopilot'});
const COUNCIL_ORIGIN='autopilot-council';
const measuredUsage=(value:unknown)=>object(value)&&Number.isSafeInteger(value.input)&&Number(value.input)>=0&&Number.isSafeInteger(value.output)&&Number(value.output)>=0;
const councilTools=():PeerTools=>{
 const denied=async()=>({ok:false as const,code:'autopilot_denied',error:'Консилиум может только вернуть решение'});
 return {proposeSeats:denied,createSeats:denied,send:denied,ask:denied,readPane:denied,merge:denied,assignRole:denied};
};
const attachmentExtension:Record<TurnAttachment['mime'],string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'};
function programBinaryTarget(id:string,file:string):boolean{
 const name=basename(file);
 if(name===id)return true;
 // The official launchers are links to these differently named installed files.
 if(id==='codex'&&name==='codex.js'&&file.endsWith(`${sep}@openai${sep}codex${sep}bin${sep}codex.js`))return true;
 return id==='claude'&&/^\d+\.\d+\.\d+$/.test(name)&&file.includes(`${sep}.local${sep}share${sep}claude${sep}versions${sep}`);
}
function programBinaryInProject(file:string,project:string):boolean{
 const full=resolve(file),inside=relative(project,full);
 if(inside===''||inside!=='..'&&!inside.startsWith('..'+sep)&&!isAbsolute(inside))return true;
 for(let dir=dirname(full);;dir=dirname(dir)){
  for(const marker of ['.git','.harness'])try{lstatSync(join(dir,marker));return true}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  if(dirname(dir)===dir)break;
 }
 return false;
}
function providerAttachments(source:TurnAttachment[],vendor:string,projectDir:string):{attachments:TurnAttachment[];cleanup:()=>void}{
 if(vendor!=='codex'||!source.length)return {attachments:source,cleanup:()=>{}};let directory:string|undefined;
 try{directory=mkdtempSync(join(realpathSync(tmpdir()),'harnessy-turn-attachments-'));chmodSync(directory,0o700);const fromProject=relative(realpathSync(projectDir),directory),inside=fromProject===''||!isAbsolute(fromProject)&&fromProject!=='..'&&!fromProject.startsWith('..'+sep);if(inside)throw new RuntimeError('attachment_invalid','приватный снимок вложения оказался внутри проекта',400);
  const attachments=source.map((attachment,index)=>{const path=join(directory!,index+'.'+attachmentExtension[attachment.mime]);writeFileSync(path,attachment.data,{flag:'wx',mode:0o600});chmodSync(path,0o600);return {...attachment,path}});
  return {attachments,cleanup:()=>{try{rmSync(directory!,{recursive:true,force:true})}catch{}}};
 }catch(error){if(directory)try{rmSync(directory,{recursive:true,force:true})}catch{}if(error instanceof RuntimeError)throw error;throw new RuntimeError('attachment_invalid','приватный снимок вложения не создан',400,{cause:error})}
}
type AttemptDecision=NonNullable<Record_['attempt']>;
function turnMeasurements(event:Record<string,unknown>|null){if(event?.type!=='done')return {};const raw=object(event.usage)?event.usage:{},value=(key:string)=>typeof raw[key]==='number'&&Number.isSafeInteger(raw[key])&&raw[key]>=0?raw[key] as number:null;return {usage:{input:value('input'),output:value('output'),cacheRead:value('cacheRead')},...(event.usageIncomplete===true?{usageIncomplete:true as const}:{}),...(typeof event.durationMs==='number'?{durationMs:event.durationMs}:{})}}
export class Runtime {
 private attachmentStores=new WeakMap<ProjectState,AttachmentStore>();
 private directRetries=new WeakMap<ProjectState,Map<string,{binding:string;seqs:number[]}>>();
 readonly networkStats:NetworkStats;private unsubscribeNetworkStats:()=>void;private tunnelTrace=new Map<string,number>();readonly networkProviderChecks:NetworkProviderChecks;readonly networkRelay:NetworkRelay;readonly sshTunnels:NonNullable<RuntimeDeps['sshTunnels']>;readonly providerOperations:ProviderOperations;readonly network:NetworkSettings;readonly networkChecks:NetworkChecks;
 private apiAgents=new Map<string,ApiAgent>();readonly llmKeys:KeyStore;private unsubscribeLlm:()=>void;
 get llm(){return this.modelService(()=>this.settings.llmProviders(),listener=>this.settings.onLlmRoutesChanged(listener))}
 private modelService(routes:LlmDependencies['routes'],subscribeRoutes:NonNullable<LlmDependencies['subscribeRoutes']>,p=this.project,vendorPrefix='api:'){return createLlmService({routes,resolveKey:(ref,generation)=>this.llmKeys.resolveKey(keySlot(ref,generation)),subscribeRoutes,providerFetch:id=>this.routedFetch(vendorPrefix+id),trace:event=>{p.trace.record(event.kind,{outcome:event.outcome,reason:traceReason(event.code??'none'),durationMs:event.durationMs,data:{id:event.requestId,vendor:event.provider,model:event.model,code:event.code,...event.usage}})}})}
 readonly clock;readonly connections;readonly projectRegistry;readonly settings;readonly pins;readonly defaultDir:string;readonly scopes=new Scopes();private tokens=new ProcessTokens(this.scopes);
 private traces=new Set<TraceStore>();private traceConfig={enabled:true,maxBytes:16*1024*1024};private generation=0;private current:ProjectState|null=null;private opening=Promise.resolve();private quotas=new WeakMap<ProjectState,LimitsStore>();private cliQuotas=new WeakMap<ProjectState,ProviderLimitsStore>();
 private programBinaryJobs=new Map<string,Promise<unknown>>();
 private autopilotSettlements=new WeakMap<ProjectState,Map<string,()=>Promise<void>>>();
 autopilotModelSettlement(key:string,complete:()=>Promise<void>){const p=this.project;let callbacks=this.autopilotSettlements.get(p);if(!callbacks)this.autopilotSettlements.set(p,callbacks=new Map());callbacks.set(key,complete)}
 /** A delivery claims callbacks once, before async preparation. A retry cannot claim them again. */
 private claimAutopilotSettlement(p:ProjectState,pane:string,records:readonly Record_[],turnInstanceId:string){
  const keys=records.filter(r=>r.origin?.startsWith('autopilot:')).map(r=>r.origin!.slice(10));
  for(const {record}of this.attemptDecisions(p)){const a=record.attempt!;if(a.autopilot&&a.action==='retry'&&a.pane===pane&&a.deliverySeq!==null&&records.some(r=>r.seq<=a.deliverySeq!))keys.push('attempt:'+a.turnInstanceId)}
  const pending=this.autopilotSettlements.get(p),callbacks:(()=>Promise<void>)[]=[];
  for(const key of new Set(keys)){const callback=pending?.get(key);if(callback){pending!.delete(key);callbacks.push(callback)}}
  let completed=false;
  return Object.freeze({turnInstanceId,complete:async(callId:string)=>{
   if(callId!==turnInstanceId)throw new RuntimeError('spend_call_mismatch','Квитанция расхода относится к другому вызову',409);
   this.same(p);if(completed)return;completed=true;
   for(const callback of callbacks)await callback();
  }});
 }
 private autopilotEngines=new WeakMap<ProjectState,RuntimeAutopilotEngine>();
 private autopilotTimers=new WeakMap<ProjectState,unknown>();
 private autopilotDecisionLedgers=new WeakMap<ProjectState,AutopilotDecisionLedger>();
 private autopilotApplication=new WeakMap<ProjectState,symbol>();private autopilotContext=new AsyncLocalStorage<symbol>();private autopilotJobs=new WeakMap<ProjectState,Set<Promise<unknown>>>();
 readonly deps:RuntimeDeps;readonly actions:RuntimeActions;
 constructor(deps:RuntimeDeps,actions:RuntimeActions){this.deps=deps;this.actions=actions;this.llmKeys=deps.llmKeys??new MacKeyStore();this.sshTunnels=deps.sshTunnels??new SshTunnels();
 if(!actions||['ask','merge','assignRole','afterTurn','restorePendingAcks','cancelAsks'].some(k=>typeof (actions as unknown as Record<string,unknown>)[k]!=='function'))throw new RuntimeError('actions_required','порт действий обязателен',500);
 this.clock=deps.clock??systemClock;this.connections=deps.connections??new Connections();this.projectRegistry=deps.projectRegistry??new ProjectRegistry();this.defaultDir=canonicalPath(deps.defaultDir??process.env.CHAT_WORK_DIR??(process.platform==='win32'?join(homedir(),'Harnessy-Projects','Chat'):'/Users/Shared/simple-claude-chat'));
 const current=()=>this.current&&!this.current.closed?this.current.dir:null;
 this.settings=typeof deps.settings==='function'?deps.settings(current):deps.settings??new Settings(undefined,current);
 let savedPrograms:Record<string,unknown>={};try{savedPrograms=this.settings.get().owner}catch{}
 const programBinary=(id:string,standard:string)=>{
  const value=savedPrograms['programBinary_'+id];
  if(typeof value!=='string'||!isAbsolute(value)||value.length>1024||value.includes('\0'))return standard;
  try{
   const canonical=realpathSync(value),project=canonicalPath(deps.projectDir??this.defaultDir);
   if(!programBinaryTarget(id,canonical)||programBinaryInProject(value,project)||programBinaryInProject(canonical,project)||!lstatSync(canonical).isFile())return standard;
   accessSync(canonical,constants.X_OK);return canonical;
  }catch{return standard}
 };
 for(const id of ['claude','codex'] as const){const path=programBinary(id,id);if(path!==id)process.env[id==='claude'?'CLAUDE_BIN':'CODEX_BIN']=path}
 this.unsubscribeLlm=this.settings.onLlmRoutesChanged(()=>{const p=this.current;if(p&&!p.closed){this.syncApiModels(p);p.bus.publish('owner',{type:'llm.routes',providers:Object.keys(this.settings.llmProviders())})}});
 this.pins=typeof deps.pins==='function'?deps.pins(current,id=>this.chatMeta(id)):deps.pins??new Pins(undefined,current,id=>this.chatMeta(id));this.traceSettings();
 this.providerOperations=new ProviderOperations(this,deps.providerCatalog??new ProviderCatalog([...builtinEntries(deps.providers,deps.models??{}),...CLI_DESCRIPTORS.map(d=>cliEntry({...d,binary:programBinary(d.id,d.binary)})),ollamaEntry()],undefined,{cacheDir:deps.catalogCacheDir??catalogCacheDirectory()}),deps.loginTerminal??new LoginTerminal());
 this.network=new NetworkSettings(this.settings,deps.networkKeys??new MacKeyStore({purpose:'proxy-password'}),this.connections,()=>this.providerOperations.catalog.ids());
 this.networkProviderChecks=new NetworkProviderChecks(this);this.networkChecks=new NetworkChecks(this.settings,this.network,{...deps.networkCheckOptions,tunnels:this.sshTunnels});
 this.networkStats=new NetworkStats(this.settings,deps.networkStatsPath??this.settings.networkStatsPath());const stopChecks=this.networkChecks.subscribe((id,check)=>this.networkStats.identity(id,check));const stopTunnels=this.sshTunnels.subscribe(value=>{this.networkStats.tunnel(value);const p=this.current;if(!p||p.closed)return;const previous=this.tunnelTrace.get(value.id),action=value.state==='starting'&&previous!==undefined&&previous!==value.generation?'restart':value.state;this.tunnelTrace.set(value.id,value.generation);p.trace.record('network.tunnel',{outcome:value.state==='down'?'failed':'ok',reason:value.code?traceReason(value.code,value.reason??''):{code:'none',text:''},data:{exit:value.id,action,state:value.state,code:value.code,retryAt:value.retryAt,generation:value.generation}})});this.unsubscribeNetworkStats=()=>{stopChecks();stopTunnels?.()};this.networkRelay=new NetworkRelay(this.settings,this.network,{...deps.networkRelayOptions,tunnels:()=>this.sshTunnels,check:(id,revision)=>this.networkChecks.snapshot(id,revision),authFailure:provider=>{const p=this.current;if(p&&!p.closed)p.trace.record('network.auth_failed',{outcome:'failed',reason:traceReason('proxy_auth_required','Доступ к ретранслятору отклонён'),data:{vendor:provider,code:'proxy_auth_required'}});deps.networkRelayOptions?.authFailure?.(provider)},measurement:sample=>{this.networkStats.connection(sample);deps.networkRelayOptions?.measurement?.(sample)},httpStatus:(provider,exit,status)=>{this.networkStats.http(provider,exit,status);deps.networkRelayOptions?.httpStatus?.(provider,exit,status)},event:value=>{const p=this.current;if(p&&!p.closed)p.trace.record(value.kind,{outcome:value.kind==='network.exit_failed'?'failed':'ok',reason:value.code?traceReason(value.code):{code:'none',text:''},data:{vendor:value.provider,exit:value.exit,from:value.from,to:value.to,reason:value.reason,code:value.code}});deps.networkRelayOptions?.event?.(value)},trace:value=>{this.networkStats.relay([value]);const p=this.current,{provider,exit,outcome,...counters}=value;if(p&&!p.closed)p.trace.record('network.connection',{outcome,data:{vendor:provider,id:exit,...counters}});deps.networkRelayOptions?.trace?.(value)}});this.networkStats.watchRelay(()=>this.networkRelay.stats())
 }
 routedFetch(provider:string):typeof fetch {const routed=this.networkRelay.fetch(provider,this.deps.llmFetch??fetch);return async(input,init)=>{try{return await routed(input,init)}catch(e){if(e instanceof NetworkError)throw new LlmError(e.code as import('@harnessy/llm').FailureCode);throw e}}}
 private traceSettings(){try{const owner=this.settings.effective();this.traceConfig={enabled:owner.traceEnabled!==false,maxBytes:Number.isSafeInteger(owner.traceMaxMiB)&&Number(owner.traceMaxMiB)>=1&&Number(owner.traceMaxMiB)<=128?Number(owner.traceMaxMiB)*1024*1024:16*1024*1024}}catch{}}
 traceTool<T>(scope:TurnScope,name:string,args:unknown,run:()=>Promise<T>){this.scopes.assert(scope);const p=this.project;return p.trace.tool(name,args,run,p.trace.forTurn(scope.turnInstanceId))}
 private traceProvider(p:ProjectState,pane:string,turn:string,event:NonNullable<TurnContext['traceEvent']> extends (e:infer E)=>void?E:never){const parent=p.trace.forTurn(turn),key=turn+':'+event.id;let spans=this.toolSpans.get(p);if(!spans){spans=new Map();this.toolSpans.set(p,spans)}
  if(event.phase==='warning'){p.trace.record(event.name==='login.retry'?'login.retry':'provider.warning',{actor:'model:'+pane,data:{code:event.reason,error:event.error}},parent);return}
  if(event.phase==='call'){const span=p.trace.record('tool.call',{actor:'model:'+pane,data:{name:event.name,args:event.data}},parent);spans.set(key,{span,started:this.clock.now()})}
  else{const previous=spans.get(key),span=previous?.span??p.trace.record('tool.call',{actor:'model:'+pane,data:{name:event.name}},parent);p.trace.end(span,'tool.result',{actor:'model:'+pane,outcome:event.outcome??'ok',reason:event.reason?traceReason(event.reason,event.error):{code:'none',text:''},durationMs:previous?this.clock.now()-previous.started:null,data:{name:event.name,result:event.data}});spans.delete(key)}
 }
 private toolSpans=new WeakMap<ProjectState,Map<string,{span:TraceContext;started:number}>>();
 private finishTraceTools(p:ProjectState,turn:string){const spans=this.toolSpans.get(p);if(!spans)return;for(const [key,value] of spans)if(key.startsWith(turn+':')){p.trace.end(value.span,'tool.result',{actor:value.span.pane?'model:'+value.span.pane:'engine',outcome:p.closed?'cancelled':'failed',reason:{code:p.closed?'cancelled':'unavailable',text:'Источник не передал результат инструмента до завершения хода'},durationMs:this.clock.now()-value.started});spans.delete(key)}}
 private traceEvents(p:ProjectState){const approvals=new Map<string,TraceContext>();p.bus.observer=(pane,event)=>{if(event.type==='approval'||event.type==='autopilot'||event.type==='state')this.autopilotEngines.get(p)?.wake();const current=currentTrace(),parent=current?.store===p.trace?current:p.trace.forTurn(p.active.get(pane)?.scope.turnInstanceId);let span=parent;
  if(event.type==='approval'){span=p.trace.record('approval.shown',{pane,data:{name:event.title},refs:parent?.turnInstanceId?{attemptId:parent.turnInstanceId}:{}},parent);approvals.set(pane+':'+event.id,span)}
  else if(event.type==='approvalResolved'){const previous=approvals.get(pane+':'+event.id);span=p.trace.record('approval.resolved',{pane,outcome:event.decision==='allow'?'ok':event.decision==='timeout'?'timeout':'rejected',reason:{code:event.decision==='allow'?'none':event.decision==='timeout'?'timeout':'owner_denied',text:String(event.decision)}},previous??parent);approvals.delete(pane+':'+event.id)}
  else if(event.type==='queued'&&object(event.record)){span=p.trace.record('queue.enqueued',{pane,refs:{journalSeq:Number(event.record.seq)},data:{pending:event.pending}},p.trace.forJournal(Number(event.record.seq))??parent)}
  else if(event.type==='state'&&event.waiting)span=p.trace.record('queue.waiting',{pane,data:{status:event.status}},parent);
  else if(event.type==='error'||event.type==='toolError')span=p.trace.record('error.provider',{pane,outcome:'failed',reason:traceReason(event.code,String(event.message??event.text??''))},parent);
  return span?{...event,traceId:span.traceId,spanId:span.spanId,project:p.dir}:event;
 };
 }
 get project():ProjectState{if(!this.current||this.current.closed)throw new RuntimeError('project_closed','проект закрыт');return this.current}
 get registry(){return this.project.registry}get owner(){return this.project.owner}get journal(){return this.project.journal}get channel(){return this.project.channel}get lineErrors(){return [...this.project.lineErrors]}get halted(){return this.project.halted}
 private quota(p:ProjectState){let store=this.quotas.get(p);if(!store){store=new LimitsStore(p.dir,this.clock,this.deps.providers,()=>{if(!p.closed&&this.current===p)p.bus.publish('owner',{type:'limits',...this.limitsSnapshot()})},this.deps.limitsCacheDir,(vendor,result)=>{p.trace.record('limits.measurement',{outcome:result.ok?'ok':result.code==='limits_not_applicable'?'rejected':'failed',reason:result.ok?{code:'none',text:''}:traceReason(result.code,result.reason),data:{vendor,status:result.ok?'ok':result.code,...(result.ok?{windows:result.windows}:{})}})});this.quotas.set(p,store)}return store}
 private cliQuota(p:ProjectState){let store=this.cliQuotas.get(p);if(!store){store=new ProviderLimitsStore(this.providerOperations.catalog,this.clock,()=>{if(!p.closed&&this.current===p)p.bus.publish('owner',{type:'limits',...this.limitsSnapshot()})},this.deps.limitsCacheDir,event=>{p.trace.record('provider.limits',{outcome:event.ok?'ok':'failed',reason:event.ok?{code:'none',text:''}:traceReason(event.code,event.reason),durationMs:event.durationMs,data:{vendor:event.vendor,code:event.code,reason:event.reason}})});this.cliQuotas.set(p,store)}return store}
 limitsSnapshot(){const p=this.project,base=this.quota(p).snapshot(),cli=this.cliQuota(p).snapshot(),providers=[...base.providers.map(v=>({...v,ok:v.status==='ok'})),...cli.providers],error=cli.errors[0],available=providers.some(v=>v.ok||v.windows.length>0);return {...base,...(error&&!available?{ok:false as const,code:error.code,reason:error.reason}:{}),revision:base.revision+cli.revision,providers,updatedAt:Math.max(base.updatedAt??0,...cli.providers.map(v=>v.fetchedAt??0))||null,...(cli.errors.length?{errors:cli.errors}:{})}}
 async limits(){const p=this.project;await Promise.all([this.quota(p).refresh(),this.cliQuota(p).refresh()]);this.same(p);return this.limitsSnapshot()}
 apiModelSnapshot(){try{const routes=this.settings.llmProviders(),models=Object.fromEntries(Object.entries(routes).map(([id,config])=>['api:'+id,routeModels(id,config).map(m=>({id:m.id,label:m.name,images:m.input.includes('image')}))]));return {models,turnModes:Object.fromEntries(Object.keys(models).map(id=>[id,API_MODES])),apiError:null}}catch{return {models:{} as Record<string,{id:string;label:string;images:boolean}[]>,turnModes:{} as Record<string,typeof API_MODES>,apiError:{code:'settings_unreadable',reason:'Настройки API-маршрутов не прочитаны'}}}}
 private syncApiModels(p:ProjectState){const snapshot=this.apiModelSnapshot();for(const id of Object.keys(p.registry.models))if(apiRoute(id)&&!Object.hasOwn(snapshot.models,id))p.registry.models[id]=[];for(const [id,models]of Object.entries(snapshot.models)){p.registry.providers.add(id);p.registry.models[id]=models}}
 private ollamaAgent(maxSteps?:number){return new ApiAgent('ollama',{vendor:'ollama',...(maxSteps===undefined?{}:{maxSteps}),prepareModel:async(model,signal)=>{await this.network.migrate();if(this.networkRelay.configured('ollama')&&/(?::cloud|-cloud)$/.test(model))throw new ProviderError('capability_unsupported','Подключите Ollama Cloud как API по адресу https://ollama.com/v1 с ключом — тогда маршрут применится');const prepare=this.providerOperations.catalog.get('ollama').prepareModel;if(!prepare)throw new ProviderError('capability_unsupported','Подготовка модели Ollama не подключена');return prepare(model,signal)},service:async signal=>{const p=this.project,models=await this.providerOperations.catalog.get('ollama').models(signal,false);if(!models.length)throw new ProviderError('models_unavailable','Ollama: список моделей пуст');const config:ProviderConfig={api:'openai-completions',baseURL:OLLAMA_URL+'/v1',models:models.map(m=>({id:m.id,name:m.label})),compat:{supportsStore:false,supportsDeveloperRole:false}};return this.modelService(()=>({ollama:config}),()=>()=>{},p,'')}})}
 private provider(vendor:Vendor|'human'):import('@harnessy/providers').Provider{if(vendor==='ollama'){let agent=this.apiAgents.get(vendor);if(!agent){agent=this.ollamaAgent();this.apiAgents.set(vendor,agent)}return agent}const route=apiRoute(vendor);if(route){let agent=this.apiAgents.get(vendor);if(!agent){agent=new ApiAgent(route,{service:()=>this.llm});this.apiAgents.set(vendor,agent)}return agent}const provider=vendor==='human'?null:this.deps.providers[vendor]??(this.providerOperations.catalog.ids().includes(vendor)?this.providerOperations.catalog.provider(vendor):null);if(!provider)throw new RuntimeError('no_provider','нет провайдера: '+vendor,503);return provider}
 providerProbeTurn(seat:import('@harnessy/providers').CliSeat,prompt:string,ctx:import('@harnessy/providers').CliContext):ReturnType<import('@harnessy/providers').Provider['runTurn']>{return seat.vendor==='ollama'?this.ollamaAgent(1).runTurn({...seat,mode:'chat'},prompt,ctx):this.providerOperations.catalog.get(seat.vendor).runTurn(seat,prompt,ctx)}
 private requireOwner(initiator:Initiator,allowQueuedChange=false):void {if(initiator?.seat!=='owner'||initiator.trust!=='owner')throw new RuntimeError('policy_denied','действие доступно только владельцу',403);const p=this.current;if(!p||p.closed)return;if(initiator.source==='autopilot'){const token=this.autopilotApplication.get(p);if(!token||this.autopilotContext.getStore()!==token)throw new RuntimeError('policy_denied','действие Автопилота доступно только внутри подтверждённого применения',403)}else if(!allowQueuedChange)this.guardAutopilotApplication(p)}
 assertOwner(initiator:Initiator):void {this.requireOwner(initiator)}
 private guardAutopilotApplication(p:ProjectState){const token=this.autopilotApplication.get(p);if(token&&this.autopilotContext.getStore()!==token)throw new RuntimeError('autopilot_busy','Автопилот завершает решение; повторите действие после него',409)}
 async withAutopilotGeneration<T>(expectedGeneration:number,apply:(snapshot:AutopilotPermissionSnapshot)=>T|Promise<T>):Promise<T>{
  const p=this.project,job=this.settings.withAutopilotGeneration(expectedGeneration,snapshot=>{
   this.same(p);const token=Symbol('autopilot application');this.autopilotApplication.set(p,token);
   return this.autopilotContext.run(token,async()=>{try{return await apply(snapshot)}finally{this.autopilotApplication.delete(p)}})
  },()=>this.clock.now(),()=>this.same(p));
  let jobs=this.autopilotJobs.get(p);if(!jobs)this.autopilotJobs.set(p,jobs=new Set());jobs.add(job);
  try{return await job}finally{jobs.delete(job)}
 }
 private scheduleAutopilot(p:ProjectState,state:import('@harnessy/projects').AutopilotState){const old=this.autopilotTimers.get(p);if(old!==undefined)this.clock.clearTimeout(old);this.autopilotTimers.delete(p);if(!state.on||state.until?.kind!=='morning')return;const due=Math.max(0,Date.parse(state.until.at)-this.clock.now());const timer=this.clock.setTimeout(()=>{if(this.current===p&&!p.closed)void this.autopilotStatus().catch(error=>this.report(p,p.owner,error))},due);this.autopilotTimers.set(p,timer)}
 async autopilotStatus(){const p=this.project,before=this.settings.autopilot(),state=await this.settings.currentAutopilot(()=>this.clock.now());this.same(p);this.scheduleAutopilot(p,state);if(before.on&&!state.on)p.owner.publish({type:'autopilot',autopilot:state});return state}
 autopilotDecisionLedger(p=this.project):AutopilotDecisionLedger {let ledger=this.autopilotDecisionLedgers.get(p);if(!ledger){ledger=new AutopilotDecisionLedger(p.dir,event=>{if(!p.closed)p.owner.publish(event)},()=>this.clock.now());this.autopilotDecisionLedgers.set(p,ledger)}return ledger}
 autopilotDecisions(initiator:Initiator){this.requireOwner(initiator);const p=this.project,state=this.settings.autopilot(),decisions=this.autopilotDecisionLedger(p).list(),failures:{code:string;reason:string;generation:number;at:string}[]=[];
  const current=(generation:number,at:string)=>generation===state.generation&&Number.isFinite(Date.parse(at))&&state.startedAt!==null&&Date.parse(at)>=Date.parse(state.startedAt);
  for(const row of decisions)if((row.entry.state==='failed'||row.entry.state==='uncertain')&&current(row.entry.generation,row.at))failures.push({code:row.entry.code,reason:row.entry.reason,generation:row.entry.generation,at:row.at});
  // Pre-proposal refusals (e.g. no reviewer) have no decision intent. Read their durable, generation-bound engine notices without a tail limit.
  for(const row of p.journal.read({limit:0})){if(row.from!=='harness'||row.kind!=='note'||row.origin!=='autopilot-owner'||row.to.length!==1||row.to[0]!=='owner')continue;let value:unknown;try{value=JSON.parse(row.text)}catch{continue}if(object(value)&&typeof value.generation==='number'&&current(value.generation,row.ts)&&typeof value.code==='string'&&value.code&&typeof value.reason==='string'&&value.reason)failures.push({code:value.code,reason:value.reason,generation:value.generation,at:row.ts})}
  failures.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));return {ok:true as const,project:p.dir,decisions,lastFailure:failures.at(-1)??null}}

 autopilotCancelDecision(project:string,id:string,effectVersion:string,initiator:Initiator){return cancelAutopilotDecision(this,project,id,effectVersion,initiator)}
 async autopilotSet(body:Record<string,unknown>,initiator:Initiator){this.requireOwner(initiator,true);if(initiator.source==='autopilot')throw new RuntimeError('policy_denied','Автопилот не меняет собственные условия',403);const p=this.project;if(body.project!==p.dir||body.instance!==p.trace.instanceId)throw new RuntimeError('project_changed','Проект сменился; обновите состояние Автопилота',409);const {project:_,instance:__,...change}=body;const state=await this.settings.changeAutopilot(change,()=>this.clock.now(),()=>this.same(p));this.same(p);this.scheduleAutopilot(p,state);p.owner.publish({type:'autopilot',autopilot:state});return {ok:true as const,project:p.dir,autopilot:state}}
 ownerAutopilotAction(p=this.project,initiator:Initiator=OWNER){this.same(p);if(initiator.source==='autopilot'){this.requireOwner(initiator);return}this.guardAutopilotApplication(p);const before=this.settings.autopilot();if(!before.on||before.until?.kind!=='reply')return;const state=this.settings.ownerAutopilotAction();this.scheduleAutopilot(p,state);p.owner.publish({type:'autopilot',autopilot:state})}
 async autopilotCouncilAgent(p:ProjectState,request:AutopilotAgentRequest):Promise<AutopilotAgentReply>{
  this.same(p);const participant=request.participant,pane=this.pane(participant.seat,p);
  if(pane.kind!==participant.role||pane.model!==participant.model||pane.vendor!==participant.vendor||!pane.model)throw new RuntimeError('participant_changed','Место консилиума изменилось',409);
  if(request.signal.aborted)throw new ProviderError('cancelled','Консилиум отменён');
  const hold=reserve(p,[pane],'место консилиума сейчас отвечает');
  let networkTurn:NetworkTurn|undefined,handle:import('@harnessy/providers').TurnHandle|null=null;
  const interrupt=()=>{try{void handle?.interrupt().catch(()=>{})}catch{}};request.signal.addEventListener('abort',interrupt,{once:true});
  try{
   const record=p.channel.postCore({to:[pane.id],kind:'task',text:request.prompt,thread:request.replyTo,origin:COUNCIL_ORIGIN},HARNESS);
   await this.waitVendor(p,pane.vendor);this.same(p);
   if(p.registry.get(pane.id)!==pane||pane.kind!==participant.role||pane.model!==participant.model||pane.vendor!==participant.vendor||request.signal.aborted)throw new RuntimeError('participant_changed','Место консилиума изменилось',409);
   this.validateTurn(pane.vendor,'chat');const seat={...pane.providerSeat(),mode:'chat' as const,sessionId:null,writePaths:[],worktree:null},provider=this.provider(pane.vendor),vendor=provider.vendor;
   networkTurn=this.networkRelay.begin(vendor,'autopilot:'+request.requestId,request.signal);let terminalError:string|null=null,usage:unknown=null,usageIncomplete=false,durationMs=0;const started=this.clock.now();
   const beforeModel=async()=>{const route=apiRoute(vendor);if(route){const config=this.settings.llmProviders()[route];let local=false;try{local=!!config?.baseURL&&['127.0.0.1','localhost','[::1]'].includes(new URL(config.baseURL).hostname)}catch{}if(!local)await this.networkRelay.prepare(vendor,request.signal,networkTurn)}else if(vendor!=='ollama')await this.networkRelay.prepare(vendor,request.signal,networkTurn);networkTurn!.assert();await this.withAutopilotGeneration(request.generation,()=>{this.same(p);if(request.signal.aborted)throw new ProviderError('cancelled','Консилиум отменён')})};
   const ctx:TurnContext={signal:networkTurn.signal,beforeModel,publish:event=>{if(event.type==='error')terminalError=event.text;if(event.type==='done'){usage=event.usage;usageIncomplete=event.usageIncomplete===true;durationMs=event.durationMs}},modelStarted:()=>{},modelResponded:()=>{},askApproval:async()=>false,session:()=>{},setHandle:value=>{handle=value;if(request.signal.aborted)interrupt()},env:apiRoute(vendor)||vendor==='ollama'?{}:await this.networkRelay.environment(vendor,request.signal,networkTurn)??this.connections.proxyEnv(vendor),roleNote:this.roleNote(p,pane),peers:[],tools:councilTools(),relayDepth:0,projectDir:p.dir,appUrl:this.deps.appUrl,registerProcessToken:token=>{if(!p.closed)this.tokens.register(token,p.generation,pane.id,vendor)},revokeProcessToken:token=>this.tokens.revoke(token,p.generation,pane.id,vendor),writableRoots:[],attachments:[]};
   if(!apiRoute(vendor)&&vendor!=='ollama')await beforeModel();
   let result:Awaited<ReturnType<typeof provider.runTurn>>;try{result=await networkTurn.run(async()=>{const started=await this.withAutopilotGeneration(request.generation,()=>{this.same(p);if(request.signal.aborted)throw new ProviderError('cancelled','Консилиум отменён');return {response:provider.runTurn(seat,request.prompt,ctx)}});return started.response})}finally{if(!p.closed){pane.append({...timestampMessage('ai','[консилиум Автопилота]',this.clock.now()),vendor,model:seat.model,usage:usage??{input:null,output:null,cacheRead:null},durationMs:durationMs||this.clock.now()-started,outcome:request.signal.aborted?'interrupted':'ok',deliverySeq:record.seq,runtime:{turnInstanceId:'autopilot:'+request.requestId,recordSeqs:[],effectsPending:false,interrupted:request.signal.aborted,nextSeen:{}}});p.state.saveChats(p.registry)}}handle=null;if(terminalError)throw new ProviderError('turn_failed',terminalError);if(request.signal.aborted)throw new ProviderError('cancelled','Консилиум отменён');
   this.same(p);if(p.registry.get(pane.id)!==pane||pane.kind!==participant.role||pane.model!==participant.model||pane.vendor!==participant.vendor)throw new RuntimeError('participant_changed','Место консилиума изменилось',409);
   p.registry.refreshPolicy();const response=p.channel.postAgentEffect({to:['owner'],kind:participant.role==='reviewer'?'status':'decision',text:result.text,thread:request.replyTo,reply_to:record.seq},{seat:pane.id,trust:'agent'},'auto');
   return Object.freeze({seat:pane.id,model:participant.model,requestId:request.requestId,replyTo:request.replyTo,token:request.token,text:response.text,measured:!usageIncomplete&&measuredUsage(usage)});
  }finally{request.signal.removeEventListener('abort',interrupt);interrupt();try{await networkTurn?.close()}finally{hold.release()}}
 }
 private attachmentStore(p:ProjectState){let store=this.attachmentStores.get(p);if(!store){store=new AttachmentStore(p.dir);this.attachmentStores.set(p,store)}return store}
 attachmentUpload(input:Record<string,unknown>,initiator:Initiator){this.requireOwner(initiator);if(Object.keys(input).length!==1||!Object.hasOwn(input,'base64'))throw new RuntimeError('attachment_invalid','нужно одно поле base64',400);return this.attachmentStore(this.project).upload(input.base64)}
 attachmentRead(id:unknown,initiator:Initiator){this.requireOwner(initiator);return this.attachmentStore(this.project).bytes(id)}
 private modelSupportsImages(p:ProjectState,vendor:string,model:string){const selected=p.registry.models[vendor]?.find(row=>row.id===model);if(!selected)return false;if(apiRoute(vendor)||vendor==='codex')return selected.images===true;try{return this.providerOperations.catalog.peek(vendor).capabilities.images===true}catch{return false}}
 chatAttachments(pane:Pane,value:unknown):AttachmentRef[] {if(value===undefined)return [];if(!Array.isArray(value)||value.length>ATTACHMENT_MAX_COUNT||value.some(id=>typeof id!=='string'||!/^[0-9a-f]{64}$/.test(id))||new Set(value).size!==value.length)throw new RuntimeError('attachments_invalid','attachments — до '+ATTACHMENT_MAX_COUNT+' разных идентификаторов изображений',400);const p=this.project,refs=value.map(id=>{const {path:_,...ref}=this.attachmentStore(p).resolve(id);return ref});if(refs.length&&!this.modelSupportsImages(p,pane.vendor,pane.model))throw new RuntimeError('images_unsupported','Выбранная модель не видит изображения',409);return refs}
 private same(p:ProjectState):void{if(this.current!==p||p.closed)throw new RuntimeError('project_changed','проект сменился',409)}
 private pane(id:string,p=this.project):Pane{const pane=p.registry.get(id);if(!pane)throw new RuntimeError('pane_unknown','нет окна',404);return pane}
 labelOf(id:string,p=this.project){return id==='owner'?'владелец':id==='harness'?'харнесс':p.registry.get(id)?.label??id}
 subscribe(selector:Selector){if('pane' in selector)this.pane(selector.pane!);return this.project.bus.subscribe(selector)}
 projectPath(path:string,root=canonicalPath(projectsRoot(this.settings.effective()))):string {const target=canonicalPath(path);if(target===root)throw new RuntimeError('path_is_root','это папка всех проектов: выберите или создайте проект внутри',400);return target}
 private async changeProject<T>(operation:()=>Promise<T>):Promise<T> {
 const previous=this.opening;let release!:()=>void;this.opening=new Promise(r=>{release=r});await previous;
 try{return await operation()}finally{release()}
 }
 async openProject(dir:string,options:{expected?:ProjectState;initialize?:(p:ProjectState)=>void|Promise<void>;deferPumps?:boolean;roomModel?:string}={}):Promise<void> {
 const current=this.current;if(current&&this.autopilotApplication.has(current))throw new RuntimeError('autopilot_busy','Автопилот завершает решение; дождитесь его окончания',409);
 return this.changeProject(()=>this.openProjectLocked(dir,options))
 }
 private async openProjectLocked(dir:string,options:{expected?:ProjectState;initialize?:(p:ProjectState)=>void|Promise<void>;deferPumps?:boolean;roomModel?:string},root=canonicalPath(projectsRoot(this.settings.effective()))):Promise<void> {
 if(options.expected)this.same(options.expected);const previous=this.current,path=realpathSync(this.projectPath(dir,root)),roomModel=options.roomModel||previous?.registry.get('room')?.model;await this.closeProjectLocked();
 let harness:string;
 try{harness=await withPathLock(path,lock=>ensureLineLocked(lock,this.projectPath(path,root)))}
 catch(e){
  // Closing hides project-scoped settings; retain the original root for both the check and the recovery door.
  if(e instanceof RuntimeError&&e.code==='path_is_root'&&previous)await this.openProjectLocked(previous.dir,{},root);
  throw e
 }
 const generation=++this.generation,lineErrors:string[]=[];let team=null,policy=null;
 try{team=loadTeam(harness);lineErrors.push(...team.warnings)}catch(e){lineErrors.push(message(e))}
 try{policy=new Policy(join(harness,'comms-policy.yaml'))}catch(e){lineErrors.push(message(e))}
 let registry!:Registry,owner!:Pane;
 const bus=new EventBus(()=>{const panes=[owner,...registry.panes.values()];return [...panes.flatMap(p=>[...p.approvals.values()].map(a=>({pane:p.id,event:a.event()}))),...panes.filter(p=>p.uncertainNote).map(p=>({pane:p.id,replay:true,event:{type:'note',text:p.uncertainNote,warning:this.warningId(this.project,p,'uncertain')}})),...panes.filter(p=>p.recoveryNote).map(p=>({pane:p.id,replay:true,event:{type:'note',text:p.recoveryNote,warning:this.warningId(this.project,p,'recovery')}})),...panes.filter(p=>p.recoveryError).map(p=>({pane:p.id,replay:true,event:p.recoveryError!}))]});
 const models={...this.deps.models};if(!this.deps.models){const entries=Object.entries(this.deps.providers) as [Vendor,import('@harnessy/providers').Provider][];const results=await Promise.allSettled(entries.map(([,provider])=>provider.models()));for(let i=0;i<entries.length;i++){const result=results[i]!;if(result.status==='fulfilled')models[entries[i]![0]]=result.value;else lineErrors.push(message(result.reason))}}
 Object.assign(models,this.apiModelSnapshot().models);const registered=new Set([...Object.keys(this.deps.providers),...this.providerOperations.catalog.ids(),...Object.keys(models).filter(id=>apiRoute(id)),...Object.values(team?.seats??{}).map(s=>s.vendor).filter(id=>apiRoute(id))]);const seats=Object.values(team?.seats??{}).filter(seat=>{if(seat.vendor==='claude'||seat.vendor==='codex'||registered.has(seat.vendor))return true;lineErrors.push('место '+seat.id+': неизвестная программа '+seat.vendor);return false});
 registry=new Registry(path,models,seats,bus,this.clock,registered);registry.policy=policy;
 owner=new Pane({id:'owner',vendor:'human',label:'владелец',model:'',cwd:path,role:'owner'},bus,this.clock);
 const journal=new Journal(path,{now:()=>new Date(this.clock.now()),...this.deps.journalOptions});
 registry.policyChanged=policy=>{journal.append({sender:'harness',to:['*'],kind:'policy',text:'политика связи перечитана: версия '+policy.version,policy:policy.version})};
 const git=await openProjectGit(path,Object.values(team?.seats??{}),team?.integrationBranch??'main',this.deps.gitops??gitops);lineErrors.push(...git.lineErrors);
 for(const pane of registry.panes.values()){pane.cwd=git.cwdBySeat[pane.id]??path;pane.worktree=git.worktreeBySeat[pane.id]??null;pane.branch=git.branchBySeat[pane.id]??null}
 const gitFact=(args:string[]):string|null=>{if(!git.repoRoot)return null;try{return execFileSync('git',['-C',git.repoRoot,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim()||null}catch{return null}};
 const channel=new Channel({journal,policy,projectDir:path,liveSeats:()=>registry.ids,roleOf:id=>registry.roleOf(id),labelOf:id=>id==='owner'?'владелец':id==='harness'?'харнесс':registry.get(id)?.label??id,hasRepo:()=>!!git.repoRoot,resolveSha:sha=>gitFact(['rev-parse','--verify','--end-of-options',sha+'^{commit}']),mergeCommitFor:sha=>{if(!git.repoRoot)return null;const branch=team?.integrationBranch??'main';try{execFileSync('git',['-C',git.repoRoot,'merge-base','--is-ancestor',sha,branch],{stdio:'ignore',timeout:5000})}catch{return null}return gitFact(['rev-list','--merges','--ancestry-path','--reverse',sha+'..'+branch])?.split(/\s+/)[0]??sha}});
 const saved=journal.loadPanes();if(object(saved.room)&&(typeof saved.room.model==='string'||saved.room.model===null)&&typeof saved.room.mode==='string')makeRoomIn({registry,dir:path,bus},this,saved.room.model,saved.room.mode,typeof saved.room.vendor==='string'&&(saved.room.vendor==='claude'||saved.room.vendor==='codex'||registered.has(saved.room.vendor))?saved.room.vendor:undefined);for(const pane of registry.panes.values()){const st=saved[pane.id];if(!object(st))continue;if(typeof st.vendor==='string'&&(st.vendor==='claude'||st.vendor==='codex'||registered.has(st.vendor)))pane.vendor=st.vendor;registry.update(pane,{model:st.model,mode:st.mode,sessionId:st.sessionId??null,digest:st.digest??false});if(pane.id==='room')pane.folderless=typeof st.folderless==='boolean'?st.folderless:pane.mode==='chat'}
 const freshRoom=saved.room===undefined&&!registry.get('room')&&team!==null&&!Object.keys(team.seats).length;if(freshRoom)makeRoomIn({registry,dir:path,bus},this,roomModel||'',path===this.defaultDir?'chat':'read');
 const state=new StateStore(path,this.deps.stateIO??diskIO,this.clock,this.deps.id);const halted=state.load(registry,lineErrors);
 if(saved.room===undefined&&roomModel&&!registry.get('room')&&makeRoomIn({registry,dir:path,bus},this,roomModel,path===this.defaultDir?'chat':'read'))state.savePanes(registry,journal);
 const trace=new TraceStore(path,()=>this.traceConfig,()=>this.clock.now(),id=>id===owner.id||!!registry.get(id)||Object.values(state.chats.chats).some(chat=>chat.pane===id));this.traces.add(trace);await trace.restore();
 const p:ProjectState={trace,generation,dir:path,closed:false,starting:true,now:()=>this.clock.now(),editing:new Map(),materializing:new Set(),restoreFailed:new Map(),team,repoRoot:git.repoRoot,policy,journal,channel,registry,owner,bus,state,lineErrors,halted,active:new Map(),pumps:new Map(),resets:new Map(),routeJobs:new Map(),processEpoch:new Map(),wakeups:new Set()};
 this.networkRelay.reopen();this.current=p;this.syncApiModels(p);this.traceEvents(p);channel.on(event=>{if(!p.closed)this.onChannel(p,event)});
 try{await this.projectRegistry.rememberProject(path)}catch(e){lineErrors.push(message(e))}
 await this.actions.restorePendingAcks({runtime:this,project:p});
 await restoreProposals(this,p);
 try{await restoreAssignments(this,p)}catch(e){lineErrors.push(message(e));for(const id of registry.ids)p.restoreFailed.set(id,message(e))}
 for(const id of p.materializing){p.restoreFailed.set(id,[...lineErrors].reverse().find(text=>text.startsWith('назначение '+id+' '))??lineErrors.at(-1)??'восстановление назначения не завершено')}p.materializing.clear();
 await restorePromotions(this,p);
 try{this.tasksStore(p).recover()}catch(e){lineErrors.push(message(e));for(const id of registry.ids)p.restoreFailed.set(id,message(e))}
 try{await options.initialize?.(p)}catch(e){p.starting=false;throw e}
 try{await this.restoreAttemptDecisions(p)}catch(e){lineErrors.push(message(e));for(const id of registry.ids)p.restoreFailed.set(id,message(e))}
 for(const pane of registry.panes.values()){
 const attempt=state.attempts[pane.id],matched=attempt&&state.results(pane).some(r=>object(r.runtime)&&r.runtime.turnInstanceId===attempt.turnInstanceId);
 if(attempt&&!matched){pane.status='uncertain';try{state.uncertain(pane.id)}catch(e){lineErrors.push(message(e))}pane.uncertainNote=waitingError(p,pane).message;pane.publish({type:'note',text:pane.uncertainNote,warning:this.warningId(p,pane,'uncertain')})}
 else {await this.recover(p,pane)}
 }
 if(!lineErrors.some(text=>text.startsWith('chats.json не читается'))){if(freshRoom)state.savePanes(registry,journal);else state.saveChats(registry)}
 p.starting=false;this.autopilotEngines.set(p,new RuntimeAutopilotEngine(this,p));this.autopilotEngines.get(p)!.wake();try{await this.autopilotStatus()}catch(error){lineErrors.push('Автопилот: '+message(error))}this.quota(p).start();this.providerOperations.start(p);if(!halted&&!options.deferPumps)for(const pane of registry.panes.values())if((pane.status==='idle'||p.state.attempts[pane.id]?.unsent)&&!p.materializing.has(pane.id)&&!p.restoreFailed.has(pane.id))await this.resumeQueue(pane.id,p);
 }
 async projectSet(path:string,options:{reload?:boolean},initiator:Initiator){
 this.requireOwner(initiator);const p=this.project;
 if(!validDir(path))throw new RuntimeError('path_invalid','папки нет или это не папка: '+path,400);
 return this.changeProject(async()=>{
 this.same(p);this.requireOwner(initiator);const target=this.projectPath(path);if(target===p.dir&&!options.reload)return {ok:true as const,project:target,changed:false as const};
 const hold=reserve(p,[...p.registry.panes.values()],'идёт ход: смени папку, когда все окна свободны',true);
 try{if(!validDir(target))throw new RuntimeError('path_invalid','папки нет или это не папка: '+path,400);await this.openProjectLocked(target,{expected:p});const next=this.project;return {ok:true as const,project:next.dir,changed:true as const,lineErrors:[...next.lineErrors],panes:[...next.registry.panes.values()].map(p=>p.settings())}}
 finally{hold.release()}
 })
 }
 async projectCreate(input:{path?:unknown;git?:unknown;model?:unknown},initiator:Initiator){
 this.requireOwner(initiator);const p=this.project,path=expandUser(pythonTrim(String(input.path||'')));
 if(!path||!isAbsolute(path)||[...path].length>400)throw new RuntimeError('path_invalid','нужен абсолютный путь папки',400);
 return this.changeProject(async()=>{
 this.same(p);this.requireOwner(initiator);const target=this.projectPath(path),busyText='идёт ход: создай папку, когда все окна свободны';let hold=reserve(p,[...p.registry.panes.values()],busyText,true);
 try{
 let info:Awaited<ReturnType<typeof initProject>>;
 try{info=await initProject(target,{git:input.git===undefined||pyTruthy(input.git),model:String(input.model||''),orchestrator:false},{...(this.deps.gitops?{gitops:this.deps.gitops}:{}),catalog:structuredClone(p.registry.models),...(p.registry.get('room')?.model?{roomModel:p.registry.get('room')!.model}:{}),settings:structuredClone(this.settings.effective()),validatePath:()=>{this.same(p);this.requireOwner(initiator)}})}
 catch(e){if(e instanceof RuntimeError&&['project_changed','autopilot_busy','policy_denied'].includes(e.code))throw e;throw new RuntimeError('project_failed','проект не создан: '+message(e),400,{cause:e})}
 this.same(p);this.requireOwner(initiator);
 // Reacquire for the current seats synchronously; closing marks the project closed before the next await.
 hold.release();hold=reserve(p,[...p.registry.panes.values()],busyText,true);
 await this.openProjectLocked(target,{expected:p,...(typeof input.model==='string'?{roomModel:input.model}:{})});const next=this.project;
 return {ok:true as const,project:next.dir,...info,seats:[...next.registry.panes.values()].filter(p=>p.id!=='room').length}
 }finally{hold.release();if(this.current===p&&!p.closed)for(const id of p.registry.ids)void this.kick(id)}
 })
 }
 async closeProject():Promise<void>{const active=this.current&&this.autopilotEngines.get(this.current);active?.close();await active?.idle();const p=this.current,jobs=p&&this.autopilotJobs.get(p);if(jobs?.size)await Promise.allSettled([...jobs]);return this.changeProject(()=>this.closeProjectLocked())}
 private async closeProjectLocked():Promise<void>{const p=this.current;if(!p||p.closed)return;if(p.state.undurable.size){try{p.state.saveChats(p.registry);p.state.undurable.clear()}catch(e){throw new RuntimeError('write_failed','ответ модели не сохранён: '+p.state.chatsPath+': '+message(e),409,{cause:e,fields:{path:p.state.chatsPath}})}}p.closed=true;const timer=this.autopilotTimers.get(p);if(timer!==undefined)this.clock.clearTimeout(timer);this.autopilotTimers.delete(p);this.actions.closeProject?.(p);const turns=[...p.active.values()];
 this.quotas.get(p)?.close();this.cliQuotas.get(p)?.close();for(const turn of turns)this.cancelTurn(turn.pane.id,'project_closed',p);
 await this.networkProviderChecks.closeProject(p);p.owner.denyApprovals();p.bus.close();this.tokens.clear();this.scopes.clear();await this.providerOperations.cancel(p);
 let failure:unknown;try{await Promise.all([...Object.values(this.deps.providers),...this.apiAgents.values()].map(provider=>provider?.close()))}catch(e){failure=e}
 for(const turn of turns)turn.releaseReset();await Promise.all(turns.map(t=>t.finished));if(failure)throw failure
 }
 private onChannel(p:ProjectState,event:ChannelEvent):void {
 if(event.type==='rejected')p.trace.record('queue.rejected',{outcome:'rejected',reason:{code:'approval_policy',text:event.reason}});
 if(event.type==='posted')p.trace.record('queue.posted',{refs:{journalSeq:event.record.seq},data:{kind:event.record.kind,from:event.record.from,to:event.record.to,text:event.record.text}});
 if(event.type==='posted')p.registry.get(event.initiator.seat)?.publish({type:'sent',record:event.record});
 if(event.type==='rejected')p.registry.get(event.sender)?.publish({type:'toolError',text:'политика: '+event.reason});
 if(event.type==='pendingAck'){void this.actions.restorePendingAcks({runtime:this,project:p}).catch(e=>this.report(p,p.owner,e));return}
 if(event.type!=='delivered'||event.record.origin==='steer'||event.record.origin===COUNCIL_ORIGIN)return;
 for(const id of event.record.to){if(id==='owner'){p.owner.publish({type:'owner',record:event.record});if(['question','blocker','escalation'].includes(event.record.kind))this.autopilotEngines.get(p)?.wake();continue}const pane=p.registry.get(id);if(!pane)continue;
 pane.publish({type:'queued',record:event.record,pending:p.journal.pendingFor(id).length});
 if(event.record.kind==='stop')this.cancelTurn(id,'stop',p);
 if(pane.status==='uncertain'&&!(p.state.attempts[id]?.unsent&&event.record.from==='owner'&&['task','question','note'].includes(event.record.kind))){this.stateEvent(p,pane);continue}void this.kick(id)
 }
 }
 waiting(id:string){const p=this.project,pane=this.pane(id,p);if(p.restoreFailed.has(id))return null;const info=waiting(p,pane);if(info)return info;const pending=this.attemptDecisions(p).find(d=>d.record.attempt!.pane===id&&!d.done);if(!pending)return null;const a=pending.record.attempt!,result=p.state.results(pane).find(r=>r.runtime?.turnInstanceId===a.turnInstanceId);return {status:a.action==='finish'?'recovering' as const:'uncertain' as const,recordSeqs:Array.isArray(result?.runtime.recordSeqs)?[...result.runtime.recordSeqs]:[],startedAt:null,turnInstanceId:a.turnInstanceId,actions:[a.action]}}
 publishState(id:string):void {const p=this.project;this.stateEvent(p,this.pane(id,p))}
 private warningId(p:ProjectState,pane:Pane,kind:string):string {return pane.id+':'+(waiting(p,pane)?.turnInstanceId??p.active.get(pane.id)?.scope.turnInstanceId??'episode:'+p.generation)+':'+kind}
 private taskStores=new WeakMap<ProjectState,TaskStore>();
 private tasksStore(p=this.project){let store=this.taskStores.get(p);if(!store){store=new TaskStore(p);this.taskStores.set(p,store)}return store}
 async tasksList(initiator:Initiator,scope?:TurnScope){const p=this.project;return locked(this,p,()=>{if(initiator.trust==='owner')this.requireOwner(initiator);else {if(!scope||scope.seatId!==initiator.seat)throw new RuntimeError('owner_only','Нужно подтверждённое место',403);this.scopes.assert(scope);if(scope.projectDir!==p.dir||!p.registry.canObserve(scope.seatId,'owner'))throw new RuntimeError('policy_denied','Политика не разрешает читать очередь владельца',403)}const store=this.tasksStore(p);store.recover();return store.list()})}
 async taskChange(action:'create'|'assign',body:Record<string,unknown>,initiator:Initiator,id?:string){this.requireOwner(initiator,true);const p=this.project;return locked(this,p,()=>{if(body.project!==p.dir||body.instance!==p.trace.instanceId&&!this.tasksStore(p).hasOperation(body.opId))throw new RuntimeError('project_changed','Проект изменился; обновите очередь',409);this.guardAutopilotApplication(p);const task=this.tasksStore(p).change(action,body,id);this.ownerAutopilotAction(p,initiator);if(task.to)void this.kick(task.to);return {ok:true,project:p.dir,instance:p.trace.instanceId,task}},initiator)}
 postOwner(input:AgentPostInput,initiator:Initiator):Record_ {this.requireOwner(initiator);const p=this.project,targets=Array.isArray(input.to)?input.to:[input.to];if(input.kind!=='stop'&&[...p.registry.panes.keys()].some(id=>(targets.includes(id)||targets.includes('*'))&&(p.editing.has(id)||p.materializing.has(id)||p.restoreFailed.has(id))))throw new RuntimeError('busy','назначение или изменение разговора ещё не завершено',409);p.registry.refreshPolicy();const record=p.channel.postCore({...input,thread:input.thread??(input.kind==='task'?'T'+(p.journal.lastSeq+1):null)},OWNER);this.ownerAutopilotAction(p,initiator);return record}
 private report(p:ProjectState,pane:Pane,error:unknown,turnInstanceId?:string):void{if(!p.closed){const failure=turnFailure(error,p.dir,0),event={type:'error',message:failure.reason,sessionId:pane.sessionId,code:failure.code,...(turnInstanceId?{turnInstanceId}:{}),waiting:pane.status==='uncertain'?this.waiting(pane.id):null,warning:this.warningId(p,pane,'error')};if(pane.status==='recovering'||pane.status==='uncertain')pane.recoveryError=event;pane.publish(event)}}
 private stateEvent(p:ProjectState,pane:Pane){if(!p.closed)pane.publish({type:'state',...pane.settings(),settingsBinding:this.paneBinding(pane.id,p),pending:p.journal.pendingFor(pane.id).length,status:pane.status,waiting:this.waiting(pane.id)})}
 private attemptDecisions(p:ProjectState):{record:Record_;done:Record_|null}[] {
  const entries:{record:Record_;done:Record_|null}[]=[];
  for(const record of p.journal.read({limit:0})){if(record.from!=='harness'||record.kind!=='note'||record.origin!=='attempt')continue;
   const a=record.attempt,invalid=()=>new RuntimeError('decision_invalid','решение попытки не читается: #'+record.seq,409);
   if(!a||a.autopilot!==undefined&&(!object(a.autopilot)||typeof a.autopilot.model!=='string'||!a.autopilot.model||typeof a.autopilot.vendor!=='string'||!a.autopilot.vendor)||typeof a.pane!=='string'||!a.pane||a.chat!==undefined&&(typeof a.chat!=='string'||!a.chat)||typeof a.turnInstanceId!=='string'||!a.turnInstanceId||!['retry','skip','finish'].includes(a.action)||typeof a.done!=='boolean'||a.recordSeqs!==undefined&&(!Array.isArray(a.recordSeqs)||a.recordSeqs.some(seq=>!Number.isSafeInteger(seq)||seq<=0)||new Set(a.recordSeqs).size!==a.recordSeqs.length)||a.deliverySeq!==null&&(!Number.isSafeInteger(a.deliverySeq)||a.deliverySeq<0)||a.action==='skip'&&a.deliverySeq===null||record.thread!=='attempt:'+a.turnInstanceId||record.to.length!==1||record.to[0]!=='owner')throw invalid();
   if(!a.done){if(record.reply_to!==null||entries.some(d=>d.record.attempt!.pane===a.pane&&d.record.attempt!.turnInstanceId===a.turnInstanceId))throw invalid();entries.push({record,done:null})}
   else {const decision=entries.find(d=>d.record.seq===record.reply_to&&d.record.attempt!.pane===a.pane&&d.record.attempt!.chat===a.chat&&d.record.attempt!.turnInstanceId===a.turnInstanceId&&d.record.attempt!.action===a.action&&d.record.attempt!.deliverySeq===a.deliverySeq);if(!decision)throw invalid();decision.done??=record}
  }return entries
 }
 private decisionResult(record:Record_){const a=record.attempt!;return {ok:true as const,pane:a.pane,turnInstanceId:a.turnInstanceId,action:a.action,seq:record.seq}}
 private async finishDecision(p:ProjectState,record:Record_):Promise<void> {
  const a=record.attempt!,pane=this.pane(a.pane,p),current=p.state.attempts[a.pane];
  if(current&&current.turnInstanceId!==a.turnInstanceId)throw new RuntimeError('stale_attempt','ожидание этого места уже изменилось');
  if(a.action==='finish'){if(!p.state.results(pane).some(r=>r.runtime?.turnInstanceId===a.turnInstanceId))throw new RuntimeError('stale_attempt','сохранённый результат уже изменился');if(!await this.recover(p,pane,true))throw waitingError(p,pane);this.same(p)}
  else {if(a.action==='skip')p.journal.advance(a.pane,a.deliverySeq!);if(current)p.state.clearAttempt(a.pane)}
  const range=record.text.match(/ #\d+–#\d+$/)?.[0].trim()??'',text=a.action==='skip'?'пропущено владельцем'+(range?': '+range:''):'решение владельца выполнено: '+(a.action==='retry'?'повторить':'завершить восстановление')+(range?' '+range:'');
  if(!this.attemptDecisions(p).find(d=>d.record.seq===record.seq)?.done)p.journal.append({sender:'harness',to:['owner'],kind:'note',origin:'attempt',thread:record.thread,reply_to:record.seq,text,attempt:{...a,done:true}});
  pane.status='idle';pane.uncertainNote=null;pane.recoveryNote=null;pane.recoveryError=null;this.stateEvent(p,pane)
 }
 private async restoreAttemptDecisions(p:ProjectState,only?:Pane):Promise<void> {
  for(const decision of this.attemptDecisions(p)){if(decision.done||only&&decision.record.attempt!.pane!==only.id)continue;const pane=p.registry.get(decision.record.attempt!.pane);if(!pane)throw new RuntimeError('decision_invalid','место решения больше не существует');
   await locked(this,p,async()=>{const hold=reserve(p,[pane],'место занято: завершается решение владельца',true);try{await this.finishDecision(p,decision.record)}finally{hold.release()}})
  }
 }
 async attempt(id:string,input:Record<string,unknown>,initiator:Initiator){
  this.requireOwner(initiator);const p=this.project;
  if(typeof input.project!=='string'||typeof input.turnInstanceId!=='string'||!input.turnInstanceId||typeof input.action!=='string'||!['retry','skip','finish'].includes(input.action))throw new RuntimeError('attempt_invalid','нужны project, turnInstanceId и action: retry|skip|finish',400);
  if(input.project!==p.dir)throw new RuntimeError('project_changed','проект сменился');
  if(input.network!==undefined&&(input.network!=='direct_once'||input.action!=='retry'))throw new RuntimeError('attempt_invalid','прямое подключение доступно только для одного повтора',400);
  const result=await locked(this,p,async()=>{this.requireOwner(initiator);const pane=this.pane(id,p),previous=this.attemptDecisions(p).find(d=>d.record.attempt!.pane===id&&d.record.attempt!.turnInstanceId===input.turnInstanceId);
   if(previous){if(previous.record.attempt!.action!==input.action||previous.record.attempt!.network!==input.network)throw new RuntimeError('decision_exists','для этой попытки уже сохранено другое решение');if(previous.done)return this.decisionResult(previous.record)}
   if(p.restoreFailed.has(id))free(p,pane);
   const hold=reserve(p,[pane],'место занято: идёт ход',true);
   try{p.state.refreshDamage(p.registry);for(const [sid,a] of Object.entries(p.state.attempts))if(a.turnInstanceId.startsWith('unreadable:')){const other=p.registry.get(sid);if(other)other.status='uncertain'}
    const info=waiting(p,pane);if(!previous){if(!info)throw new RuntimeError('not_waiting','место не ждёт итога хода');if(info.turnInstanceId!==input.turnInstanceId)throw new RuntimeError('stale_attempt','ожидание этого места уже изменилось',409,{fields:{pane:id,project:p.dir,waiting:info}});if(!info.actions.includes(input.action as 'retry'|'skip'|'finish'))throw new RuntimeError('attempt_invalid','это решение недоступно для текущего ожидания',409,{fields:{pane:id,project:p.dir,waiting:info}})}
    const direct=input.network==='direct_once';let grantedBinding:string|null=null;if(direct){const expected=this.paneBinding(id,p),binding=input.binding;if(!object(binding)||Object.entries(expected).some(([k,v])=>binding[k]!==v)||!expected.networkGeneration)throw new RuntimeError('binding_changed','Настройки изменились — решите заново',409,{fields:{pane:id,project:p.dir,waiting:info,settingsBinding:expected}});if(!info?.recordSeqs.length||!info.failure||!['network_unavailable','network_no_reserve','network_country_unverified','network_proxy_auth','network_changed'].includes(info.failure.code)||!['ssh','proxy'].includes(this.networkRelay.summary(pane.vendor)?.type??''))throw new RuntimeError('attempt_invalid','Для этого ожидания прямой повтор недоступен');grantedBinding=JSON.stringify(expected);}
    const action=input.action as AttemptDecision['action'],deliverySeq=previous?previous.record.attempt!.deliverySeq:action==='finish'?p.state.results(pane).find(r=>r.runtime?.turnInstanceId===input.turnInstanceId)!.deliverySeq:p.state.deliveryBoundary(id,p.journal);
    const seqs=info?.recordSeqs??[],range=seqs.length?' #'+seqs[0]+'–#'+seqs.at(-1):'',label=action==='retry'?'повторить':action==='skip'?'пропустить':'завершить восстановление';
    const attemptChat=p.state.activeChat(pane,false);
    const record=previous?.record??p.journal.append({sender:'harness',to:['owner'],kind:'note',origin:'attempt',thread:'attempt:'+input.turnInstanceId,text:'владелец решил: '+label+range,attempt:{pane:id,...(attemptChat?.pane===id&&attemptChat.id?{chat:attemptChat.id}:{}),turnInstanceId:input.turnInstanceId as string,action,...(initiator.source==='autopilot'?{autopilot:{model:pane.model,vendor:pane.vendor}}:{}),...(direct?{network:'direct_once' as const}:{}),...(info?.status==='unsent'?{unsent:true as const}:{}),recordSeqs:[...seqs],deliverySeq,done:false}});
    await this.finishDecision(p,record);if(direct){let grants=this.directRetries.get(p);if(!grants)this.directRetries.set(p,grants=new Map());grants.set(id,{binding:grantedBinding!,seqs:[...seqs]})}return this.decisionResult(record)
   }catch(e){const pending=this.attemptDecisions(p).find(d=>d.record.attempt!.pane===id&&!d.done);if(pending){pane.status=pending.record.attempt!.action==='finish'?'recovering':'uncertain';this.report(p,pane,e)}throw e}finally{hold.release()}
  });this.ownerAutopilotAction(p,initiator);if(!p.closed)void this.kick(id);return result
 }
 kick(id:string):Promise<void> {const p=this.project,pane=this.pane(id,p),running=p.pumps.get(id);p.wakeups.add(id);if(running)return running;
 let again=false;
 const promise=Promise.resolve().then(async()=>{do{p.wakeups.delete(id);again=await this.pump(p,pane)}while(again&&p.wakeups.has(id)&&!p.closed)}).catch(e=>{again=false;this.report(p,pane,e)}).finally(()=>{if(p.pumps.get(id)===promise)p.pumps.delete(id);if(again&&p.wakeups.has(id)&&!p.closed)void this.kick(id)});p.pumps.set(id,promise);return promise
 }
 async resumeQueue(id:string,p=this.project):Promise<void> {await p.pumps.get(id);if(this.current===p&&!p.closed)void this.kick(id)}
 async idle():Promise<void>{const p=this.project;do{while(p.pumps.size)await Promise.all([...p.pumps.values()]);await this.autopilotEngines.get(p)?.idle()}while(p.pumps.size)}
 private async pump(p:ProjectState,pane:Pane):Promise<boolean>{
 if(p.closed||p.starting||pane.busy||p.editing.has(pane.id)||p.materializing.has(pane.id)||p.restoreFailed.has(pane.id))return false;
 if(firstOpenPending(p,pane))return false;
 await this.restoreAttemptDecisions(p,pane);
 const unsent=p.state.attempts[pane.id];
 let combine=unsent?.unsent&&p.journal.pendingFor(pane.id).some(e=>e.record.from==='owner'&&['task','question','note'].includes(e.record.kind)&&e.record.seq>unsent.unsent!.afterSeq)?unsent:null;
 if(combine&&!p.halted)pane.status='idle';else if(!await this.recover(p,pane))return false;
 while(!p.closed&&!p.halted&&!pane.busy){if((!combine&&p.state.attempts[pane.id]?.status==='uncertain')||pane.status==='uncertain')return false;
 let entries=p.journal.pendingFor(pane.id).filter(e=>e.record.origin!=='steer');if(!entries.length)return true;
 const retry=!combine?this.attemptDecisions(p).find(d=>d.done&&d.record.attempt?.pane===pane.id&&d.record.attempt.unsent&&d.record.attempt.action==='retry'&&d.record.attempt.deliverySeq! > (p.journal.cursors[pane.id]??0)):null;
 if(retry)entries=entries.filter(e=>e.deliverySeq<=retry.record.attempt!.deliverySeq!);
 const direct=this.directRetries.get(p)?.get(pane.id);this.directRetries.get(p)?.delete(pane.id);if(direct){if(direct.seqs.some(seq=>!entries.some(e=>e.record.seq===seq)))throw new RuntimeError('binding_changed','Разговор изменился; прямой повтор отменён');entries=entries.filter(e=>direct.seqs.includes(e.record.seq));this.assertDirectReady(p,pane,direct.binding,entries)}
 const records=entries.map(e=>e.record),work=records.filter(r=>r.kind!=='stop');for(const record of work)p.trace.record('queue.taken',{pane:pane.id,refs:{journalSeq:record.seq}},p.trace.forJournal(record.seq));pane.publish({type:'delivered',records});
 if(!work.length){p.journal.advance(pane.id,Math.max(...entries.map(e=>e.deliverySeq)));continue}
 try{await this.runTurn(pane.id,renderInbox(work,id=>this.labelOf(id,p)),{entries,project:p,...(combine?{combined:combine.recordSeqs}:{}),...(direct?{directOnce:direct.binding}:{})})}catch(e){if(!p.closed){if(!p.state.attempts[pane.id]&&pane.status==='idle'&&!(e instanceof RuntimeError&&e.code==='stale_attempt')){p.state.startAttempt(pane,{turnInstanceId:randomUUID(),recordSeqs:records.map(r=>r.seq),deliverySeq:Math.max(...entries.map(e=>e.deliverySeq)),startedAt:this.clock.now()});p.state.notSent(pane.id,p.journal.lastSeq,turnFailure(e,p.dir,0));pane.status='uncertain';this.report(p,pane,e)}if(!p.state.attempts[pane.id]?.unsent)pane.publish({type:'note',text:queueNote(work.length)});this.stateEvent(p,pane)}return false}
 combine=null;if(pane.status==='recovering')return false
 }return true
 }
 private async recover(p:ProjectState,pane:Pane,throwErrors=false):Promise<boolean>{
 if(p.closed)return false;
 const results=p.state.results(pane);let complete=true;
 try{for(const result of results){const rt=result.runtime;
 if(rt&&Number.isSafeInteger(result.deliverySeq)&&result.deliverySeq<=(p.journal.cursors[pane.id]??0)&&rt.effectsPending===false&&!p.state.undurable.has(rt.turnInstanceId)&&p.state.attempts[pane.id]?.turnInstanceId!==rt.turnInstanceId)continue;
 p.state.validate(result,pane,p.journal);
 const replaying=!throwErrors||pane.status==='recovering';pane.status='recovering';if(replaying){pane.recoveryNote='ответ модели сохранён; завершается восстановление доставки';pane.publish({type:'note',text:pane.recoveryNote,warning:this.warningId(p,pane,'recovery')})}
 if(p.state.undurable.has(result.runtime.turnInstanceId)){p.state.saveChats(p.registry);p.state.undurable.delete(result.runtime.turnInstanceId)}
 if(p.state.attempts[pane.id]?.turnInstanceId===result.runtime.turnInstanceId)p.state.clearAttempt(pane.id);
 p.journal.advance(pane.id,result.deliverySeq);
 const records=deepFreeze(result.runtime.recordSeqs.map(seq=>p.journal.get(seq)!));
 if(result.runtime.interrupted){const thread='turn:'+result.runtime.turnInstanceId;if(!p.journal.read({limit:0,thread}).some(r=>r.origin==='interrupt')){const last=Math.max(0,...records.map(r=>r.seq)),text='ход прерван владельцем'+(last?' после записи #'+last:'');p.channel.postCore({to:['owner'],kind:'note',text,origin:'interrupt',thread},HARNESS);pane.publish({type:'note',text})}}
 const effects=await this.actions.afterTurn({runtime:this,project:p,pane,turnInstanceId:result.runtime.turnInstanceId,records,text:result.text,interrupted:result.runtime.interrupted});
 if(p.closed)return false;
 pane.seen={...result.runtime.nextSeen};pane.carry='';p.state.savePanes(p.registry,p.journal);
 if(effects==='completed')p.state.finishEffects(result,p.registry);else complete=false
 }
 if(p.state.attempts[pane.id]){pane.status='uncertain';return false}pane.status=complete?'idle':'recovering';if(complete){pane.recoveryError=null;pane.recoveryNote=null;pane.uncertainNote=null};this.stateEvent(p,pane);return complete
 }catch(e){pane.status='recovering';if(throwErrors)throw e;this.report(p,pane,e);return false}
 }
 private actionContext(p:ProjectState,turn:ActiveTurn):ActionContext {return Object.freeze({runtime:this,scope:turn.scope,turnRecords:turn.records,relayDepth:turn.relayDepth,assertActive:()=>{this.scopes.assert(turn.scope);this.same(p)}})}
 private async scoped<T>(scope:TurnScope,fn:(p:ProjectState,ctx:ActionContext)=>T|Promise<T>):Promise<T|BridgeFailure> {
 try{this.scopes.assert(scope);const p=this.project,turn=p.active.get(scope.seatId);if(!turn||turn.scope!==scope)throw new RuntimeError('turn_ended','ход не активен',403);const ctx=this.actionContext(p,turn);ctx.assertActive();return await fn(p,ctx)}
 catch(e){return {ok:false,code:e instanceof RuntimeError||e instanceof JournalError||e instanceof ProviderError?e.code:'invalid',error:message(e)}}
 }
 send(scope:TurnScope,a:BridgeSendArgs):Promise<SendResult> {return this.scoped(scope,(p,ctx)=>{
 const to=typeof a.to==='string'?a.to.split(',').map(pythonTrim).filter(Boolean):a.to;
 if(Array.isArray(to)&&to.length&&to.every(t=>t==='owner')&&a.kind==='answer')return {ok:false as const,code:'answer_is_text',error:'владельцу отвечай обычным текстом ответа — он виден ему в чате; send владельцу — только escalation, status или question'};
 ctx.assertActive();const record=p.channel.post({...a,to,reply_to:a.reply_to===0?null:a.reply_to??null}, {seat:scope.seatId,trust:'agent'});
 return {ok:true as const,seq:record.seq,thread:record.thread,to:[...record.to]}
 })}
 readPane(scope:TurnScope,a:ReadPaneArgs):Promise<ReadPaneResult>{return this.scoped(scope,(p,ctx)=>{
 if(a.pane===scope.seatId||!p.registry.get(a.pane))return {ok:false as const,code:'pane_unknown',error:'нет такого окна: '+a.pane};
 if(!p.registry.canObserve(scope.seatId,a.pane))return {ok:false as const,code:'policy_denied',error:'политика: роль '+p.registry.roleOf(scope.seatId)+' не наблюдает разговоры роли '+p.registry.roleOf(a.pane)};
 const n=typeof a.last_n==='number'&&Number.isFinite(a.last_n)?Math.max(1,Math.min(100,Math.trunc(a.last_n||20))):20;ctx.assertActive();return {ok:true as const,text:p.registry.transcriptOf(a.pane,n)}
 })}
 ask(scope:TurnScope,args:AskArgs):Promise<AskResult>{return this.scoped(scope,(_p,ctx)=>this.actions.ask(args,ctx))}
 merge(scope:TurnScope,args:MergeArgs):Promise<MergeResult>{return this.scoped(scope,(_p,ctx)=>this.actions.merge(args,ctx))}
 async mergeOwner(args:MergeArgs,initiator:Initiator):Promise<MergeResult>{this.requireOwner(initiator);const p=this.project;if(!this.actions.mergeOwner)throw new RuntimeError('actions_required','порт действий обязателен',500);try{return await this.actions.mergeOwner(args,{runtime:this,project:p,initiator:Object.freeze({...initiator}),assertActive:()=>{this.same(p);this.requireOwner(initiator)}})}catch(e){return {ok:false,code:e instanceof RuntimeError||e instanceof JournalError?e.code:'merge_failed',error:message(e)}}}
 assignRole(scope:TurnScope,_args:AssignRoleArgs):Promise<AssignRoleResult>{return this.scoped(scope,()=>Promise.resolve({ok:false as const,code:'proposal_required',error:'участников создаёт оркестратор по подтверждённому предложению'}))}
 proposeSeats(scope:TurnScope,input:ProposalInput){return this.scoped(scope,(_p,ctx)=>propose(this,ctx,input))}
 createSeats(scope:TurnScope,input:ProposalRef){return this.scoped(scope,(_p,ctx)=>create(this,ctx,input))}
 teamProposals(initiator:Initiator){return proposals(this,initiator)}
 confirmTeam(input:ProposalRef,initiator:Initiator){return confirm(this,input,initiator)}
 createOwnerSeat(input:OwnerSeatInput,initiator:Initiator){return createOwnerSeat(this,input,initiator)}
 proposeOwnerSeat(input:Record<string,unknown>,initiator:Initiator){return proposeOwner(this,input,initiator)}
 instructionFile(path:string){return instructionFile(this,path)}
 updateInstruction(id:string,input:Record<string,unknown>,initiator:Initiator){return updateInstruction(this,id,input,initiator)}
 toolsFor(scope:TurnScope):PeerTools {
 this.scopes.assert(scope);const p=this.project,turn=p.active.get(scope.seatId);if(!turn||turn.scope!==scope)throw new RuntimeError('turn_ended','ход не активен',403);
 return {
 proposeSeats:async a=>{const r=await this.proposeSeats(scope,a);return r.ok?{ok:true,text:JSON.stringify(r)}:r},
 createSeats:async a=>{const r=await this.createSeats(scope,a);return r.ok?{ok:true,text:JSON.stringify(r)}:r},
 send:async a=>{const r=await this.send(scope,a);return r.ok?{ok:true,text:'Запись #'+r.seq+' отправлена '+r.to.join(', ')+'; тред '+(r.thread||'без треда')+'.'}:r},
 readPane:a=>this.readPane(scope,a),
 ask:async a=>{const r=await this.ask(scope,a);return r.ok?{ok:true,text:r.reply||'(пустой ответ)'}:{...r,error:'Ответа нет: '+r.error}},
 merge:async a=>{const r=await this.merge(scope,a);return r.ok?{ok:true,text:'Слито: '+r.sha.slice(0,12)+' → '+r.mergeSha.slice(0,12)+' в '+r.branch+'.'}:{...r,error:'Слияние отклонено: '+r.error}},
 assignRole:async a=>{const r=await this.assignRole(scope,a);return r.ok?{ok:true,text:'Назначена роль «'+r.label+'» ('+r.pane+', '+r.model+', '+r.mode+') по поручению №'+r.mandate+'; вводная отправлена.'}:r}
 }
 }
 validateBridge(from:string,token:string):TurnScope{const p=this.current;return this.tokens.validate(from,token,p&&!p.closed?p.generation:-1,p?.active.get(from)?.vendor??p?.registry.get(from)?.vendor??'')}
 private roleNote(p:ProjectState,pane:Pane):string {const roles=Object.fromEntries([...p.registry.panes].map(([id,p])=>[id,p.kind??'room'])),labels=Object.fromEntries([...p.registry.panes].map(([id,p])=>[id,p.label]));return roleNote(pane,{projectDir:p.dir,repoRoot:p.repoRoot,team:p.team,instructionText:p.team&&p.team.seats[pane.id]?instructionsFor(p.team,p.team.seats[pane.id]!):'',policySummary:p.policy?.summaryFor(pane.kind??'room',roles,labels)??null})}
 context(id:string){const p=this.project,pane=this.pane(id,p),chat=p.state.activeChat(pane,false);return contextCard(pane,{instructionText:p.team&&p.team.seats[id]?instructionsFor(p.team,p.team.seats[id]!):'',roleNote:this.roleNote(p,pane),chat:chat?{...meta(p,chat)}:null})}
 private networkGeneration(vendor:string){try{return this.settings.networkGeneration(vendor)}catch{return null}}
 private assertDirectReady(p:ProjectState,pane:Pane,binding:string,entries:DeliveryEntry[]):void {
  const captured=JSON.parse(binding),current=this.paneBinding(pane.id,p);
  if(Object.entries(current).some(([k,v])=>k!=='networkGeneration'&&captured[k]!==v))throw new RuntimeError('binding_changed','Разговор изменился; прямой повтор отменён');
  if(current.networkGeneration&&captured.networkGeneration===current.networkGeneration)return;
  const turnInstanceId=randomUUID(),reason='Настройки изменились — решите заново';
  p.state.startAttempt(pane,{turnInstanceId,recordSeqs:entries.map(e=>e.record.seq),deliverySeq:Math.max(0,...entries.map(e=>e.deliverySeq)),startedAt:this.clock.now(),status:'uncertain'});
  p.state.recordFailedTurn(pane,p.registry,{turnInstanceId,ts:this.clock.now()/1000,model:pane.model,vendor:pane.vendor,outcome:'error',errorCode:'network_changed',failure:{code:'network_changed',reason,durationMs:0}});
  pane.status='uncertain';pane.uncertainNote=reason;this.stateEvent(p,pane);
  throw new RuntimeError('binding_changed',reason,409,{fields:{pane:pane.id,project:p.dir,waiting:this.waiting(pane.id),settingsBinding:current}});
 }
 private async waitVendor(p:ProjectState,vendor:Vendor|'human'):Promise<void>{if(vendor==='human')return;while(p.resets.has(vendor)||p.routeJobs.has(vendor)){await Promise.all([p.resets.get(vendor),p.routeJobs.get(vendor)]);this.same(p)}}
 async runTurn(id:string,messageText:string,options:{entries?:DeliveryEntry[];project?:ProjectState;relayDepth?:number;reservation?:symbol;directOnce?:string;combined?:number[]}={}):Promise<string> {
 const p=options.project??this.project,parent=options.entries?.length?p.trace.parentForJournal(options.entries.map(e=>e.record.seq)):currentTrace(),turnInstanceId=randomUUID(),started=this.clock.now(),span=p.trace.record('turn.start',{actor:'model:'+id,pane:id,chat:p.state.chats.active[id]??null,turnInstanceId,refs:{attemptId:turnInstanceId}},parent);
 const settlement=this.claimAutopilotSettlement(p,id,(options.entries??[]).map(e=>e.record),turnInstanceId);
 return p.trace.run(span,async()=>{try{const text=await this.runTurnCore(id,messageText,options,settlement),result=p.registry.get(id)?.transcript.find(m=>object(m.runtime)&&m.runtime.turnInstanceId===turnInstanceId);p.trace.end(span,'turn.end',{actor:'model:'+id,outcome:result?.outcome==='interrupted'?'cancelled':result?.outcome==='error'?'failed':'ok',reason:result?.outcome==='error'?traceReason(result.errorCode,'Ошибка провайдера'):{code:'none',text:''},durationMs:this.clock.now()-started,data:{model:result?.model,usage:result?.usage}});return text}catch(e){const failure=turnFailure(e,p.dir,this.clock.now()-started),reason=traceReason(failure.code,failure.reason);p.trace.end(span,'turn.end',{actor:'model:'+id,outcome:reason.code==='cancelled'?'cancelled':reason.code==='timeout'?'timeout':'failed',reason,durationMs:this.clock.now()-started});throw e}finally{this.finishTraceTools(p,turnInstanceId)}});
 }
 private async runTurnCore(id:string,messageText:string,options:{entries?:DeliveryEntry[];project?:ProjectState;relayDepth?:number;reservation?:symbol;directOnce?:string;combined?:number[]},settlement:Readonly<{turnInstanceId:string;complete:(callId:string)=>Promise<void>}>):Promise<string> {
 const p=options.project??this.project;await this.waitVendor(p,this.pane(id,p).vendor);
 const prepare=()=>{const pane=this.pane(id,p);this.same(p);if(options.entries?.some(entry=>!p.journal.pendingFor(id).some(current=>current.record.seq===entry.record.seq&&current.deliverySeq===entry.deliverySeq)))throw new RuntimeError('stale_attempt','Сообщение уже убрано или отправлено');if(options.directOnce)this.assertDirectReady(p,pane,options.directOnce,options.entries??[]);this.validateTurn(pane.vendor,pane.mode);
 if(p.starting)throw new RuntimeError('project_opening','проект открывается',409);
 if(firstOpenPending(p,pane))throw new RuntimeError('role_not_opened','Откройте чат роли, чтобы она получила вводную',409);
 if(p.halted)throw new RuntimeError('halted','остановлено владельцем: ходы не идут, сообщения ждут в очереди');
 if(pane.busy||p.editing.has(id)&&p.editing.get(id)!==options.reservation)throw new RuntimeError('busy',pane.label+' занято');
 if(p.restoreFailed.has(id))free(p,pane);
 if(p.materializing.has(id))throw new RuntimeError('recovering','назначение роли не завершено');
 if(pane.status!=='idle')throw new RuntimeError(pane.status,'ход не активен');
 const entries=options.entries??[],records=deepFreeze(entries.map(e=>e.record)),injected:TranscriptMessage[]=[],artifacts=new Set<string>();
 const relayDepth=Math.max(options.relayDepth??0,askDeliveryDepth(p,records));
 if(!pane.model)throw new RuntimeError('model_required','Сначала выберите модель разговора',400);
 const launchSeat=pane.providerSeat();
 const automatic=records.filter(record=>record.from==='owner'&&record.kind==='decision'&&record.origin?.startsWith('autopilot:')).map(record=>{
  const saved=this.autopilotDecisionLedger(p).get(record.origin!.slice(10)),bound=saved?.capability.effectModelCall;
  if(!object(bound)||bound.seat!==id||typeof bound.model!=='string')throw new RuntimeError('autopilot_binding_changed','Модель автоматического ответа не подтверждена; решение ждёт владельца',409);
  if(typeof bound.vendor!=='string')throw new RuntimeError('autopilot_binding_changed','Провайдер автоматического ответа не подтверждён',409);return {model:bound.model,vendor:bound.vendor};
 });
 for(const {record} of this.attemptDecisions(p)){const a=record.attempt!;if(a.autopilot&&a.action==='retry'&&a.pane===id&&a.deliverySeq!==null&&records.some(r=>r.seq<=a.deliverySeq!))automatic.push(a.autopilot)}
 if(automatic.some(bound=>bound.model!==launchSeat.model||bound.vendor!==launchSeat.vendor)||automatic.length&&launchSeat.mode!=='chat')throw new RuntimeError('autopilot_binding_changed','Модель или права места изменились после решения Автопилота; решение ждёт владельца',409);
 const attachmentRefs=records.flatMap(record=>normalizeAttachments(record.attachments));
 if(attachmentRefs.length&&!this.modelSupportsImages(p,launchSeat.vendor,launchSeat.model))throw new RuntimeError('images_unsupported','Выбранная модель не видит изображения',409);
 const verifiedAttachments=attachmentRefs.map(ref=>{const {id:_,size:__,w:___,h:____,...attachment}=this.attachmentStore(p).verify(ref);return attachment});
 pane.busy=true;pane.touched=true;pane.revision++;const launchModel=launchSeat.model,launchEpoch=pane.sessionEpoch;
 const scope=this.scopes.create(p.dir,id,currentTrace()?.turnInstanceId??randomUUID()),controller=new AbortController();let releaseReset!:()=>void,finish!:()=>void;
 const turn:ActiveTurn={scope,controller,pane,vendor:pane.vendor,records,deliverySeq:Math.max(0,...entries.map(e=>e.deliverySeq)),relayDepth,attemptNumber:0,handle:null,started:false,stopRequested:false,terminal:null,partial:'',finished:new Promise(r=>{finish=r}),finish:()=>finish(),timer:undefined,resetWait:new Promise(r=>{releaseReset=r}),releaseReset:()=>releaseReset(),result:null,injected};p.active.set(id,turn);this.stateEvent(p,pane);
 return {automatic,pane,entries,records,injected,artifacts,relayDepth,launchSeat,verifiedAttachments,launchModel,launchEpoch,scope,controller,turn};};
 // Registered queue claims share the assignment lock; legacy deliveries keep their existing path.
 const prepared=options.entries?.some(({record})=>record.from==='owner'&&record.origin?.startsWith('task-operation:'))?await locked(this,p,prepare):prepare();
 const {automatic,pane,entries,records,injected,artifacts,relayDepth,launchSeat,verifiedAttachments,launchModel,launchEpoch,scope,controller,turn}=prepared;
 let success=false,terminalSent=false,launchVendor:Vendor|null=null,transfer:ConversationTransfer|null=null,networkTurn:NetworkTurn|undefined,turnAttachments:TurnAttachment[]=verifiedAttachments,cleanupAttachments=()=>{},turnChatId:string|undefined;const toolEvents:ObservedToolEvent[]=[],toolResults:ToolReceipt[]=[];
 try{
 p.state.startAttempt(pane,{turnInstanceId:scope.turnInstanceId,recordSeqs:records.map(r=>r.seq),startedAt:this.clock.now(),deliverySeq:turn.deliverySeq});
 if(!validDir(pane.cwd))throw new RuntimeError('cwd_changed','папки нет: '+pane.cwd);const provider=this.provider(turn.vendor),vendor=provider.vendor,epoch=p.processEpoch.get(vendor)??0,sessionEpoch=pane.sessionEpoch;
 launchVendor=vendor;
 ({attachments:turnAttachments,cleanup:cleanupAttachments}=providerAttachments(verifiedAttachments,vendor,p.dir));
 const knowledgeChat=p.state.activeChat(pane,false),knowledge=knowledgeChat?deepFreeze(roleKnowledge(p,knowledgeChat)):null;turnChatId=(knowledgeChat??p.state.activeChat(pane)!).id;
 const previousKnowledge=[...pane.transcript].reverse().find(m=>m.teamKnowledge)?.teamKnowledge;
 if(previousKnowledge!==undefined&&(!object(previousKnowledge)||previousKnowledge.project!==p.dir||previousKnowledge.chat!==knowledgeChat?.id||!isTeamSnapshot(previousKnowledge.team)))throw new RuntimeError('chat_invalid','снимок команды не соответствует разговору',409);
 const teamText=knowledge?(object(previousKnowledge)?teamKnowledgeChanges(previousKnowledge.team as import('@harnessy/context').TeamMemberKnowledge[],knowledge.team):knowledge.text):'';let teamSaved=false;
 const summary=digest(pane,p.registry.others(id),(a,b)=>p.registry.canObserve(a,b)),nextSeen=summary.nextSeen;
 let prompt=messageText;if(pane.carry){prompt='Прежний разговор (был без папки, продолжается здесь):\n'+pane.carry+'\n\n---\nНовое сообщение:\n'+prompt;pane.publish({type:'note',text:'в сообщение добавлен прежний разговор'})}
 if(summary.text){prompt=summary.text+'\n\n---\nСообщение тебе:\n'+prompt;pane.publish({type:'note',text:'в сообщение добавлена сводка соседей ('+[...summary.text].length+' символов)'})}
 if(teamText)prompt=teamText+'\n\n---\n'+prompt;
 if(options.combined?.length){const note=timestampMessage('peer','[от харнесс] Отправлено вместе с ранее неотправленным сообщением',this.clock.now());pane.append(note);pane.uncommitted.add(note);injected.push(note)}
 for(const r of records){const attachments=normalizeAttachments(r.attachments),journalTs=Date.parse(r.ts),m={...timestampMessage(r.from==='owner'?'me':'peer',r.from==='owner'?r.text:'[от '+this.labelOf(r.from,p)+'] '+r.text,this.clock.now()),journalSeq:r.seq,...(Number.isFinite(journalTs)?{journalTs:journalTs/1000}:{}),...(attachments.length?{attachments}:{})};if(pythonTrim(m.text)||attachments.length){pane.append(m);pane.uncommitted.add(m);injected.push(m)}}
 const current=()=>!p.closed&&p.active.get(id)===turn;
 const checkDirectNetwork=()=>{if(options.directOnce){const generation=JSON.parse(options.directOnce).networkGeneration;if(!generation||generation!==this.networkGeneration(pane.vendor))throw new RuntimeError('network_changed','Настройки изменились — решите заново')}};
 const beginNetwork=()=>this.networkRelay.begin(vendor,p.dir+'\0'+id,controller.signal,(text,network)=>{if(!current())return;pane.publish({type:'networkRoute',text,network,chat:p.state.activeChat(pane)!.id,turnInstanceId:scope.turnInstanceId})},!!options.directOnce);
 networkTurn=beginNetwork();
 let attempt=0,earlySession:string|null=null,effected=false,sessionLost=false,toolCalls=0,visibleText='',toolOrder=0;const failedExits=new Set<string>();
 const ctx:TurnContext={traceTool:(name,args,run)=>{effected=true;return p.trace.tool(name,args,run,p.trace.forTurn(scope.turnInstanceId))},traceEvent:event=>{if(event.phase==='call')effected=true;if(current()){this.traceProvider(p,id,scope.turnInstanceId,event);if(!turn.stopRequested&&event.phase==='result'&&event.id&&event.outcome&&['ok','failed','rejected','timeout','cancelled'].includes(event.outcome)){const reason=event.error||event.reason;toolResults.push({id:createHash('sha256').update(scope.turnInstanceId+'\0'+event.id).digest('hex'),name:safeDiagnostic(event.name,{project:p.dir,limit:200}),status:event.outcome==='ok'?'ok':'error',offset:visibleText.length,order:toolOrder++,...(reason&&!/^[a-z][a-z0-9_]*$/.test(reason)?{reason:safeDiagnostic(reason,{project:p.dir,limit:300})}:{})})}}},signal:networkTurn.signal,modelResponded:()=>{effected=true},modelStarted:()=>{if(current()){
  const notices:TranscriptMessage[]=[];
  const teamNotice=knowledge&&teamText&&!teamSaved?{...timestampMessage('peer','[от харнесс] '+teamText,this.clock.now()),teamKnowledge:{project:p.dir,chat:knowledge.chat,team:knowledge.team,turnInstanceId:scope.turnInstanceId}}:null;
  if(teamNotice)notices.push(teamNotice);
  if(notices.length){for(const notice of notices)pane.append(notice);try{p.state.saveChats(p.registry)}catch(e){pane.transcript=pane.transcript.filter(m=>!notices.includes(m));throw e}}
  if(teamNotice){teamSaved=true;pane.publish({type:'roleKnowledge',knowledge})}
  turn.started=true;if(earlySession&&pane.vendor===vendor&&pane.sessionEpoch===sessionEpoch){pane.sessionId=earlySession;p.state.savePanes(p.registry,p.journal);earlySession=null}
 }},publish:event=>{
 if(!current())return;if(event.type==='contextChanged'){if(event.kind!=='provider_compaction')throw new RuntimeError('context_event_invalid','неизвестное изменение контекста провайдера',409);appendContextChange(p,pane,contextChange(p,pane,{kind:'provider_compaction',chat:turnChatId!,turnInstanceId:scope.turnInstanceId,before:event.before,after:event.after,source:vendor},this.clock.now()));return}if(event.type==='done'||event.type==='error'){turn.terminal=event.type==='error'?{type:'error',message:turnFailure({message:event.text},p.dir,0).reason,sessionId:pane.sessionId}:event;return}
 if(event.type==='tool')toolCalls++;if(turn.stopRequested)return;if(event.type==='tool'||event.type==='delta'&&event.text.length>0)effected=true;if(event.type==='toolError')event={...event,text:turnFailure({message:event.text},p.dir,0).reason};if(event.type==='tool'){for(const path of artifactPaths(event,p.dir))if(artifacts.size<50)artifacts.add(path);toolEvents.push({type:'tool',name:safeDiagnostic(event.name,{project:p.dir,limit:200}),detail:safeDiagnostic(event.detail,{project:p.dir,limit:300}),status:'unknown',offset:visibleText.length,order:toolOrder++})}if(event.type==='toolError')toolEvents.push({type:'toolError',reason:event.text,status:'error',offset:visibleText.length,order:toolOrder++});if(event.type==='delta'){turn.partial+=event.text;visibleText+=event.text}p.trace.run(p.trace.forTurn(scope.turnInstanceId)!,()=>pane.publish(event))
 },askApproval:(title,detail,request)=>{try{this.scopes.assert(scope)}catch{return Promise.resolve(false)}return p.trace.run(p.trace.forTurn(scope.turnInstanceId)!,()=>pane.askApproval(title,detail,undefined,request?.provider===vendor?request:undefined))},session:sid=>{if(!current()||turn.stopRequested||pane.vendor!==vendor||pane.sessionEpoch!==sessionEpoch)return;if(transfer&&!turn.started){earlySession=sid;return}pane.sessionId=sid;p.state.savePanes(p.registry,p.journal)},setHandle:handle=>{
 if(!current())return;turn.handle=handle;pane.handle=handle;if(handle&&turn.stopRequested)this.interruptHandle(p,pane,handle)
 },beforeModel:async()=>{const route=apiRoute(vendor);if(route){const config=this.settings.llmProviders()[route];let local=false;try{local=!!config?.baseURL&&['127.0.0.1','localhost','[::1]'].includes(new URL(config.baseURL).hostname)}catch{}if(!local)await this.networkRelay.prepare(vendor,controller.signal,networkTurn)}else if(vendor!=='ollama'){const relay=await this.networkRelay.prepare(vendor,controller.signal,networkTurn);if(relay&&ctx.env.HARNESS_RELAY_PROXY!==relay.url)throw new NetworkError()}checkDirectNetwork()},env:apiRoute(vendor)||vendor==='ollama'?{}:await this.networkRelay.environment(vendor,controller.signal,networkTurn)??this.connections.proxyEnv(vendor),roleNote:this.roleNote(p,pane),peers:[...p.registry.panes.values()].map(p=>({id:p.id,label:p.label,vendor:p.vendor as Vendor})),tools:new Proxy(this.toolsFor(scope),{get:(target,key)=>{const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{effected=true;return value.apply(target,args)}:value}}),relayDepth:turn.relayDepth,projectDir:p.dir,appUrl:this.deps.appUrl,attachments:turnAttachments,
 registerProcessToken:token=>{if(!p.closed&&(p.processEpoch.get(vendor)??0)===epoch)this.tokens.register(token,p.generation,id,vendor)},revokeProcessToken:token=>this.tokens.revoke(token,p.generation,id,vendor),writableRoots:writableRoots(p.repoRoot,!!pane.worktree)};
 let result:{text:string;sessionId:string|null;interrupted?:boolean};
 while(true){attempt++;turn.terminal=null;turn.attemptNumber=attempt;const attemptNumber=attempt,seat=sessionLost?{...launchSeat,sessionId:null}:launchSeat,activeAttempt=()=>current()&&turn.attemptNumber===attemptNumber;
 if(!seat.sessionId){try{let settings;try{settings=transferSettings(this.settings.get().owner)}catch(e){throw new RuntimeError('context_settings_invalid','настройки переноса: '+message(e),409)}
  const snapshot=transferSnapshot(p,pane,records,settings.contextTransferEnabled);transfer=snapshot?conversationTransfer(snapshot,settings):null;
 }catch(e){
  const chat=p.state.chats.chats[p.state.chats.active[pane.id]??''];
  transfer={project:p.dir,chat:chat?.pane===pane.id?chat.id:'',messages:0,verbatim:0,compressed:false,tokens:0,content:'',enabled:true,failure:{code:e instanceof RuntimeError?e.code:'context_unreadable',reason:slice(message(e),600)}};
 }}
 // Failed history is never mixed with the current request (including a saved carry).
 const attemptPrompt=transfer?.failure?messageText:transfer?.content?transfer.content+'\n\n---\nНовое сообщение:\n'+prompt:prompt;
 const attemptNetwork=networkTurn,attemptSignal=ctx.signal,acceptResult=()=>activeAttempt()&&!attemptNetwork.failure&&!attemptNetwork.rejection,assertAttempt=()=>{if(!activeAttempt()||attemptSignal.aborted)throw new ProviderError('cancelled','Попытка завершена')};
 if(automatic.length){ctx.tools=councilTools();ctx.askApproval=async()=>false}
 const attemptCtx:TurnContext={...ctx,modelResponded:()=>{if(activeAttempt()&&!attemptSignal.aborted)effected=true},beforeModel:async run=>{assertAttempt();await ctx.beforeModel?.(run);assertAttempt()},traceTool:(name,args,run)=>{assertAttempt();return ctx.traceTool!(name,args,run)},traceEvent:event=>{if(activeAttempt()&&!attemptSignal.aborted)ctx.traceEvent?.(event)},tools:new Proxy(ctx.tools,{get:(target,key)=>{const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{if(!activeAttempt()||attemptSignal.aborted)return Promise.resolve({ok:false,code:'turn_ended',error:'ход не активен'});return value.apply(target,args)}:value}}),modelStarted:()=>{if(activeAttempt()&&!attemptSignal.aborted)ctx.modelStarted?.()},publish:e=>{if(acceptResult())ctx.publish(e)},session:s=>{if(acceptResult())ctx.session(s)},setHandle:h=>{if(acceptResult())ctx.setHandle(h)},askApproval:(title,detail,request)=>acceptResult()?ctx.askApproval(title,detail,request):Promise.resolve(false)};
 try{if(controller.signal.aborted)throw new ProviderError('cancelled','ход отменён');if(!apiRoute(vendor)&&vendor!=='ollama')await ctx.beforeModel?.({provider:vendor,model:seat.model});result=await Promise.race([networkTurn.run(async()=>{checkDirectNetwork();const output=await provider.runTurn(seat,attemptPrompt,attemptCtx);if(output.text&&!attemptSignal.aborted)effected=true;return output}),turn.resetWait.then(()=>{throw new ProviderError('cancelled','ход отменён')})]);break}
 catch(e){if(!options.directOnce&&networkTurn.failure&&!networkTurn.retryBlocked&&!effected&&!controller.signal.aborted){const failed=networkTurn.hop?.id;if(failed&&!failedExits.has(failed)&&failedExits.size<32){failedExits.add(failed);await networkTurn.close();networkTurn=beginNetwork();ctx.signal=networkTurn.signal;ctx.env=apiRoute(vendor)||vendor==='ollama'?{}:await this.networkRelay.environment(vendor,controller.signal,networkTurn)??this.connections.proxyEnv(vendor);await networkTurn.ready();if(networkTurn.hop&&failedExits.has(networkTurn.hop.id))throw e;turn.started=false;turn.partial='';continue}}
 if(turn.stopRequested&&turn.started){result={text:turn.partial,sessionId:pane.sessionId,interrupted:true};break}
 if(e instanceof ProviderError&&e.code==='session_missing'&&attempt===1&&seat.sessionId&&!controller.signal.aborted){if(pane.vendor===vendor&&pane.sessionEpoch===sessionEpoch)pane.sessionId=null;p.state.savePanes(p.registry,p.journal);pane.publish({type:'note',text:'сессия модели не найдена — начат новый разговор'});sessionLost=true;turn.partial='';turn.started=false;continue}throw e}finally{if(turn.attemptNumber===attemptNumber)turn.attemptNumber=0}}
 if(p.closed)throw new ProviderError('cancelled','ход отменён');
 const interrupted=turn.stopRequested&&turn.started||result.interrupted===true;
 const heldError=(turn as ActiveTurn).terminal;if(heldError?.type==='error'&&!interrupted)throw new ProviderError('turn_failed',String(heldError.message||'Причина отказа не получена'));pane.sessionId=pane.vendor===vendor&&pane.sessionEpoch===sessionEpoch?result.sessionId:null;
 for(const m of injected)pane.uncommitted.delete(m);
 const response=timestampMessage('ai',result.text,this.clock.now()) as ResultMessage;response.mode=launchSeat.mode;const held=(turn as ActiveTurn).terminal;
 if(toolEvents.length)response.toolEvents=toolEvents.map(event=>({...event,offset:visibleText===result.text?event.offset:null}));if(toolResults.length)response.toolResults=toolResults.map(receipt=>({...receipt,offset:visibleText===result.text?receipt.offset:null}));
 if(held?.type==='done'){if(typeof held.model==='string'&&held.model)response.model=held.model;if(object(held.usage))response.usage=structuredClone(held.usage);if(held.usageIncomplete===true)response.usageIncomplete=true;if(typeof held.durationMs==='number'&&Number.isFinite(held.durationMs))response.durationMs=held.durationMs}
 if(!interrupted&&held?.type==='done'&&held.usageIncomplete!==true&&measuredUsage(held.usage)){
  try{await settlement.complete(scope.turnInstanceId)}catch(error){if(!p.closed)p.journal.append({sender:'harness',to:['owner'],kind:'note',origin:'autopilot-owner',text:'Учёт расхода не подтверждён; верхний резерв сохранён'})}
 }
 const connection=networkTurn?.receipt();if(connection)response.network=connection;
 response.vendor=launchVendor;response.outcome=interrupted?'interrupted':'ok';
 response.usage=turnUsage({turnId:scope.turnInstanceId,model:response.model??null,vendor:launchVendor!,mode:launchSeat.mode,usage:response.usage,usageIncomplete:response.usageIncomplete===true,durationMs:response.durationMs??Math.max(0,this.clock.now()-(p.state.attempts[id]?.startedAt??this.clock.now())),toolCalls:turn.started?toolCalls:null,stopped:interrupted},this.settings.priceList());
 response.deliverySeq=turn.deliverySeq;response.runtime={turnInstanceId:scope.turnInstanceId,recordSeqs:records.map(r=>r.seq),effectsPending:true,interrupted,nextSeen};turn.result=response;if(artifacts.size)response.artifacts={project:p.dir,chat:p.state.activeChat(pane)!.id,turnInstanceId:scope.turnInstanceId,paths:[...artifacts]};
 const transferNotice=transfer&&!interrupted?{...timestampMessage('peer','[от харнесс] '+transferLabel(transfer),this.clock.now()),contextTransfer:{...transfer,turnInstanceId:scope.turnInstanceId}}:null;
 const changed=transferNotice?contextChange(p,pane,{kind:transfer!.compressed?'truncate':'transfer',chat:turnChatId!,turnInstanceId:scope.turnInstanceId,before:null,after:null,source:'harness',transfer:transferNotice.contextTransfer},this.clock.now()):null;
 if(transferNotice&&changed)Object.assign(transferNotice,{contextChanged:changed});
 if(transferNotice)pane.append(transferNotice);
 try{p.state.commitResult(pane,p.registry,response)}catch(e){if(transferNotice)pane.transcript=pane.transcript.filter(m=>m!==transferNotice);throw e}
 if(options.combined?.length){const note=injected.find(m=>m.role==='peer'&&m.text.includes('Отправлено вместе'));if(note)pane.publish({type:'note',text:note.text,seq:note.seq})}
 if(transferNotice&&changed)pane.publish({type:'contextChanged',change:changed,chat:changed.chat,turnInstanceId:changed.turnInstanceId,seq:transferNotice.seq,ts:changed.ts});
 const receipt=p.state.attempts[id];if(receipt?.turnInstanceId===scope.turnInstanceId)p.state.clearAttempt(id);
 await this.recover(p,pane,true);
 const terminal=held?.type==='done'?held:{type:'done',sessionId:pane.sessionId,durationMs:0,usage:{input:null,output:null,cacheRead:null}};
 if(terminal.type==='done'&&object(terminal.usage))pane.tokens=terminal.usage as unknown as import('@harnessy/providers').Usage;
 pane.publish({...terminal,turnUsage:response.usage,turnInstanceId:scope.turnInstanceId,mode:launchSeat.mode,...(response.network?{network:response.network}:{}),seq:response.seq,chat:p.state.activeChat(pane)!.id,messages:injected.map(({seq,role,text,ts,attachments})=>({seq,role,text,ts,...(attachments?{attachments:structuredClone(attachments)}:{})})),...(response.artifacts?{artifacts:structuredClone(response.artifacts),turnInstanceId:scope.turnInstanceId}:{}),...(interrupted?{interrupted:true}:{})});terminalSent=true;
 success=true;return result.text
 }catch(e){
 if(options.directOnce&&!p.closed&&!controller.signal.aborted&&JSON.parse(options.directOnce).networkGeneration!==this.networkGeneration(pane.vendor))e=new RuntimeError('network_changed','Настройки изменились — решите заново');
 if(!turn.result){pane.transcript=pane.transcript.filter(m=>!injected.includes(m));for(const m of injected)pane.uncommitted.delete(m);
 const networkFailure=e instanceof RuntimeError&&e.code==='network_changed'||e instanceof ProviderError&&['network_unavailable','network_country_unverified','network_no_reserve','network_proxy_auth','region_restricted','network_blocked'].includes(e.code);
 if(turn.started||turn.partial||toolEvents.length||toolResults.length||!records.length&&networkFailure)try{p.state.recordFailedTurn(pane,p.registry,{turnInstanceId:scope.turnInstanceId,ts:this.clock.now()/1000,model:launchModel,vendor:launchVendor,outcome:'error',errorCode:turnFailure(e,p.dir,0).code,...(turn.partial?{partialText:turn.partial}:{}),...(records.length?{recordSeqs:records.map(r=>r.seq)}:{}),...turnMeasurements(turn.terminal),failure:turnFailure(e,p.dir,this.clock.now()-(p.state.attempts[id]?.startedAt??this.clock.now())),...(toolEvents.length?{toolEvents:toolEvents.map(event=>({...event,offset:null}))}:{}),...(toolResults.length?{toolResults:toolResults.map(receipt=>({...receipt,offset:null}))}:{})},turnChatId)}catch(error){p.lineErrors.push(message(error))}
 if(!turn.started&&!records.length&&!networkFailure){try{p.state.clearAttempt(id)}catch(error){pane.status='uncertain';p.lineErrors.push(message(error))}}
 else if(!turn.started&&records.length){try{if(transfer&&pane.vendor===launchVendor&&pane.sessionEpoch===launchEpoch){pane.sessionId=null;p.state.savePanes(p.registry,p.journal)}
  if(p.state.attempts[id]?.turnInstanceId!==scope.turnInstanceId)p.state.refreshDamage(p.registry);
  p.state.notSent(id,p.journal.lastSeq,turnFailure(e,p.dir,this.clock.now()-(p.state.attempts[id]?.startedAt??this.clock.now())),{turnInstanceId:scope.turnInstanceId,recordSeqs:records.map(r=>r.seq),startedAt:p.state.attempts[id]?.startedAt??this.clock.now(),deliverySeq:turn.deliverySeq});
 }catch(error){p.lineErrors.push(message(error))}pane.status='uncertain';pane.uncertainNote=waitingError(p,pane).message;}
 else {
  // После modelStarted сохраняем прежний uncertain; внутренний отказ сети без записи очереди также сохраняет карточку TS-22c.
  try{p.state.uncertain(id)}catch(error){p.lineErrors.push(message(error))}
  pane.status='uncertain';pane.uncertainNote=waitingError(p,pane).message;if(!p.closed)pane.publish({type:'note',text:pane.uncertainNote,warning:this.warningId(p,pane,'uncertain')})}
 }else {pane.status='recovering';pane.recoveryNote='ответ модели сохранён; завершается восстановление доставки';pane.publish({type:'note',text:pane.recoveryNote,warning:this.warningId(p,pane,'recovery')})}
 if(!terminalSent&&!p.closed)this.report(p,pane,e instanceof ProviderError&&e.code==='cancelled'?new RuntimeError('cancelled','ход отменён'):e,scope.turnInstanceId);
 throw e
 }finally{
 cleanupAttachments();await networkTurn?.close();this.scopes.revoke(scope);if(!turn.stopRequested)this.actions.cancelAsks(scope,'turn_ended');this.clock.clearTimeout(turn.timer);
 if(p.active.get(id)===turn){p.active.delete(id);pane.busy=false;pane.handle=null;this.stateEvent(p,pane)}
 if(!p.closed&&turn.started&&(turn.vendor==='claude'||turn.vendor==='codex'))void this.quota(p).refresh(turn.vendor,true);
 if(success&&!p.closed&&!options.entries&&pane.status==='idle')void this.kick(id);turn.finish()
 }
 }
 private interruptHandle(p:ProjectState,pane:Pane,handle:NonNullable<ActiveTurn['handle']>):void{try{void handle.interrupt().catch(e=>pane.publish({type:'toolError',text:turnFailure(e,p.dir,0).reason}))}catch(e){pane.publish({type:'toolError',text:turnFailure(e,p.dir,0).reason})}}
 cancelTurn(id:string,reason:string,p=this.project):boolean {
 const turn=p.active.get(id);if(!turn)return false;this.scopes.revoke(turn.scope);
 if(turn.stopRequested)return true;turn.stopRequested=true;turn.pane.denyApprovals();turn.controller.abort(reason);
 try{this.actions.cancelAsks(turn.scope,reason)}catch(e){turn.pane.publish({type:'toolError',text:turnFailure(e,p.dir,0).reason})}
 if(turn.handle)this.interruptHandle(p,turn.pane,turn.handle);
 turn.timer=this.clock.setTimeout(()=>{if(p.active.get(id)===turn)void this.resetVendor(turn.vendor as Vendor,p).catch(e=>this.report(p,turn.pane,e))},30_000);return true
 }
 interrupt(id:string,initiator:Initiator){this.requireOwner(initiator);const p=this.project,pane=this.pane(id,p);if(this.cancelTurn(id,'interrupt')){this.ownerAutopilotAction(p,initiator);return {ok:true}}pane.denyApprovals();return {ok:false,error:'нечего прерывать'}}
 approve(id:string,approvalId:string,decision:'allow'|'deny',initiator:Initiator){this.requireOwner(initiator);const p=this.project;if(id==='owner'&&approvalId.startsWith('provider-probe:')){const result=this.providerOperations.approve(p,approvalId,decision);if(result.ok)this.ownerAutopilotAction(p,initiator);return result}const pane=id==='owner'?p.owner:this.pane(id,p),ok=pane.resolveApproval(approvalId,decision==='allow');if(ok)this.ownerAutopilotAction(p,initiator);return {ok,error:ok?null:'вопрос уже закрыт'}}
 async halt(on:boolean,initiator:Initiator){this.requireOwner(initiator);const p=this.project;let failure:unknown;if(on){p.halted=true;try{p.state.saveHalt(true)}catch(e){failure=e}}else{p.state.saveHalt(false);p.halted=false}const interrupted:string[]=[];
 for(const pane of p.registry.panes.values()){if(on&&this.cancelTurn(pane.id,'halt',p))interrupted.push(pane.id);pane.publish({type:'note',text:on?'остановлено владельцем: ходы не идут, сообщения ждут в очереди':'работа возобновлена владельцем'});this.stateEvent(p,pane);if(!on&&pane.status==='idle')void this.kick(pane.id)}
 if(failure)throw failure;this.ownerAutopilotAction(p,initiator);return {ok:true,halted:on,interrupted,pending:Object.fromEntries([...p.registry.panes.values()].map(pane=>[pane.id,p.journal.pendingFor(pane.id).length]).filter(([,n])=>n))}
 }
 validateTurn(vendor:string,mode:string){if(apiRoute(vendor)){if(!Object.hasOwn(this.settings.llmProviders(),apiRoute(vendor)!))throw new RuntimeError('provider_unknown','Маршрут API не найден',409);if(!Object.hasOwn(API_MODES,mode)||!API_MODES[mode as keyof typeof API_MODES].ok)throw new RuntimeError('mode_unsupported','Режим API-модели не подключён',409);return}if(vendor==='claude'||vendor==='codex')return;const catalog=this.providerOperations.catalog;if(!catalog.ids().includes(vendor))throw new RuntimeError('provider_unknown','Программа отсутствует в каталоге',400);
 const supported=catalog.get(vendor).capabilities.turn?.[mode as 'read'|'edit'|'all'];if(supported?.ok!==true){const reason=supported?.reason??'Программа не гарантирует режим '+mode;throw new RuntimeError('capability_unsupported',reason,409,{fields:{reason}})}
 }
 // No await: validation and selection consume the same observed catalog snapshot.
 validateSelection(vendor:string,model:unknown,mode:string){if(apiRoute(vendor)){this.validateTurn(vendor,mode);const models=this.apiModelSnapshot().models[vendor]??[];if(typeof model!=='string'||!models.some(m=>m.id===model))throw new RuntimeError('model_unsupported','Модель отсутствует в API-маршруте',409);return models}
  const catalog=this.providerOperations.catalog,builtin=vendor==='claude'||vendor==='codex';
  if(!catalog.ids().includes(vendor)){if(!builtin)throw new RuntimeError('provider_unknown','Программа отсутствует в каталоге',400);this.validateTurn(vendor,mode);return}
  const row=catalog.peek(vendor),entry=catalog.get(vendor);
  if(row.installed===null||row.checking)throw new RuntimeError('provider_checking','Программа проверяется, повторите через несколько секунд',409);
  if(row.installed!==true)throw new RuntimeError('provider_not_installed','Программа '+row.title+' не установлена',409);
  if(row.service?.ok===false)throw new RuntimeError('provider_unavailable',row.service.reason??'Служба программы недоступна',409);
  if(row.login.state!=='ok'&&!(row.login.state==='unknown'&&entry.allowUnverifiedLogin===true)){
   const reason=row.login.reason??'Вход в '+row.title+' не выполнен';throw new RuntimeError('login_required',reason+' · Вход: '+row.login.command,409,{fields:{reason,command:row.login.command}});
  }
  if(typeof model!=='string'||!row.models.some(m=>m.id===model))throw new RuntimeError('model_unsupported','Модель отсутствует в снимке каталога программы',409);
  this.validateTurn(vendor,mode);
  return row.models.map(m=>({...m}));
 }
 paneBinding(id:string,p=this.project){const pane=this.pane(id,p);return {project:p.dir,instanceId:p.trace.instanceId,pane:id,chat:p.state.chats.active[id]??null,revision:pane.revision,mode:pane.mode,networkGeneration:this.networkGeneration(pane.vendor)}}
 paneSet(id:string,body:Record<string,unknown>,initiator:Initiator){this.requireOwner(initiator);const p=this.project;
 // No await between checking the owner's snapshot and applying the change. The
 // project instance and pane revision also invalidate confirmations after A→B→A.
 if(body.mode==='all'||body.binding!==undefined){const binding=body.binding,expected=p.registry.get(id)?this.paneBinding(id,p):null;
  if(!expected||!object(binding)||Object.keys(binding).length!==Object.keys(expected).length||!Object.entries(expected).every(([key,value])=>binding[key]===value))throw new RuntimeError('binding_changed','Проект, разговор или права места изменились; обновите статус и подтвердите заново',409);
 }
 const pane=this.pane(id,p);if(p.restoreFailed.has(id))free(p,pane);if(pane.status==='recovering')throw waitingError(p,pane);if(p.editing.has(id)||p.materializing.has(id))throw new RuntimeError('busy','место сейчас отвечает — дождитесь ответа');const {cwd:_,binding:__,...safe}=body;
 if(body.vendor!==undefined&&(typeof body.vendor!=='string'||!p.registry.providers.has(body.vendor)))throw new RuntimeError('provider_unknown','Программа отсутствует в каталоге',400);
 const target=typeof body.vendor==='string'?body.vendor:p.registry.modelVendor(pane,safe)??pane.vendor,mode=pane.busy?pane.mode:typeof body.mode==='string'?body.mode:pane.mode;
 if(body.vendor!==undefined||target!=='claude'&&target!=='codex'){
  const model=body.vendor!==undefined?body.model:typeof body.model==='string'&&body.model?body.model:pane.model,models=this.validateSelection(target,model,mode);
  if(models)p.registry.models[target]=models;
  if(typeof model!=='string'||!p.registry.models[target]?.some(m=>m.id===model))throw new RuntimeError('model_unsupported','Модель отсутствует в снимке каталога',409);
 }else this.validateTurn(target,mode);
 const updated=p.registry.update(pane,safe);if(updated){p.state.savePanes(p.registry,p.journal);this.ownerAutopilotAction(p,initiator);this.stateEvent(p,pane);if(pane.status==='idle')void this.kick(id)}const info=waiting(p,pane);return {ok:true,pane:{...pane.settings(),settingsBinding:this.paneBinding(id,p)},...(updated&&pane.busy?{appliesFrom:'next' as const}:{}),...(info?{waiting:info}:{})}}
 async steer(id:string,text:string,initiator:Initiator){this.requireOwner(initiator);const p=this.project,pane=this.pane(id,p);text=pythonTrim(text);if(!text)throw new RuntimeError('text_empty','пустое сообщение',400);
 const turn=p.active.get(id),record=p.channel.postCore({to:[id],kind:'note',text,origin:'steer'},OWNER);
 try{if(!turn||turn.stopRequested||!turn.handle)throw new RuntimeError('turn_ended','ход не активен');this.scopes.assert(turn.scope);await turn.handle.steer(text);this.same(p);this.requireOwner(initiator);this.scopes.assert(turn.scope);pane.record('me',text);pane.publish({type:'steered',record});this.ownerAutopilotAction(p,initiator);return {ok:true,seq:record.seq,steered:true}}
 catch(e){const reason='вмешательство не доставлено: '+turnFailure(e,p.dir,0).reason;if(!p.closed)p.channel.postCore({to:['owner'],kind:'rejected',text:reason,reply_to:record.seq,origin:'steer'},HARNESS);throw new RuntimeError('steer_failed',reason,409,{cause:e})}
 }
 resetVendor(vendor:Vendor,p=this.project):Promise<void>{const existing=p.resets.get(vendor);if(existing)return existing;
 let resolve!:()=>void,reject!:(e:unknown)=>void;const reset=new Promise<void>((a,b)=>{resolve=a;reject=b});p.resets.set(vendor,reset);p.processEpoch.set(vendor,(p.processEpoch.get(vendor)??0)+1);this.tokens.revokeVendor(p.generation,vendor);
 const turns=[...p.active.values()].filter(t=>t.vendor===vendor);for(const t of turns)this.cancelTurn(t.pane.id,'reset',p);
 void (async()=>{try{await this.provider(vendor).reset();for(const t of turns)t.releaseReset();resolve()}catch(e){reject(e)}finally{if(p.resets.get(vendor)===reset)p.resets.delete(vendor)}})();return reset
 }
 async setRoute(_vendor:Vendor,config:{route?:string;proxy?:string;iface?:string;label?:string;expect?:string},initiator:Initiator):Promise<never>{this.requireOwner(initiator);throw new RuntimeError(config.route==='iface'?'iface_unsupported':'network_route_moved','Подключения → Выходы → цепочка провайдера',409)}
 async auth(vendor:Vendor){await this.waitVendor(this.project,vendor);return this.provider(vendor).auth()}
 async models(vendor:Vendor,fallback?:{id:string;label:string;images?:boolean}[]){const p=this.project;await this.waitVendor(p,vendor);let models:{id:string;label:string;images?:boolean}[];
 try{models=await this.provider(vendor).models()}catch(e){this.same(p);if(!fallback)throw e;models=structuredClone(fallback)}
 this.same(p);if(!models.length&&fallback)models=structuredClone(fallback);p.registry.models[vendor]=models;return models
 }
 async listSessions(id:string){const p=this.project,pane=this.pane(id,p);await this.waitVendor(p,pane.vendor);return this.provider(pane.vendor).listSessions(pane.cwd)}
 async sessionMessages(id:string,sessionId:string){const p=this.project,pane=this.pane(id,p);await this.waitVendor(p,pane.vendor);return this.provider(pane.vendor).sessionMessages(pane.cwd,sessionId)}
 async openSession(id:string,sessionId:string,initiator:Initiator){this.requireOwner(initiator);const p=this.project,pane=this.pane(id,p);free(p,pane,pane.label+' занято: идёт ход');const {revision,vendor,cwd}=pane;const msgs=await this.provider(vendor).sessionMessages(cwd,sessionId);
 this.same(p);this.requireOwner(initiator);if(p.registry.get(id)!==pane||pane.revision!==revision||pane.vendor!==vendor||pane.cwd!==cwd||pane.busy||p.editing.has(id)||p.materializing.has(id))throw new RuntimeError('stale_session','окно изменилось во время чтения сессии');
 free(p,pane,pane.label+' занято: идёт ход');
 pane.sessionId=sessionId;pane.touched=true;pane.revision++;pane.transcript=msgs.map(m=>({role:m.role,text:m.text,ts:0}));pane.seen={};p.state.savePanes(p.registry,p.journal);this.ownerAutopilotAction(p,initiator);return {id:sessionId,messages:msgs}
 }
 promoteChat(id:string,input:PromotionInput,initiator:Initiator){return promoteChat(this,id,input,initiator)}
 roleCatalog(){return roleCatalog(this)}
 createSeat(input:CreateSeatInput,initiator:Initiator){return createSeat(this,input,initiator)}
 async ensureSeatMaterialized(id:string,initiator:Initiator,operationId?:string){this.requireOwner(initiator);if(this.project.restoreFailed.has(id))free(this.project,this.pane(id));return ensureSeatMaterialized(this,id,initiator,operationId)}
 async onboard(id:string,initiator:Initiator,binding:{project?:unknown;chat?:unknown}={}){this.requireOwner(initiator);if(this.project.restoreFailed.has(id))free(this.project,this.pane(id));return onboard(this,id,initiator,binding)}
 makeRoom(model:string,mode:string,initiator:Initiator){return makeRoom(this,model,mode,initiator)}
 roomSet(input:{model?:unknown;folder?:unknown;vendor?:unknown},initiator:Initiator){return roomSet(this,input,initiator)}
 roomMove(input:{path?:unknown;create?:unknown;git?:unknown},initiator:Initiator){return roomMove(this,input,initiator)}
 assignRoomRole(input:CreateSeatInput & PromotionInput & {chat?:unknown},initiator:Initiator){return assignRoomRole(this,input,initiator)}
 chatMeta(id:string){const p=this.current;if(!p||p.closed)return null;const c=p.state.chats.chats[id];return c?meta(p,c):null}
 chatsList(initiator:Initiator){return chatsList(this,initiator)}
 chatGet(id:string,initiator:Initiator){return chatGet(this,id,initiator)}
 chatsNew(input:{pane?:unknown;carry?:unknown},initiator:Initiator){return chatsNew(this,input,initiator)}
 chatsOpen(input:{chat?:unknown;carry?:unknown},initiator:Initiator){return chatsOpen(this,input,initiator)}
 handoff(input:{to?:unknown;from?:unknown;kind?:unknown;chat?:unknown;seqs?:unknown;quotes?:unknown;prompt?:unknown;text?:unknown},initiator:Initiator){return handoff(this,input,initiator)}
 chat(input:Record<string,unknown>,initiator:Initiator){const p=this.project;this.requireOwner(initiator);const result=chat(this,input,initiator);this.ownerAutopilotAction(p,initiator);return result}
 pinsGet(initiator:Initiator){this.requireOwner(initiator);return this.pins.get()}
 async pinSet(input:Parameters<Pins['set']>[0],initiator:Initiator){this.requireOwner(initiator);const p=this.project;return this.pins.set(input,()=>{this.same(p);this.requireOwner(initiator)},()=>this.ownerAutopilotAction(p,initiator))}
 settingsGet(initiator:Initiator){this.requireOwner(initiator);return this.settings.get()}
 async settingsPatch(scope:unknown,patch:unknown,initiator:Initiator){this.requireOwner(initiator);
 if(object(patch)&&Object.keys(TRANSFER_DEFAULTS).some(key=>Object.hasOwn(patch,key))){if(scope&&scope!=='owner')throw new RuntimeError('context_settings_invalid','настройки переноса: только область owner',400);try{transferSettings(patch)}catch(e){throw new RuntimeError('context_settings_invalid',message(e),400)}}
 const p=this.project,result=await this.settings.patch(scope,patch,()=>{this.same(p);this.requireOwner(initiator)},()=>this.ownerAutopilotAction(p,initiator));this.traceSettings();return result}
 async setProgramBinary(id:string,path:unknown,initiator:Initiator){
  this.requireOwner(initiator);
  const project=this.project;
  const previous=this.programBinaryJobs.get(id),job=(previous??Promise.resolve()).catch(()=>{}).then(async()=>{
  this.same(project);
  const entry=this.providerOperations.catalog.get(id);
  if(typeof path!=='string'||!isAbsolute(path)||path.length>1024||path.includes('\0')||basename(path)!==id)throw new RuntimeError('program_binary_invalid','Это не '+id+'. Выберите файл программы '+id+'.',400);
  let canonical:string;
  try{canonical=await realpath(path);const projectRoot=await realpath(project.dir);
   if(!programBinaryTarget(id,canonical)||programBinaryInProject(path,projectRoot)||programBinaryInProject(canonical,projectRoot))throw Error('not an installed program');
   const file=await stat(canonical);if(!file.isFile())throw Error('not file');await access(canonical,constants.X_OK);
   const candidate=entry.withBinary?.(canonical);if(!candidate)throw new RuntimeError('program_binary_invalid','Путь к этой программе не настраивается',400);
   const version=await candidate.version(AbortSignal.timeout(5000));
   if(typeof version!=='string'||!version.trim()||id==='claude'&&!/Claude Code/i.test(version)||id==='codex'&&!/^codex(?:-cli)?\b/i.test(version))throw Error('wrong program');
   this.same(project);if(await realpath(path)!==canonical)throw Error('program link changed');
  }catch(e){if(e instanceof RuntimeError)throw e;throw new RuntimeError('program_binary_invalid','Это не '+id+'. Выберите файл программы '+id+'.',400)}
  if([...project.active.values()].some(active=>active.pane.vendor===id))throw new RuntimeError('provider_busy','Программа отвечает; дождитесь завершения хода',409);
  await this.settings.setProgramBinary(id,canonical,()=>{this.same(project);this.requireOwner(initiator)},()=>this.ownerAutopilotAction(project,initiator));
  if(id==='claude'||id==='codex'){process.env[id==='claude'?'CLAUDE_BIN':'CODEX_BIN']=canonical;await this.deps.providers[id]?.reset()}
  const read=await this.providerOperations.catalog.setBinary(id,canonical);
  return {ok:true,provider:read.row};
  });this.programBinaryJobs.set(id,job);
  try{return await job}finally{if(this.programBinaryJobs.get(id)===job)this.programBinaryJobs.delete(id)}
 }
 async close(){this.unsubscribeLlm();const tunnels=this.sshTunnels.close();try{await this.closeProject()}finally{await tunnels;await this.providerOperations.close();await this.networkRelay.close();this.unsubscribeNetworkStats();this.networkStats.close();await Promise.all([...this.traces].map(t=>t.close()))}}
}
export async function createRuntime(deps:RuntimeDeps,actions:RuntimeActions):Promise<Runtime>{const runtime=new Runtime(deps,actions);await runtime.openProject(deps.projectDir);return runtime}
