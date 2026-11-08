import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {join,win32} from 'node:path';
import {FORBIDDEN_ENV,type RouteEnv,type BuiltinVendor} from './types.ts';
const PROXIES=['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy','NO_PROXY','no_proxy','NODE_OPTIONS','NODE_USE_ENV_PROXY','HARNESS_RELAY_PROXY'] as const;
export function stripElectronServiceEnv(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
 for(const key of Object.keys(env))if(key.startsWith('ELECTRON_'))delete env[key];return env;
}
export function childEnv(vendor:BuiltinVendor,route:RouteEnv={},base:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const env={...base};
 for(const key of PROXIES)if(typeof route[key]==='string')env[key]=route[key];
 for(const key of FORBIDDEN_ENV[vendor])delete env[key];
 // Bridge credentials never belong to an agent process.
 delete env.PANE_TOKEN;return stripElectronServiceEnv(env);
}
export async function claudeBinary(env:NodeJS.ProcessEnv=process.env,platform=process.platform):Promise<string|null>{
 const windows=platform==='win32',home=windows?(env.USERPROFILE??homedir()):homedir();
 const fromPath=windows?(env.PATH??env.Path??'').split(win32.delimiter).filter(win32.isAbsolute).map(dir=>join(dir,'claude.exe')):[];
 const candidates=windows?[env.CLAUDE_BIN,join(home,'.local','bin','claude.exe'),join(home,'.claude','local','claude.exe'),...fromPath]:[env.CLAUDE_BIN,join(home,'.local','bin','claude'),join(home,'.claude','local','claude'),'/opt/homebrew/bin/claude','/usr/local/bin/claude'];
 for(const path of candidates){
  if(!path)continue;try{await access(path,constants.X_OK);return path}catch{}
 }return null;
}
