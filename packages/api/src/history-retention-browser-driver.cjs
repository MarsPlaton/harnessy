const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const base=process.env.RETENTION_BROWSER_BASE;
if(!base||!process.env.RETENTION_BROWSER_USER_DATA)throw Error('Missing isolated browser fixture');
app.setPath('userData',process.env.RETENTION_BROWSER_USER_DATA);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 if(app.setActivationPolicy)app.setActivationPolicy('prohibited');app.dock?.hide();
 const win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((request,done)=>done({cancel:/^https?:/.test(request.url)&&!request.url.startsWith(base+'/')}));
 const evaluate=code=>win.webContents.executeJavaScript(code,true);
 const wait=async expression=>{for(let n=0;n<200;n++){if(await evaluate('Boolean('+expression+')'))return;await new Promise(resolve=>setTimeout(resolve,50))}const state=await evaluate("({current:LIVE.H.cur&&Object.keys(LIVE.H.cur),chatLength:LIVE.S.chat.length,tail:LIVE.S.chat.slice(-3).map(m=>({role:m.role,src:m.src,text:m.text?.slice(0,80),html:m.html?.slice(0,600),queued:m.queued})),paneBusy:LIVE.H.pane?.busy,waiting:LIVE.H.pane?.waiting,link:LIVE.H.link,pending:document.documentElement.hasAttribute('data-live-pending')})");throw Error('Timed out: '+expression+'; state='+JSON.stringify(state))};
 await win.loadURL(base+'/sketches/proto/01-chat.html');
 await wait("window.LIVE?.H.on&&!LIVE.H.snapshotOnly&&!document.documentElement.hasAttribute('data-live-pending')");
 await evaluate("(async()=>{LIVE.S.ui.pane='worker';LIVE.S.ui.direct={worker:true};LIVE.pickPane();LIVE.hStatus();await LIVE.loadChat({onboard:false});CX.render()})()");
 await wait("LIVE.H.pane?.id==='worker'&&LIVE.S.chat.length>40&&document.querySelector('.frame.cur .live-in')");
 for(const [run,[width,height]] of [[1440,900],[1440,760],[1100,800],[390,844]].entries()){
  win.setContentSize(width,height);await wait(`innerWidth===${width}&&innerHeight===${height}`);
  // Exercise completion and selection deterministically; native input delivery is covered by context-facts-browser-driver.
  await evaluate(`(()=>{const ta=document.querySelector('.frame.cur .live-in');ta.value='Новый вопрос ${run}';ta.dispatchEvent(new Event('input',{bubbles:true}));ta.focus();const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});ta.dispatchEvent(enter);if(!enter.defaultPrevented)throw Error('Enter was not handled')})()`);
  await wait(`document.querySelector('.frame.cur .live-cur .md-body')?.textContent.includes('Новый ответ ${run}')`);
  const before=await evaluate(`(()=>{const rows=[...document.querySelectorAll('.frame.cur .live-msg.ai[data-message-index]')],node=rows.find(n=>n.querySelector('.md-body p')?.textContent.includes('Сохранённый ответ 12')),text=node?.querySelector('.md-body p')?.firstChild,button=node?.querySelector('button[data-la]');if(!node||!text||!button)throw Error('Missing saved message or its action');node.scrollIntoView({block:'center'});button.focus({preventScroll:true});const range=document.createRange();range.setStart(text,0);range.setEnd(text,11);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);window.__retention={node,text,button,id:node.dataset.messageLiveId,index:Number(node.dataset.messageIndex),selection:sel.toString()};return {count:LIVE.S.chat.length,index:window.__retention.index,selection:sel.toString(),focused:document.activeElement===button}})()`);
  if(before.count<=40||!before.focused||before.selection!=='Сохранённый')throw Error('Invalid fixture before completion: '+JSON.stringify(before));
  console.log('RELEASE_'+run);await wait(`!LIVE.H.cur&&LIVE.S.chat.length===40&&LIVE.S.chat.some(m=>m.text==='Новый ответ ${run}')`);
  const after=await evaluate(`(()=>{const s=window.__retention,node=document.querySelector('.frame.cur .live-msg[data-message-live-id="'+s.id+'"]');return {same:node===s.node,text:s.text.isConnected,selection:getSelection().toString(),focused:document.activeElement===s.button,index:Number(node?.dataset.messageIndex),actionIndex:Number(s.button.dataset.i),count:LIVE.S.chat.length}})()`);
  if(!after.same||!after.text||after.selection!==before.selection||!after.focused||after.index>=before.index||after.actionIndex!==after.index||after.count!==40)throw Error('Completion lost selection or focus at '+width+'x'+height+': '+JSON.stringify({before,after}));
  if(process.env.HARNESSY_TEST_SHOTS){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.HARNESSY_TEST_SHOTS,'history-'+width+'x'+height+'.png'),image.resize({width,height}).toPNG())}
 }
 // A changed ordering must retain the same focused and selected message even if it moves.
 const reordered=await evaluate(`(async()=>{const s=window.__retention;getSelection().setBaseAndExtent(s.text,11,s.text,0);const seq=LIVE.S.chat[Number(s.node.dataset.messageIndex)].seq,history=await LIVE.api('/api/chats/'+LIVE.H.active.worker),message=history.messages.find(m=>m.role==='ai'&&m.seq===seq);if(!message)throw Error('Missing selected message in history');message.ts=1;await LIVE.loadChat({onboard:false,history});const node=document.querySelector('.frame.cur .live-msg[data-message-live-id="'+s.id+'"]'),selection=getSelection();return {same:node===s.node,index:Number(node?.dataset.messageIndex),selection:selection.toString(),anchor:selection.anchorOffset,focus:selection.focusOffset,focused:document.activeElement===s.button,text:s.text.isConnected}})()`);
 if(!reordered.same||reordered.index!==0||reordered.selection!=='Сохранённый'||reordered.anchor!==11||reordered.focus!==0||!reordered.focused||!reordered.text)throw Error('Reordered history lost selection or focus: '+JSON.stringify(reordered));
 win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
