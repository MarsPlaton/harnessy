import {open,mkdir,readFile,unlink} from 'node:fs/promises';
import {constants,lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {CliStateStore} from './cli/state.ts';
import {assertPrivateDirectory,hardenPrivateDirectory} from '@harnessy/team';
import {ProviderError} from './types.ts';
import type {CliTurnInput} from './cli/types.ts';
import {importGeminiSession} from './gemini-session.ts';
import {geminiSettingsGuard} from './gemini-settings-guard.ts';

export const geminiHome=(env:NodeJS.ProcessEnv)=>resolve(env.GEMINI_CLI_HOME||homedir());
const unavailable=()=>new ProviderError('capability_unsupported','Gemini: настройки проекта могут включить hooks; изолированный ход недоступен');
function workspace(input:CliTurnInput){try{lstatSync(join(input.seat.cwd,'.gemini','settings.json'));throw unavailable()}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
// Gemini 0.63 accepts user settings, but system settings require root ownership.
// A leased private home preserves CLI sessions without changing the owner's home.
// Only the existing Google login is projected; no ambient settings/extensions/MCP.
export async function prepareGeminiSettings(configPath:string,input:CliTurnInput,env:NodeJS.ProcessEnv,stateRoot?:string){
 workspace(input);
 const lease=new CliStateStore('gemini',stateRoot).acquire(input.seat.cwd,input.seat.id),config=join(lease.path,'.gemini');
 let guard:ReturnType<typeof geminiSettingsGuard>|undefined;
 const privateDirectory=()=>{lease.validate();guard?.directories();if(process.platform==='win32')assertPrivateDirectory(config)};
 const validate=()=>{privateDirectory();workspace(input)};
 try{
  await mkdir(config,{mode:0o700,recursive:true});
  if(process.platform==='win32')hardenPrivateDirectory(config);
  guard=geminiSettingsGuard(config);
  await importGeminiSession(join(geminiHome(env),'.gemini'),config,input.seat.cwd,input.seat.sessionId,validate);
  for(const name of ['oauth_creds.json','google_accounts.json']){
   const source=await open(join(geminiHome(env),'.gemini',name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(e=>{if(e.code==='ENOENT')return null;throw e});
   if(!source){privateDirectory();await unlink(join(config,name)).catch(e=>{if(e.code!=='ENOENT')throw e});continue}
   try{const stat=await source.stat();if(!stat.isFile()||stat.size>1024*1024)throw new ProviderError('protocol','Gemini: неверный файл входа');
    const bytes=Buffer.alloc(1024*1024+1),{bytesRead}=await source.read(bytes,0,bytes.length,0);if(bytesRead>1024*1024)throw new ProviderError('protocol','Gemini: неверный файл входа');
    validate();const target=await open(join(config,name),constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{await target.chmod(0o600);await target.writeFile(bytes.subarray(0,bytesRead))}finally{await target.close()}
   }finally{await source.close()}
  }
  const value=JSON.parse(await readFile(configPath,'utf8'));value.security={auth:{selectedType:'oauth-personal'}};
  validate();guard.write(JSON.stringify(value));
  return {env:{GEMINI_CLI_HOME:lease.path,GEMINI_CLI_SYSTEM_SETTINGS_PATH:'',GEMINI_CLI_SYSTEM_DEFAULTS_PATH:''},validate:()=>{validate();guard!.validate()},dispose:async()=>{try{guard?.dispose()}finally{lease.release()}}};
 }catch(e){try{guard?.dispose()}finally{lease.release()}throw e}
}
