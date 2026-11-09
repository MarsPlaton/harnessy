import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApi} from './server.ts';
import {fixture,deferred,OWNER} from './test-helpers.ts';
import {testSite} from './site-test-helpers.ts';
import {systemClock} from '../../runtime/src/types.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const electron=process.env.HARNESSY_TEST_ELECTRON||join(root,'ui/desktop/node_modules/.bin/electron');
test('TS-47.8: real completion keeps old selection and focus when the history is trimmed at four sizes',
 {timeout:60_000,skip:existsSync(electron)?false:'Electron is not installed; set HARNESSY_TEST_ELECTRON'},async t=>{
 const h=await fixture(t,{seats:'  worker: {role: executor, vendor: claude, label: воркер, model: w1, mode: read, digest: true}',deps:{clock:systemClock}}),r=h.runtime,gates=Array.from({length:4},()=>deferred());let runs=0;
 t.after(()=>gates.forEach(gate=>gate.resolve()));await r.settingsPatch('owner',{releaseUnderstood_0_1_0_alpha:true},OWNER);
 const pane=r.registry.get('worker')!;for(let i=0;i<22;i++){pane.record('me','Вопрос '+i);pane.record('ai','Сохранённый ответ '+i+' — текст для выделения и чтения.')}
 h.provider.onRun=async(seat,_text,ctx)=>{const run=runs++;ctx.modelStarted?.();ctx.publish({type:'delta',text:'Новый ответ '+run});await gates[run]!.promise;ctx.publish({type:'done',model:seat.model,sessionId:null,durationMs:1,usage:{input:1,output:1,cacheRead:0}});return {text:'Новый ответ '+run,sessionId:null}};
 const api=createApi({runtime:r,siteDir:join(testSite(),'sketches'),port:0});await api.listen();t.after(()=>api.close());h.deps.appUrl=api.url;
 const env:NodeJS.ProcessEnv={...process.env,HARNESSY_TEST_WINDOW:'hidden',RETENTION_BROWSER_BASE:api.url,RETENTION_BROWSER_USER_DATA:join(h.dir,'retention-electron')};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(electron,[fileURLToPath(new URL('./history-retention-browser-driver.cjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM')});let stdout='',stderr='';const released=new Set<number>();
 child.stdout.on('data',data=>{stdout+=data;for(let i=0;i<gates.length;i++)if(!released.has(i)&&stdout.includes('RELEASE_'+i)){released.add(i);gates[i]!.resolve()}});child.stderr.on('data',data=>{stderr+=data});
 const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});assert.equal(exit,0,'browser regression failed: '+stderr+'\n'+stdout+'; provider runs='+runs);assert.equal(released.size,4);await r.idle();
});
