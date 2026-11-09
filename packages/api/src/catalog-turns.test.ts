import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderCatalog,cliEntry} from '@harnessy/providers';
import {createRuntime} from '@harnessy/runtime';
import {cliFixture} from '../../providers/src/cli/test-support.ts';
import {timestampMessage} from '../../runtime/src/state.ts';
import {antigravityFixture} from '../../providers/src/antigravity-test-helpers.ts';
import {fixture,call,OWNER,deferred} from './test-helpers.ts';

test('303/304: HTTP selection → CLI turn transfers saved conversation and persists vendor/history',async t=>{
 const f=await cliFixture(t,'probe'),entry=cliEntry(f.description,{env:f.env,cwd:f.dir,temporaryDirectory:f.dir}),h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([entry])}});
 await call(h.api,'/api/providers/'+h.runtime.providerOperations.catalog.ids()[0]+'/check',{body:{}});const status=(await call(h.api,'/api/status')).body;assert.equal(status.turnModes['test-cli'].read.ok,true);assert.equal(status.models['test-cli'][0].id,'test-model');assert.ok(status.models.claude.length);for(const mode of ['read','edit','all','chat','check','web','ask']){assert.equal(status.turnModes.claude[mode].ok,true);assert.equal(status.turnModes.codex[mode].ok,true)}
 const pane=h.runtime.registry.get('worker')!,p=h.runtime.project;pane.sessionId='old-claude';pane.transcript=[timestampMessage('me','SAVED OWNER QUESTION',h.clock.now()),timestampMessage('ai','SAVED ANSWER',h.clock.now())];p.state.savePanes(p.registry,p.journal);
 const changed=await call(h.api,'/api/panes/worker',{body:{vendor:'test-cli',model:'test-model'}});assert.equal(changed.status,200,changed.text);assert.equal(pane.vendor,'test-cli');assert.equal(pane.sessionId,null);
 await h.runtime.runTurn('worker','NEW QUESTION');const turn=f.capture().find(v=>v.input);assert.ok(turn);assert.match(turn.input.message,/Контекст этого разговора/);assert.match(turn.input.message,/SAVED OWNER QUESTION/);assert.match(turn.input.message,/SAVED ANSWER/);assert.equal(pane.sessionId,'session-1');assert.equal(pane.transcript.at(-1)?.vendor,'test-cli');const spend=await call(h.api,'/api/spend/turns?vendor=test-cli');assert.equal(spend.status,200);assert.equal(spend.body.items[0].vendor,'test-cli');
 await h.runtime.close();const restored=await createRuntime(h.deps,h.runtime.actions);t.after(()=>restored.close());assert.equal(restored.registry.get('worker')?.vendor,'test-cli');assert.equal(restored.registry.get('worker')?.sessionId,'session-1');assert.ok(restored.registry.get('worker')?.transcript.some(m=>m.text==='fixture answer'));
});

test('303/306: unknown vendor and unsupported mode reject without changing pane or room; explicit vendor resolves duplicate model ids',async t=>{
 const f=await cliFixture(t,'probe'),entry=cliEntry({...f.description,modes:{all:f.description.modes.all!}},{env:f.env,cwd:f.dir}),h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([entry])}});await call(h.api,'/api/providers/'+h.runtime.providerOperations.catalog.ids()[0]+'/check',{body:{}});
 const pane=h.runtime.registry.get('worker')!,before=pane.settings();for(const body of [{vendor:'missing',model:'w1'},{vendor:'test-cli',model:'test-model'},{model:'test-model'}]){const r=await call(h.api,'/api/panes/worker',{body});assert.equal(r.status,body.vendor==='missing'?400:409);assert.equal(r.body.code,body.vendor==='missing'?'provider_unknown':'capability_unsupported');assert.deepEqual(pane.settings(),before)}
 for(const vendor of ['missing','test-cli']){const r=await call(h.api,'/api/room',{body:{vendor,model:'test-model',folder:true}});assert.equal(r.body.code,vendor==='missing'?'provider_unknown':'capability_unsupported')}
 const r=await call(h.api,'/api/panes/worker',{body:{vendor:'test-cli',model:'test-model',mode:'all',binding:h.runtime.paneBinding('worker')}});assert.equal(r.status,200,r.text);assert.equal(pane.vendor,'test-cli');pane.mode='read';await assert.rejects(h.runtime.runTurn('worker','bypass'),{code:'capability_unsupported'});assert.equal(f.capture().some(v=>v.action==='turn'),false);
 h.runtime.providerOperations.catalog.get('test-cli').models=async()=>[{id:'test-model',label:'Fixture'},{id:'w1',label:'Duplicate'}];await call(h.api,'/api/providers/'+h.runtime.providerOperations.catalog.ids()[0]+'/check',{body:{}});pane.mode='all';const duplicate=await call(h.api,'/api/panes/worker',{body:{vendor:'test-cli',model:'w1'}});assert.equal(duplicate.status,200);assert.equal(pane.vendor,'test-cli');
});

