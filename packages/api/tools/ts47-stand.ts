import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {builtinEntries,LoginTerminal,ProviderCatalog,ProviderError} from '@harnessy/providers';
import {Connections,ProjectRegistry,Settings,Pins} from '@harnessy/projects';
import {createActions,createRuntime,type RuntimeDeps} from '@harnessy/runtime';
import {MemoryKeys} from '../../llm/src/test-helpers.ts';
import {createApi} from '../src/server.ts';
import {fakeScenario,ScenarioProvider} from './ts47-fake.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const scenario=fakeScenario(process.env);
const portText=process.env.HARNESS_FAKE_PORT??'3794';
if(!/^[1-9][0-9]{0,4}$/.test(portText)||Number(portText)>65535||Number(portText)===3777)throw Error('HARNESS_FAKE_PORT: нужен свободный порт 1–65535, кроме 3777');
// Keep every run's generated proto separate, including when an auditor is already using another run.
const port=Number(portText),data=mkdtempSync(join(dirname(root),'TS-47F-stand-')),site=join(data,'site');
const built=spawnSync(process.platform==='win32'?'python':'python3',[join(root,'ui/deploy/build.py'),'--out',site],{cwd:root,stdio:'inherit',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
if(built.error)throw built.error;if(built.status!==0)throw Error('Не удалось собрать proto: '+built.status);

// A fresh sibling directory keeps all project and owner state outside the real projects.
const project=join(data,'project'),empty=join(data,'default');
mkdirSync(join(project,'.harness'),{recursive:true});mkdirSync(empty);
process.env.HARNESS_PROJECTS_ROOT=join(data,'projects');mkdirSync(process.env.HARNESS_PROJECTS_ROOT);
writeFileSync(join(project,'.harness/team.yaml'),[
 'version: 1','integration_branch: main','seats:',
 '  lead: {kind: orchestrator, role: orchestrator, vendor: claude, label: Тестовый руководитель, model: claude-opus-5-5, mode: read, digest: false}',
 '  worker: {kind: worker, role: executor, vendor: codex, label: Тестовый исполнитель, model: gpt-5.6-sol, mode: read, digest: false}',''
].join('\n'),{flag:'wx'});
const claude=new ScenarioProvider('claude',scenario),codex=new ScenarioProvider('codex',scenario),providers={claude,codex};
const models={claude:await claude.models(),codex:await codex.models()};
const catalog=new ProviderCatalog(builtinEntries(providers,models,{
 env:{CLAUDE_BIN:'fake-claude',CODEX_BIN:'fake-codex'},
 execute:async()=>({code:0,signal:null,stdout:'TS-47.F fake 1\n',stderr:''})
}));
class DisabledLoginTerminal extends LoginTerminal {
 override async launch(){throw new ProviderError('login_terminal_failed','Вход через Терминал отключён в тестовом стенде')}
}
const deps:RuntimeDeps={projectDir:project,defaultDir:empty,providers,models,providerCatalog:catalog,appUrl:'http://127.0.0.1:'+port,
 limitsCacheDir:join(data,'limits'),catalogCacheDir:join(data,'catalog'),networkStatsPath:join(data,'network-stats.json'),
 llmKeys:new MemoryKeys(),networkKeys:new MemoryKeys(),llmFetch:async()=>{throw Error('Тестовый стенд не обращается к внешним моделям')},
 loginTerminal:new DisabledLoginTerminal(),
 connections:new Connections(join(data,'connections.json')),projectRegistry:new ProjectRegistry({projects:join(data,'projects.json'),lastProject:join(data,'last')},{noLast:true}),
 settings:current=>new Settings(join(data,'settings.json'),current),pins:(current,meta)=>new Pins(join(data,'pins.json'),current,meta)};
const runtime=await createRuntime(deps,createActions());
const api=createApi({runtime,siteDir:join(site,'sketches'),port,host:'127.0.0.1',
 router:{models:()=>({ok:false,reason:'Тестовый стенд: внешний роутер выключен'}),health:async()=>({ok:false,reason:'Тестовый стенд: внешний роутер выключен'})}});
// This marker belongs to the test stand, never to the production API.
api.server.prependListener('request',(request,response)=>{
 if(request.method!=='GET')return;
 let path:string;try{path=decodeURIComponent((request.url??'').split('?')[0]!)}catch{return}
 const match=/^\/api\/events\/([^/]+)$/.exec(path),pane=match?.[1];
 if(pane&&(['all','owner'].includes(pane)||runtime.registry.get(pane)))response.setHeader('X-Harnessy-Test-Double','1');
});
try {
 const url=await api.listen();deps.appUrl=url;
 console.log('TS-47.F: '+url+'/sketches/proto/10-new-chat.html');
 console.log('Проект и настройки стенда: '+data);
 console.log('Сценарий: '+JSON.stringify(scenario)+'; настоящие модели не запускаются.');
 const stop=()=>{void api.close().then(()=>process.exit(0),error=>{console.error(error);process.exit(1)})};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
} catch(error){await api.close();throw error}
