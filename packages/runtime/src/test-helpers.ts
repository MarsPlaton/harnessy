import {ProviderCatalog} from '@harnessy/providers';
import {lstatSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {parseCompat,compatJson} from '@harnessy/journal';
import type {TestContext} from 'node:test';
import {Connections,GitOps,ProjectRegistry,Settings,Pins} from '@harnessy/projects';
import type {Provider,Seat,TurnContext,Vendor} from '@harnessy/providers';
import {createRuntime,type Runtime,type RuntimeDeps,type RuntimeActions,type RuntimeEvent,type Clock} from './index.ts';
export const OWNER={seat:'owner',trust:'owner'} as const;
export const completedActions:RuntimeActions={async ask(){return {ok:true,reply:'ответ',seq:1}},async merge(){return {ok:true,sha:'a'.repeat(40),mergeSha:'b'.repeat(40),branch:'main'}},async assignRole(){return {ok:true,pane:'tester',label:'тестер',model:'w1',mode:'read',mandate:1}},async afterTurn(){return 'completed'},async restorePendingAcks(){},cancelAsks(){}};
export function deferred<T=void>(){let resolve!:(v:T|PromiseLike<T>)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
export async function until(fn:()=>boolean):Promise<void>{const deadline=Date.now()+20_000;while(Date.now()<deadline){if(fn())return;await delay(10)}if(fn())return;throw Error('условие теста не наступило')}
export class FakeClock implements Clock {time=1791500000125;private seq=0;private timers=new Map<number,{due:number;fn:()=>void}>();now=()=>this.time;setTimeout(fn:()=>void,ms:number){const id=++this.seq;this.timers.set(id,{due:this.time+ms,fn});return id}clearTimeout(id:unknown){this.timers.delete(id as number)}
 advance(ms:number){this.time+=ms;for(const [id,t] of [...this.timers].sort((a,b)=>a[1].due-b[1].due))if(t.due<=this.time&&this.timers.delete(id))t.fn()}
}
export type Result={text:string;sessionId:string|null;interrupted?:boolean};
export class FakeProvider implements Provider {
 calls:{seat:Seat;message:string;ctx:TurnContext}[]=[];resets=0;closes=0;authCalls=0;modelCalls=0;listCalls=0;messageCalls=0;
 onRun:((seat:Seat,text:string,ctx:TurnContext)=>Promise<Result>)|null=null;onReset:(()=>Promise<void>)|null=null;onMessages:(()=>Promise<{role:'me'|'ai';text:string}[]>)|null=null;
 readonly vendor:Vendor;constructor(vendor:Vendor='claude'){this.vendor=vendor}
 async runTurn(seat:Seat,message:string,ctx:TurnContext):Promise<Result>{this.calls.push({seat,message,ctx});if(this.onRun)return this.onRun(seat,message,ctx);ctx.modelStarted?.();ctx.publish({type:'done',sessionId:'s1',model:seat.model,durationMs:5,usage:{input:20,output:3,cacheRead:7}});return {text:'готов: '+seat.id,sessionId:'s1'}}
 async reset(){this.resets++;await this.onReset?.()}async close(){this.closes++}
 async auth(){this.authCalls++;return {loggedIn:true}}async models(){this.modelCalls++;return [{id:this.vendor==='claude'?'w1':'c1',label:'модель'}]}
 async listSessions(_cwd:string){this.listCalls++;return [{id:'old',title:'прежний',updated:1}]}
 async sessionMessages(_cwd:string,_id:string){this.messageCalls++;return this.onMessages?this.onMessages():[{role:'ai' as const,text:'прежний ответ'}]}
}
export function collect(runtime:Runtime){const events:RuntimeEvent[]=[],sub=runtime.subscribe({all:true});void (async()=>{for await(const event of sub.events)events.push(event)})();return {events,sub}}
// An opt-in test double only for probes in a known isolated non-Git project.
// Any write, outside path or newly created repository fails instead of being masked.
export function noRepositoryGit(root:string){
 const project=realpathSync(root);
 return new GitOps(async(args,cwd)=>{
  if(!cwd)throw Error('no-repository fixture: missing Git working directory');
  const path=realpathSync(cwd),rel=relative(project,path);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('no-repository fixture: path outside project');
  for(let dir=path;;dir=dirname(dir)){
   try{lstatSync(join(dir,'.git'));throw Error('no-repository fixture: Git repository exists')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
   if(dirname(dir)===dir)break;
  }
  if(args.length===2&&args[0]==='rev-parse'&&(args[1]==='--show-toplevel'||args[1]==='--is-inside-work-tree'))return {code:128,stdout:'',stderr:'not a git repository'};
  throw Error('no-repository fixture: unexpected Git operation '+args.join(' '));
 });
}
export async function harness(t:TestContext,options:{seats?:string;deps?:Partial<RuntimeDeps>;actions?:RuntimeActions;before?:(dir:string)=>void;noRepository?:boolean}={}){
 if(options.noRepository&&options.deps?.gitops)throw Error('no-repository fixture: custom GitOps conflicts with option');
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'harnessy-runtime-')));mkdirSync(join(dir,'.harness','state'),{recursive:true});
 const seats=options.seats??'  worker: {role: executor, vendor: claude, label: воркер, model: w1, mode: read, digest: false}';
 writeFileSync(join(dir,'.harness','team.yaml'),'version: 1\nintegration_branch: main\nseats:\n'+seats+'\n');options.before?.(dir);
 const provider=new FakeProvider(),clock=new FakeClock();const deps:RuntimeDeps={providerCatalog:new ProviderCatalog([]),projectDir:dir,limitsCacheDir:join(dir,'limits-cache'),appUrl:'http://127.0.0.1:9000',providers:{claude:provider},clock,models:{claude:[{id:'w1'},{id:'w2'}],codex:[{id:'c1'}]},connections:new Connections(join(dir,'connections.json')),projectRegistry:new ProjectRegistry({projects:join(dir,'projects.json'),lastProject:join(dir,'last')},{noLast:true}),settings:current=>new Settings(join(dir,'owner-settings.json'),current),pins:(current,meta)=>new Pins(join(dir,'pins.json'),current,meta),...(options.noRepository?{gitops:noRepositoryGit(dir)}:{}),...options.deps};
 const runtime=await createRuntime(deps,options.actions??completedActions);t.after(async()=>{await runtime.close();rmSync(dir,{recursive:true,force:true})});assert.equal(runtime.project.dir,dir,'test fixture must use the runtime project identity');await runtime.idle();return {runtime,provider,clock,dir,deps}
}

