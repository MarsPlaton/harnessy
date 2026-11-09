import {pyTruthy} from '@harnessy/team';
import {RuntimeError,type Runtime} from '@harnessy/runtime';
import type {Route} from './routes.ts';
import {OWNER,string} from './routes.ts';
import {json,slice,text} from './responses.ts';
import {providerOwner} from './routes-providers.ts';
const roles={role_taken:409,seat_exists:409};
export function ownerRoutes(r:Runtime):Route[]{return [
 {method:'POST',path:'/api/project',handle:async({body})=>json(await r.projectSet(string(body.path),{reload:pyTruthy(body.reload)},OWNER))},
 {method:'POST',path:'/api/project/create',handle:async({body})=>json(await r.projectCreate(body,OWNER))},
 {method:'POST',path:'/api/panes/:id',style:'E',handle:({params,body})=>json(r.paneSet(params.id!,body,OWNER))},
 {method:'POST',path:'/api/panes/:id/instruction',style:'J',handle:async({request,params,body})=>{providerOwner(request);return json(await r.updateInstruction(params.id!,body,OWNER))}},
 {method:'POST',path:'/api/panes/:id/attempt',style:'J',handle:async({params,body})=>json(await r.attempt(params.id!,body,OWNER))},
 {method:'GET',path:'/api/chats',handle:()=>json(r.chatsList(OWNER))},
 {method:'POST',path:'/api/chats/new',handle:async({body})=>json(await r.chatsNew(body,OWNER))},
 {method:'POST',path:'/api/chats/open',handle:async({body})=>json(await r.chatsOpen(body,OWNER))},
 {method:'POST',path:'/api/chats/:id/orchestrator',style:'J',handle:async({params,body})=>json(await r.promoteChat(params.id!,body,OWNER))},
 {method:'GET',path:'/api/chats/:id',style:'E',handle:({params})=>json(r.chatGet(params.id!,OWNER))},
 {method:'GET',path:'/api/pins',handle:()=>json(r.pinsGet(OWNER))},
 {method:'POST',path:'/api/pins',handle:async({body})=>{if(body.project!==undefined&&body.project!==r.project.dir)throw new RuntimeError('project_changed','проект сменился',409);return json(await r.pinSet(body,OWNER))}},
 {method:'GET',path:'/api/settings',handle:()=>json(r.settingsGet(OWNER))},
 {method:'POST',path:'/api/settings',handle:async({request,body})=>{providerOwner(request);return json(await r.settingsPatch(body.scope,body.patch,OWNER))}},
 {method:'POST',path:'/api/tasks',style:'J',handle:async({request,body})=>{providerOwner(request);return json(await r.taskChange('create',body,OWNER),201)}},
 {method:'POST',path:'/api/tasks/:id/assign',style:'J',handle:async({request,body,params})=>{providerOwner(request);return json(await r.taskChange('assign',body,OWNER,params.id!))}},
 {method:'POST',path:'/api/autopilot',style:'J',handle:async({request,body})=>{providerOwner(request);return json(await r.autopilotSet(body,OWNER))}},
 {method:'GET',path:'/api/autopilot/decisions',style:'J',handle:({request})=>{providerOwner(request);return json(r.autopilotDecisions(OWNER))}},
 {method:'POST',path:'/api/autopilot/decisions/:id/cancel',style:'J',handle:async({request,body,params})=>{providerOwner(request);if(Object.keys(body).some(key=>!['project','effectVersion'].includes(key))||typeof body.project!=='string'||typeof body.effectVersion!=='string'||!body.effectVersion)throw new RuntimeError('decision_invalid','Нужны проект и версия применённого эффекта',400);return json(await r.autopilotCancelDecision(body.project,params.id!,body.effectVersion,OWNER))}},
 {method:'GET',path:'/api/context/:id',handle:({params})=>r.registry.get(params.id!)?json(r.context(params.id!)):json({ok:false,error:'нет такого места'},404)},
 {method:'POST',path:'/api/halt',handle:async({body})=>json(await r.halt(body.on===undefined||pyTruthy(body.on),OWNER))},
 {method:'POST',path:'/api/room',handle:async({body})=>json(await r.roomSet(body,OWNER))},
 {method:'POST',path:'/api/room/move',handle:async({body})=>json(await r.roomMove(body,OWNER))},
 {method:'POST',path:'/api/assign',style:'J',statuses:roles,handle:async({body})=>json(await r.assignRoomRole(body,OWNER))},
 {method:'GET',path:'/api/seats/proposals',style:'J',handle:()=>r.teamProposals(OWNER).then(json)},
 {method:'POST',path:'/api/seats/owner',style:'J',handle:async({request,body})=>{if(request.headers['x-pane-token']||body.from!==undefined)return json({ok:false,code:'policy_denied',error:'эту роль создаёт только владелец'},403);return json(await r.createOwnerSeat(body,OWNER))}},
 {method:'POST',path:'/api/seats/confirm',style:'J',handle:async({request,body})=>{if(request.headers['x-pane-token']||body.from!==undefined)return json({ok:false,code:'policy_denied',error:'состав подтверждает только владелец'},403);return json(await r.confirmTeam(body,OWNER))}},
 {method:'POST',path:'/api/onboard',handle:async({body})=>json(await r.onboard(string(body.pane),OWNER,body))},
 {method:'POST',path:'/api/handoff',handle:async({body})=>json(await r.handoff(body,OWNER))},
 {method:'POST',path:'/api/chat',style:'E',handle:({body})=>json(r.chat(body,OWNER))},
 {method:'POST',path:'/api/attachments',style:'J',handle:({body})=>json(r.attachmentUpload(body,OWNER),201)},
 {method:'GET',path:'/api/attachments/:id',style:'J',handle:({request,params})=>{providerOwner(request);const attachment=r.attachmentRead(params.id,OWNER);return {status:200,value:null,bytes:attachment.data,headers:{'Content-Type':attachment.mime,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}}}},
 {method:'POST',path:'/api/steer',style:'E',handle:async({body})=>json(await r.steer(string(body.pane),string(body.message),OWNER))},
 {method:'POST',path:'/api/approve',style:'E',handle:({body,request})=>{const probe=string(body.id).startsWith('provider-probe:');if(probe){providerOwner(request);if(body.pane!=='owner'||!['allow','deny'].includes(string(body.decision))||typeof body.project!=='string')return json({ok:false,code:'approval_invalid',error:'Ожидаются pane:owner, id, decision:allow|deny и project'},400)}if(body.project!==undefined&&body.project!==r.project.dir)throw new RuntimeError('project_changed','проект сменился',409);return json(r.approve(string(body.pane),string(body.id),body.decision==='allow'?'allow':'deny',OWNER))}},
 {method:'POST',path:'/api/interrupt',style:'E',handle:({body})=>json(r.interrupt(string(body.pane),OWNER))},
 {method:'GET',path:'/api/sessions',style:'E',handle:async({query})=>{const id=query.get('pane')??'';if(!r.registry.get(id))throw new RuntimeError('pane_unknown','нет окна',400);try{return json({sessions:await r.listSessions(id)})}catch(e){return json({sessions:[],error:slice(text(e),300)})}}},
 {method:'POST',path:'/api/sessions/open',style:'E',statuses:{pane_unknown:400},handle:async({body})=>{try{return json(await r.openSession(string(body.pane),string(body.id),OWNER))}catch(e){if(e instanceof RuntimeError)throw e;return json({error:slice(text(e),300)},404)}}}
]}
