import {CatalogCacheError,CatalogCache} from './catalog-cache.ts';
import {publicCatalogText,maskCatalogAccount} from './catalog-public.ts';
import {CatalogScheduler,CATALOG_READ_TIMEOUT_MS} from './catalog-scheduler.ts';
import {loginFailure,type LoginFailure} from './catalog-login.ts';
import {CatalogAuth} from './catalog-auth.ts';
import {waitWithSignal} from './cancellation.ts';
import {CliProvider} from './cli/provider.ts';
import {readCliMetadata,readCliFileMetadata} from './cli/query.ts';
import {ANTIGRAVITY} from './antigravity.ts';
import {COPILOT} from './copilot.ts';
import {GEMINI} from './gemini.ts';
import {KIMI} from './kimi.ts';
import {QWEN} from './qwen.ts';
import {DEVIN} from './devin.ts';
import {OPENCODE} from './opencode.ts';
import {executeCli} from './cli/process.ts';
import {createHmac,randomBytes} from 'node:crypto';
import {ProviderError,record,providerId,type Provider,type Vendor,type TurnContext,type ProviderLimits,type TurnModes,type TurnModeSupport} from './types.ts';
import type {CliDescriptor,CliUnavailableDescriptor,CliDependencies,CliSeat,CliContext,CliAuth,CliModel,CliCommand} from './cli/types.ts';

