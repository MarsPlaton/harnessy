import {spawnSync} from 'node:child_process';
import {posix,win32} from 'node:path';

const bareMarkers=['.local/bin','/opt/homebrew/bin','/usr/local/bin'];
const clean=(value:string,windows=false)=>value.split(windows?win32.delimiter:':').filter(path=>path&&(windows?win32.isAbsolute(path):posix.isAbsolute(path))&&path.length<=1024&&!/[\x00-\x1f\x7f]/.test(path));
export interface PathRecovery {path:string;searched:string[];source:'login-shell'|'known-directories'|'existing'}
/** One bounded, non-interactive lookup; no shell text is interpreted as a command. */
export function recoverProgramPath(env:NodeJS.ProcessEnv=process.env,run=spawnSync,platform=process.platform):PathRecovery{
 if(platform==='win32'){
  const original=clean(env.PATH??env.Path??'',true),home=env.USERPROFILE&&win32.isAbsolute(env.USERPROFILE)?env.USERPROFILE:'',local=env.LOCALAPPDATA&&win32.isAbsolute(env.LOCALAPPDATA)?env.LOCALAPPDATA:'',roaming=env.APPDATA&&win32.isAbsolute(env.APPDATA)?env.APPDATA:'';
  const known=[...(home?[win32.join(home,'.local','bin')]:[]),...(local?[win32.join(local,'Microsoft','WinGet','Links')]:[]),...(roaming?[win32.join(roaming,'npm')]:[])];
  const searched=[...new Set([...original,...known])];return {path:searched.join(win32.delimiter),searched,source:known.some(path=>!original.includes(path))?'known-directories':'existing'};
 }
 const home=env.HOME&&posix.isAbsolute(env.HOME)?env.HOME:'',original=clean(env.PATH??''),bare=!!home&&bareMarkers.every(marker=>!original.includes(marker.startsWith('/')?marker:posix.join(home,marker)));
 let shellPaths:string[]=[];
 if(bare){
  const shell=env.SHELL&&posix.isAbsolute(env.SHELL)?env.SHELL:'/bin/zsh';
  try{const result=run(shell,['-lc','printf %s "$PATH"'],{env,encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:32768,stdio:['ignore','pipe','ignore']});if(result.status===0&&typeof result.stdout==='string'&&!/[\r\n]/.test(result.stdout))shellPaths=clean(result.stdout)}catch{}
 }
 const known=home?[posix.join(home,'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',posix.join(home,'.npm-global/bin'),posix.join(home,'.volta/bin'),posix.join(home,'.cargo/bin'),posix.join(home,'.hermes/node/bin'),...(env.NVM_BIN&&posix.isAbsolute(env.NVM_BIN)?[env.NVM_BIN]:[]),posix.join(home,'.nvm/current/bin')]:['/opt/homebrew/bin','/usr/local/bin'];
 const searched=[...new Set([...shellPaths,...original,...known])];
 return {path:searched.join(':'),searched,source:shellPaths.length?'login-shell':bare?'known-directories':'existing'};
}
