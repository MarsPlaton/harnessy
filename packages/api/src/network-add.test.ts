import {fixtureSource,fixtureGroups} from './live-fixture.ts';
import {createContext,runInContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {ProviderCatalog,ProviderError,builtinEntries} from '@harnessy/providers';
import {fixture,call,deferred,FakeProvider} from './test-helpers.ts';
import {MemoryKeys} from '../../llm/src/test-helpers.ts';
import {networkUi as ui} from './network-ui-test-helpers.ts';
import {sshDouble} from '../../runtime/src/ssh-test-helpers.ts';
const opts={timeout:15000},root='/api/network';
const unixTest=process.platform==='win32'?test.skip:test;
const proxy={id:'fixture-proxy',type:'proxy',label:'Прокси',url:'socks5h://proxy.test:1080',login:'alice'};
const ssh={id:'fixture-vps',type:'ssh',label:'VPS',host:'vps.test',port:2222,user:'owner',keyPath:'~/.ssh/id_ed25519'};
const measured={ok:true,revision:'check',checkedAt:100,ip:'192.0.2.5',country:'Нидерланды',durationMs:48,state:'checked'};
const output=(input:string)=>({code:0,signal:null,stdout:input.includes('ipify')?'{"ip":"192.0.2.5"}\n0.048':'{"country_name":"Нидерланды"}\n0.05',stderr:''});
function tunnels(){const calls:any[]=[],stopped:string[]=[];return {calls,stopped,async ensure(id:string,config:any){assert.deepEqual(Object.keys(config).sort(),['host','keyPath','port','user']);calls.push({id,config});return {id,state:'up',url:'socks5h://127.0.0.1:19080',generation:1,code:null,reason:null,retryAt:null} as any},async stop(id:string){stopped.push(id)},get(){return null},snapshots(){return []},subscribe(){return()=>true},async close(){}}}
const response=(path:string)=>path.endsWith('/exits')?{ok:true,exits:[]}:path.includes('/providers/')?{ok:true,provider:decodeURIComponent(path.split('/').at(-1)!),configured:false,exits:[],revision:null}:path.endsWith('/ssh-keys')?{ok:true,files:[{name:'id_ed25519',path:'~/.ssh/id_ed25519'}]}:{ok:false};
async function step(v:ReturnType<typeof ui>,kind='proxy'){await v.click('[data-net-new]');if(kind==='ssh')await v.click('[data-proxy-kind="ssh"]');await v.click('[data-proxy-action="next"]')}

test('23b: preview proxy uses credentials on stdin only, writes nothing, and save/use is atomic with retained measurement',opts,async t=>{
 const keys=new MemoryKeys(),calls:any[]=[],catalog=new ProviderCatalog(builtinEntries({claude:new FakeProvider()},{},{execute:async()=>({code:0,signal:null,stdout:"1.0",stderr:""})})),h=await fixture(t,{deps:{providerCatalog:catalog,networkKeys:keys,networkCheckOptions:{execute:async spec=>{calls.push(spec);return output(spec.input!)}}}});
 await call(h.api,root+'/exits');const file=join(h.dir,'owner-settings.json'),before=readFileSync(file,'utf8');
 const preview=await call(h.api,root+'/preview',{body:{config:proxy,password:'fixture-password-23b'}});assert.equal(preview.status,200);assert.equal(preview.body.check.ok,true);assert.equal(keys.rows.size,0);assert.equal(readFileSync(file,'utf8'),before);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.input.includes('fixture-password-23b')&&!JSON.stringify(c.args).includes('fixture-password-23b')&&!JSON.stringify(c.env).includes('fixture-password-23b')));assert.doesNotMatch(preview.text,/fixture-password/);
 const changed=await call(h.api,root+'/providers/claude',{body:{exits:[],revision:null}});assert.equal(changed.status,200);
 let saved=await call(h.api,root+'/exits/'+proxy.id+'/save',{body:{config:{...proxy,label:'Нидерланды'},revision:null,password:'fixture-password-23b',use:{provider:'claude',revision:null}}});assert.equal(saved.status,409);assert.equal(keys.rows.size,0);assert.equal(h.runtime.settings.network().exits[proxy.id],undefined);
 saved=await call(h.api,root+'/exits/'+proxy.id+'/save',{body:{config:{...proxy,label:'Нидерланды'},revision:null,password:'fixture-password-23b',use:{provider:'claude',revision:changed.body.revision}}});assert.equal(saved.status,200,saved.text);assert.deepEqual(h.runtime.settings.network().chains.claude,[proxy.id]);assert.equal(keys.rows.size,1);assert.doesNotMatch(readFileSync(file,'utf8'),/fixture-password/);const listed=(await call(h.api,root+'/exits')).body.exits[0];assert.equal(listed.lastCheck.ip,'192.0.2.5');assert.equal(listed.lastCheck.revision,saved.body.revision);
});
test('23b: draft measurement cannot be attributed to changed address or credentials',opts,async t=>{
 const h=await fixture(t,{deps:{networkKeys:new MemoryKeys(),networkCheckOptions:{execute:async spec=>output(spec.input!)}}});
 for(const [id,change]of [['address',{url:'socks5h://other.test:1080'}],['password',{}]] as const){const config={...proxy,id};await call(h.api,root+'/preview',{body:{config,password:'first'}});await call(h.api,root+'/exits/'+id+'/save',{body:{config:{...config,...change},revision:null,password:'second'}});assert.equal((await call(h.api,root+'/exits')).body.exits.find((r:any)=>r.config.id===id).lastCheck,null)}
});
test('23b: SSH preview uses a distinct tunnel and closes it after external identity; saved tunnels are untouched',opts,async t=>{
 const service=tunnels(),calls:any[]=[],h=await fixture(t,{deps:{sshTunnels:service,networkCheckOptions:{execute:async spec=>{calls.push(spec);return output(spec.input!)}}}});
 const r=await call(h.api,root+'/preview',{body:{config:ssh}});assert.equal(r.status,200,r.text);assert.equal(r.body.check.ok,true);assert.equal(service.calls.length,1);assert.match(service.calls[0].id,/^check-/);assert.notEqual(service.calls[0].id,ssh.id);assert.equal(service.calls[0].config.host,ssh.host);assert.deepEqual(service.stopped,[service.calls[0].id]);assert.ok(calls.every(c=>c.input.includes('socks5h://127.0.0.1:19080')));assert.equal(h.runtime.settings.network().exits[ssh.id],undefined);
});
for(const [code,message]of [['ssh_host_key_unknown','Ключ хоста ещё не добавлен'],['ssh_auth_failed','Сервер не принял ключ'],['ssh_timeout','Сервер не отвечает']])test('23b: SSH refusal gives an actionable safe reason: '+code,opts,async t=>{
 const service=tunnels();service.ensure=async()=>{throw Object.assign(Error('SECRET-DO-NOT-REFLECT'),{code})};let calls=0;const h=await fixture(t,{deps:{sshTunnels:service,networkCheckOptions:{execute:async()=>{calls++;throw Error()}}}});const r=await call(h.api,root+'/preview',{body:{config:ssh}});assert.equal(r.body.check.ok,false);assert.match(r.body.check.reason,new RegExp(message!));assert.doesNotMatch(r.text,/SECRET-DO-NOT-REFLECT/);assert.equal(calls,0);assert.equal(service.stopped.length,1);
});
test('23b: preview abort stops temporary SSH and cancels curl',opts,async t=>{
 const service=tunnels(),started=deferred(),ended=deferred();const h=await fixture(t,{deps:{sshTunnels:service,networkCheckOptions:{execute:async(_spec,signal)=>{started.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));ended.resolve();return {code:1,signal:null,stdout:'',stderr:''}}}}});
 const abort=new AbortController(),pending=call(h.api,root+'/preview',{body:{config:ssh},signal:abort.signal});const rejection=assert.rejects(pending);await started.promise;abort.abort();await rejection;await ended.promise;assert.ok(service.stopped.includes(service.calls[0].id));
});
test('23b: malformed requests and model identities cannot use the preview or assign a provider',opts,async t=>{
 let calls=0;const h=await fixture(t,{deps:{networkKeys:new MemoryKeys(),networkCheckOptions:{execute:async()=>{calls++;throw Error()}}}});
 for(const body of [{},{config:proxy,password:null},{config:{...proxy,passwordRef:'other',passwordGeneration:'bogus'}},{config:{...proxy,url:'http://name:secret@proxy.test'}},{config:{...ssh,host:'-oProxyCommand=x'}},{config:{...ssh,keyPath:'/tmp/key'}},{config:{...proxy,type:'direct'}},{config:proxy,unexpected:true}]){const response=await call(h.api,root+'/preview',{body});assert.ok(response.status>=400,JSON.stringify({body,status:response.status,result:response.body}))}
 for(const headers of [{'x-pane-token':'fake'},{'x-harness-pane':'worker'}])assert.equal((await call(h.api,root+'/preview',{headers,body:{config:proxy}})).status,403);
 for(const use of [{},{provider:'absent',revision:null},{provider:'claude',revision:null,extra:true}])assert.ok((await call(h.api,root+'/exits/'+proxy.id+'/save',{body:{config:proxy,revision:null,use}})).status>=400);
 assert.equal(calls,0);assert.equal(h.runtime.settings.network().exits[proxy.id],undefined);
});
test('23b: proxy authentication failure and reflected country never reveal the password',opts,async t=>{
 let fail=true;const secret='fixturesecret';const h=await fixture(t,{deps:{networkCheckOptions:{execute:async spec=>fail?{code:67,signal:null,stdout:'',stderr:secret}:spec.input!.includes('ipify')?output(spec.input!):{code:0,signal:null,stdout:JSON.stringify({country_name:secret})+'\n0.2',stderr:''}}}});
 const bad=await call(h.api,root+'/preview',{body:{config:proxy,password:secret}});assert.match(bad.body.check.reason,/Неверный логин или пароль/);assert.doesNotMatch(bad.text,new RegExp(secret));fail=false;const good=await call(h.api,root+'/preview',{body:{config:proxy,password:secret}});assert.equal(good.body.check.ok,true);assert.equal(good.body.check.country,null);assert.doesNotMatch(good.text,new RegExp(secret));
});

