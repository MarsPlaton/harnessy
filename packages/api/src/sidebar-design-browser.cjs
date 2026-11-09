const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.setPath('userData',process.env.SIDEBAR_BROWSER_USER_DATA);
app.whenReady().then(async()=>{
  if(app.dock) app.dock.hide();
  const output=process.env.SIDEBAR_SCREENSHOTS;
  if(output) fs.mkdirSync(output,{recursive:true});
  for(const [w,h] of [[1440,900],[1440,760],[1100,800],[390,844]]){
    const win=new BrowserWindow({show:false,width:w,height:h,useContentSize:true,webPreferences:{sandbox:true}});
    const js=s=>win.webContents.executeJavaScript(s);
    const shot=async name=>{if(output) fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).resize({width:w,height:h,quality:'best'}).toPNG());};
    try{
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:false});
      const key=async k=>{const [key,code,n]={Enter:['Enter','Enter',13],Space:[' ','Space',32],Tab:['Tab','Tab',9],ArrowDown:['ArrowDown','ArrowDown',40],Escape:['Escape','Escape',27]}[k];const args={key,code,windowsVirtualKeyCode:n,nativeVirtualKeyCode:n};await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'rawKeyDown',...args});if(k==='Enter') await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'char',text:'\r',...args});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...args});await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');};
      const frame=w===390?'a1-390':'a1-chat',selector='#'+frame;
      await win.loadFile(path.join(process.env.SIDEBAR_SITE,'sketches/disarto/40-sidebar.html'),{hash:'shot='+frame});
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const geometry=await js(`(()=>{const p=document.querySelector('${selector} aside.side.ps'),row=p.querySelector('.ps2-current-project');return {panel:p.getBoundingClientRect().width,text:row.textContent,role:getComputedStyle(row.querySelector(':scope>.m')).visibility,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      assert.equal(geometry.panel,232,JSON.stringify(geometry));assert.match(geometry.text,/Alpha-Test.*2 роли.*⋯/);assert.equal(geometry.role,'visible');assert.equal(geometry.overflow,false);
      await shot(`${w}x${h}.png`);
      await js(`document.querySelector('${selector} .ps2-current-toggle').focus()`);
      await key('Enter');
      const state=()=>js(`(()=>{const t=document.querySelector('${selector} .ps2-current-toggle');return {expanded:t.getAttribute('aria-expanded'),hidden:document.getElementById(t.getAttribute('aria-controls')).hidden,focus:document.activeElement===t}})()`);
      assert.deepEqual(await state(),{expanded:'false',hidden:true,focus:true});
      if(w===390) await shot('390x844-collapsed.png');
      await key('Space');assert.deepEqual(await state(),{expanded:'true',hidden:false,focus:true});
      const point=await js(`(()=>{const r=document.querySelector('${selector} .ps2-current-toggle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      const click=async()=>{await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});};
      await click();assert.deepEqual(await state(),{expanded:'false',hidden:true,focus:true});
      await click();assert.deepEqual(await state(),{expanded:'true',hidden:false,focus:true});
      const clickElement=async target=>{await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const location=await js(`(()=>{const e=document.querySelector('${selector} ${target}'),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,rect:[r.left,r.top,r.right,r.bottom],hit:hit?.outerHTML.slice(0,240),reachable:hit===e||e.contains(hit)}})()`);assert.equal(location.reachable,true,`${w}x${h} ${target} is not reachable by pointer: ${JSON.stringify(location)}`);const point={x:location.x,y:location.y};for(const type of ['mouseMoved','mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');};
      const menuOpen=()=>js(`(()=>{const r=document.querySelector('${selector} .ps2-current-project');return {row:r.classList.contains('open'),popover:r.querySelector('[popover]').matches(':popover-open'),expanded:r.querySelector('.ps2-current-menu').getAttribute('aria-expanded')}})()`);
      await clickElement('.ps2-current-project > .m');assert.deepEqual(await menuOpen(),{row:false,popover:false,expanded:'false'});
      await clickElement('.ps2-current-menu');assert.deepEqual(await menuOpen(),{row:true,popover:true,expanded:'true'});
      await clickElement('.ps2-current-project > .m');assert.deepEqual(await menuOpen(),{row:true,popover:true,expanded:'true'});
      await key('Escape');assert.equal(await js(`document.activeElement===document.querySelector('${selector} .ps2-current-menu')`),true);
      await key('Enter');
      const menu=await js(`(()=>{const row=document.querySelector('${selector} .ps2-current-project'),m=row.querySelector('[popover]'),frame=row.closest('.ps2-phone, .app'),f=frame.getBoundingClientRect(),r=m.getBoundingClientRect(),rr=row.getBoundingClientRect(),items=[...m.querySelectorAll('[role=menuitem]')],hits=items.filter(x=>{const a=x.getBoundingClientRect(),hit=document.elementFromPoint(a.left+a.width/2,a.top+a.height/2);return hit&&(hit===x||x.contains(hit))}).length;return {open:m.matches(':popover-open'),expanded:row.querySelector('.ps2-current-menu').getAttribute('aria-expanded'),role:getComputedStyle(row.querySelector(':scope>.m')).visibility,count:items.length,hits,rect:[r.left,r.top,r.right,r.bottom],row:[rr.top,rr.bottom],frame:[f.left,f.top,f.right,f.bottom],styleTop:m.style.top,styleMaxHeight:m.style.maxHeight,transform:getComputedStyle(frame).transform,scrollTop:row.closest('.ps-scroll').scrollTop,focus:document.activeElement===items[0]}})()`);
      if(w===390) console.log('390x844 menu geometry: '+JSON.stringify(menu));
      assert.equal(menu.open,true,JSON.stringify(menu));assert.equal(menu.expanded,'true');assert.equal(menu.role,'visible');assert.equal(menu.count,9);assert.equal(menu.hits,9,JSON.stringify(menu));assert.equal(menu.focus,true);
      assert.equal((await js(`document.querySelector('${selector} .ps2-current-toggle').getAttribute('aria-expanded')`)),'true');
      assert.ok(menu.rect[0]>=0&&menu.rect[1]>=0&&menu.rect[2]<=w&&menu.rect[3]<=h,JSON.stringify(menu));
      if(w===390){assert.ok(menu.rect[1]>=menu.row[1]||menu.rect[3]<=menu.row[0],JSON.stringify(menu));await shot('390x844-menu.png');}
      await key('ArrowDown');assert.equal(await js(`document.activeElement===document.querySelectorAll('${selector} .ps2-current-project [role=menuitem]')[1]`),true);
      await key('Escape');assert.equal(await js(`document.activeElement===document.querySelector('${selector} .ps2-current-menu')`),true);assert.equal(await js(`document.querySelector('${selector} .ps2-current-menu').getAttribute('aria-expanded')`),'false');
      await key('Space');await key('Tab');assert.equal(await js(`document.querySelector('${selector} .ps2-current-menu').getAttribute('aria-expanded')`),'false');assert.equal(await js(`!!document.activeElement.closest('${selector} .ps2-pmenu')`),false);
      console.log(`${w}x${h}: 232px, Enter/Space, Tab, меню 9/9, счётчик и Escape`);
    }finally{win.close()}
  }
  app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
