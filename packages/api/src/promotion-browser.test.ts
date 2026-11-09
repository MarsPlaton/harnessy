import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApi} from './server.ts';
import {noRepositoryFixture,OWNER} from './test-helpers.ts';
import {testSite} from './site-test-helpers.ts';
import {systemClock} from '../../runtime/src/types.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const electron=process.env.HARNESSY_TEST_ELECTRON||join(root,'ui/desktop/node_modules/.bin/electron');

test('TS-47.1: browser resumes the saved promotion from the reply after the intro',
 {timeout:process.platform==='win32'?180_000:60_000,skip:existsSync(electron)?false:'Electron is not installed; set HARNESSY_TEST_ELECTRON'},async t=>{
 const h=await noRepositoryFixture(t,{deps:{clock:systemClock}}),r=h.runtime;
 await r.settingsPatch('owner',{releaseUnderstood_0_1_0_alpha:true},OWNER);
 r.roomSet({model:'w1'},OWNER);r.registry.get('room')!.record('me','Обсуждение проекта');r.registry.get('room')!.record('ai','Ответ до назначения');
 const list=r.chatsList(OWNER),id=list.active.room!,chat=list.chats.find(c=>c.id===id)!,append=r.journal.append.bind(r.journal);let once=true;
 r.journal.append=record=>{const out=append(record);if(once&&record.origin==='onboarding'){once=false;throw Error('Тестовый обрыв после сохранения вводной')}return out};
 await assert.rejects(r.promoteChat(id,{project:h.dir,revision:chat.revision,documents:[]},OWNER),/Тестовый обрыв/);
 const pending=r.chatGet(id,OWNER).chat;assert.equal(pending.pane,'orchestrator');assert.equal(pending.promotion?.pending,true);assert.equal(pending.promotion?.completed,3);
 const operationId=pending.promotion!.operationId;
 const api=createApi({runtime:r,siteDir:join(testSite(),'sketches'),port:0});await api.listen();t.after(()=>api.close());h.deps.appUrl=api.url;
 const driver=fileURLToPath(new URL('./promotion-browser-driver.cjs',import.meta.url));
 const env:NodeJS.ProcessEnv={...process.env,HARNESSY_TEST_WINDOW:'hidden',PROMOTION_BROWSER_BASE:api.url,PROMOTION_CHAT_ID:id,PROMOTION_OPERATION_ID:operationId,PROMOTION_BROWSER_USER_DATA:join(h.dir,'electron-profile')};
 delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(electron,[driver],{env,stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM')});let stdout='',stderr='';
 child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data});
 const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
 assert.equal(exit,0,'browser regression failed: '+stderr+'\n'+stdout);await r.idle();
 const completed=r.chatGet(id,OWNER).chat;assert.equal(completed.id,id);assert.equal(completed.promotion?.operationId,operationId);assert.equal(completed.promotion?.pending,false);assert.equal(r.project.state.chats.active.orchestrator,id);
 assert.equal(h.provider.calls.length,1);assert.equal(r.journal.read({limit:0}).filter(item=>item.origin==='onboarding').length,1);
});
