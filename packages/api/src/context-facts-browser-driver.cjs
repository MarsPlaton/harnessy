const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.CONTEXT_BROWSER_BASE;
if(!base||!process.env.CONTEXT_BROWSER_USER_DATA)throw Error('Missing isolated browser fixture');
app.setPath('userData',process.env.CONTEXT_BROWSER_USER_DATA);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
 if(app.setActivationPolicy)app.setActivationPolicy('prohibited');app.dock?.hide();
 const win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((request,done)=>done({cancel:/^https?:/.test(request.url)&&!request.url.startsWith(base+'/')}));
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.error('renderer: '+message)});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true)}catch(error){throw Error('Evaluate '+code+': '+error.message)}};
 const wait=async expression=>{for(let n=0;n<200;n++){if(await evaluate('Boolean('+expression+')'))return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error('Timed out: '+expression)};
 // Overlay opacity finishes before the panel transform/inner delay. Native
 // coordinates and the next keyboard action must wait for all three, including
 // closing transitions left by the previous interaction.
 const settled=async open=>{
  await wait(`(()=>{const o=document.querySelector('.frame.cur .ovl'),p=o?.querySelector('.panel');return o&&o.classList.contains('on')===${open}&&o.inert===${!open}&&p.classList.contains('open')===${open}})()`);
  await evaluate(`(async()=>{const o=document.querySelector('.frame.cur .ovl');await Promise.all(o.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))})()`);
 };
 const key=async name=>{
  await evaluate("window.__contextInput=new Promise(resolve=>addEventListener('keyup',()=>resolve(true),{once:true}));true");
  const code=name==='Space'?' ':name;win.webContents.sendInputEvent({type:'keyDown',keyCode:code});if(name==='Enter'||name==='Space')win.webContents.sendInputEvent({type:'char',keyCode:name==='Enter'?'\r':' '});win.webContents.sendInputEvent({type:'keyUp',keyCode:code});
  await evaluate("Promise.race([window.__contextInput,new Promise((_,reject)=>setTimeout(()=>reject(Error('key event not delivered; focus='+document.activeElement?.outerHTML?.slice(0,250))),5000))])");
 };
 await win.loadURL(base+'/sketches/proto/01-chat.html');
 try{await wait("window.LIVE?.H.on&&!LIVE.H.snapshotOnly&&!document.documentElement.hasAttribute('data-live-pending')")}catch(error){throw Error(error.message+'; boot: '+JSON.stringify(await evaluate("(async()=>({live:!!window.LIVE,on:window.LIVE?.H.on,connected:window.LIVE?.H.connected,failed:window.LIVE?.H.connectionFailed,pane:window.LIVE?.H.pane,selection:window.LIVE?.S.ui.pane,project:window.LIVE?.H.project,snapshot:window.LIVE?.H.snapshotOnly,pending:document.documentElement.hasAttribute('data-live-pending'),status:await fetch('/api/status').then(async r=>({code:r.status,text:(await r.text()).slice(0,600)})).catch(e=>String(e))}))()")))}
 await evaluate("(async()=>{LIVE.S.ui.pane='worker';LIVE.pickPane();LIVE.hStatus();await LIVE.loadChat({onboard:false});dispatchEvent(new Event('live:status'))})()");
 await wait("LIVE.H.pane?.id==='worker'&&document.querySelector('.frame.cur [data-ctx]')&&document.querySelector('[data-context-transfer=compressed]')");
 const event=await evaluate("document.querySelector('[data-context-transfer=compressed]').textContent");if(!event.includes('Дословно 1 из 2')||!event.includes('не токенизатор'))throw Error('Transfer event lost facts: '+event);
 await evaluate("document.querySelector('[data-context-transfer=compressed] details summary').focus()");await key('Enter');await wait("document.querySelector('[data-context-transfer=compressed] details').open");
 await evaluate("(async()=>{window.__transferBefore=document.querySelector('[data-context-transfer=compressed] details');await LIVE.loadChat({onboard:false})})()");
 if(!await evaluate("document.querySelector('[data-context-transfer=compressed] details').open&&document.activeElement===document.querySelector('[data-context-transfer=compressed] details summary')"))throw Error('History reread closed or defocused the transfer');
 await key('Enter');await wait("!document.querySelector('[data-context-transfer=compressed] details').open");await evaluate("LIVE.loadChat({onboard:false})");if(await evaluate("document.querySelector('[data-context-transfer=compressed] details').open"))throw Error('History reread reopened a closed transfer');
 const contrast=await evaluate(`(()=>{const ok=document.querySelector('[data-context-transfer=compressed]'),bad=document.querySelector('[data-context-transfer=failed]'),fg=getComputedStyle(bad.querySelector('small')).color,bg=getComputedStyle(bad).backgroundColor,normal=getComputedStyle(ok).backgroundColor;const rgb=s=>s.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}),lum=s=>rgb(s).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);const a=lum(fg),b=lum(bg);return {fg,bg,normal,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}})()`);
 if(contrast.bg!==contrast.normal||contrast.ratio<4.5)throw Error('Failure contrast/background is wrong: '+JSON.stringify(contrast));
 for(const [width,height] of [[1440,900],[1440,760],[1100,800],[390,844]]){
  win.setContentSize(width,height);await wait(`innerWidth===${width}&&innerHeight===${height}`);await wait(`document.documentElement.hasAttribute('data-m')===${width<760}`);
  await evaluate("document.querySelector('[data-context-transfer=compressed]').scrollIntoView({block:'center'})");await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  if(process.env.HARNESSY_TEST_SHOTS){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.HARNESSY_TEST_SHOTS,'event-'+width+'x'+height+'.png'),image.resize({width,height}).toPNG())}
  await evaluate("document.querySelector('[data-context-transfer=failed]').scrollIntoView({block:'center'})");await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  if(process.env.HARNESSY_TEST_SHOTS){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.HARNESSY_TEST_SHOTS,'failed-'+width+'x'+height+'.png'),image.resize({width,height}).toPNG())}
 }
 win.setContentSize(1440,900);await wait('innerWidth===1440&&innerHeight===900');
 await evaluate("(()=>{window.__ctxOpenBinding=LIVE.sendBinding();window.__ctxCloses=[];const close=HX.close;HX.close=function(){window.__ctxCloses.push(new Error().stack);return close.apply(this,arguments)};document.querySelector('.frame.cur [data-ctx]').click()})()");
 await wait("document.querySelector('[data-context-part=instructions] summary')?.textContent.includes('есть')&&document.querySelector('[data-context-part=documents] summary')?.textContent.includes('1')");
 try{await wait("document.querySelector('.ovl.on .panel.open .inner')&&Number(getComputedStyle(document.querySelector('.ovl.on .panel .inner')).opacity)>0.99")}catch(error){throw Error(error.message+'; state: '+JSON.stringify(await evaluate("({overlays:[...document.querySelectorAll('.ovl')].map(o=>({classes:o.className,panel:o.querySelector('.panel')?.className,opacity:getComputedStyle(o.querySelector('.inner')).opacity})),binding:LIVE.sendBinding(),opened:window.__ctxOpenBinding,closes:window.__ctxCloses,instance:LIVE.H.liveStatus?.trace?.instanceId,connected:LIVE.H.on})")))}
 await evaluate("dispatchEvent(new Event('live:status'))");if(!await evaluate("!!document.querySelector('.ovl.on [data-context-parts]')"))throw Error('A status update closed the context card');
 const facts=await evaluate("[...document.querySelectorAll('.ctx51-part summary')].map(n=>n.textContent)");
 if(!facts.some(s=>s.includes('Сохранённые сообщения')&&s.includes('4'))||!facts.some(s=>s.includes('Вложения')&&s.includes('1'))||!facts.some(s=>s.includes('Сводка соседей')&&s.includes('включена')))throw Error('Unexpected facts: '+JSON.stringify(facts));
 const history=await evaluate("document.querySelector('[data-ctab=history]')?.textContent");if(!history?.includes('2'))throw Error('Expected two saved history messages: '+history);
 await evaluate("document.querySelectorAll('.ctx51-part').forEach(n=>n.open=true)");
 for(const [width,height] of [[1440,900],[1440,760],[1100,800],[390,844]]){
  win.setContentSize(width,height);await wait(`innerWidth===${width}&&innerHeight===${height}`);await wait(`document.documentElement.hasAttribute('data-m')===${width<760}`);
  await evaluate("document.querySelector('.ctx51-card').scrollIntoView({block:'start'})");await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await wait(`(()=>{const r=document.querySelector('.ctx51-card').getBoundingClientRect();return r.left>=0&&r.right<=${width}+1})()`);
  const geometry=await evaluate(`(()=>{const p=document.querySelector('.ovl.on .panel'),c=document.querySelector('.ctx51-card'),r=c.getBoundingClientRect();return {left:r.left,right:r.right,panelScroll:p.scrollHeight>p.clientHeight||p.querySelector('.inner').scrollHeight>p.querySelector('.inner').clientHeight,pageOverflow:document.documentElement.scrollWidth>innerWidth}})()`);
  if(geometry.left<0||geometry.right>width+1||geometry.pageOverflow||!geometry.panelScroll)throw Error('Card does not fit or scroll at '+width+'x'+height+': '+JSON.stringify(geometry));
  if(process.env.HARNESSY_TEST_SHOTS){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.HARNESSY_TEST_SHOTS,'context-'+width+'x'+height+'.png'),image.resize({width,height}).toPNG())}
 }
 await evaluate("(()=>{const d=document.querySelector('[data-context-part=documents]');d.open=true;d.querySelector('a').focus();window.__ctxFetch=window.fetch;window.__ctxInterrupts=0;window.fetch=function(...args){if(String(args[0]).includes('/api/interrupt'))window.__ctxInterrupts++;return window.__ctxFetch.apply(this,args)};LIVE.H.cur={pane:'worker',text:'',tools:[]}})()");
 await settled(true);await key('Escape');await settled(false);await wait("document.querySelector('.ovl:not(.on)')?.inert&&document.activeElement.matches('.frame.cur [data-ctx]')");
 if(await evaluate("window.__ctxInterrupts!==0||document.activeElement.getAttribute('aria-expanded')!=='false'"))throw Error('Escape interrupted the turn or failed to return focus');
 await evaluate("LIVE.H.cur=null;window.fetch=window.__ctxFetch;true");await key('Tab');if(await evaluate("!!document.activeElement.closest('.ovl:not(.on)')"))throw Error('Tab entered the closed context card');
 await evaluate("document.querySelector('.frame.cur [data-ctx]').focus()");await key('Enter');await settled(true);await wait("document.querySelector('.ovl.on [data-context-parts]')&&!document.querySelector('.ovl.on').inert");await key('Escape');await settled(false);await wait("document.querySelector('.ovl:not(.on)')?.inert&&document.activeElement.matches('.frame.cur [data-ctx]')");
 const mouse=async({x,y})=>{
  await evaluate("window.__contextInput=new Promise(resolve=>addEventListener('click',()=>resolve(true),{once:true}));true");
  win.webContents.sendInputEvent({type:'mouseMove',x,y});win.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});
  await evaluate('window.__contextInput');
 };
 for(const [width,height] of [[1440,900],[1440,760],[1100,800],[390,844]]){
  win.setContentSize(width,height);await wait(`innerWidth===${width}&&innerHeight===${height}`);await wait(`document.documentElement.hasAttribute('data-m')===${width<760}`);
  for(const close of ['cross','outside']){
   await evaluate("document.querySelector('.frame.cur [data-ctx]').focus()");await key('Enter');
   try{await wait("document.querySelector('.ovl.on .panel.open [data-context-parts]')&&Number(getComputedStyle(document.querySelector('.ovl.on')).opacity)>0.99")}catch(error){throw Error(error.message+'; '+width+'x'+height+' '+close+'; '+JSON.stringify(await evaluate("({active:document.activeElement?.outerHTML?.slice(0,250),indicator:document.querySelector('.frame.cur [data-ctx]')?.outerHTML,overlay:document.querySelector('.frame.cur .ovl')?.outerHTML?.slice(0,300),binding:LIVE.sendBinding()})")))}
   await settled(true);
   await evaluate("document.querySelector('[data-context-part=messages] summary').focus()");
   const pointExpr=`(()=>{const overlay=document.querySelector('.ovl.on'),panel=overlay.querySelector('.panel');if(${JSON.stringify(close)}==='cross'){const r=panel.querySelector('.x').getBoundingClientRect(),x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);return document.elementFromPoint(x,y)?.closest('.x')?{x,y}:null}const r=overlay.getBoundingClientRect();for(const [x,y] of [[r.left+5,r.top+5],[r.right-5,r.top+5],[r.left+5,r.bottom-5],[r.right-5,r.bottom-5]])if(document.elementFromPoint(x,y)===overlay)return {x:Math.round(x),y:Math.round(y)};return null})()`;
   await wait(pointExpr);const point=await evaluate(pointExpr);
   if(!point)throw Error('No clickable '+close+' at '+width+'x'+height);await mouse(point);
   await settled(false);
   await wait("document.querySelector('.ovl:not(.on)')?.inert&&document.activeElement.matches('.frame.cur [data-ctx]')");
   if(await evaluate("document.activeElement.getAttribute('aria-expanded')!=='false'"))throw Error(close+' did not reset the indicator');await key('Tab');
   await wait("!document.activeElement.matches('.frame.cur [data-ctx]')");if(await evaluate("!!document.activeElement.closest('.ovl:not(.on)')"))throw Error('Tab entered the card closed by '+close);
  }
 }
 await evaluate("document.querySelector('.frame.cur [data-ctx]').focus()");await key('Enter');await wait("document.querySelector('.ovl.on [data-context-parts]')");
 await evaluate("(()=>{const a=document.querySelector('.frame.cur [data-ctx]');HX.open(a,'<button type=button data-other-card>Другая карточка</button>',{hide:false});document.querySelector('[data-other-card]').focus()})()");
 await settled(true);
 await wait("document.querySelector('.frame.cur [data-ctx]').getAttribute('aria-expanded')==='false'");
 if(!await evaluate("document.activeElement.matches('[data-other-card]')"))throw Error('Closing context stole focus from a replacement card');
 await evaluate('HX.close()');await settled(false);await wait("document.querySelector('.ovl:not(.on)')?.inert");
 await evaluate("document.querySelector('.frame.cur [data-ctx]').focus()");await key('Enter');await wait("document.querySelector('.ovl.on [data-context-parts]')");
 await evaluate("(()=>{LIVE.invalidateBinding();HX.close();document.querySelector('.frame.cur .live-in').focus()})()");
 await wait("document.querySelector('.ovl:not(.on)')?.inert");if(!await evaluate("document.activeElement.matches('.frame.cur .live-in')"))throw Error('Stale context stole focus from the new conversation');
 console.log('CONTEXT_BROWSER_OK');win.close();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
