// main.js — автономная оболочка Harnessy. Собранный движок работает в Node,
// встроенном в Electron; системный Node приложению не нужен.
const {app,BrowserWindow,shell,nativeTheme,ipcMain,dialog,Menu}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EngineManager,defaultPaths}=require('./engine.js');
const {DesktopUpdates,trustedUpdateOrigin}=require('./updates.js');
const {autoUpdater}=require('electron-updater');
const {reportDesktopTrace}=require('./trace.js');

const DARK='#0a0a0b';
const HIDDEN_TEST_WINDOW=process.env.HARNESSY_TEST_WINDOW==='hidden';
const PRIMARY=app.requestSingleInstanceLock();
app.setName('Harnessy-alpha');
nativeTheme.themeSource='dark';
if(!PRIMARY)app.quit();

const firstRunPath=process.env.HARNESS_PROJECTS_FILE||path.join(os.homedir(),'.harness-projects.json');
const firstRun=!fs.existsSync(firstRunPath);
const engine=new EngineManager({
  externalUrl:process.env.HARNESSY_URL,
  paths:defaultPaths(__dirname,process.resourcesPath,app.isPackaged),
  log:message=>console.log('[harnessy] '+message),
});
let currentOrigin='';
let allowQuit=false,stopping=false;
const updates=new DesktopUpdates({
  updater:autoUpdater,packaged:app.isPackaged&&process.platform==='darwin',file:path.join(app.getPath('userData'),'updates.json'),
  notify:state=>BrowserWindow.getAllWindows().forEach(win=>{if(!win.isDestroyed())win.webContents.send('harnessy:update-state',state)}),
  stopEngine:()=>engine.stop(),resumeEngine:async()=>{
    const launch=await engine.start(),previous=currentOrigin;
    currentOrigin=launch.origin;
    if(previous!==currentOrigin)for(const win of BrowserWindow.getAllWindows()){
      if(win.isDestroyed())continue;
      const old=win.webContents.getURL();
      if(!sameOrigin(old,previous))continue;
      const page=new URL(old);
      void win.loadURL(new URL(page.pathname+page.search+page.hash,currentOrigin).href);
    }
  },allowQuit:value=>{allowQuit=value},
  log:message=>console.log('[harnessy] '+message),
});

