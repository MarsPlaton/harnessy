import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{readFileSync,writeFileSync,renameSync,mkdirSync,rmdirSync,symlinkSync,unlinkSync} from 'node:fs';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {ProviderCatalog,builtinEntries} from '@harnessy/providers';
import {Settings,NetworkSettings} from '@harnessy/projects';
import {keySlot} from '@harnessy/llm';
import {fixture,call,FakeProvider,deferred} from './test-helpers.ts';
import {MemoryKeys,config as apiConfig} from '../../llm/src/test-helpers.ts';
const limits={timeout:15000},root='/api/network',proxy={id:'proxy-a',type:'proxy',label:'Прокси A',url:'socks5h://proxy.test:1080',login:'alice',expectedIp:'2001:db8::1'},direct={id:'direct',type:'direct',label:'Напрямую'};
const unixTest=process.platform==='win32'?test.skip:test;
async function setup(t:Parameters<typeof fixture>[0]){const keys=new MemoryKeys(),entries=builtinEntries({claude:new FakeProvider(),codex:new FakeProvider('codex')},{},{execute:async()=>({code:0,signal:null,stdout:'1.0.0',stderr:''})}),providerCatalog=new ProviderCatalog([...entries,...['ollama','gemini','custom-cli'].map(id=>({...entries[0]!,id,title:id}))]),h=await fixture(t,{deps:{networkKeys:keys,providerCatalog,llmKeys:new MemoryKeys()}});return {...h,keys,file:join(h.dir,'owner-settings.json')}}
const save=(api:Awaited<ReturnType<typeof fixture>>['api'],config:unknown,revision:unknown=null,password?:string|null)=>call(api,root+'/exits/'+(config as any).id+'/save',{body:{config,revision,...(password!==undefined?{password}:{})}});

function sshHome(t:Parameters<typeof fixture>[0],dir:string){const home=join(dir,'mock-home');mkdirSync(join(home,'.ssh'),{recursive:true});writeFileSync(join(home,'.ssh/id_ed25519'),'FAKE KEY');const original=os.homedir;os.homedir=()=>home;syncBuiltinESMExports();t.after(()=>{os.homedir=original;syncBuiltinESMExports()});return home}

test('22a: owner exits and ordered chains cover programs, API routes and Ollama; no implicit direct after configuration',limits,async t=>{
 const h=await setup(t);sshHome(t,h.dir);let r=await call(h.api,root+'/providers/claude');assert.equal(r.status,200);assert.deepEqual(r.body,{ok:true,provider:'claude',configured:false,exits:[],policy:{mode:'fallback',silenceSeconds:60},revision:null});
 const a=await save(h.api,proxy,null,'p'),d=await save(h.api,direct);assert.equal(a.status,200);assert.equal(d.status,200);assert.equal(a.body.password.mask,'••••••••');assert.equal(await h.keys.resolveKey(keySlot(proxy.id,a.body.config.passwordGeneration)),'p');
 if(process.platform!=='win32')assert.equal((await save(h.api,{id:'ssh',type:'ssh',label:'VPS',host:'vps.example.test',port:22,user:'owner',keyPath:'~/.ssh/id_ed25519'})).status,200);
 await h.runtime.settings.changeLlmProvider('custom',apiConfig('https://model.example.test'),null);
 const routes=process.platform==='win32'?['proxy-a','direct']:['proxy-a','ssh','direct'];
 for(const provider of ['claude','codex','ollama','gemini','custom-cli','api:custom']){r=await call(h.api,root+'/providers/'+provider,{body:{exits:routes,revision:null}});assert.equal(r.status,200);assert.deepEqual(r.body.exits,routes);assert.equal(r.body.configured,true)}
 r=await call(h.api,root+'/exits/proxy-a/delete',{body:{revision:a.body.revision}});assert.equal(r.body.code,'exit_in_use');
 let chain=(await call(h.api,root+'/providers/claude')).body;assert.equal((await call(h.api,root+'/providers/claude',{body:{exits:[],revision:chain.revision}})).status,200);
 chain=(await call(h.api,root+'/providers/claude')).body;assert.deepEqual(chain.exits,[]);assert.equal(chain.configured,true);assert.notEqual(chain.revision,null);
 const settings=new Settings(h.file);assert.deepEqual(settings.network().chains.claude,[]);assert.deepEqual((await call(h.api,root+'/exits')).body.exits.map((x:any)=>x.config.id),routes);
 assert.equal((await call(h.api,root+'/providers/not-registered',{body:{exits:[],revision:null}})).body.code,'provider_unknown');assert.equal((await call(h.api,root+'/providers/api:missing')).body.code,'provider_unknown');
});