test('23b UI: two steps parse proxy URL, hide credentials, preserve failed-save draft and use the captured provider',opts,async()=>{
 let fail=true;const v=ui(async(path,body)=>path.endsWith('/preview')?{ok:true,check:measured}:path.endsWith('/save')?fail?{ok:false,code:'credential_unavailable'}:{ok:true,config:body.config,revision:'saved',password:{present:true}}:response(path));await v.flush();v.L.network.openAdd({provider:'claude',title:'Claude'});await v.flush();assert.match(v.find('.proxy-add-dialog').textContent,/Что добавляем/);assert.equal(v.document.querySelector('[data-net-field="id"]'),null);await v.click('[data-proxy-action="next"]');await v.proxyInput('address','https://alice:p%40ss@proxy.test:8443');assert.equal(v.find('[data-proxy-field="address"]').value,'proxy.test');assert.equal(v.find('[data-proxy-field="login"]').value,'alice');assert.equal(v.find('[data-proxy-field="password"]').value,'p@ss');assert.equal(v.find('[data-proxy-field="password"]').getAttribute('type'),'password');assert.doesNotMatch(v.find('.proxy-add-dialog').innerHTML,/p@ss/);
 await v.click('[data-proxy-action="check"]');assert.match(v.find('[data-proxy-result]').textContent,/Работает · Нидерланды · 192.0.2.5 · 48 мс/);assert.equal(v.find('[data-proxy-field="label"]').value,'Нидерланды');await v.click('[data-proxy-action="use"]');assert.match(v.find('[data-proxy-result]').textContent,/Связка ключей недоступна/);assert.equal(v.find('[data-proxy-field="password"]').value,'p@ss');fail=false;await v.click('[data-proxy-action="use"]');const request=v.requests.filter(r=>r.path.endsWith('/save')).at(-1);assert.equal(request.body.config.url,'https://proxy.test:8443');assert.deepEqual(JSON.parse(JSON.stringify(request.body.use)),{provider:'claude',revision:null});assert.equal(v.find('[data-proxy-field="password"]').value,'');assert.match(v.find('[data-proxy-result]').textContent,/используется для Claude/);
});
test('23b UI: SSH command is parsed, key is marked only after success, explicit name and prices survive checking',opts,async()=>{
 const v=ui(async(path,body)=>path.endsWith('/preview')?{ok:true,check:measured}:path.endsWith('/save')?{ok:true,config:body.config,revision:'new'}:response(path));await v.flush();await step(v,'ssh');await v.proxyInput('address','ssh owner@vps.test -p 2222');await v.proxyInput('keyPath','~/.ssh/id_ed25519');await v.proxyInput('label','Мой сервер');await v.proxyInput('monthlyUsd','12.5');await v.proxyInput('perGbUsd','0');assert.equal(v.find('[data-proxy-key-result]').textContent,'');await v.click('[data-proxy-action="check"]');assert.equal(v.find('[data-proxy-key-result]').textContent,'подошёл');assert.equal(v.find('[data-proxy-field="label"]').value,'Мой сервер');await v.click('[data-proxy-action="save"]');const body=v.requests.filter(r=>r.path.endsWith('/save')).at(-1).body;assert.equal(body.config.host,'vps.test');assert.equal(body.config.user,'owner');assert.equal(body.config.port,2222);assert.equal(body.config.price.perGbUsd,0);assert.equal(body.use,undefined);
});
for(const action of ['edit','project','pagehide','back','reopen'])test('23b UI: late check cannot revive an obsolete form: '+action,opts,async()=>{
 const gate=deferred<any>();const v=ui(async path=>path.endsWith('/preview')?gate.promise:response(path));await v.flush();await step(v);await v.proxyInput('address','proxy.test');const pending=v.click('[data-proxy-action="check"]');
 if(action==='edit')await v.proxyInput('address','other.test');if(action==='project')await v.change();if(action==='pagehide')await v.window.emit('pagehide');if(action==='back')await v.click('[data-proxy-action="back"]');if(action==='reopen')v.L.network.openAdd({provider:'codex',title:'Codex'});
 gate.resolve({ok:true,check:measured});await pending;assert.doesNotMatch(v.body.textContent,/Работает · Нидерланды/);assert.equal(v.requests.some(r=>r.path.endsWith('/save')),false);
});
test('23b UI: double save makes one request; later response never closes another form; empty keys can retry',opts,async()=>{
 const gate=deferred<any>(),seen=deferred();let keys=false;const v=ui(async(path,body)=>path.endsWith('/save')?(seen.resolve(),gate.promise):path.endsWith('/ssh-keys')?keys?response(path):{ok:true,files:[]}:response(path));await v.flush();await step(v,'ssh');assert.match(v.find('.proxy-add-dialog').textContent,/Ключей в ~\/.ssh пока нет/);keys=true;await v.click('[data-proxy-action="keys"]');assert.match(v.find('.proxy-add-keys').textContent,/id_ed25519/);await v.click('[data-proxy-close]');await step(v);await v.proxyInput('address','proxy.test');const saving=v.click('[data-proxy-action="save"]');await seen.promise;await v.click('[data-proxy-action="save"]');assert.equal(v.requests.filter(r=>r.path.endsWith('/save')).length,1);await v.click('[data-proxy-close]');v.L.network.openAdd({provider:'codex'});gate.resolve({ok:true,config:v.requests.find(r=>r.path.endsWith('/save')).body.config,revision:'new'});await saving;assert.match(v.find('.proxy-add-dialog').textContent,/Что добавляем/);
});
test('23b UI: malformed commands, ports and absent keys never reach the engine',opts,async()=>{
 const v=ui(async path=>response(path));await v.flush();await step(v,'ssh');for(const address of ['ssh a@vps.test; cat /etc/passwd','ssh -oProxyCommand=x a@host']){await v.proxyInput('address',address);await v.click('[data-proxy-action="check"]');assert.match(v.find('[data-proxy-result]').textContent,/Другие команды/)}await v.proxyInput('address','owner@vps.test');await v.click('[data-proxy-action="save"]');assert.match(v.find('[data-proxy-result]').textContent,/Выберите ключ/);await v.proxyInput('keyPath','~/.ssh/id_ed25519');await v.proxyInput('port','0');await v.click('[data-proxy-action="check"]');assert.match(v.find('[data-proxy-result]').textContent,/Порт должен/);assert.equal(v.requests.some(r=>r.body),false);
});

