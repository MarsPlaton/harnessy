import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,renameSync,existsSync,realpathSync,symlinkSync,readdirSync,linkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {CliProvider} from './cli/provider.ts';
import {cliFixture} from './cli/test-support.ts';
import {GEMINI} from './gemini.ts';
import {geminiSettingsGuard} from './gemini-settings-guard.ts';

test('47.11 r2: a stale hard-linked settings name cannot truncate owner data',async t=>{
 const h=await cliFixture(t,'probe'),root=realpathSync(h.dir),directory=join(root,'config'),owner=join(root,'owner-data');mkdirSync(directory);writeFileSync(owner,'owner data');linkSync(owner,join(directory,'settings.json'));
 const guard=geminiSettingsGuard(directory);try{guard.write('{"hooksConfig":{"enabled":false}}');guard.validate()}finally{guard.dispose()}
 assert.equal(readFileSync(owner,'utf8'),'owner data');assert.equal(existsSync(join(directory,'settings.json')),false);
});

if(process.platform==='win32')test('47.11 r2: Windows refuses to rename an ancestor while prepared settings are open',async t=>{
 const h=await cliFixture(t,'probe'),directory=join(realpathSync(h.dir),'config');mkdirSync(directory);
 const guard=geminiSettingsGuard(directory);try{
  guard.write('{"hooksConfig":{"enabled":false}}');
  assert.throws(()=>renameSync(directory,directory+'-old'),{code:'EPERM'});
  guard.validate();
 }finally{guard.dispose()}
 assert.equal(existsSync(join(directory,'settings.json')),false);
});

for(const attack of ['directory','file','overwrite','parent','symlink','move-outside'] as const)test('47.11 r2: rejects '+attack+' during beforeModel and removes the original token file',async t=>{
 if(process.platform==='win32'&&['directory','parent','symlink'].includes(attack)){t.skip('Windows denies renaming an ancestor of the open settings file');return}
 const h=await cliFixture(t,'probe'),state=join(h.dir,'private-state'),owner=join(h.dir,'owner');mkdirSync(state);mkdirSync(join(owner,'.gemini'),{recursive:true});
 writeFileSync(join(owner,'.gemini','google_accounts.json'),JSON.stringify({active:'fixture@example.test'}));
 const config=join(state,'gemini',createHash('sha256').update(realpathSync(h.dir)).digest('hex'),'worker','.gemini'),settings=join(config,'settings.json');
 let starts=0,entered!:()=>void,release!:()=>void;
 const prepared=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve});
 const p=new CliProvider({...GEMINI,binary:process.execPath},{env:{GEMINI_CLI_HOME:owner},cwd:h.dir,stateRoot:state,temporaryDirectory:h.dir,execute:async(_request,_signal,hooks)=>{
  if(!hooks?.stdout)return {stdout:'0.63.0',stderr:'',code:0,signal:null};
  starts++;hooks.started?.();return {stdout:'',stderr:'process must not be started',code:1,signal:null};
 }});t.after(()=>p.close());
 const ctx={...h.ctx,beforeModel:async()=>{entered();await gate}};
 const turn=p.runTurn({...h.seat,vendor:'gemini',model:'default',mode:'all'},'fixture',ctx);
 // Attach the rejection handler before releasing the deliberately held window.
 const rejected=assert.rejects(turn,{code:'state_dir_tampered'});await prepared;
 const value=JSON.parse(readFileSync(settings,'utf8'));value.hooksConfig.enabled=true;
 let original=settings;
 if(attack==='directory'||attack==='symlink'){
  const moved=config+'-old';renameSync(config,moved);original=join(moved,'settings.json');
  if(attack==='symlink')symlinkSync(moved,config,'dir');else{mkdirSync(config);writeFileSync(settings,JSON.stringify(value))}
 }else if(attack==='parent'){
  const parent=dirname(config),moved=parent+'-old';renameSync(parent,moved);original=join(moved,'.gemini','settings.json');mkdirSync(config,{recursive:true});writeFileSync(settings,JSON.stringify(value));
 }else if(attack==='file'||attack==='move-outside'){
  original=attack==='file'?settings+'.old':join(h.dir,'moved-settings.json');renameSync(settings,original);writeFileSync(settings,JSON.stringify(value));
 }else writeFileSync(settings,JSON.stringify(value));
 release();await rejected;
 assert.equal(starts,0);
 if(process.platform==='win32'&&attack==='move-outside')assert.equal(readFileSync(original,'utf8'),'','the moved inode must not retain its token');
 else assert.equal(existsSync(original),false,'the prepared inode must not retain its token under a renamed path');
 assert.deepEqual(h.registered,h.revoked);assert.equal(readdirSync(join(state,'gemini')).some(name=>name.startsWith('.leases-')),false);
});
