const {spawnSync}=require('node:child_process');
const path=require('node:path');
const clean=(value,windows=false)=>String(value||'').split(windows?path.win32.delimiter:':').filter(part=>part&&(windows?path.win32.isAbsolute(part):path.posix.isAbsolute(part))&&part.length<=1024&&!/[\x00-\x1f\x7f]/.test(part));
function recoverProgramPath(env=process.env,run=spawnSync,platform=process.platform){
 if(platform==='win32'){
  const original=clean(env.PATH??env.Path,true),home=env.USERPROFILE&&path.win32.isAbsolute(env.USERPROFILE)?env.USERPROFILE:'',local=env.LOCALAPPDATA&&path.win32.isAbsolute(env.LOCALAPPDATA)?env.LOCALAPPDATA:'',roaming=env.APPDATA&&path.win32.isAbsolute(env.APPDATA)?env.APPDATA:'';
  const known=[...(home?[path.win32.join(home,'.local','bin')]:[]),...(local?[path.win32.join(local,'Microsoft','WinGet','Links')]:[]),...(roaming?[path.win32.join(roaming,'npm')]:[])];
  const searched=[...new Set([...original,...known])];return {path:searched.join(path.win32.delimiter),searched,source:known.some(part=>!original.includes(part))?'known-directories':'existing'};
 }
 const home=env.HOME&&path.posix.isAbsolute(env.HOME)?env.HOME:'',original=clean(env.PATH),bare=!!home&&![path.posix.join(home,'.local/bin'),'/opt/homebrew/bin','/usr/local/bin'].some(part=>original.includes(part));
 let shellPaths=[];
 if(bare){try{const shell=env.SHELL&&path.posix.isAbsolute(env.SHELL)?env.SHELL:'/bin/zsh',result=run(shell,['-lc','printf %s "$PATH"'],{env,encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:32768,stdio:['ignore','pipe','ignore']});if(result.status===0&&typeof result.stdout==='string'&&!/[\r\n]/.test(result.stdout))shellPaths=clean(result.stdout)}catch{}}
 const known=home?[path.posix.join(home,'.local/bin'),'/opt/homebrew/bin','/usr/local/bin',path.posix.join(home,'.npm-global/bin'),path.posix.join(home,'.volta/bin'),path.posix.join(home,'.cargo/bin'),path.posix.join(home,'.hermes/node/bin'),...(env.NVM_BIN&&path.posix.isAbsolute(env.NVM_BIN)?[env.NVM_BIN]:[]),path.posix.join(home,'.nvm/current/bin')]:['/opt/homebrew/bin','/usr/local/bin'];
 const searched=[...new Set([...shellPaths,...original,...known])];return {path:searched.join(':'),searched,source:shellPaths.length?'login-shell':bare?'known-directories':'existing'};
}
module.exports={recoverProgramPath};