test('23b: shared API keeps ordinary GET unchanged and forwards the optional abort signal',async()=>{
 const source=readFileSync(new URL('../../../ui/deploy/live.js',import.meta.url),'utf8'),seen:any[]=[];
 const context:any={H:{project:'/fixture',confirmedProjectGeneration:1},fetch:async(path:string,init?:any)=>{seen.push({path,init});return {json:async()=>({ok:true})}}};
 runInContext(fixtureSource(source,fixtureGroups.live_api_to_networkWaiting,{filename:'live.js',wrapper:0})+'globalThis.call=api;',createContext(context));
 await context.call('/api/status');assert.equal(seen[0].init,undefined);
 const abort=new AbortController();await context.call('/api/network/preview',{config:proxy},{signal:abort.signal});assert.equal(seen[1].init.signal,abort.signal);assert.equal(seen[1].init.method,'POST');assert.deepEqual(JSON.parse(seen[1].init.body),{config:proxy});
});


for(const path of ['preview','saved-check'])unixTest('23b r2: '+path+' uses real SSH configuration validation and removes the temporary key and process',opts,async t=>{
 const f=sshDouble(t),h=await fixture(t,{deps:{sshTunnels:f.tunnels,networkCheckOptions:{execute:async spec=>output(spec.input!)}}});
 const config={...f.config,id:'vps',type:'ssh' as const,label:'VPS',keyPath:'~/.ssh/key'};
 let r;if(path==='preview')r=await call(h.api,root+'/preview',{body:{config}});else{
  await h.runtime.settings.changeNetwork(async n=>{n.migrated=true;n.legacyLabelsVersion=1;n.exits.vps=config;return {result:undefined}});
  const revision=(await call(h.api,root+'/exits')).body.exits.find((x:any)=>x.config.id==='vps').revision;
  r=await call(h.api,root+'/exits/vps/check',{body:{revision}});
 }
 assert.equal(r.status,200,r.text);assert.equal(r.body.check.ok,true);assert.equal(f.workers.length,1);assert.deepEqual(f.tunnels.snapshots(),[]);assert.equal(existsSync(f.workers[0]!.command.cwd),false);assert.equal(await f.workers[0]!.process.done.then(x=>x.code),0);
});
for(const fail of ['ssh','curl'])unixTest('23b r2: real SSH manager is stopped and cleaned after '+fail+' failure',opts,async t=>{
 const f=sshDouble(t);if(fail==='ssh')f.setExit({code:255,stderr:'Permission denied (publickey).'});
 const h=await fixture(t,{deps:{sshTunnels:f.tunnels,networkCheckOptions:{execute:async()=>({code:7,signal:null,stdout:'',stderr:'Connection failed'})}}});
 const r=await call(h.api,root+'/preview',{body:{config:{...f.config,id:'vps',type:'ssh',label:'VPS',keyPath:'~/.ssh/key'}}});
 assert.equal(r.status,200,r.text);assert.equal(r.body.check.ok,false);assert.equal(r.body.check.code,fail==='ssh'?'ssh_auth_failed':'network_check_failed');assert.deepEqual(f.tunnels.snapshots(),[]);assert.equal(f.workers.length,1);assert.equal(existsSync(f.workers[0]!.command.cwd),false);f.clock.advance(60000);assert.equal(f.workers.length,1);
});
for(const phase of ['startup','curl'])unixTest('23b r2: HTTP abort releases the real SSH manager during '+phase,opts,async t=>{
 const f=sshDouble(t),started=deferred(),cleaned=deferred();if(phase==='startup')f.holdControl(true);
 const stop=f.tunnels.stop.bind(f.tunnels);f.tunnels.stop=async id=>{await stop(id);cleaned.resolve()};
 const h=await fixture(t,{deps:{sshTunnels:f.tunnels,networkCheckOptions:{execute:async(_spec,signal)=>{started.resolve();await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})});return {code:1,signal:null,stdout:'',stderr:''}}}}});
 const abort=new AbortController(),pending=call(h.api,root+'/preview',{body:{config:{...f.config,id:'vps',type:'ssh',label:'VPS',keyPath:'~/.ssh/key'}},signal:abort.signal}),rejected=assert.rejects(pending);
 await (phase==='startup'?f.controlEntered.promise:started.promise);abort.abort();await rejected;await cleaned.promise;
 assert.deepEqual(f.tunnels.snapshots(),[]);assert.equal(f.workers.length,1);assert.equal(existsSync(f.workers[0]!.command.cwd),false);f.clock.advance(60000);assert.equal(f.workers.length,1);
});
for(const suffix of ['proxy.invalid:8443','proxy.invalid/not-allowed','proxy.invalid:bad',''])test('23b r2 UI: pending response and Back/Next cannot serialize URL credentials: '+(suffix||'missing host'),opts,async()=>{
 const gate=deferred<any>(),v=ui(async path=>path.includes('/providers/')?gate.promise:response(path));await v.flush();v.L.network.openAdd({provider:'claude',title:'Claude'});await v.click('[data-proxy-action="next"]');
 const secret='SecretNotInHtml23b',address=v.find('[data-proxy-field="address"]');address.value='https://alice:'+secret+'@'+suffix;await address.emit('input');
 const safe=()=>{assert.doesNotMatch(v.find('.proxy-add-dialog').innerHTML,new RegExp(secret));assert.doesNotMatch(v.find('[data-proxy-field="address"]').value,new RegExp(secret));assert.equal(v.find('[data-proxy-field="password"]').value,secret);assert.equal(v.find('[data-proxy-field="password"]').getAttribute('value'),'')};safe();
 gate.resolve(response(root+'/providers/claude'));await v.flush();safe();await v.click('[data-proxy-action="back"]');assert.doesNotMatch(v.find('.proxy-add-dialog').innerHTML,new RegExp(secret));await v.click('[data-proxy-action="next"]');safe();
 if(suffix!=='proxy.invalid:8443'){await v.click('[data-proxy-action="check"]');assert.equal(v.requests.some(r=>r.path.endsWith('/preview')),false);await v.proxyInput('address','proxy.invalid:8443');await v.click('[data-proxy-action="check"]');assert.equal(v.requests.filter(r=>r.path.endsWith('/preview')).length,1)}
});
test('23b r2 UI: malformed userinfo remains private and cannot silently become a valid address',opts,async()=>{
 const v=ui(async path=>response(path));await v.flush();await step(v);await v.proxyInput('address','https://alice:SecretNotInHtml%GG@proxy.invalid:8443');await v.click('[data-proxy-action="back"]');await v.click('[data-proxy-action="next"]');assert.doesNotMatch(v.find('.proxy-add-dialog').innerHTML,/SecretNotInHtml/);await v.click('[data-proxy-action="check"]');assert.equal(v.requests.some(r=>r.path.endsWith('/preview')),false);assert.match(v.find('[data-proxy-result]').textContent,/Не удалось разобрать/);
});