unixTest('22b/r3: saving an SSH exit rejects a writable root and uses the same root check as tunnel startup',limits,async t=>{
 const h=await setup(t),home=sshHome(t,h.dir),directory=join(home,'.ssh'),config={id:'ssh',type:'ssh',label:'VPS',host:'vps.example.test',port:22,user:'owner',keyPath:'~/.ssh/id_ed25519'};
 for(const mode of [0o777,0o775,0o702]){fs.chmodSync(directory,mode);const r=await save(h.api,config);assert.equal(r.status,400);assert.equal(r.body.code,'ssh_key_invalid');assert.equal(h.runtime.settings.network().exits.ssh,undefined)}
 fs.chmodSync(directory,0o755);assert.equal((await save(h.api,config)).status,200);
});

test('22a: all HTTP doors deny model authority; malformed configs and generic settings cannot bypass validation',limits,async t=>{
 const h=await setup(t);const routes=[{path:root+'/exits'},{path:root+'/exits/proxy-a/save',body:{config:proxy,revision:null,password:'fixture-secret'}},{path:root+'/exits/proxy-a/delete',body:{revision:null}},{path:root+'/providers/claude'},{path:root+'/providers/claude',body:{exits:[],revision:null}}];
 for(const route of routes){for(const headers of [{'x-pane-token':'forged'},{'x-harness-pane':'worker'}])assert.equal((await call(h.api,route.path,{...(route.body?{body:route.body}:{}),headers})).status,403);if(route.body)assert.equal((await call(h.api,route.path,{body:{...route.body,from:'owner'}})).status,403)}
 for(const config of [{...proxy,id:'constructor'},{...proxy,label:''},{...proxy,expectedIp:'999.999.1.1'},{...proxy,url:'https://user:secret@proxy.test'},{...proxy,url:'https://proxy.test/path'},{...proxy,url:'socks4://proxy.test'},{...proxy,password:'secret'},{...proxy,passwordRef:'other'},{...proxy,type:'iface'},{id:'ssh',type:'ssh',label:'VPS',host:'-oOption',port:22,user:'owner',keyPath:'~/.ssh/key'},{id:'ssh',type:'ssh',label:'VPS',host:'host',port:0,user:'owner',keyPath:'~/.ssh/key'},{id:'ssh',type:'ssh',label:'VPS',host:'host',port:22,user:'-root',keyPath:'~/.ssh/key'},{id:'ssh',type:'ssh',label:'VPS',host:'host',port:22,user:'owner',keyPath:'/tmp/key'},{id:'ssh',type:'ssh',label:'VPS',host:'host',port:22,user:'owner',keyPath:join(homedir(),'.ssh/../outside') }]){const r=await save(h.api,config);assert.ok(r.status>=400,JSON.stringify(config));}
 for(const body of [{},{config:proxy},{config:proxy,revision:null,password:''},{config:proxy,revision:null,password:'x\ny'},{config:proxy,revision:null,secret:'fake'}])assert.ok((await call(h.api,root+'/exits/proxy-a/save',{body})).status>=400);
 for(const exits of [undefined,['absent'],['direct','direct'],{},[null]])assert.ok((await call(h.api,root+'/providers/claude',{body:{exits,revision:null}})).status>=400);
 for(const scope of ['owner','project'])await assert.rejects(h.runtime.settings.patch(scope,{network:{exits:{}}}),{code:'invalid_settings'});
 writeFileSync(join(h.dir,'.harness/state/settings.json'),JSON.stringify({network:{exits:{forged:true}}}));assert.notDeepEqual(h.runtime.settings.effective().network,{exits:{forged:true}});assert.equal(h.keys.rows.size,0);
});

