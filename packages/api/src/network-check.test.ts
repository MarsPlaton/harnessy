import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {fixture,call,deferred} from './test-helpers.ts';
import {MemoryKeys} from '../../llm/src/test-helpers.ts';
const opts={timeout:15000},root='/api/network';
const config={id:'proxy',type:'proxy',label:'Прокси',url:'http://proxy.test:8080',login:'owner',expectedIp:'192.0.2.1'};
test('22e: check uses captured password only in stdin, fixed IP destinations and no ambient proxy; revision guards late results',opts,async t=>{
 const seen:any[]=[],keys=new MemoryKeys(),gate=deferred(),entered=deferred();let delay=false;
 const h=await fixture(t,{deps:{networkKeys:keys,networkCheckOptions:{execute:async req=>{seen.push(req);if(delay){delay=false;entered.resolve();await gate.promise}return {code:0,signal:null,stderr:'',stdout:req.input?.includes('ipapi.co')?'{"country_name":"Test"}\n0.020':'{"ip":"192.0.2.1"}\n0.025'}}}}});t.after(()=>gate.resolve());
 const saved=(await call(h.api,root+'/exits/proxy/save',{body:{config,revision:null,password:'private-fixture'}})).body;
 let r=await call(h.api,root+'/exits/proxy/check',{body:{revision:saved.revision},headers:{'x-pane-token':'forged'}});assert.equal(r.status,403);assert.equal(seen.length,0);
 r=await call(h.api,root+'/exits/proxy/check',{body:{revision:saved.revision}});assert.equal(r.status,200);assert.equal(r.body.check.state,'matches');assert.equal(r.body.check.country,'Test');assert.equal(r.body.check.durationMs,25);assert.equal((await call(h.api,root+'/exits')).body.exits[0].lastCheck.state,'matches');
 assert.equal(seen.length,2);for(const req of seen){assert.deepEqual(req.args,['-q','--config','-']);assert.match(req.input,/private-fixture/);assert.doesNotMatch(JSON.stringify({args:req.args,env:req.env}),/private-fixture|HTTP_PROXY|ALL_PROXY/)}assert.doesNotMatch((await call(h.api,'/api/trace')).text,/private-fixture/);
 delay=true;const checking=call(h.api,root+'/exits/proxy/check',{body:{revision:saved.revision}});await entered.promise;
 assert.equal((await call(h.api,root+'/exits/proxy/save',{body:{config:{...config,expectedIp:'192.0.2.2'},revision:saved.revision}})).status,200);gate.resolve();r=await checking;assert.equal(r.body.code,'network_conflict');assert.equal((await call(h.api,root+'/exits')).body.exits[0].lastCheck,null);
});
test('22e: direct check explicitly disables proxies; malformed service responses are safe; SSH check reports the actual tunnel failure',opts,async t=>{
 const seen:any[]=[],h=await fixture(t,{deps:{sshTunnels:{ensure:async()=>({id:'ssh',state:'down',url:null,generation:1,code:'ssh_auth_failed',reason:'Сервер не принял ключ',retryAt:null}),get:()=>null,snapshots:()=>[],stop:async()=>{},close:async()=>{},subscribe:()=>()=>true},networkKeys:new MemoryKeys(),networkCheckOptions:{execute:async req=>{seen.push(req);return {code:7,signal:null,stdout:'',stderr:'credential=private-fixture'}}}}});
 const home=join(h.dir,'mock-home');mkdirSync(join(home,'.ssh'),{recursive:true});writeFileSync(join(home,'.ssh/key'),'FAKE KEY');const original=os.homedir;os.homedir=()=>home;syncBuiltinESMExports();t.after(()=>{os.homedir=original;syncBuiltinESMExports()});
 for(const config of [{id:'direct',type:'direct',label:'Напрямую'},{id:'ssh',type:'ssh',label:'VPS',host:'vps.test',port:22,user:'owner',keyPath:'~/.ssh/key'}]){if(process.platform==='win32'&&config.id==='ssh')continue;const savedResponse=await call(h.api,root+'/exits/'+config.id+'/save',{body:{config,revision:null}});assert.equal(savedResponse.status,200,savedResponse.text);const saved=savedResponse.body;const r=await call(h.api,root+'/exits/'+config.id+'/check',{body:{revision:saved.revision}});if(config.id==='ssh'){assert.equal(r.body.check.ok,false);assert.equal(r.body.check.code,'ssh_auth_failed');assert.match(r.body.check.reason,/не принял ключ/)}else {assert.equal(r.body.check.ok,false);assert.doesNotMatch(r.text,/private-fixture/);assert.match(seen[0].input,/proxy = ""/);assert.equal((await call(h.api,root+'/exits/direct/check',{body:{}})).body.code,'network_conflict')}}assert.equal(seen.length,1);
});
test('22e: SSH chooser lists filenames only under ~/.ssh; no contents, symlinks or public metadata files',{...opts,skip:process.platform==='win32'},async t=>{
 let dir='';const h=await fixture(t,{before:path=>{dir=join(path,'ssh');mkdirSync(dir);writeFileSync(join(dir,'id_ed25519'),'PRIVATE-KEY-FIXTURE');writeFileSync(join(dir,'id_ed25519.pub'),'public');writeFileSync(join(dir,'known_hosts'),'hosts');symlinkSync('/etc/passwd',join(dir,'escape'))},deps:{networkCheckOptions:{get sshDir(){return dir}}}});
 assert.equal((await call(h.api,root+'/ssh-keys',{headers:{'x-harness-pane':'worker'}})).status,403);const r=await call(h.api,root+'/ssh-keys');assert.deepEqual(r.body.files,[{name:'id_ed25519',path:'~/.ssh/id_ed25519'}]);assert.doesNotMatch(r.text,/PRIVATE-KEY|escape|known_hosts|\.pub/);
});