for(const selector of ['[data-proxy-top]','[data-net-list] .proxy-add'])test('23a/23b: inventory '+selector+' opens the two-step form and shows the saved measured entry',opts,async t=>{
 const h=await fixture(t,{deps:{networkKeys:new MemoryKeys(),networkCheckOptions:{execute:async spec=>output(spec.input!)}}}),v=ui(async(path,body)=>(await call(h.api,path,body===undefined?{}:{body})).body);
 await v.flush();await v.click('[data-v="exits"]');await v.click(selector);assert.match(v.find('.proxy-add-dialog').textContent,/Что добавляем/);assert.equal(v.document.querySelector('[data-net-field="id"]'),null);
 await v.click('[data-proxy-action="next"]');await v.proxyInput('address','socks5://alice:fixture-password@proxy.test:1080');await v.click('[data-proxy-action="check"]');await v.click('[data-proxy-action="save"]');await v.flush();
 assert.match(v.find('[data-net-list]').textContent,/Нидерландыработает.*192.0.2.5.*ещё не использовался/);assert.equal(v.document.querySelectorAll('[data-proxy-id]').length,1);assert.equal(v.requests.filter(r=>r.path.endsWith('/save')).length,1);assert.equal(h.provider.calls.length,0);
});

test('23a/23b: save and use refreshes the inventory provider names after its old chain was cached',opts,async t=>{
 const catalog=new ProviderCatalog(builtinEntries({claude:new FakeProvider()},{},{execute:async()=>({code:0,signal:null,stdout:'1.0',stderr:''})})),h=await fixture(t,{deps:{providerCatalog:catalog,networkKeys:new MemoryKeys(),networkCheckOptions:{execute:async spec=>output(spec.input!)}}}),v=ui(async(path,body)=>(await call(h.api,path,body===undefined?{}:{body})).body);
 await v.flush();v.L.network.setProviders('programs',[{id:'claude',title:'Claude Code'}]);await v.flush();v.L.network.openAdd({provider:'claude',title:'Claude Code'});await v.flush();await v.click('[data-proxy-action="next"]');await v.proxyInput('address','socks5://proxy.test:1080');await v.click('[data-proxy-action="check"]');await v.click('[data-proxy-action="use"]');await v.flush();
 const card=v.find('[data-proxy-id]'),id=card.getAttribute('data-proxy-id');assert.deepEqual(h.runtime.settings.network().chains.claude,[id]);assert.match(card.textContent,/через него ходятClaude Code/);assert.equal(h.provider.calls.length,0);
});

