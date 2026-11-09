import {safeDiagnostic} from '@harnessy/providers';
import {RuntimeError,message} from './errors.ts';
import type {Runtime} from './runtime.ts';
import type {ProjectState} from './types.ts';
import {AutopilotSpendBudget} from './autopilot-budget.ts';
import {RuntimeAutopilotCouncil,RuntimeAutopilotSafety,recoverAutopilotIntents,autopilotJournalSource,autopilotApprovalSource,autopilotWaitingSource} from './autopilot-runtime.ts';
import {autopilotHash,type AutopilotIssue,type AutopilotCapability,type AutopilotPermissionSnapshot} from './autopilot-council.ts';

export class RuntimeAutopilotEngine {
 private recovered=false;private seen=new Set<string>();private running:Promise<void>|null=null;private again=false;private closed=false;
 private council:RuntimeAutopilotCouncil;
 private runtime:Runtime;private project:ProjectState;
 constructor(runtime:Runtime,project:ProjectState){this.runtime=runtime;this.project=project;
  this.council=new RuntimeAutopilotCouncil(runtime,{state:runtime,budget:new AutopilotSpendBudget(project.dir,runtime.deps.autopilotSpendQuotes??(async()=>{throw new RuntimeError('spend_unknown','Нет подтверждённой верхней оценки вызова в пунктах недельного окна подписки; для API не задан денежный потолок; решение ждёт владельца',409)})),safety:new RuntimeAutopilotSafety(runtime,project)});
 }
 wake(){if(this.closed)return;this.again=true;if(this.running)return;this.running=Promise.resolve().then(async()=>{do{this.again=false;await this.scan()}while(this.again&&!this.closed)}).catch(error=>this.notice('autopilot_failed',message(error))).finally(()=>{this.running=null})}
 async idle(){while(this.running)await this.running}
 close(){this.closed=true;this.council.close()}
 private current(){return !this.closed&&!this.project.closed&&this.runtime.project===this.project}
 private notice(code:string,reason:string,source?:AutopilotIssue['source'],generation=this.runtime.settings.autopilot().generation){if(!this.current())return;reason=safeDiagnostic(reason,{project:this.project.dir});this.project.journal.append({sender:'harness',to:['owner'],kind:'note',origin:'autopilot-owner',text:JSON.stringify({code,reason,generation,source:source??null})});this.project.owner.publish({type:'autopilotWaiting',code,reason,source:source??null})}
 private async scan(){
  if(!this.current())return;const r=this.runtime,p=this.project;
  if(!this.recovered){await recoverAutopilotIntents(r,p);this.recovered=true}const state=await r.autopilotStatus();if(!this.current()||!state.on)return;
  if([...p.registry.panes.values()].some(pane=>(pane.kind==='orchestrator'||pane.kind==='reviewer')&&(pane.busy||p.editing.has(pane.id)||p.materializing.has(pane.id))))return;
  const permission:AutopilotPermissionSnapshot={generation:state.generation,revision:state.revision,conditions:state.conditions,stopCodes:state.conditions.stopCases};
  const issues:AutopilotIssue[]=[],add=(source:AutopilotIssue['source'],capabilities:AutopilotCapability[])=>{const allowed=capabilities.filter(c=>permission.conditions.operations.includes(c.operation));if(allowed.length)issues.push({project:p.dir,generation:state.generation,permission,source,capabilities:allowed})};
  for(const record of p.journal.read({limit:0})){
   if(!['question','blocker','escalation'].includes(record.kind)||!record.to.includes('owner')||record.from==='owner'||!p.registry.get(record.from))continue;
   const replies=p.journal.repliesTo(record.seq).filter(row=>row.from==='owner'&&row.kind==='decision');
   if(replies.length&&!replies.every(row=>row.origin?.startsWith('autopilot:')&&r.autopilotDecisionLedger(p).get(row.origin.slice(10))?.state==='intent'))continue;
   const pane=p.registry.get(record.from)!;
   add(autopilotJournalSource(record),[{operation:('answer_'+record.kind) as 'answer_question'|'answer_blocker'|'answer_escalation',parameters:{pane:pane.id,replyTo:record.seq},effectModelCall:{seat:pane.id,model:pane.model,vendor:pane.vendor}}]);
  }
  for(const pane of p.registry.panes.values()){
   for(const approval of pane.approvals.values())add(autopilotApprovalSource(pane.id,approval),[{operation:'deny',parameters:{pane:pane.id,approvalId:approval.id}},{operation:'approve',parameters:{pane:pane.id,approvalId:approval.id}}]);
   const wait=r.waiting(pane.id);if(wait&&!pane.busy)add(autopilotWaitingSource(pane.id,wait),wait.actions.map(action=>({operation:action==='skip'?'stop_pane':'continue_pane',parameters:{pane:pane.id,turnInstanceId:wait.turnInstanceId,action},...(action==='retry'?{effectModelCall:{seat:pane.id,model:pane.model,vendor:pane.vendor}}:{})})));
  }
  for(const issue of issues){
   if(!this.current())return;const key=autopilotHash({source:issue.source,generation:issue.generation});if(this.seen.has(key))continue;this.seen.add(key);
   // Permission is checked before the first paid request and again atomically with the effect.
   try{await r.withAutopilotGeneration(issue.generation,snapshot=>{if(snapshot.revision!==permission.revision)throw new RuntimeError('autopilot_generation_mismatch','Условия изменились',409)})}catch{return}
   const result=await this.council.consider(issue);if(!this.current())return;
   if(result.status==='owner'){
    this.notice(result.code,result.reason,issue.source,issue.generation);
    if(result.code==='spend_over_cap'){
     const latest=r.settings.autopilot();if(latest.on&&latest.generation===issue.generation){const stopped=await r.settings.changeAutopilot({on:false,revision:latest.revision},()=>r.clock.now(),()=>{if(!this.current())throw new RuntimeError('project_changed','Проект изменился',409)});p.owner.publish({type:'autopilot',autopilot:stopped})}return;
    }
   }
  }
 }
}
