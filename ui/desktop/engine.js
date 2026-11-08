const {spawn}=require('node:child_process');
const fs=require('node:fs');
const net=require('node:net');
const os=require('node:os');
const path=require('node:path');
const {recoverProgramPath}=require('./path-recovery.js');

const START_PATH='/sketches/proto/10-new-chat.html';

const delay=(ms,setTimer=setTimeout)=>new Promise(resolve=>setTimer(resolve,ms));

function available(port,host='127.0.0.1',createServer=net.createServer){
  return new Promise(resolve=>{
    const server=createServer();
    server.unref?.();
    server.once('error',()=>resolve(false));
    server.listen({port,host,exclusive:true},()=>server.close(()=>resolve(true)));
  });
}

async function firstAvailablePort(start=3777,options={}){
  const attempts=options.attempts??100;
  for(let port=start;port<start+attempts;port++)if(await available(port,options.host,options.createServer))return port;
  throw new Error('не найден свободный локальный порт');
}

function waitForExit(child){
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  return new Promise(resolve=>child.once('exit',resolve));
}

function defaultPaths(base,resourcesPath,isPackaged){
  const resourceRoot=isPackaged?resourcesPath:base;
  return {
    engineRoot:path.join(resourceRoot,'engine'),
    entry:path.join(resourceRoot,'engine','node_modules','@harnessy','api','dist','bin','harnessy.js'),
    site:isPackaged?path.join(resourceRoot,'site','sketches'):path.resolve(base,'../deploy/out/site/sketches'),
  };
}

class EngineManager {
  constructor(options={}){
    this.options=options;
    this.spawn=options.spawn??spawn;
    this.fetch=options.fetch??globalThis.fetch;
    this.execPath=options.execPath??process.execPath;
    this.env=options.env??process.env;
    this.log=options.log??(()=>{});
    this.portStart=options.portStart??3777;
    this.child=null;
    this.started=null;
    this.stopping=null;
    this.generation=0;
  }
  external(){
    const raw=this.options.externalUrl??this.env.HARNESSY_URL;
    if(!raw)return null;
    const url=new URL(raw);
    if(!['http:','https:'].includes(url.protocol))throw new Error('HARNESSY_URL: нужен http(s)-адрес');
    return {origin:url.origin,url:url.pathname==='/'?url.origin+START_PATH:url.toString()};
  }
  async status(origin){
    try{const response=await this.fetch(origin+'/api/status',{signal:AbortSignal.timeout(this.options.statusTimeoutMs??1200)});return response.ok===true}catch{return false}
  }
  async start(){
    if(this.started)return this.started;
    const generation=++this.generation;
    let pending;
    pending=this.startFresh(generation).catch(error=>{if(this.started===pending)this.started=null;throw error});
    this.started=pending;
    return this.started;
  }
  active(generation){return generation===this.generation}
  cancelled(){return new Error('запуск движка отменён')}
  async startFresh(generation){
    const external=this.external();
    if(external){if(!await this.status(external.origin))throw new Error('внешний движок не отвечает: '+external.origin);if(!this.active(generation))throw this.cancelled();return {...external,managed:false};}
    const paths=this.options.paths;
    if(!paths||!fs.existsSync(paths.entry))throw new Error('собранный движок не найден: '+String(paths&&paths.entry));
    const recovered=recoverProgramPath(this.env);this.env={...this.env,PATH:recovered.path};
    this.log('программы ищем в: '+recovered.searched.join(', '));
    let launches=0;
    for(let port=this.portStart,attempt=0;attempt<(this.options.portAttempts??100);attempt++,port++){
      if(!this.active(generation))throw this.cancelled();
      const free=await (this.options.portAvailable??available)(port);
      if(!free)continue;
      if(!this.active(generation))throw this.cancelled();
      if(launches>=(this.options.launchAttempts??3))break;
      launches++;
      const origin='http://127.0.0.1:'+port;
      const child=this.launch(paths,port);
      this.child=child;
      const ready=await this.waitUntilReady(origin,child,()=>this.active(generation));
      if(ready&&this.active(generation)){this.log('движок запущен: '+origin);return {origin,url:origin+START_PATH,port,managed:true};}
      await this.stopChild(child);
      if(this.child===child)this.child=null;
      if(!this.active(generation))throw this.cancelled();
    }
    throw new Error('движок не запустился на свободном локальном порту');
  }
  launch(paths,port){
    const logDirectory=this.options.logDirectory??path.join(os.homedir(),'.harnessy');
    fs.mkdirSync(logDirectory,{recursive:true,mode:0o700});
    const logPath=path.join(logDirectory,'server-desktop.log');
    const output=fs.openSync(logPath,'a',0o600);
    try{fs.chmodSync(logPath,0o600)}catch{}
    let child;
    try{
      child=this.spawn(this.execPath,[paths.entry],{
        cwd:paths.engineRoot,
        detached:false,
        shell:false,
        env:{...this.env,ELECTRON_RUN_AS_NODE:'1',PORT:String(port),HARNESSY_SITE:paths.site},
        stdio:['ignore',output,output,'ipc'],
      });
    }finally{fs.closeSync(output)}
    child.once('error',error=>this.log('движок: '+error.message));
    child.once('exit',(code,signal)=>{if(this.child===child&&!this.stopping)this.log('движок завершился: '+(signal||code));});
    return child;
  }
  async waitUntilReady(origin,child,active=()=>true){
    const attempts=this.options.readyAttempts??80,waitMs=this.options.readyWaitMs??250;
    for(let i=0;i<attempts;i++){
      if(!active()||child.exitCode!==null||child.signalCode!==null)return false;
      if(await this.status(origin))return true;
      await delay(waitMs,this.options.setTimeout);
    }
    return false;
  }
  async stopChild(child){
    if(child.exitCode!==null||child.signalCode!==null)return;
    const exited=waitForExit(child);
    try{if(process.platform==='win32'&&child.connected)child.disconnect();else child.kill('SIGTERM')}
    catch{child.kill('SIGTERM')}
    const graceful=await Promise.race([exited.then(()=>true),delay(this.options.stopTimeoutMs??5000,this.options.setTimeout).then(()=>false)]);
    if(!graceful&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited}
  }
  async stop(){
    if(this.stopping)return this.stopping;
    this.generation++;
    const child=this.child;this.child=null;this.started=null;
    if(!child)return;
    this.stopping=this.stopChild(child).finally(()=>{this.stopping=null});
    return this.stopping;
  }
  async restart(){await this.stop();return this.start()}
  killNow(){this.generation++;const child=this.child;this.child=null;if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
}

module.exports={EngineManager,START_PATH,available,defaultPaths,firstAvailablePort};