test('22a: revision is checked under owner lock; concurrent independent records survive and stale save never writes a key',limits,async t=>{
 const h=await setup(t),a=await save(h.api,proxy,null,'old-fixture');assert.equal(a.status,200);
 const results=await Promise.all(['one','two'].map(label=>save(h.api,{...a.body.config,label},a.body.revision,label+'-fixture')));assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(h.keys.rows.size,1);
 const current=results.find(x=>x.status===200)!.body;const separate=await Promise.all([save(h.api,{...current.config,label:'Changed'},current.revision),save(h.api,direct)]);assert.deepEqual(separate.map(x=>x.status),[200,200]);assert.equal(h.runtime.settings.network().exits['proxy-a']!.label,'Changed');
 const chains=await Promise.all([call(h.api,root+'/providers/claude',{body:{exits:['proxy-a'],revision:null}}),call(h.api,root+'/providers/codex',{body:{exits:['direct'],revision:null}})]);assert.deepEqual(chains.map(x=>x.status),[200,200]);
 const bytes=readFileSync(h.file,'utf8');assert.equal((await save(h.api,proxy,null,'should-not-write')).body.code,'network_conflict');assert.equal(readFileSync(h.file,'utf8'),bytes);assert.equal(h.keys.rows.size,1);
});

test('22a: unpublished key generations never reach old exit readers; settings/key failures roll back without leaking secrets',limits,async t=>{
 const h=await setup(t),a=(await save(h.api,proxy,null,'old-fixture')).body,old=structuredClone(a.config),put=h.keys.put.bind(h.keys),entered=deferred(),release=deferred();
 t.after(()=>release.resolve());h.keys.put=async(id,value)=>{await put(id,value);entered.resolve();await release.promise};
 const request=save(h.api,{...a.config,url:'https://new.example.test'},a.revision,'new-fixture');await entered.promise;
 assert.equal(await h.runtime.network.resolvePassword(old),'old-fixture');const during=(await call(h.api,root+'/exits')).body.exits[0];assert.equal(during.config.url,proxy.url);assert.equal(during.config.passwordGeneration,old.passwordGeneration);
 release.resolve();const changed=await request;assert.equal(changed.status,200);assert.notEqual(changed.body.config.passwordGeneration,old.passwordGeneration);assert.equal(await h.runtime.network.resolvePassword(old),null);assert.equal(await h.runtime.network.resolvePassword(changed.body.config),'new-fixture');
 const bytes=readFileSync(h.file,'utf8');h.keys.put=async(id,value)=>{await put(id,value);renameSync(h.file,h.file+'.bak');mkdirSync(h.file)};
 const failure=await save(h.api,changed.body.config,changed.body.revision,'uncommitted-fixture');assert.equal(failure.body.code,'write_failed');rmdirSync(h.file);renameSync(h.file+'.bak',h.file);assert.equal(readFileSync(h.file,'utf8'),bytes);assert.equal(h.keys.rows.size,1);
 h.keys.put=async(id,value)=>{await put(id,value);throw Error('RAW '+value)};const keyFailure=await save(h.api,changed.body.config,changed.body.revision,'failed-key-fixture');assert.equal(keyFailure.body.code,'credential_unavailable');assert.equal(h.keys.rows.size,1);assert.equal(readFileSync(h.file,'utf8'),bytes);
 for(const output of [failure.text,keyFailure.text,(await call(h.api,root+'/exits')).text,(await call(h.api,'/api/trace')).text,bytes])assert.doesNotMatch(output,/old-fixture|new-fixture|uncommitted-fixture|failed-key-fixture|RAW/);
 h.keys.put=put;const removed=await save(h.api,changed.body.config,changed.body.revision,null);assert.equal(removed.status,200);assert.equal(removed.body.password.present,false);assert.equal(h.keys.rows.size,0);
 assert.equal((await call(h.api,root+'/exits/proxy-a/delete',{body:{revision:removed.body.revision}})).status,200);assert.deepEqual((await call(h.api,root+'/exits')).body.exits,[]);
});

