const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');

const base=process.env.PROMOTION_BROWSER_BASE,id=process.env.PROMOTION_CHAT_ID,operationId=process.env.PROMOTION_OPERATION_ID;
if(!base||!id||!operationId||!process.env.PROMOTION_BROWSER_USER_DATA)throw Error('Missing isolated browser fixture');
app.setPath('userData',process.env.PROMOTION_BROWSER_USER_DATA);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-features','Translate');
app.commandLine.appendSwitch('force-device-scale-factor','1');

app.whenReady().then(async()=>{
 if(app.setActivationPolicy)app.setActivationPolicy('prohibited');app.dock?.hide();
 const win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 let requests=0;
 win.webContents.session.webRequest.onBeforeRequest((request,done)=>{
  if(request.method==='POST'&&request.url===base+'/api/chats/'+encodeURIComponent(id)+'/orchestrator')requests++;
  done({cancel:/^https?:/.test(request.url)&&!request.url.startsWith(base+'/')});
 });
 const evaluate=code=>win.webContents.executeJavaScript(code,true);
 const wait=async expression=>{for(let n=0;n<200;n++){if(await evaluate('Boolean('+expression+')'))return;await new Promise(resolve=>setTimeout(resolve,50))}const detail=await evaluate("JSON.stringify({pane:window.LIVE?.H?.pane?.id,actions:document.querySelector('.frame.cur .live-acts')?.outerHTML,role:document.querySelector('.frame.cur [data-cx=role]')?.outerHTML})");throw Error('Timed out: '+expression+'; DOM: '+detail)};
 const bounds=selector=>`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return {x,y,width:r.width,height:r.height,hit:!!h&&(h===e||e.contains(h))}})()`;
 const click=async selector=>{
  await wait('!!('+bounds(selector)+')?.hit');const rect=await evaluate(bounds(selector));
  if(!rect||!rect.width||!rect.height||!rect.hit)throw Error('Not clickable: '+selector);
  const x=Math.round(rect.x),y=Math.round(rect.y);win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
 };
 await win.loadURL(base+'/sketches/proto/01-chat.html');
 await wait("window.LIVE?.H.on&&!LIVE.H.snapshotOnly&&!document.documentElement.hasAttribute('data-live-pending')");
 await click('.frame.cur [data-cx="role"]');await wait('!!document.querySelector(\'[data-cx-seat="orchestrator"]\')');await click('[data-cx-seat="orchestrator"]');
 await new Promise(resolve=>setTimeout(resolve,100));if(await evaluate('!!document.querySelector("[data-cx-sw=plain]")'))await click('[data-cx-sw="plain"]');
 await wait('LIVE.H.pane?.id==="orchestrator"&&LIVE.H.active.orchestrator==='+JSON.stringify(id));
 await wait('!!document.querySelector(\'.frame.cur [data-la="assign"]\')');
 const pending=await evaluate('LIVE.H.chatList.find(c=>c.id==='+JSON.stringify(id)+')?.promotion');
 if(!pending?.pending||pending.completed!==3||pending.operationId!==operationId)throw Error('Wrong saved operation before click');
 for(const [width,height] of [[1440,900],[1440,760],[1100,800],[390,844]]){
  win.setContentSize(width,height);await new Promise(resolve=>setTimeout(resolve,100));
  await wait('!!('+bounds('.frame.cur [data-la="assign"]')+')?.hit');
  if(process.env.HARNESSY_TEST_SHOTS){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.HARNESSY_TEST_SHOTS,'pending-'+width+'x'+height+'.png'),image.resize({width,height}).toPNG())}
 }
 await click('.frame.cur [data-la="assign"]');
 await wait('LIVE.H.chatList.some(c=>c.id==='+JSON.stringify(id)+'&&c.promotion&&!c.promotion.pending)');
 await wait('!document.querySelector(\'.frame.cur [data-la="assign"]\')');
 const completed=await evaluate('LIVE.H.chatList.find(c=>c.id==='+JSON.stringify(id)+')?.promotion');
 if(completed?.operationId!==operationId||requests!==1)throw Error('Wrong operation or number of requests');
 if(process.env.HARNESSY_TEST_SHOTS){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.HARNESSY_TEST_SHOTS,'completed-390x844.png'),image.resize({width:390,height:844}).toPNG())}
 console.log('Browser promotion recovery: same chat and operation, one request.');win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
