/* release.js — постоянная отметка сборки и versioned-дисклеймер ранней alpha. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{
    root.HARNESS_RELEASE_UI=api;
    const run=()=>void api.mount(root.document,typeof root.fetch==='function'?root.fetch.bind(root):null,root.HARNESS_RELEASE);
    if(root.document?.readyState==='loading')root.document.addEventListener('DOMContentLoaded',run,{once:true});else run();
  }
})(globalThis,function(){
  const releaseValue=release=>{const version=String(release?.version||''),channel=version.includes('-alpha')?'alpha':version.includes('-beta')?'beta':'latest';return release&&release.channel===channel&&/^\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+)?)?$/.test(version)?release:null};
  const acceptanceKey=release=>'releaseUnderstood_'+String(release.version).replace(/[^A-Za-z0-9]+/g,'_');
  const credentialInfo=platform=>/Windows|Win32/i.test(String(platform||''))
    ?'<dt>Доступ к моделям</dt><dd>Вход в Claude Code и Codex хранится в этих программах</dd>'
    :'<dt>Ключи</dt><dd>остаются в связке ключей macOS</dd>';
  const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  async function responseJson(request,path,options){
    if(typeof request!=='function')return null;
    try{const response=await request(path,options);if(!response||response.ok!==true)return null;return await response.json()}catch{return null}
  }
  async function accepted(request,release){
    const body=await responseJson(request,'/api/settings',{headers:{Accept:'application/json'},cache:'no-store',credentials:'same-origin'}),owner=body&&typeof body.owner==='object'?body.owner:null;
    return !!owner&&owner[acceptanceKey(release)]===true
  }
  // Демо на сайте без движка: подтверждение сохранить некуда, дверь закрывается на этот показ (в приложении движок есть всегда).
  async function engineAvailable(request){
    return (await responseJson(request,'/api/settings',{headers:{Accept:'application/json'},cache:'no-store',credentials:'same-origin'}))!==null
  }
  async function remember(request,release){
    const key=acceptanceKey(release),body=await responseJson(request,'/api/settings',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',keepalive:true,body:JSON.stringify({scope:'owner',patch:{[key]:true}})}),saved=body&&typeof body.saved==='object'?body.saved:null;
    return body?.ok===true&&!!saved&&saved[key]===true
  }
  async function mount(document,request,raw){
    const release=releaseValue(raw);if(!document||!release)return {mounted:false};
    const label=release.label||release.channel+' · '+release.version.split('-',1)[0];
    for(const top of document.querySelectorAll('.frame .top'))if(!top.querySelector('.release-badge')){
      const badge=document.createElement('span');badge.className='release-badge';badge.textContent=label;badge.setAttribute('aria-label','Версия '+label);top.append(badge);
    }
    if(release.channel==='latest')return {mounted:true,shown:false};
    const gate=document.createElement('div');gate.className='release-gate';gate.setAttribute('role','dialog');gate.setAttribute('aria-modal','true');gate.setAttribute('aria-labelledby','release-gate-title');
    gate.innerHTML='<div class="release-card"><span class="release-badge">'+escapeHtml(label)+'</span><h1 id="release-gate-title">Ранняя версия · '+release.channel+'</h1><p>Это пробная сборка. Здесь ещё может что-то ломаться и меняться.</p><dl><div><dt>Данные проектов</dt><dd>остаются в ваших папках и в git</dd></div><div>'+credentialInfo(globalThis.navigator?.userAgent)+'</div></dl><p class="release-status" role="status">Проверяю подтверждение…</p><button class="btn p" type="button" data-release-accept disabled>Понимаю, продолжить</button></div>';
    document.body.append(gate);const button=gate.querySelector('[data-release-accept]'),status=gate.querySelector('.release-status');
    if(await accepted(request,release)){gate.remove();return {mounted:true,shown:false}}
    status.textContent='';button.disabled=false;button.focus();
    button.addEventListener('click',async()=>{button.disabled=true;status.textContent='Сохраняю подтверждение…';if(await remember(request,release)){gate.remove();return}if(!(await engineAvailable(request))){gate.remove();return}status.textContent='Не удалось сохранить. Попробуйте ещё раз.';button.disabled=false;button.focus()});
    return {mounted:true,shown:true,gate};
  }
  return {acceptanceKey,accepted,remember,mount,releaseValue,engineAvailable,credentialInfo,escapeHtml};
});