test('22a: old direct/proxy settings migrate once; credentials move to versioned key storage, source traffic behavior stays intact',limits,async t=>{
 const h=await setup(t),legacy=join(h.dir,'connections.json'),data={claude:{route:'proxy',proxy:'https://alice:p%40ss@proxy.test:8443',label:'Прежний выход',expect:'192.0.2.1'},codex:{route:'direct',label:'Без прокси'}};writeFileSync(legacy,JSON.stringify(data));
 const r=await call(h.api,root+'/exits');assert.equal(r.status,200);assert.equal(r.body.exits.length,2);const a=r.body.exits[0];assert.equal(a.config.url,'https://proxy.test:8443/');assert.equal(a.config.login,'alice');assert.equal(await h.runtime.network.resolvePassword(a.config),'p@ss');assert.equal(h.keys.rows.size,1);
 for(const text of [r.text,readFileSync(h.file,'utf8'),(await call(h.api,'/api/trace')).text])assert.doesNotMatch(text,/p@ss|p%40ss/);
 assert.deepEqual((await call(h.api,root+'/providers/claude')).body.exits,['legacy-claude']);assert.deepEqual((await call(h.api,root+'/providers/codex')).body.exits,['legacy-codex']);
 assert.equal(h.runtime.connections.proxyEnv('claude').HTTPS_PROXY,data.claude.proxy);assert.equal(readFileSync(legacy,'utf8'),JSON.stringify(data));
 const restarted=new NetworkSettings(new Settings(h.file),h.keys,h.runtime.connections,()=>['claude','codex']);await restarted.list();assert.equal(h.keys.rows.size,1);
});

test('22a: corrupt settings or legacy iface fail closed, with recovery through the existing connection door',limits,async t=>{
 const h=await setup(t),legacy=join(h.dir,'connections.json');writeFileSync(legacy,'{broken');assert.equal((await call(h.api,root+'/exits')).body.code,'network_unreadable');assert.equal(readFileSync(legacy,'utf8'),'{broken');
 writeFileSync(legacy,JSON.stringify({claude:{route:'iface',iface:'utun3'}}));const failed=await call(h.api,root+'/exits');assert.equal(failed.body.code,'iface_unsupported');assert.match(failed.body.error,/не маршрутизирует/);assert.equal(h.keys.rows.size,0);
 await h.runtime.connections.setRoute('claude','direct');assert.equal((await call(h.api,root+'/exits')).status,200);
 writeFileSync(h.file,'{corrupt');assert.equal((await save(h.api,direct)).body.code,'network_unreadable');assert.equal(readFileSync(h.file,'utf8'),'{corrupt');
});

test('22a: migration rolls back all newly created password versions if settings publication fails',limits,async t=>{
 const h=await setup(t);await h.runtime.settings.patch('owner',{keep:true});const bytes=readFileSync(h.file,'utf8');writeFileSync(join(h.dir,'connections.json'),JSON.stringify({claude:{route:'proxy',proxy:'http://alice:one@first.test'},codex:{route:'proxy',proxy:'http://bob:two@second.test'}}));
 const put=h.keys.put.bind(h.keys);let writes=0;h.keys.put=async(id,value)=>{await put(id,value);if(++writes===2){renameSync(h.file,h.file+'.bak');mkdirSync(h.file)}};
 const r=await call(h.api,root+'/exits');assert.equal(r.body.code,'write_failed');assert.equal(h.keys.rows.size,0);rmdirSync(h.file);renameSync(h.file+'.bak',h.file);assert.equal(readFileSync(h.file,'utf8'),bytes);
 h.keys.put=put;assert.equal((await call(h.api,root+'/exits')).status,200);assert.equal(h.keys.rows.size,2);
});

test('22a: deletion and chain creation cannot race into a dangling reference; captured generations cannot be forged',limits,async t=>{
 const h=await setup(t);const a=(await save(h.api,proxy,null,'fixture-key')).body,d=(await save(h.api,direct)).body;
 const race=await Promise.all([call(h.api,root+'/exits/direct/delete',{body:{revision:d.revision}}),call(h.api,root+'/providers/claude',{body:{exits:['direct'],revision:null}})]);assert.equal(race.filter(x=>x.status===200).length,1);
 const state=h.runtime.settings.network();if(state.chains.claude?.includes('direct'))assert.ok(state.exits.direct);else assert.equal(state.exits.direct,undefined);
 const changed={...a.config,passwordGeneration:'00000000-0000-4000-8000-000000000001'};assert.equal((await save(h.api,changed,a.revision)).body.code,'network_invalid');assert.equal(h.keys.rows.size,1);assert.equal(await h.runtime.network.resolvePassword(a.config),'fixture-key');
 assert.equal((await call(h.api,root+'/exits/constructor/delete',{body:{revision:null}})).body.code,'network_invalid');
});