export const failedActions:RuntimeActions={...completedActions,ask:async()=>({ok:false,code:"unavailable",error:"действие недоступно: ask"}),merge:async()=>({ok:false,code:"unavailable",error:"действие недоступно: merge"}),assignRole:async()=>({ok:false,code:"unavailable",error:"действие недоступно: assign_role"}),async afterTurn({pane}){pane.recoveryNote="обработка после хода недоступна в этой сборке";pane.publish({type:"note",text:pane.recoveryNote});return "unavailable"},async restorePendingAcks({project}){if(project.channel.pendingAcks().length){const text="восстановление карточек подтверждения недоступно в этой сборке";if(!project.lineErrors.includes(text))project.lineErrors.push(text);project.owner.publish({type:"error",message:text,sessionId:null})}}};

// Historical materialization fixtures enter the internal mechanism, never the closed owner/agent door.
export async function savedAssignment(runtime:Runtime,args:import('./roles.ts').CreateSeatInput){
 const {assign}=await import('./roles.ts'),{meta}=await import('./chats.ts'),p=runtime.project;
 const result=await assign(runtime,p,args,{by:'владелец (интерфейс)',how:'сохранённое назначение',assert(){if(runtime.project!==p||p.closed)throw Error('project changed')}});
 return {ok:true as const,pane:result.pane.settings(),chat:meta(p,result.chat)};
}

export async function savedConversationAssignment(runtime:Runtime,args:import('./roles.ts').CreateSeatInput){
 const {assignConversation,chatSnapshot}=await import('./roles.ts'),{meta}=await import('./chats.ts'),p=runtime.project;
 const result=await assignConversation(runtime,p,args,chatSnapshot(p,p.registry.get('room')!),'сохранённое назначение из разговора');
 return {pane:result.result.pane.settings(),chat:meta(p,result.result.chat),replaced:result.replaced};
}

// TS-09b2: owner promotion is bound to a saved chat revision, including legacy /api/assign.
export function promotionInput(runtime:Runtime){const list=runtime.chatsList(OWNER),id=list.active.room!,chat=list.chats.find(c=>c.id===id)!;return {chat:id,project:runtime.project.dir,revision:chat.revision,documents:chat.documents}}

// 154 extends stored chats with a persisted revision; all pre-extension bytes still match the historical goldens.
export function legacyChatBytes(text:string){
 const data=parseCompat(text) as {chats:Record<string,{revision?:number;revisionHash?:string;transcriptSeq?:number;transcript:{seq?:number}[]}>};
 // TS-19.2 adds stable ids; the historical payload/float bytes remain identical.
 for(const chat of Object.values(data.chats)){assert.equal(chat.transcriptSeq,chat.transcript.length);chat.transcript.forEach((m,i)=>{assert.equal(m.seq,i+1);delete m.seq});delete chat.transcriptSeq;if(chat.revision!==undefined){assert.ok(Number.isSafeInteger(chat.revision)&&chat.revision>0);assert.match(chat.revisionHash??'',/^[0-9a-f]{64}$/);delete chat.revision;delete chat.revisionHash}}
 return compatJson(data,2);
}