test('303: /status uses a snapshot without awaiting CLI metadata; missing turn modes never authorize a turn',async t=>{
 const f=await cliFixture(t,'probe'),entry=cliEntry(f.description,{env:f.env,cwd:f.dir}),gate=deferred();entry.version=async()=>{await gate.promise;return '1'};delete entry.capabilities.turn;
 const h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([entry])}});try{const r=await call(h.api,'/api/status');assert.equal(r.status,200);assert.equal(r.body.turnModes['test-cli'].read.ok,false);assert.deepEqual(r.body.models['test-cli'],[]);assert.throws(()=>h.runtime.validateTurn('test-cli','read'),{code:'capability_unsupported'})}finally{gate.resolve()}
});

test('303: a registered vendor in team.yaml survives loading; unregistered ids are not executable',async t=>{
 const f=await cliFixture(t,'probe'),entry=cliEntry(f.description,{env:f.env,cwd:f.dir}),h=await fixture(t,{seats:'  worker: {kind: worker, role: worker, vendor: test-cli, model: test-model, mode: read}',deps:{providerCatalog:new ProviderCatalog([entry])}});assert.equal(h.runtime.registry.get('worker')?.vendor,'test-cli');await h.runtime.runTurn('worker','hello');assert.equal(f.capture().filter(v=>v.action==='turn').length,1);
});

test('307/308: pane switches to Antigravity all and runs; read/edit and room read reject with the declared reason',async t=>{
 const agy=antigravityFixture(t),h=await fixture(t,{deps:{providerCatalog:new ProviderCatalog([agy.entry])}});await call(h.api,'/api/providers/'+h.runtime.providerOperations.catalog.ids()[0]+'/check',{body:{}});
 const model='gemini-3.8-flash-high',pane=h.runtime.registry.get('worker')!,before=pane.settings();for(const mode of ['read','edit']){const r=await call(h.api,'/api/panes/worker',{body:{vendor:'antigravity',model,mode}});assert.equal(r.status,409);assert.equal(r.body.code,'capability_unsupported');assert.match(r.body.reason,/нет изолированного MCP/);assert.deepEqual(pane.settings(),before)}
 const room=await call(h.api,'/api/room',{body:{vendor:'antigravity',model,folder:true}});assert.equal(room.status,409);
 assert.equal((await call(h.api,'/api/panes/worker',{body:{vendor:'antigravity',model,mode:'all',binding:h.runtime.paneBinding('worker')}})).status,200);await h.runtime.runTurn('worker','fixed fixture request');assert.equal(pane.vendor,'antigravity');assert.equal(pane.transcript.at(-1)?.text,'готов');const status=(await call(h.api,'/api/status')).body;assert.deepEqual(status.turnModes.antigravity.all,{ok:true,note:'без инструментов Harnessy'});
 const turn=agy.capture().find(v=>v.args.includes('stream-json'));assert.ok(turn);assert.equal(turn.paneToken,false);assert.equal(turn.args.some((a:string)=>a.includes('mcp')),false);
});

test('303: malformed turn metadata is rejected rather than treated as permission',async t=>{
 const f=await cliFixture(t,'probe'),entry=cliEntry(f.description,{env:f.env,cwd:f.dir});assert.throws(()=>new ProviderCatalog([{...entry,capabilities:{...entry.capabilities,turn:{read:{ok:'true'},edit:{ok:false},all:{ok:true}} as never}}]),{code:'protocol'});
});