test('22a r2: API deletion atomically removes its chain; failed publication preserves both and the key',limits,async t=>{
 const h=await setup(t),exit=(await save(h.api,proxy)).body;
 const route=await call(h.api,'/api/llm/providers/linked/save',{body:{config:apiConfig('https://model.example.test'),revision:null,secret:'FakeRouteKey'}});assert.equal(route.status,200,route.text);
 const chain=await call(h.api,root+'/providers/api:linked',{body:{exits:[proxy.id],revision:null}});assert.equal(chain.status,200);
 const bytes=readFileSync(h.file,'utf8'),rename=fs.renameSync;let publications=0,fail=true;
 fs.renameSync=((from,to)=>{if(String(to)===h.file){publications++;assert.equal(readFileSync(h.file,'utf8'),bytes);if(fail)throw Error('fixture write failure')}return rename(from,to)}) as typeof rename;
 syncBuiltinESMExports();t.after(()=>{fs.renameSync=rename;syncBuiltinESMExports()});
 const failed=await call(h.api,'/api/llm/providers/linked/delete',{body:{revision:route.body.revision}});assert.equal(failed.body.code,'write_failed');assert.equal(readFileSync(h.file,'utf8'),bytes);assert.equal(h.runtime.llmKeys instanceof MemoryKeys&&h.runtime.llmKeys.rows.size,1);
 let notified=false;h.runtime.settings.onLlmRoutesChanged(()=>{notified=true;assert.equal(h.runtime.settings.llmProviders().linked,undefined);assert.equal(h.runtime.settings.network().chains['api:linked'],undefined)});
 fail=false;const removed=await call(h.api,'/api/llm/providers/linked/delete',{body:{revision:route.body.revision}});assert.equal(removed.status,200,removed.text);assert.equal(publications,2);assert.equal(notified,true);fs.renameSync=rename;syncBuiltinESMExports();
 assert.equal((await call(h.api,root+'/exits/'+proxy.id+'/delete',{body:{revision:exit.revision}})).status,200);assert.equal(h.runtime.llmKeys instanceof MemoryKeys&&h.runtime.llmKeys.rows.size,0);
});

test('22a r2: old orphan chains are readable and clearable only with their revision; arbitrary providers remain rejected',limits,async t=>{
 const h=await setup(t),exit=(await save(h.api,proxy)).body;
 await h.runtime.settings.changeNetwork(async config=>{config.chains['api:lost']=[proxy.id];return {result:undefined}});
 const read=await call(h.api,root+'/providers/api:lost');assert.equal(read.status,200);assert.equal(read.body.orphaned,true);assert.deepEqual(read.body.exits,[proxy.id]);
 const bytes=readFileSync(h.file,'utf8');
 for(const revision of [undefined,null,'stale']){const response=await call(h.api,root+'/providers/api:lost',{body:{exits:[],...(revision!==undefined?{revision}:{})}});assert.equal(response.body.code,'network_conflict');assert.equal(readFileSync(h.file,'utf8'),bytes)}
 assert.equal((await call(h.api,root+'/providers/api:lost',{body:{exits:[proxy.id],revision:read.body.revision}})).body.code,'provider_unknown');
 assert.equal((await call(h.api,root+'/providers/api:lost',{body:{exits:[],revision:read.body.revision},headers:{'x-pane-token':'forged'}})).status,403);
 const cleared=await call(h.api,root+'/providers/api:lost',{body:{exits:[],revision:read.body.revision}});assert.equal(cleared.status,200);assert.equal(cleared.body.configured,false);assert.equal(cleared.body.revision,null);assert.equal(h.runtime.settings.network().chains['api:lost'],undefined);
 assert.equal((await call(h.api,root+'/providers/api:lost',{body:{exits:[],revision:null}})).body.code,'provider_unknown');
 assert.equal((await call(h.api,root+'/exits/'+proxy.id+'/delete',{body:{revision:exit.revision}})).status,200);
});

