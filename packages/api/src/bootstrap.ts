import {mkdir,readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ClaudeProvider,CodexProvider,claudeBinary,type Provider,type Vendor} from '@harnessy/providers';
import {recoverProgramPath} from '@harnessy/providers';
import {Runtime,RuntimeError,createActions,type RuntimeDeps} from '@harnessy/runtime';
import {ownerPaths,validDir,expandUser,ProjectRegistry,Connections,Settings,Pins} from '@harnessy/projects';
import {CLAUDE_MODELS,CODEX_FALLBACK} from './catalog.ts';
import {createApi,PROTO_ENTRY,type Api} from './server.ts';
import {text} from './responses.ts';
export interface BootstrapOptions {env?:NodeJS.ProcessEnv;log?:(line:string)=>void;providers?:(cwd:string,env:NodeJS.ProcessEnv)=>Partial<Record<Vendor,Provider>>;findClaude?:()=>Promise<string|null>;signal?:AbortSignal}
export const repositoryRoot=fileURLToPath(new URL('../../../',import.meta.url));
async function isDirectory(path:string){try{return (await stat(path)).isDirectory()}catch{return false}}
// Used only for the startup address line; provider execution and auth own their binary selection.
function cancelled(signal?:AbortSignal){if(signal?.aborted)throw new RuntimeError('cancelled','запуск остановлен',409)}
async function stoppable<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!signal)return work;let stop!:()=>void;
 const abort=new Promise<never>((_resolve,reject)=>{stop=()=>reject(new RuntimeError('cancelled','запуск остановлен',409));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true})});
 try{return await Promise.race([work,abort])}finally{signal.removeEventListener('abort',stop)}
}
export async function bootstrap(options:BootstrapOptions={}){
 cancelled(options.signal);const env=options.env??process.env,log=options.log??console.log,recovered=recoverProgramPath(env);env.PATH=recovered.path;
 log('[harness] программы ищем в: '+recovered.searched.join(', '));
 const paths=ownerPaths(env),defaultDir=resolve(expandUser(env.CHAT_WORK_DIR||(process.platform==='win32'?join(homedir(),'Harnessy-Projects','Chat'):'/Users/Shared/simple-claude-chat'))),projectsRoot=resolve(expandUser(env.HARNESS_PROJECTS_ROOT||'~/Harnessy-Projects')),siteDir=resolve(env.HARNESSY_SITE||join(repositoryRoot,'ui/deploy/out/site/sketches'));
 const port=Number(env.PORT??3777);if(!Number.isInteger(port)||port<0||port>65535)throw Error('PORT: нужен порт 0–65535');
 await mkdir(defaultDir,{recursive:true});await mkdir(projectsRoot,{recursive:true});let startDir=defaultDir;
 if(!env.HARNESS_NO_LAST){try{const last=(await readFile(paths.lastProject,'utf8')).trim();if(validDir(last))startDir=last;else log('[harness] последняя папка недоступна — '+defaultDir)}catch(e){log('[harness] последний проект не прочитан: '+text(e)+' — '+defaultDir)}}
 cancelled(options.signal);const providers=options.providers?.(defaultDir,env)??{claude:new ClaudeProvider({env}),codex:new CodexProvider({env,cwd:defaultDir})};
 const deps:RuntimeDeps={projectDir:startDir,defaultDir,appUrl:'http://127.0.0.1:'+port,models:{claude:structuredClone(CLAUDE_MODELS),codex:structuredClone(CODEX_FALLBACK)},providers,
 projectRegistry:new ProjectRegistry(paths,{noLast:!!env.HARNESS_NO_LAST}),connections:new Connections(paths.connections),settings:current=>new Settings(paths.settings,current),pins:(current,meta)=>new Pins(paths.pins,current,meta)};
 const runtime=new Runtime(deps,createActions());let api:Api|undefined,closeJob:Promise<void>|undefined;
 const close=()=>{options.signal?.removeEventListener('abort',onStop);return closeJob??=(api?api.close():runtime.close())};
 const onStop=()=>{void close().catch(()=>{})};options.signal?.addEventListener('abort',onStop,{once:true});
 try{
 await runtime.openProject(startDir,{deferPumps:true});cancelled(options.signal);api=createApi({runtime,siteDir,port});const url=await api.listen();cancelled(options.signal);deps.appUrl=url;
 const p=runtime.project;log('[harness] линия: '+p.dir+' · мест '+p.registry.ids.length+' · политика v'+(p.policy?.version??'—')+' · записей '+p.journal.lastSeq+(p.lineErrors.length?' · ошибки: '+p.lineErrors.join('; '):''));
 for(const directory of recovered.searched.slice(0,16))p.trace.record('provider.path',{data:{path:directory,action:'search'}});
 log('[harness] '+url);log('[harness] claude: '+((await stoppable(options.findClaude?.()??claudeBinary(env),options.signal))||'НЕ НАЙДЕН')+'; node для моста Codex: '+process.execPath);
 log('[harness] прототип Harnessy: '+(await isDirectory(siteDir)?url+PROTO_ENTRY:'папки нет — '+siteDir));
 try{const a=await stoppable(runtime.auth('claude'),options.signal);log('[harness] вход Claude по подписке: '+(a.loggedIn?'да ('+String(a.authMethod??'')+')':'НЕТ — выполни в Терминале: claude auth login'))}catch{log('[harness] вход Claude по подписке: НЕТ — выполни в Терминале: claude auth login')}
 cancelled(options.signal);for(const id of runtime.registry.ids)void runtime.kick(id);
 return {api,runtime,url,close}
 }catch(e){await close();cancelled(options.signal);throw e}
}
