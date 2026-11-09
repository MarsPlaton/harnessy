import {isAbsolute,join,relative,sep} from 'node:path';
import type {Runtime} from '@harnessy/runtime';

// One synchronous, project-bound read. No provider calls, delivery or role creation.
export function swarm(r:Runtime){
 const p=r.project
 const instructionPath=(id:string)=>{const seat=p.team?.seats[id],raw=seat?.instructions;if(!raw)return null;const file=isAbsolute(raw)?raw:join(p.team!.harnessDir,raw),path=relative(p.dir,file);return !path||isAbsolute(path)||path==='..'||path.startsWith('..'+sep)?null:path.split(sep).join('/')};
 let policy:unknown;try{if(!p.policy)throw Error('Политика обмена не подключена.');p.policy.maybeReload();policy={ok:true,version:p.policy.version,routes:p.policy.routes}}catch{policy={ok:false,code:'policy_unavailable',error:'Политика обмена не прочитана. Проверьте comms-policy.yaml.'}}
 const records=p.journal.read({limit:0}),rows=records.filter(row=>row.seq>0);
 const entry=(row:typeof records[number])=>({seq:row.seq,ts:row.ts,from:row.from,to:[...row.to],kind:row.kind,thread:row.thread??null,text:row.text});
 return {ok:true,project:p.dir,instance:p.trace.instanceId,policy,generatedAt:r.clock.now(),halted:p.halted,team:{path:p.team?join(p.team.harnessDir,'team.yaml'):null,integrationBranch:p.team?.integrationBranch??null},
  journal:{records:rows.slice(-100).map(entry),total:rows.length,lastSeq:p.journal.lastSeq},
  panes:[...p.registry.panes.values()].filter(pane=>pane.id!=='room').map(pane=>{
   const turn=p.active.get(pane.id),chat=p.state.chats.active[pane.id]??null,attempt=p.state.attempts[pane.id],context=r.context(pane.id),waiting=r.waiting(pane.id),activeRecords=new Set(turn?.records.map(row=>row.seq)??[]),queue=p.journal.pendingFor(pane.id).filter(item=>!activeRecords.has(item.record.seq));
   return {...pane.settings(),chat,instructionPath:instructionPath(pane.id),status:pane.status,waiting:waiting?{...waiting,recordSeqs:[...waiting.recordSeqs],actions:[...waiting.actions]}:null,pending:queue.length,queue:queue.map(item=>entry(item.record)),
    turn:turn?{id:turn.scope.turnInstanceId,startedAt:attempt?.turnInstanceId===turn.scope.turnInstanceId?attempt.startedAt:null,records:turn.records.map(entry),message:turn.records.at(-1)?.text??null}:null,
    context:{used:context.used,window:context.window,pct:context.pct,measured:context.measured,last:context.last,turns:context.turns}}
  })};
}