test('22a r2: queued chain update cannot resurrect a deleted route; malformed network refuses deletion without changes',limits,async t=>{
 const h=await setup(t);await save(h.api,direct);const config=apiConfig('https://model.example.test');
 const route=await h.runtime.settings.changeLlmProvider('race',config,null);await h.runtime.network.saveChain('api:race',['direct'],null);
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());
 const deletion=h.runtime.settings.changeLlmProvider('race',undefined,route.revision,async()=>{entered.resolve();await release.promise});await entered.promise;
 const update=h.runtime.network.saveChain('api:race',['direct'],(await h.runtime.network.chain('api:race')).revision);
 const rejected=assert.rejects(update,{code:'provider_unknown'});release.resolve();await deletion;await rejected;assert.equal(h.runtime.settings.network().chains['api:race'],undefined);
 await h.runtime.settings.changeLlmProvider('race',config,null);const state=JSON.parse(readFileSync(h.file,'utf8'));state.network.chains.claude=['missing-exit'];writeFileSync(h.file,JSON.stringify(state));const bytes=readFileSync(h.file,'utf8');
 const failed=await call(h.api,'/api/llm/providers/race/delete',{body:{revision:route.revision}});assert.equal(failed.body.code,'network_unreadable');assert.equal(readFileSync(h.file,'utf8'),bytes);
});

unixTest('22a r2: SSH save validates real file containment, including symlink ancestors, missing files and replacement',limits,async t=>{
 const h=await setup(t),home=sshHome(t,h.dir),base=join(home,'.ssh'),outside=join(h.dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'key'),'OUTSIDE FAKE KEY');
 const ssh={id:'ssh',type:'ssh',label:'VPS',host:'vps.example.test',port:22,user:'owner',keyPath:'~/.ssh/id_ed25519'};
 symlinkSync(join(outside,'key'),join(base,'escape'));symlinkSync(outside,join(base,'escape-dir'));symlinkSync(join(base,'id_ed25519'),join(base,'inside'));
 const accepted=await save(h.api,ssh);assert.equal(accepted.status,200,accepted.text);assert.equal((await save(h.api,{...ssh,keyPath:'~/.ssh/inside'},accepted.body.revision)).status,200);
 const current=(await call(h.api,root+'/exits')).body.exits[0],bytes=readFileSync(h.file,'utf8');
 for(const keyPath of ['~/.ssh/escape','~/.ssh/escape-dir/key','~/.ssh/missing',join(base,'escape'),base+'/escape-dir']){
  const r=await save(h.api,{...ssh,keyPath},current.revision);assert.equal(r.status,400,keyPath);assert.equal(r.body.code,'ssh_key_invalid');assert.equal(readFileSync(h.file,'utf8'),bytes);
 }
 unlinkSync(join(base,'id_ed25519'));symlinkSync(join(outside,'key'),join(base,'id_ed25519'));assert.equal((await save(h.api,current.config,current.revision)).body.code,'ssh_key_invalid');
 // Broken/moved keys affect save and tunnel startup, never the owner's read/delete recovery doors.
 assert.equal((await call(h.api,root+'/exits')).status,200);assert.equal((await call(h.api,root+'/exits/ssh/delete',{body:{revision:current.revision}})).status,200);
 renameSync(base,base+'-old');symlinkSync(base+'-old',base);assert.equal((await save(h.api,ssh)).body.code,'ssh_key_invalid');
});