for(const action of ['use','save'])test('23e HTTP + UI: recovery wizard '+action+' rechecks login only after provider assignment',opts,async t=>{
 let h:Awaited<ReturnType<typeof fixture>>|undefined;let calls=0;
 const catalog=new ProviderCatalog([{id:'claude',title:'Claude Code',binary:'claude',login:{args:['login']},forbiddenEnv:[],capabilities:{headless:true,mcp:true,resume:true,limits:false},version:async()=> '1',auth:async()=>{calls++;if(!h?.runtime.settings.network().chains.claude?.length)throw new ProviderError('network_unavailable','fixture unavailable');return {loggedIn:true}},models:async()=>[{id:'model',label:'Model'}],runTurn:async()=>{throw Error('no paid call')}}]);
 h=await fixture(t,{deps:{providerCatalog:catalog,networkKeys:new MemoryKeys()}});await catalog.read('claude');
 const v=ui(async(path,body)=>(await call(h!.api,path,body?{body}:{})).body,true,h.dir);await v.flush();await v.click('#addbtn');await v.click('[data-program-open="claude"]');assert.match(v.find('[data-login-recovery]').textContent,/нет связи/);
 await v.click('[data-login-connect]');await v.flush();assert.match(v.find('.proxy-add-dialog').textContent,/Сохранить|Что добавляем/);await v.click('[data-proxy-action="next"]');await v.proxyInput('address','socks5h://proxy.test:1080');
 const before=calls;await v.click('[data-proxy-action="'+action+'"]');await v.flush();assert.equal(v.requests.filter(r=>r.path==='/api/providers/claude/check'&&r.body).length,action==='use'?1:0);assert.equal(calls-before,action==='use'?1:0);
 const n=h.runtime.settings.network();assert.equal(Object.keys(n.exits).length,1);assert.equal(n.chains.claude?.length||0,action==='use'?1:0);
 if(action==='use'){assert.equal(v.document.querySelector('.proxy-add-dialog'),null);assert.equal(v.document.querySelector('[data-login-recovery]'),null)}else assert.match(v.find('[data-proxy-result]').textContent,/Сохранено/);
 assert.equal(v.requests.filter(r=>/\/probe$|\/send$/.test(r.path)).length,0);
});