const html=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const offline=reason=>'data:text/html;charset=utf-8,'+encodeURIComponent(
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Harnessy-alpha</title><style>
  body{margin:0;background:${DARK};color:#ececee;font:14px/1.5 Inter,-apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh}
  .c{max-width:520px;padding:28px 32px;border:1px solid #2d2d32;border-radius:16px;background:#141416}
  .e{font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#c27a34;margin-bottom:10px}
  h1{font-size:22px;margin:0 0 8px;letter-spacing:-.01em}p{color:#9a9aa2;margin:0 0 6px}code{color:#d89c54}</style></head>
  <body><div class="c"><div class="e">Harnessy · alpha</div><h1>Движок не запустился</h1>
  <p>${html(reason)}</p><p>Подробности: <code>${html(path.join(os.homedir(),'.harnessy','server-desktop.log'))}</code></p><p>После исправления нажмите ${process.platform==='win32'?'Ctrl+R':'⌘R'}.</p></div></body></html>`);

const {contextMenuTemplate}=require('./context-menu.js');
const contextMeta=new WeakMap();
ipcMain.on('harnessy:context-meta',(event,value)=>{
  const text=value&&typeof value.text==='string'?value.text.slice(0,100000):'';
  contextMeta.set(event.sender,{quote:value&&value.quote===true,text});
});

function sameOrigin(url,origin){try{return new URL(url).origin===origin}catch{return false}}

async function createWindow(){
  let launch=null,failure='';
  try{launch=await engine.start();currentOrigin=launch.origin}catch(error){failure=error instanceof Error?error.message:String(error)}
  const start=launch?(firstRun?launch.origin+'/sketches/proto/19-first-run.html':launch.url):offline(failure||'неизвестная ошибка запуска');
  const win=new BrowserWindow({
    width:1440,height:920,minWidth:900,minHeight:600,title:'Harnessy-alpha',backgroundColor:DARK,show:false,focusable:!HIDDEN_TEST_WINDOW,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false,preload:path.join(__dirname,'preload.js')},
  });
  const log=message=>console.log('[harnessy] '+message);
  const nativeFailure=action=>currentOrigin&&void reportDesktopTrace(currentOrigin,action);
  win.webContents.on('render-process-gone',()=>nativeFailure('render-process-gone'));
  win.webContents.on('did-fail-load',(_event,code)=>{if(code!==-3)nativeFailure('did-fail-load')});
  win.on('unresponsive',()=>nativeFailure('unresponsive'));
  win.once('ready-to-show',()=>{if(!HIDDEN_TEST_WINDOW)win.show()});
  win.webContents.setWindowOpenHandler(({url})=>{if(!sameOrigin(url,currentOrigin)){void shell.openExternal(url);return {action:'deny'}}return {action:'allow'}});
  win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('data:')&&!sameOrigin(url,currentOrigin)){event.preventDefault();void shell.openExternal(url)}});
  win.webContents.on('page-title-updated',event=>event.preventDefault());
  win.webContents.on('did-start-navigation',()=>contextMeta.delete(win.webContents));
  win.webContents.on('context-menu',(event,params)=>{
    event.preventDefault();
    const template=contextMenuTemplate(params,contextMeta.get(win.webContents),{
      quote:text=>win.webContents.send('harnessy:quote-selection',text),
      transfer:text=>win.webContents.send('harnessy:transfer-selection',text),
      copyImage:()=>win.webContents.copyImageAt(params.x, params.y),
    });
    Menu.buildFromTemplate(template).popup({window:win});
  });
  if(process.env.HARNESSY_SHOT)win.webContents.once('did-finish-load',()=>setTimeout(async()=>{
    try{fs.writeFileSync(process.env.HARNESSY_SHOT,(await win.webContents.capturePage()).toPNG());log('кадр: '+process.env.HARNESSY_SHOT)}catch(error){log('кадр не снят: '+error.message)}
  },1800));
  await win.loadURL(start);
  log((launch?'открыт ':'офлайн: ')+start);
}

ipcMain.handle('harnessy:pick-folder',async(event,options={})=>{
  const win=BrowserWindow.fromWebContents(event.sender);
  const result=await dialog.showOpenDialog(win,{title:options.title||'Папка проекта',buttonLabel:options.button||'Выбрать',message:options.message||'',
    defaultPath:options.defaultPath&&fs.existsSync(options.defaultPath)?options.defaultPath:os.homedir(),properties:['openDirectory','createDirectory']});
  return result.canceled||!result.filePaths.length?null:result.filePaths[0];
});
ipcMain.handle('harnessy:pick-file',async(event,options={})=>{
  const win=BrowserWindow.fromWebContents(event.sender);
  if(!win||!trustedUpdateOrigin(event.sender.getURL(),currentOrigin))throw Error('Окно не подтверждено');
  const result=await dialog.showOpenDialog(win,{title:'Выберите файл программы',buttonLabel:'Указать программу',
    defaultPath:os.homedir(),properties:['openFile']});
  return result.canceled||!result.filePaths.length?null:result.filePaths[0];
});

function updateSender(event){
  return !!BrowserWindow.fromWebContents(event.sender)&&trustedUpdateOrigin(event.sender.getURL(),currentOrigin);
}
ipcMain.handle('harnessy:update-state',event=>{if(!updateSender(event))throw Error('Окно не подтверждено');return updates.state()});
ipcMain.handle('harnessy:update-channel',(event,channel)=>{if(!updateSender(event))throw Error('Окно не подтверждено');return updates.setChannel(channel)});
ipcMain.handle('harnessy:update-install',event=>{if(!updateSender(event))throw Error('Окно не подтверждено');return updates.install()});

app.on('before-quit',event=>{
  updates.dispose();
  if(allowQuit||!PRIMARY)return;
  event.preventDefault();
  if(stopping)return;
  stopping=true;
  void engine.stop().finally(()=>{allowQuit=true;app.quit()});
});
process.once('exit',()=>engine.killNow());
process.on('uncaughtExceptionMonitor',()=>{if(currentOrigin)void reportDesktopTrace(currentOrigin,'uncaught-exception')});
if(PRIMARY)app.whenReady().then(async()=>{
  if(HIDDEN_TEST_WINDOW){app.setActivationPolicy?.('prohibited');app.dock?.hide()}
  await createWindow();updates.start();
});
app.on('activate',()=>{if(!HIDDEN_TEST_WINDOW&&PRIMARY&&BrowserWindow.getAllWindows().length===0)void createWindow()});
app.on('window-all-closed',()=>app.quit());