/** Subscription descriptors are added here by TS-20b/c; credentials are never stored here. */
export const CLI_DESCRIPTORS:readonly (CliDescriptor|CliUnavailableDescriptor)[]=[ANTIGRAVITY,COPILOT,GEMINI,KIMI,QWEN,DEVIN,OPENCODE];
export interface CatalogService {ok:boolean;version?:string;reason?:string;command?:string}
export interface CatalogLogin {failure?:LoginFailure;unverifiedAllowed?:true;state:'ok'|'none'|'unknown'|'error';account?:string;command:string;checkedAt?:number;reason?:string}
export interface CatalogCapabilities {headless:boolean;resume:boolean;mcp:boolean;limits:boolean;images:boolean;turn?:TurnModes;probe?:TurnModeSupport}
// Public checkedAt and SSE at are epoch milliseconds (durationMs is elapsed milliseconds).
export interface CatalogRow {subtitle?:string;service?:CatalogService;id:string;title:string;kind:'subscription'|'apikey'|'local';binary:string;installed:boolean|null;checking:boolean;version:string|null;login:CatalogLogin;models:CliModel[];modelsReason?:string;capabilities:CatalogCapabilities;limits?:{ref:string};routes?:string;reason?:string;install?:{command:string;url:string};searchedPaths?:string[]}
export interface CatalogRead {row:CatalogRow;changed:boolean;identity:string|null}
export const CATALOG_TTL_MS=300_000;
export interface CatalogEntry {
 id:string;title:string;kind?:CatalogRow['kind'];subtitle?:string;service?():Promise<CatalogService>;binary:string;login:CliCommand;forbiddenEnv:readonly string[];capabilities:Omit<CatalogCapabilities,'images'>&{images?:boolean};routes?:string;install?:{command:string;url:string}|undefined;withBinary?(binary:string):CatalogEntry;
 allowUnverifiedLogin?:boolean;allowUnverifiedProbe?:boolean;probeMode?:'read'|'all';unavailableReason?:string;modelsReason?:string;staticModels?:readonly CliModel[];
 cachedModels?:(models:CliModel[])=>CliModel[];modelsWithoutLogin?:true;modelsWarning?():string|undefined;
 version(signal?:AbortSignal):Promise<string>;auth(signal?:AbortSignal):Promise<CliAuth>;models(signal?:AbortSignal,refresh?:boolean):Promise<CliModel[]>;
 prepareModel?(model:string,signal:AbortSignal):Promise<void>;
 limits?(signal?:AbortSignal):Promise<ProviderLimits>;
 runTurn(seat:CliSeat,message:string,ctx:CliContext):Promise<{text:string;sessionId:string|null;interrupted?:boolean}>;
 reset?():Promise<void>;listSessions?:Provider['listSessions'];sessionMessages?:Provider['sessionMessages'];
 close?():Promise<void>;
}
export const shellQuote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'";
export function loginCommand(entry:CatalogEntry){return [entry.binary,...entry.login.args].map(shellQuote).join(' ')}
export const unsupportedTurns=(reason:string):TurnModes=>({read:{ok:false,reason},edit:{ok:false,reason},all:{ok:false,reason}});
export const INSTALL:Readonly<Record<string,{command:string;url:string}>>={
 claude:{command:'npm install -g @anthropic-ai/claude-code',url:'https://docs.anthropic.com/en/docs/claude-code/getting-started'},
 codex:{command:'npm install -g @openai/codex@latest',url:'https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex'},
 devin:{command:'curl -fsSL https://cli.devin.ai/install.sh | bash',url:'https://cli.devin.ai/reference/commands'}
};
const searchPaths=()=>[...new Set((process.env.PATH??'').split(':').filter(path=>path.startsWith('/')&&path.length<=512&&!/[\x00-\x1f\x7f]/.test(path)))].slice(0,24);
const cliTurns=(d:CliDescriptor):TurnModes=>Object.fromEntries(['read','edit','all'].map(mode=>[mode,d.turnUnavailableReason?{ok:false,reason:d.turnUnavailableReason}:typeof d.modes[mode as 'read']==='function'?{ok:true,...(d.turnNotes?.[mode as 'read']?{note:d.turnNotes[mode as 'read']}:{})}:{ok:false,reason:d.turnReasons?.[mode as 'read']??'Программа не гарантирует режим '+mode}])) as TurnModes;
const safeText=(v:unknown):v is string=>publicCatalogText(v);
const safeModel=(m:unknown)=>record(m)&&publicCatalogText(m.id,'modelId')&&publicCatalogText(m.label,'label')&&(m.images===undefined||typeof m.images==='boolean');
export function cliEntry(description:CliDescriptor|CliUnavailableDescriptor,deps:Partial<CliDependencies>={}):CatalogEntry{
 if('unavailableReason'in description){
  const d=description,options={probeTimeoutMs:CATALOG_READ_TIMEOUT_MS,...deps,env:{...(deps.env??process.env)}},reason=d.unavailableReason;
  if(!safeText(reason)||'unavailableReason'in d.auth&&!safeText(d.auth.unavailableReason)||'list'in d.models&&!safeText(d.models.reason))throw new ProviderError('protocol','Нет причины недоступности хода');
  return {id:d.id,title:d.name,binary:d.binary,install:INSTALL[d.id],withBinary:binary=>cliEntry({...d,binary},deps),login:{args:[...d.login.args]},forbiddenEnv:[...d.forbiddenEnv],capabilities:{...d.capabilities,turn:unsupportedTurns(reason),probe:{ok:false,reason}},unavailableReason:reason,...(d.modelsWithoutLogin?{modelsWithoutLogin:true}:{}),...('list'in d.models?{modelsReason:d.models.reason,staticModels:d.models.list}:{}),
   version:signal=>readCliMetadata(d.binary,d.forbiddenEnv,d.version,options,signal),auth:signal=> 'unavailableReason'in d.auth?Promise.resolve({loggedIn:false,state:'unknown' as const,reason:d.auth.unavailableReason}):'file'in d.auth?readCliFileMetadata(d.auth,options.env):readCliMetadata(d.binary,d.forbiddenEnv,d.auth,options,signal),models:signal=> 'list'in d.models?Promise.resolve(d.models.list.map(m=>({...m}))):readCliMetadata(d.binary,d.forbiddenEnv,d.models,options,signal),
   runTurn:async()=>{throw new ProviderError('capability_unsupported',reason)}};
 }
 const p=new CliProvider(description,{probeTimeoutMs:CATALOG_READ_TIMEOUT_MS,...deps}),turn=cliTurns(description),probeMode=turn.read.ok?'read':'all',probe:TurnModeSupport=turn[probeMode].ok?{ok:true,...(probeMode==='all'?{note:description.noHarnessMcp?'полный доступ, без инструментов Harnessy':'полный доступ'}:{})}:{ok:false,reason:turn[probeMode].reason??'Нет режима пробного хода'};return {id:p.vendor,probeMode,install:INSTALL[p.vendor],withBinary:binary=>cliEntry({...description,binary},deps),...(description.allowUnverifiedLogin?{allowUnverifiedLogin:true}:{}),...(description.allowUnverifiedProbe?{allowUnverifiedProbe:true}:{}),...(description.modelsWithoutLogin?{modelsWithoutLogin:true}:{}),title:description.name,binary:description.binary,login:{args:[...description.login.args]},forbiddenEnv:[...description.forbiddenEnv],capabilities:{headless:true,resume:!!description.resume&&!description.turnUnavailableReason,mcp:!!description.mcp&&!description.turnUnavailableReason,limits:!!description.limits,turn,probe},...(description.turnUnavailableReason?{unavailableReason:description.turnUnavailableReason}:{}),...('list'in description.models?{staticModels:description.models.list,modelsReason:description.models.reason}:{}),version:signal=>p.version(signal),auth:signal=>p.auth(signal),models:signal=>p.models(signal),...(description.limits?{limits:(signal?:AbortSignal)=>p.limits(signal)}:{}),runTurn:(s,m,c)=>p.runTurn(s,m,c),reset:()=>p.reset(),listSessions:cwd=>p.listSessions(cwd),sessionMessages:(cwd,id)=>p.sessionMessages(cwd,id),close:()=>p.close()};
}
export function builtinEntries(providers:Partial<Record<Vendor,Provider>>,models:Partial<Record<Vendor,{id:string;label?:string;images?:boolean}[]>>,deps:Partial<CliDependencies>={}):CatalogEntry[]{
 return (['claude','codex'] as const).flatMap(id=>{const p=providers[id];if(!p)return [];const binary=deps.env?.[id==='claude'?'CLAUDE_BIN':'CODEX_BIN']||process.env[id==='claude'?'CLAUDE_BIN':'CODEX_BIN']||id;
 return [{id,title:id==='claude'?'Claude Code':'Codex',binary,install:INSTALL[id],withBinary:path=>builtinEntries({[id]:p},models,{...deps,env:{...(deps.env??process.env),[id==='claude'?'CLAUDE_BIN':'CODEX_BIN']:path}})[0]!,login:{args:['login']},forbiddenEnv:id==='claude'?['ANTHROPIC_API_KEY','CLAUDECODE','CLAUDE_CODE_SIMPLE']:['OPENAI_API_KEY'],capabilities:{headless:true,resume:true,mcp:true,limits:!!p.limits,images:(models[id]??[]).some(m=>m.images===true),probe:{ok:true},turn:{read:{ok:true},edit:{ok:true},all:{ok:true},chat:{ok:true},check:{ok:true},web:{ok:true},ask:{ok:true}}},routes:'/api/connections#'+id,
 version:async()=>{const r=await (deps.execute??executeCli)({binary,args:['--version'],cwd:deps.cwd??process.cwd(),env:deps.env??process.env,timeoutMs:5000,maxBytes:8192},AbortSignal.timeout(5000));if(r.code!==0||r.signal)throw new ProviderError('protocol','Версия программы не прочитана');return r.stdout.trim()},
 auth:async()=>{const a=await p.auth();return {loggedIn:a.loggedIn,...(typeof a.email==='string'?{email:a.email}:{}),...(typeof a.plan==='string'?{plan:a.plan}:{})}},
 models:async()=>{const found=await p.models();return (found.length?found:models[id]??[]).map(m=>({id:m.id,label:m.label||m.id,...(m.images===true?{images:true}:{})}))},
 runTurn:(s:CliSeat,m:string,c:CliContext)=>{if(s.vendor!==id)throw new ProviderError('protocol','Несовпадение провайдера');return p.runTurn({...s,vendor:id},m,{...c,peers:c.peers as TurnContext['peers']})}}];
 });
}
/** Metadata reads never run a model or launch login. Public rows contain no credentials. */
export class ProviderCatalog {
 private entries=new Map<string,CatalogEntry>();private snapshots=new Map<string,CatalogRow>();private reading=new Map<string,Promise<{row:CatalogRow;changed:boolean;identity:string|null}>>();
 private identities=new Map<string,string|null>();private salt=randomBytes(32);
 private quotaAuth=new Map<string,CatalogAuth>();
 private cache:CatalogCache|undefined;private restored=new Set<string>();private cacheErrors=new Set<string>();private diagnostics:{vendor:string;code:string}[]=[];private scheduler:CatalogScheduler;
 private pending=new Map<string,number>();private attempts=new Map<string,number>();private listeners=new Set<(value:CatalogRead)=>void>();private closed=false;private now:()=>number;
  constructor(entries:readonly CatalogEntry[]=[],now:()=>number=()=>Date.now(),options:{cacheDir?:string;concurrency?:number;timeoutMs?:number}={}){this.now=now;this.scheduler=new CatalogScheduler(options.concurrency,options.timeoutMs);if(options.cacheDir)this.cache=new CatalogCache(options.cacheDir,now);for(const e of entries){if(!e||!providerId(e.id)||!publicCatalogText(e.id,'modelId')||this.entries.has(e.id)||[e.routes,e.modelsReason,e.unavailableReason].some(v=>v!==undefined&&!safeText(v))||e.staticModels!==undefined&&(!Array.isArray(e.staticModels)||e.staticModels.some(m=>!safeModel(m)))||!safeText(e.title)||!safeText(e.binary)||e.kind!==undefined&&!['subscription','apikey','local'].includes(e.kind)||e.subtitle!==undefined&&(!safeText(e.subtitle)||e.subtitle.length>120)||e.service!==undefined&&typeof e.service!=='function'||e.allowUnverifiedProbe!==undefined&&typeof e.allowUnverifiedProbe!=='boolean'||e.allowUnverifiedProbe===true&&e.allowUnverifiedLogin!==true||!e.login||!Array.isArray(e.login.args)||!e.login.args.every(safeText)||e.login.input!==undefined||!Array.isArray(e.forbiddenEnv)||!e.forbiddenEnv.every(k=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))||!['version','auth','models','runTurn'].every(k=>typeof (e as unknown as Record<string,unknown>)[k]==='function')||!e.capabilities||e.capabilities.probe!==undefined&&(!record(e.capabilities.probe)||typeof e.capabilities.probe.ok!=='boolean'||(e.capabilities.probe.ok===false||e.capabilities.probe.reason!==undefined)&&!safeText(e.capabilities.probe.reason)||e.capabilities.probe.note!==undefined&&!safeText(e.capabilities.probe.note))||e.capabilities.turn!==undefined&&(!record(e.capabilities.turn)||[...new Set(['read','edit','all',...Object.keys(e.capabilities.turn)])].some(mode=>{const v=e.capabilities.turn?.[mode as 'read'];return !v||typeof v.ok!=='boolean'||(v.ok===false||v.reason!==undefined)&&!safeText(v.reason)||v.note!==undefined&&!safeText(v.note)}))||!['headless','resume','mcp','limits'].every(k=>typeof e.capabilities[k as 'headless']==='boolean'))throw new ProviderError('protocol','Неверный описатель каталога');this.entries.set(e.id,{...this.trackedEntry(e),login:{args:[...e.login.args]},forbiddenEnv:[...e.forbiddenEnv],capabilities:structuredClone(e.capabilities)});if(this.cache)try{const saved=this.cache.load(e.id,e.binary);if(saved){const row=this.peek(e.id),models=e.cachedModels?e.cachedModels(saved.models):saved.models;this.snapshots.set(e.id,{...row,...saved,models,capabilities:{...row.capabilities,images:row.capabilities.images||models.some(model=>model.images===true)},checking:true,login:{...row.login,...saved.login,state:'unknown',reason:'проверяется…'}});this.restored.add(e.id)}}catch(error){this.cacheErrors.add(e.id);this.diagnostics.push({vendor:e.id,code:error instanceof CatalogCacheError?error.code:'cache_read'})}}}
 cacheDiagnostics(){return this.diagnostics.splice(0)}
 get(id:string){const entry=this.entries.get(id);if(!entry)throw new ProviderError('provider_unknown','Программа отсутствует в каталоге');return entry}
 async setBinary(id:string,binary:string){const previous=this.get(id);if(!previous.withBinary)throw new ProviderError('capability_unsupported','Путь к этой программе не настраивается');await this.reading.get(id)?.catch(()=>{});const replacement=previous.withBinary(binary);this.quotaAuth.get(id)?.close();this.quotaAuth.delete(id);this.entries.set(id,this.trackedEntry(replacement));this.snapshots.delete(id);this.restored.delete(id);this.identities.delete(id);this.attempts.delete(id);await previous.close?.();return this.read(id)}
 private trackedEntry(e:CatalogEntry){if(!e.capabilities.limits||['claude','codex'].includes(e.id))return e;const reader=new CatalogAuth(signal=>e.auth(signal),auth=>this.accountIdentity(auth));this.quotaAuth.set(e.id,reader);return {...e,auth:(signal?:AbortSignal)=>reader.get(signal)}}
 authBinding(id:string){return this.quotaAuth.get(id)?.binding()}
 ids(){return [...this.entries.keys()]}
 peek(id:string):CatalogRow {const old=this.snapshots.get(id);if(old)return {...structuredClone(old),checking:this.pending.has(id)||this.restored.has(id)};const e=this.get(id);return {id:e.id,title:e.title,kind:e.kind??'subscription',...(e.subtitle?{subtitle:e.subtitle}:{}),binary:e.binary,searchedPaths:searchPaths(),installed:null,checking:this.pending.has(id)||this.restored.has(id),version:null,login:{state:'unknown',command:loginCommand(e),reason:this.cacheErrors.has(id)?'Сохранённый каталог не прочитан; проверяется…':'проверяется…'},models:[],capabilities:{...e.capabilities,images:e.capabilities.images===true,turn:e.capabilities.turn??unsupportedTurns('Программа не объявила гарантированные режимы')},...(e.modelsReason?{modelsReason:e.modelsReason}:{}),...(e.unavailableReason?{reason:e.unavailableReason}:{}),...(e.install?{install:e.install}:{} )}}
 snapshot():CatalogRead[]{return this.ids().map(id=>({row:this.peek(id),changed:false,identity:this.identities.get(id)??null}))}
 subscribe(listener:(value:CatalogRead)=>void){this.listeners.add(listener);return ()=>this.listeners.delete(listener)}
 refresh(){if(this.closed)return;for(const id of this.ids()){const at=this.attempts.get(id);if(at===undefined||this.now()-at>=CATALOG_TTL_MS)void (this.reading.get(id)??this.read(id)).catch(()=>{})}}
 provider(id:string):Provider {const e=this.get(id);return {vendor:id,runTurn:(seat,message,ctx)=>e.runTurn(seat,message,ctx),auth:async()=>({...await e.auth()}),models:()=>e.models(),reset:()=>e.reset?.()??Promise.resolve(),close:()=>e.close?.()??Promise.resolve(),listSessions:cwd=>e.listSessions?e.listSessions(cwd):Promise.reject(new ProviderError('capability_unsupported','Программа не предоставляет список сессий')),sessionMessages:(cwd,session)=>e.sessionMessages?e.sessionMessages(cwd,session):Promise.reject(new ProviderError('capability_unsupported','Программа не предоставляет историю сессии'))}}
 limitsEntries(){return [...this.entries.values()].filter(e=>!['claude','codex'].includes(e.id)&&e.capabilities.limits&&typeof e.limits==='function')}
 accountIdentity(auth:CliAuth):string|null{return auth?.loggedIn===true&&typeof auth.email==='string'&&auth.email.trim()?createHmac('sha256',this.salt).update(auth.email.trim().toLowerCase()).digest('hex'):null}
 read(id:string):Promise<CatalogRead>{
  this.get(id);this.pending.set(id,(this.pending.get(id)??0)+1);
  const finish=()=>{const n=(this.pending.get(id)??1)-1;if(n)this.pending.set(id,n);else this.pending.delete(id)};
  const previous=this.reading.get(id)??Promise.resolve(),work=previous.then(()=>this.scheduler.run(signal=>this.readNow(id,signal)),()=>this.scheduler.run(signal=>this.readNow(id,signal))).then(value=>{
   finish();value.row.checking=this.pending.has(id)||this.restored.has(id);if(!this.closed)for(const listener of this.listeners)listener(structuredClone(value));return value;
  },error=>{finish();throw error});
  this.reading.set(id,work);void work.finally(()=>{if(this.reading.get(id)===work)this.reading.delete(id)}).catch(()=>{});return work;
 }

 private async readNow(id:string,signal:AbortSignal):Promise<{row:CatalogRow;changed:boolean;identity:string|null}>{const e=this.get(id),previous=this.snapshots.get(id),previousIdentity=this.identities.get(id)??null;let identity:string|null=null,authRead=false,save=true,verified=false;let row:CatalogRow;let stage:'version'|'service'|'login'|'models'='version';
 const read=<T>(fn:()=>Promise<T>)=>waitWithSignal(fn,signal);
 row={id:e.id,title:e.title,kind:e.kind??'subscription',...(e.subtitle?{subtitle:e.subtitle}:{}),binary:e.binary,searchedPaths:searchPaths(),installed:false,checking:false,version:null,login:{state:'unknown',command:loginCommand(e)},models:[],capabilities:{...e.capabilities,images:e.capabilities.images===true,turn:e.capabilities.turn??unsupportedTurns('Программа не объявила гарантированные режимы')},...(e.capabilities.limits?{limits:{ref:'/api/limits#'+e.id}}:{}),...(e.routes?{routes:e.routes}:{}),...(e.unavailableReason?{reason:e.unavailableReason}:{}),...(e.modelsReason?{modelsReason:e.modelsReason}:{}),...(e.install?{install:e.install}:{} )};
 try{const version=await read(()=>e.version(signal));row.installed=true;if(!publicCatalogText(version,'version'))throw new ProviderError('protocol','Версия программы не прочитана');row.version=version;row.models=e.staticModels?.map(m=>({...m}))??[];
 if(e.service){stage='service';const service=await read(()=>e.service!());if(!service||typeof service.ok!=='boolean'||(service.ok===false||service.reason!==undefined)&&!safeText(service.reason)||[service.version,service.command].some(v=>v!==undefined&&!safeText(v)))throw new ProviderError('protocol','Состояние службы не прочитано');row.service={ok:service.ok,...(service.reason?{reason:service.reason}:{}),...(service.version?{version:service.version}:{}),...(service.command?{command:service.command}:{})};if(!service.ok){const reason=service.reason!;row.login={...row.login,checkedAt:this.now(),reason};row.modelsReason=reason;row.capabilities={...row.capabilities,turn:{...unsupportedTurns(reason),...Object.fromEntries(Object.keys(e.capabilities.turn??{}).map(k=>[k,{ok:false,reason}]))},probe:{ok:false,reason}}}}
 if(!row.service||row.service.ok){stage='login';const auth=await read(()=>e.auth(signal));if(!record(auth)||typeof auth.loggedIn!=='boolean'||auth.state!==undefined&&(auth.state!=='unknown'||auth.loggedIn)||auth.reason!==undefined&&!safeText(auth.reason))throw new ProviderError('protocol','Состояние входа не прочитано');identity=this.accountIdentity(auth);authRead=true;const account=maskCatalogAccount(auth.email);row.login={...row.login,state:auth.state==='unknown'?'unknown':auth.loggedIn?'ok':'none',checkedAt:this.now(),...(account?{account}:{}),...(auth.reason?{reason:auth.reason}:{}),...(e.allowUnverifiedProbe&&auth.state==='unknown'?{unverifiedAllowed:true as const}:{})};
 if(auth.loggedIn||e.modelsWithoutLogin||e.allowUnverifiedLogin&&auth.state==='unknown'){stage='models';const ms=await read(()=>e.models(signal));if(!Array.isArray(ms)||ms.some(m=>!safeModel(m))||new Set(ms.map(m=>m.id)).size!==ms.length)throw new ProviderError('models_unavailable','Модели не прочитаны');row.models=ms.map(m=>({id:m.id,label:m.label,...(m.images===true?{images:true}:{})}));row.capabilities.images=row.capabilities.images||row.models.some(m=>m.images===true);const reason=e.modelsWarning?.()??e.modelsReason;if(reason){if(!safeText(reason))throw new ProviderError('protocol','Причина недоступности моделей не прочитана');row.modelsReason=reason}else delete row.modelsReason}}
  verified=true;
 }catch(error){
  const code=error instanceof ProviderError?error.code:error instanceof Error&&['AbortError','TimeoutError'].includes(error.name)?'cancelled':'protocol',missing=code==='no_binary',transient=['transport_lost','cancelled','busy'].includes(code);save=!transient;verified=missing;
  const reason=missing?'Программа не установлена':transient?'Временно не удалось обновить данные программы ('+code+')':'Не удалось прочитать программу, вход или список моделей';
  // A failed read is not evidence of logout. Never carry models across an observed account change.
  const sameLogin=!authRead||previousIdentity===identity&&previous?.login.state===row.login.state&&previous?.login.account===row.login.account;
  if(transient&&authRead&&!sameLogin)save=true; // An observed new binding must also invalidate the disk snapshot.
  if(transient&&previous?.installed&&['ok','unknown'].includes(previous.login.state)&&previous.login.checkedAt!==undefined&&sameLogin){
   row=structuredClone(previous);row.login.reason=reason;identity=previousIdentity;
  }else if(transient){
   row.installed=row.version?true:previous?.installed??null;row.login={...row.login,state:'unknown',reason};row.models=authRead?[]:previous?.models??[];
  }else{
   row.installed=!missing;row.login={...(authRead&&!missing?row.login:{}),state:missing?'unknown':'error',command:row.login.command,checkedAt:this.now(),reason};row.models=missing?[]:e.staticModels?.map(m=>({...m}))??[];
  }
  delete row.login.failure;if(stage==='login'&&!missing&&code!=='not_logged_in')row.login.failure=loginFailure(error);
  if(e.service){row.service={ok:false,reason};row.capabilities={...row.capabilities,turn:{...unsupportedTurns(reason),...Object.fromEntries(Object.keys(e.capabilities.turn??{}).map(k=>[k,{ok:false,reason}]))},probe:{ok:false,reason}}}
 }
 if(verified)this.restored.delete(id);
 if(this.restored.has(id)){row.login={...row.login,state:'unknown',reason:'проверяется…'+(row.login.reason?' · '+row.login.reason:'')};if(previous?.login.checkedAt!==undefined)row.login.checkedAt=previous.login.checkedAt;else delete row.login.checkedAt;delete row.login.unverifiedAllowed}
 if(this.closed)return {row,changed:false,identity};
 if(save&&this.cache)try{this.cache.save(row);this.cacheErrors.delete(id)}catch{row.login.reason='Не удалось сохранить снимок каталога'}
 const signature=(v:CatalogRow)=>JSON.stringify({...v,login:{...v.login,checkedAt:0}}),changed=!previous||signature(previous)!==signature(row)||previousIdentity!==identity;
 this.attempts.set(id,this.now());this.snapshots.set(id,row);this.identities.set(id,identity);const value={row:structuredClone(row),changed,identity};
 return value;
 }

 // Notify each completed read immediately; another slow CLI must not delay binding revocation.
 async list(observe?:(value:Awaited<ReturnType<ProviderCatalog['read']>>)=>void){return Promise.all([...this.entries.keys()].map(async id=>{const value=await this.read(id);observe?.(value);return value}))}
 async close(){this.closed=true;this.scheduler.close();this.listeners.clear();for(const reader of this.quotaAuth.values())reader.close();await Promise.allSettled([...this.reading.values()]);await Promise.all([...this.entries.values()].map(e=>e.close?.()))}
}