test('22i: exit prices are optional, finite and revision-protected; malformed fields never alter the stored exit',limits,async t=>{
 const h=await setup(t);let row=(await save(h.api,{...direct,price:{monthlyUsd:15,perGbUsd:.2}})).body;assert.deepEqual(row.config.price,{monthlyUsd:15,perGbUsd:.2});
 const disk=new Settings(h.file);assert.deepEqual(disk.network().exits.direct?.price,row.config.price);
 for(const price of [null,{},'15',{monthlyUsd:'15'},{monthlyUsd:-1},{perGbUsd:1e20},{perGbUsd:null},{monthlyUsd:1,currency:'EUR'}]){
  const result=await save(h.api,{...direct,price},row.revision);assert.equal(result.body.code,'network_invalid',JSON.stringify(price));assert.deepEqual(h.runtime.settings.network().exits.direct?.price,{monthlyUsd:15,perGbUsd:.2});
 }
 const old=row.revision;row=(await save(h.api,{...direct,price:{monthlyUsd:0}},row.revision)).body;assert.deepEqual(row.config.price,{monthlyUsd:0});assert.equal((await save(h.api,{...direct,price:{perGbUsd:2}},old)).body.code,'network_conflict');
 row=(await save(h.api,direct,row.revision)).body;assert.equal(row.config.price,undefined);assert.equal(new Settings(h.file).network().exits.direct?.price,undefined);
 const proxyRow=(await save(h.api,{...proxy,price:{perGbUsd:.15}},null,'price-fixture-password')).body;assert.deepEqual(proxyRow.config.price,{perGbUsd:.15});assert.equal(proxyRow.password.present,true);
});


test('22e.2: migrated direct exits use provider names without changing IDs or chains',limits,async t=>{
 const h=await setup(t);writeFileSync(join(h.dir,'connections.json'),JSON.stringify({claude:{route:'direct'},codex:{route:'direct',label:'codex'}}));
 const r=await call(h.api,root+'/exits');assert.equal(r.status,200);
 assert.deepEqual(r.body.exits.map((r:any)=>r.config),[
  {id:'legacy-claude',label:'Напрямую · прежний маршрут Claude',type:'direct'},
  {id:'legacy-codex',label:'Напрямую · прежний маршрут Codex',type:'direct'},
 ]);
 assert.deepEqual(h.runtime.settings.network().chains,{claude:['legacy-claude'],codex:['legacy-codex']});
});
test('22e.2: existing fallback labels are repaired once under the settings lock; custom labels and other exit types survive',limits,async t=>{
 const h=await setup(t),before={migrated:true,exits:{
  'legacy-claude':{id:'legacy-claude',label:'claude',type:'direct' as const,price:{monthlyUsd:0}},
  'legacy-codex-1':{id:'legacy-codex-1',label:'codex',type:'direct' as const},
  'legacy-claude-1':{id:'legacy-claude-1',label:'Мой выход',type:'direct' as const},
  'legacy-codex':{id:'legacy-codex',label:'codex',type:'proxy' as const,url:'http://proxy.test'},
  manual:{id:'manual',label:'claude',type:'direct' as const},
 },chains:{claude:['legacy-claude','legacy-claude-1'],codex:['legacy-codex-1','legacy-codex']}};
 await h.runtime.settings.changeNetwork(async config=>{Object.assign(config,before);return {result:undefined}});
 const [r,c]=await Promise.all([call(h.api,root+'/exits'),call(h.api,root+'/providers/claude')]);assert.equal(r.status,200);assert.equal(c.status,200);
 const expected=structuredClone(before);expected.exits['legacy-claude'].label='Напрямую · прежний маршрут Claude';expected.exits['legacy-codex-1'].label='Напрямую · прежний маршрут Codex';
 const {generations,...saved}=h.runtime.settings.network();assert.deepEqual(saved,{...expected,legacyLabelsVersion:1});assert.deepEqual(Object.keys(generations??{}).sort(),['claude','codex']);for(const generation of Object.values(generations??{}))assert.match(generation,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);assert.deepEqual(c.body.exits,before.chains.claude);
 const bytes=readFileSync(h.file,'utf8');const restarted=new NetworkSettings(new Settings(h.file),h.keys,h.runtime.connections,()=>['claude','codex']);await restarted.list();assert.equal(readFileSync(h.file,'utf8'),bytes);
 const entry=r.body.exits.find((r:any)=>r.config.id==='legacy-claude');const renamed=await save(h.api,{...entry.config,label:'Выход владельца'},entry.revision);assert.equal(renamed.status,200);await restarted.list();assert.equal(h.runtime.settings.network().exits['legacy-claude']!.label,'Выход владельца');
});
