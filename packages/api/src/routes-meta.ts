import {join} from 'node:path';
import {statSync} from 'node:fs';
import {MODES,pyTruthy} from '@harnessy/team';
import {KINDS,SYSTEM_KINDS} from '@harnessy/journal';
import {projectsRoot,validDir,ROUTES,billingSnapshot,ProjectError} from '@harnessy/projects';
import {RuntimeError,promotionIdentity,type Runtime,type ProjectState} from '@harnessy/runtime';
import {limitPlan} from '@harnessy/providers';
import {CLAUDE_MODELS,CODEX_FALLBACK} from './catalog.ts';
import {OWNER,string,integer,type Route} from './routes.ts';
import {json,slice,text} from './responses.ts';
import {spend,spendTurns} from './spend.ts';
import {projectFileRoutes} from './project-file.ts';
import {sectionRoutes} from './routes-sections.ts';
import {providerOwner} from './routes-providers.ts';
import {swarm} from './swarm.ts';
import {readRouterModels,routerHealthReader,type RouterSource,type RouterHealth} from './router-health.ts';
export function sameProject(r:Runtime,p:ProjectState):void {if(p.closed||r.project!==p)throw new RuntimeError('project_changed','проект сменился',409)}
export const threads=(p:ProjectState)=>Object.fromEntries(p.channel.threads);
export async function metadata(r:Runtime,connections=false){
 const p=r.project;
 const [cl,cx,models]=await Promise.allSettled([r.auth('claude'),r.auth('codex'),r.models('codex',CODEX_FALLBACK)]);
 sameProject(r,p);
 const claude=cl.status==='fulfilled'?cl.value:{loggedIn:false,error:slice(text(cl.reason),connections?120:300)};
 const raw=cx.status==='fulfilled'?cx.value:{loggedIn:false,error:slice(text(cx.reason),300)};
 const codex={loggedIn:pyTruthy(raw.loggedIn),email:raw.email??null,plan:raw.plan??'',...(raw.error?{error:raw.error}:{})};
 return {p,claude,codex,models:models.status==='fulfilled'?models.value:structuredClone(CODEX_FALLBACK)}
}
export function metaRoutes(r:Runtime,router:RouterSource={health:routerHealthReader(),models:readRouterModels}):Route[]{
 let lastIssue='',issueProject:ProjectState|null=null;
 async function routedModels(p:ProjectState,models:{id:string;label:string;images?:boolean}[],knownHealth?:RouterHealth){
  const source=router.models();if(!source.ok){if(issueProject!==p||lastIssue!==source.reason)p.trace.record('models.unavailable',{actor:'engine',outcome:'failed',reason:{code:'unavailable',text:source.reason},data:{provider:'provider-router'}});issueProject=p;lastIssue=source.reason}else{issueProject=p;lastIssue=''}
  const ids=new Set(source.ok?source.models:[]),health=models.some(m=>ids.has(m.id))?knownHealth??await router.health():null;sameProject(r,p);
  const viaStatus=health?.ok?{ok:true as const}:{ok:false as const,reason:'provider-router не отвечает: '+(health&&!health.ok?health.reason:'движок не сообщил доступность')};
  return models.map(({id,label,images=false})=>({id,label,images,...(ids.has(id)?{via:'provider-router' as const,viaStatus}:{})}));
 }
 return [
 ...sectionRoutes(r),
 ...projectFileRoutes(r),
 {method:'GET',path:'/api/swarm',style:'J',handle:()=>json(swarm(r))},
 {method:'GET',path:'/api/limits',style:'J',handle:async()=>json(await r.limits())},
 {method:'GET',path:'/api/spend',style:'J',handle:async({query})=>json(await spend(r,query))},
 {method:'GET',path:'/api/spend/turns',style:'J',handle:async({query})=>json(await spendTurns(r,query))},
 {method:'GET',path:'/api/status',handle:async()=>{
 const {p,claude,codex,models:rawModels}=await metadata(r),models=await routedModels(p,rawModels),programs=r.providerOperations.modelSnapshot(),api=r.apiModelSnapshot();
 let network:Record<string,ReturnType<Runtime['networkRelay']['summary']>>|null=null,networkError:{code:string;reason:string}|null=null;
 try{network=Object.fromEntries([...new Set(['claude','codex',...Object.keys(programs.models),...Object.keys(api.models)])].map(id=>[id,r.networkRelay.summary(id)]))}catch(e){if(!(e instanceof ProjectError))throw e;networkError={code:e.code,reason:e.message}}
 const currentAutopilot=await r.autopilotStatus();sameProject(r,p);
 const autopilot=process.platform==='win32'?{...currentAutopilot,on:false,available:false,reason:'Автопилот пока недоступен на Windows: журнал решений требует защищённого хранения'}:currentAutopilot;
 return json({project:p.dir,autopilot,network,networkError,trace:{instanceId:p.trace.instanceId,...p.trace.status},defaultDir:r.defaultDir,limits:r.limitsSnapshot(),models:{...programs.models,...api.models,claude:CLAUDE_MODELS,codex:models},turnModes:{...programs.turnModes,...api.turnModes,claude:{read:{ok:true},edit:{ok:true},all:{ok:true},chat:{ok:true},check:{ok:true},web:{ok:true},ask:{ok:true}},codex:{read:{ok:true},edit:{ok:true},all:{ok:true},chat:{ok:true},check:{ok:true},web:{ok:true},ask:{ok:true}}},modes:MODES,kinds:KINDS,
 ownerKinds:['task','question','note','stop','resume','decision'],lineErrors:[...p.lineErrors,...(api.apiError?[api.apiError.reason]:[])],apiError:api.apiError,policy:{version:p.policy?.version??null,path:p.policy?.path??null},
 team:{path:p.team?join(p.team.harnessDir,'team.yaml'):null,integrationBranch:p.team?.integrationBranch??null,mergeRoles:p.team?.mergeRoles??[]},repo:p.repoRoot,
 panes:[...p.registry.panes.values()].map(pane=>({...pane.settings(),settingsBinding:r.paneBinding(pane.id,p),pending:p.journal.pendingFor(pane.id).length,status:pane.status,waiting:r.waiting(pane.id)})),
 approvals:[p.owner,...p.registry.panes.values()].flatMap(pane=>[...pane.approvals.values()].map(approval=>({pane:pane.id,...approval.event()}))),
 promotions:Object.values(p.state.chats.chats).map(promotionIdentity).filter(Boolean),roleCatalog:r.roleCatalog(),noProject:p.dir===r.defaultDir||p.registry.get('room')?.folderless===true,projectsRoot:projectsRoot(r.settings.effective()),activeChats:{...p.state.chats.active},hasOrchestrator:[...p.registry.panes.values()].some(p=>p.kind==='orchestrator'),halted:p.halted,threads:threads(p),auth:{claude,codex},profile:{name:r.settings.profileName()},journal:{lastSeq:p.journal.lastSeq,path:p.journal.channelPath}})
 }},
 {method:'GET',path:'/api/dir',handle:({query})=>{const cwd=query.get('cwd')??'';if(!validDir(cwd))return json({ok:false,error:'папки нет или это не папка: '+cwd},400);let hasHarness=false;try{hasHarness=statSync(join(cwd,'.harness')).isDirectory()}catch{}return json({ok:true,cwd,hasHarness})}},
 {method:'GET',path:'/api/projects',handle:async({request})=>{providerOwner(request);const p=r.project,data=await r.projectRegistry.listProjects(p.dir);sameProject(r,p);for(const row of data.projects)if(row.current)row.seats=[...p.registry.panes.values()].filter(p=>p.id!=='room').length;return json(data)}},
 {method:'GET',path:'/api/journal',handle:({query})=>{let before:number|undefined;
 if(query.has('before')){const raw=query.get('before')!;before=Number(raw);if(query.getAll('before').length!==1||!/^\d+$/.test(raw)||!Number.isSafeInteger(before)||before<=0)return json({ok:false,code:'before_invalid',error:'before: ожидается целое число больше нуля'},400)}
 let since=integer(query.get('since')??'0',NaN),limit=integer(query.get('limit')??'100',NaN);if(!Number.isFinite(since)||!Number.isFinite(limit)){since=0;limit=100}const p=r.project;
 const filters=Object.fromEntries(['kind','from','to','thread'].map(key=>[key,query.get(key)||null]));
 if(['kind','from','to'].some(key=>query.getAll(key).length>1)||filters.kind&&!new Set<string>([...KINDS,...SYSTEM_KINDS]).has(filters.kind))return json({ok:false,code:'journal_filter_invalid',error:'фильтр журнала: один kind из каталога, from и to — идентификаторы участников'},400);
 const all=p.journal.read({since:Math.min(0,since),limit:0}),projectRecords=all.filter(record=>record.seq>0),counts=new Map<string,number>();for(const record of projectRecords)counts.set(record.kind,(counts.get(record.kind)||0)+1);
 const matches=(value:string|null,filter:string|null|undefined)=>!filter||value!==null&&value.toLowerCase()===filter.toLowerCase();
 const selected=all.filter(record=>record.seq>since&&(before===undefined||record.seq<before)&&matches(record.thread,filters.thread)&&(!filters.kind||record.kind===filters.kind)&&matches(record.from,filters.from)&&(!filters.to||record.to.some(to=>matches(to,filters.to))));
 if(before!==undefined)selected.sort((a,b)=>a.seq-b.seq);
 return json({project:p.dir,records:limit?selected.slice(-limit):selected,summary:{total:projectRecords.length,byKind:Object.fromEntries(counts)},lastSeq:p.journal.lastSeq,cursors:p.journal.cursors,threads:threads(p)})}},
 {method:'POST',path:'/api/billing',style:'J',handle:async({body})=>json(await r.settings.patchBilling(body.changes))},
 {method:'GET',path:'/api/billing',handle:async()=>{
 const {p,claude,codex}=await metadata(r,true),config=r.settings.billing(),limits=r.limitsSnapshot().providers;
 const sources=([{vendor:'claude',auth:claude},{vendor:'codex',auth:codex}] as const).map(({vendor,auth})=>{
  const info=limits.find(l=>l.vendor===vendor),account=auth.loggedIn===true&&typeof auth.email==='string'&&/^[^\s@]+@[^\s@]+$/.test(auth.email.trim())?auth.email.trim().toLowerCase():null,matched=!!account&&info?.account===account;
  const plan=limitPlan('plan' in auth?auth.plan:'subscriptionType' in auth?auth.subscriptionType:null)??(matched?info?.plan:null)??null,level=matched?info?.planLevel??null:null;
  return {vendor,connected:auth.loggedIn===true,account,plan,level,levelUnknown:plan==='Max'&&!level,extraUsageEnabled:matched?info?.extraUsageEnabled??null:null};
 });
 return json({ok:true,project:p.dir,...billingSnapshot(config,sources,r.clock.now()/1000)})
 }},
 {method:'GET',path:'/api/connections',handle:async()=>{
 const {p,claude,codex,models:rawModels}=await metadata(r,true),health=await router.health();sameProject(r,p);const models=await routedModels(p,rawModels,health),seats=(v:string)=>[...p.registry.panes.values()].filter(p=>p.vendor===v&&p.id!=='room').map(p=>p.id),other=models.filter(m=>m.via==='provider-router');
 const providers:Record<string,unknown>[]=[{id:'claude',name:'Claude',kind:'подписка · вход через claude',auth:claude,models:CLAUDE_MODELS.length,seats:seats('claude'),routable:true,route:r.connections.get('claude')},{id:'codex',name:'Codex',kind:'подписка ChatGPT · codex app-server',auth:codex,models:models.length-other.length,seats:seats('codex'),routable:true,route:r.connections.get('codex')}];
 providers.push({id:'router',name:'provider-router',kind:'локально · 127.0.0.1:11435 · '+(health.ok?(health.families.join(', ')||'нет данных · список моделей пуст'):'нет данных · '+health.reason),auth:{loggedIn:health.ok},health:health.ok?'доступен':'нет данных · '+health.reason,models:health.ok?health.models.length:null,seats:seats('codex').filter(id=>other.some(m=>m.id===p.registry.get(id)?.model)),routable:false,route:null,note:'выход в сеть у роутера свой — движок его маршрут не задаёт'});
 return json({ok:true,project:p.dir,providers,routes:ROUTES})
 }},
 {method:'POST',path:'/api/connections/route',style:'J',handle:async({body})=>{
 const p=r.project;if(body.project!==undefined&&body.project!==p.dir)throw new RuntimeError('project_changed','проект сменился',409);
 const v=string(body.provider);if(v!=='claude'&&v!=='codex')return json({ok:false,error:'маршрут задаётся только провайдерам, чьи процессы запускает движок: claude, codex'},400);
 return await r.setRoute(v,{route:string(body.route)||'direct',proxy:string(body.proxy),iface:string(body.iface),label:string(body.label),expect:string(body.expect)},OWNER);
 }},
 {method:'POST',path:'/api/connections/check',handle:async({body})=>{const p=r.project;if(body.project!==undefined&&body.project!==p.dir)throw new RuntimeError('project_changed','проект сменился',409);const v=string(body.provider);if(v!=='claude'&&v!=='codex')return json({ok:false,error:'проверка выхода: claude или codex'},400);const check=await r.connections.check(v);sameProject(r,p);return json({ok:true,project:p.dir,provider:v,check,route:r.connections.get(v)})}}
]}
