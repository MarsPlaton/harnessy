import {parse} from 'acorn';

type Node = {type:string;start:number;end:number;[key:string]:any};
export type FixtureEntry = string | {statement:string} | {conditional:{identifier:string;equals:string;declaration:string}};
export type FixtureOptions = {filename?:string;wrapper?:number;scope?:string;block?:string|{identifier:string;equals:string}};

// Cache the parsed file per test process; every fixture still executes in its own VM.
const parsed=new Map<string,Node[][]>();
const programs=new Map<string,Node>();

function program(source:string):Node{
 let result=programs.get(source);
 if(!result){result=parse(source,{ecmaVersion:'latest',sourceType:'script'}) as unknown as Node;programs.set(source,result)}
 return result;
}

function wrapperStatements(source:string):Node[]{
 return (program(source).body as Node[]).filter(statement=>{
  const expression=statement.type==='ExpressionStatement'?statement.expression:null;
  const fn=expression?.type==='CallExpression'?expression.callee:null;
  return (fn?.type==='FunctionExpression'||fn?.type==='ArrowFunctionExpression')&&fn.body?.type==='BlockStatement';
 });
}

function bodies(source:string):Node[][]{
 const cached=parsed.get(source);if(cached)return cached;
 const wrappers=wrapperStatements(source).map(statement=>statement.expression.callee.body.body as Node[]);
 const result=wrappers.length?wrappers:[program(source).body];parsed.set(source,result);return result;
}

/** Extract a complete top-level IIFE for boot fixtures. */
export function fixtureWrapper(source:string,index:number,filename='live.js'):string{
 const wrapper=wrapperStatements(source)[index];
 if(!wrapper)throw Error(`Обёртка ${index} не найдена в ${filename}`);
 return source.slice(wrapper.start,wrapper.end)+'\n';
}

/** Extract a top-level named assignment, including its complete IIFE if present. */
export function fixtureAssignment(source:string,name:string,filename='app.js'):string{
 function path(node:Node):string|null{
  if(node.type==='Identifier')return node.name;
  if(node.type==='MemberExpression'&&!node.computed&&node.property.type==='Identifier'){
   const parent=path(node.object);return parent===null?null:parent+'.'+node.property.name;
  }
  return null;
 }
 const matches=(program(source).body as Node[]).filter(node=>node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'&&node.expression.operator==='='&&path(node.expression.left)===name);
 if(matches.length!==1)throw Error(`Присваивание ${name} ${matches.length?'неоднозначно':'не найдено'} в ${filename}`);
 return source.slice(matches[0]!.start,matches[0]!.end)+'\n';
}

function patternNames(pattern:Node|null|undefined):string[]{
 if(!pattern)return [];
 if(pattern.type==='Identifier')return [pattern.name];
 if(pattern.type==='RestElement')return patternNames(pattern.argument);
 if(pattern.type==='AssignmentPattern')return patternNames(pattern.left);
 if(pattern.type==='ArrayPattern')return pattern.elements.flatMap(patternNames);
 if(pattern.type==='ObjectPattern')return pattern.properties.flatMap((item:Node)=>patternNames(item.type==='RestElement'?item.argument:item.value));
 return [];
}

function names(statement:Node):string[]{
 if((statement.type==='FunctionDeclaration'||statement.type==='ClassDeclaration')&&statement.id)return [statement.id.name];
 if(statement.type==='VariableDeclaration')return statement.declarations.flatMap((declaration:Node)=>patternNames(declaration.id));
 return [];
}

function testsEquality(test:Node,identifier:string,value:string):boolean{
 if(test.type==='LogicalExpression')return testsEquality(test.left,identifier,value)||testsEquality(test.right,identifier,value);
 if(test.type!=='BinaryExpression'||test.operator!=='===')return false;
 const pair=(left:Node,right:Node)=>left.type==='Identifier'&&left.name===identifier&&right.type==='Literal'&&right.value===value;
 return pair(test.left,test.right)||pair(test.right,test.left);
}

function isConditional(node:Node,selection:{identifier:string;equals:string;declaration:string}):boolean{
 return node.type==='IfStatement'&&testsEquality(node.test,selection.identifier,selection.equals)&&node.consequent?.type==='BlockStatement'&&node.consequent.body.some((child:Node)=>names(child).includes(selection.declaration));
}

/**
 * Extract complete declarations in the requested order, without relying on their
 * neighbours. Anonymous setup statements use an explicit, unique prefix.
 */
export function fixtureSource(source:string,entries:readonly FixtureEntry[],options:FixtureOptions={}):string{
 source=source.replace(/\r\n?/g,'\n');
 const filename=options.filename||'live.js',all=bodies(source);
 let scopes=options.wrapper===undefined?all:all[options.wrapper]?[all[options.wrapper]!]:[];
 if(options.scope){
  const matches=scopes.flatMap(body=>body.filter(node=>names(node).includes(options.scope!)));
  if(matches.length!==1)throw Error(`Область ${options.scope} ${matches.length?'неоднозначна':'не найдена'} в ${filename}`);
  const declaration=matches[0]!;
  const fn=declaration.type==='FunctionDeclaration'?declaration:declaration.declarations.find((item:Node)=>patternNames(item.id).includes(options.scope!))?.init;
  scopes=fn?.body?.type==='BlockStatement'?[fn.body.body]:[];
 }
 if(options.block){
  const block=options.block,label=typeof block==='string'?block:`${block.identifier} === ${JSON.stringify(block.equals)}`;
  const matches=scopes.flatMap(body=>body.filter(node=>node.type==='IfStatement'&&(typeof block==='string'?source.slice(node.start,node.end).startsWith(block):testsEquality(node.test,block.identifier,block.equals))));
  if(matches.length!==1)throw Error(`Блок ${label} ${matches.length?'неоднозначен':'не найден'} в ${filename}`);
  scopes=matches[0]!.consequent?.type==='BlockStatement'?[matches[0]!.consequent.body]:[];
 }
 const selected:Node[]=[],seen=new Set<string>();
 for(const entry of entries){
  const label=typeof entry==='string'?entry:'statement' in entry?entry.statement:`${entry.conditional.identifier} === ${JSON.stringify(entry.conditional.equals)} / ${entry.conditional.declaration}`;
  const candidates=scopes.flatMap(body=>body.filter(node=>typeof entry==='string'?names(node).includes(entry):'statement' in entry?source.slice(node.start,node.end).startsWith(entry.statement):isConditional(node,entry.conditional)));
  if(candidates.length!==1)throw Error(`Функция, константа или оператор ${label} ${candidates.length?'неоднозначна':'не найдена'} в ${filename}`);
  const node=candidates[0]!,key=node.start+':'+node.end;
  if(!seen.has(key)){seen.add(key);selected.push(node)}
 }
 return selected.map(node=>source.slice(node.start,node.end)).join('\n')+'\n';
}

// Named selections replace order-dependent slices in the window fixtures.
export const fixtureGroups={
 proto_SPEC_to_specificationLabels: ["SPEC","specificationLabels",{"statement":"specificationLabels();"}],
 live_md_to_addEventListener: ["md","mdView","mdPath","mdFileURL","mdArtifact","mdLink","mdFiles","mdEpoch","mdReset","mdToolPaths","mdMessageArtifacts","mdSize","mdRead","hydrateArtifacts","mdCsv","mdClose",{"statement":"document.addEventListener('click',async event=>{const c"},{"statement":"addEventListener('pagehide',m"},{"statement":"addEventListener('live:status',()=>{if(m"}],
 live_LIVE_EVENTS_to_addEventListener: ["LIVE_EVENTS","stopLiveEvents","subscribeLiveEvents","syncLiveEvents",{"statement":"addEventListener('live:status',s"},{"statement":"addEventListener('pagehide',()=>{L"},{"statement":"addEventListener('pageshow',event=>{if(event.persisted)L"}],
 live_EV_to_if: ["EV","eventFeed","eventsReset","eventsValid","eventsDraw","eventsCurrent","eventsFetch","eventsRefresh","eventsSync",{"statement":"if(PAGE==='events'){\n   "}],
 live_streams_to_queueDelivered: ["streams","nextLiveTurnId","liveTurnId","orderChat","streamScope","streamKey","streamCurrent","streamGet","streamEnd","selectedBusy","streamSelect","streamClear","streamHidden","queueDelivered"],
 live_applyStatus_to_refreshStatus: ["applyStatus","refreshChats","refreshStatus"],
 live_networkCodes_to_networkWaiting: ["networkCodes","connectionTitle","networkLink","networkCause","exitName","networkPath","networkWarning","networkMenu","networkWaiting"],
 live_modelChangeKey_to_bindFreshModelChanges: ["modelChangeKey","modelChanges","recordModelChange","bindFreshModelChanges"],
 live_toolLine_to_hEvent: ["toolLine","curHTML","turnPhase","phaseHTML","elapsed","toolWord","toolCount","toolGroup","turnContent","captureLiveGroups","restoreLiveGroup","footerUpdate","askHTML","phaseTimer","drawLive","failedTurnHTML","finish","transferHTML","toolErrorEntry","updateTurn","hEvent"],
 live_loadChat_to_recoverStoppedTurn: ["loadChat","beginActiveRecovery","recoverActiveTurns","recoverStoppedTurn"],
 live_api_to_networkWaiting: ["api","captureProjectOperation","projectOperationCurrent","networkCodes","connectionTitle","networkLink","networkCause","exitName","networkPath","networkWarning","networkMenu","networkWaiting"],
 live_bindingGeneration_to_settingsReady: ["bindingGeneration","streams","nextLiveTurnId","liveTurnId","orderChat","streamScope","streamKey","streamCurrent","streamGet","streamEnd","selectedBusy","streamSelect","streamClear","streamHidden","queueDelivered","settingJobs","sendBinding","invalidateBinding","leftPage",{"statement":"addEventListener('pagehide',()=>{l"},"bindingCurrent","modelChangeKey","modelChanges","recordModelChange","bindFreshModelChanges","settingKey","configureSetting","settingsReady"],
 live_applyStatus_to_applyStatus: ["applyStatus"],
 live_projectPathValue_to_projectPathValue: ["projectPathValue"],
 proto_keyboardActions_to_document: ["keyboardActions","keyboardControls",{"statement":"keyboardControls();"},{"statement":"if(typeof MutationObserv"},{"statement":"document.addEventListener('keydown',e=>{i"}],
 live_ask_to_ask: ["ask"],
 live_consumeState_to_consumeState: ["consumeState"],
 live_curD_to_document: ["curD","applyNow","hooks","refresh","resolve",{"statement":"document.addEventListener('click',e=>{ if(PAGE!"}],
 live_waitingControls_to_document: ["waitingControls","showWaiting","unsentJoin","renderWaiting","showRestore","attemptRequests",{"statement":"document.addEventListener('click',async e=>{ const b"}],
 live_eventsValid_to_eventsValid: ["eventsValid"],
 live_NOW_to_document: ["NOW","nowCurrent","nowAttemptDisabled","nowDate","nowAge","nowReset","nowWaitingValid","nowValid","nowFetch","nowItems","nowButton","nowDraw","nowOpen","nowLive",{"statement":"if(PAGE==='now'){\n    ad"},{"statement":"document.addEventListener('click',async e=>{\n"}],
 live_OPS_to_moveConversation: ["OPS","PROMOTION_STEPS","operationIdentity","operationCurrent","operationHTML","operationsDraw","operationAttention","operationStart","operationEnd","operationProgress","operationsStatus","operationsEvent",{"statement":"document.addEventListener('click',event=>{const l"},{"statement":"addEventListener('live:status',o"},{"statement":"addEventListener('pagehide',()=>{O"},"proposalMaterialization","operationsTeams","moveConversation"],
 live_TP_to_addEventListener: ["TP","KN","knowledgeDraw","knowledgeSet","knowledgeFetch","knowledgeReset","knowledgeOpen",{"statement":"document.addEventListener('click',e=>{if(e.target.closest('[data-k"},{"statement":"addEventListener('pagehide',k"},"TEAM_KINDS","TEAM_KIND_LABELS","TEAM_MODE_LABELS","proposalCurrent","proposalKindKey","proposalSeatKind","proposalValid","proposalsNotify","proposalMember","proposalStateText","proposalRow","openTeamChat","createTeamRole","proposalCard","proposalsDraw","proposalsReset","pendingProposalLink","proposalLinkCurrent","clearProposalLink","readProposalLink","applyProposalLink","proposalsFetch","proposalsSync","showTeamProposal","requestTeamProposal","confirmProposal","closeProposalKinds","proposalKindLayoutChanged",{"statement":"addEventListener('resize',p"},{"statement":"addEventListener('scroll"},{"statement":"document.addEventListener('click',e=>{c"},{"statement":"document.addEventListener('keydown',e="},{"statement":"document.addEventListener('click',async e=>{const t"},{"statement":"addEventListener('pagehide',p"}],
 live_base_to_sideChats: ["base","pl","PIN","PROJ_ITEMS","ico","PROJECT_FOLD_KEY","projectExpanded","projectFolder","toggleProjectFolder","sideGeneration","pinJobs","sideChats"],
 live_openChatRow_to_document: ["openChatRow","sideSwitchProject",{"statement":"addEventListener('ps2:pr"},{"statement":"addEventListener('ps2:mo"},{"statement":"addEventListener('ps2:ne"},{"statement":"document.addEventListener('click',async e=>{ const t"}],
 live_hConnect_to_hConnect: ["hConnect"],
 live_captureProjectOperation_to_networkWaiting: ["captureProjectOperation","projectOperationCurrent","networkCodes","connectionTitle","networkLink","networkCause","exitName","networkPath","networkWarning","networkMenu","networkWaiting"],
 live_laMenu_to_laPath: ["laMenu","projectPathValue","laPath"],
 live_promotionBusy_to_document: ["promotionBusy","promoteConversation",{"statement":"document.addEventListener('click',async e=>{ const l"}],
 live_autopilotText_to_autopilotText: ["autopilotText"],
 live_guidanceState_to_document: ["guidanceState","guidanceKey","orchestratorOfferForced","chatGuidanceDraw","showOrchestratorOffer",{"statement":"document.addEventListener('click',async event=>{const m"}],
 live_toolErrorEntry_to_hEvent: ["toolErrorEntry","updateTurn","hEvent"],
 live_nowLive_to_nowLive: ["nowLive"],
 live_fmtN_to_document: ["fmtN","statNumber","messageUsage","turnStatsOpen","turnStatsKey","statMoney","statValue","turnStatsButton","turnStatsCard",{"statement":"document.addEventListener('click',async e=>{const bu"}],
 live_connectionFailed_to_connectionFailed: ["connectionFailed"],
 live_rememberLive_to_refreshStatus: ["rememberLive","SECTION_PAGES","PS","sectionCurrent","sectionText","sectionValid","SECTION_LAYOUT","sectionDate","sectionItems","sectionMock","sectionMissing","sectionBody","sectionItemBinding","sectionClose","sectionKind","sectionCount","sectionRow","sectionFooter","sectionDraw","sectionOpenItem","sectionFetch","sectionSync","sectionChanging","sectionConversation","sectionRequest",{"statement":"if(SECTION_PAGES[PAGE]){"},"ownerProfile","profileDraw","autopilotText","autopilotDraw","applyStatus","refreshChats","refreshStatus"],
 live_suspendPage_to_addEventListener: ["suspendPage","resumePage",{"statement":"addEventListener('pageshow',event=>{if(event.persisted)r"}],
 proto_document_to_renderWorkspaceHeader: [{"statement":"document.addEventListener('click',e=>{const me"},{"statement":"document.addEventListener('click',e=>{i"},{"statement":"addEventListener('keydow"},{"statement":"document.addEventListener('d"},"keyboardActions","keyboardControls",{"statement":"keyboardControls();"},{"statement":"if(typeof MutationObserv"},{"statement":"document.addEventListener('keydown',e=>{i"},{"statement":"renderSide();"},{"statement":"renderWorkspaceHeader();"}],
 live_statics_to_document: ["statics","saveUI","restoreUI","pre",{"statement":"document.addEventListener('click',e=>{ if(PAGE="},{"statement":"document.addEventListener('click',("}],
 live_closeLAMenus_to_laPath: ["closeLAMenus","dismissLAMenu","laMenu","projectPathValue","laPath"],
 live_laMulti_to_laMulti: ["laMulti"],
 live_spendPeriod_to_if: ["spendPeriod","SP","LIM","spendGroups","spButton","spMock","spMoney","spMetric","spDate","spName","spTable","spGroups","limitCountdown","limitSamples","limitApi","limitSubscription","limitFailed","limitName","limitProviders","spWindow","limitAge","spLimitCreditHTML","spLimitRetryHTML","limitWeek","limitFive","limitMonth","limitDetailWindows","spLimitHTML","limitActivity","widgetProviders","widgetWeek","claudeCommonWeek","widgetTone","limitRemaining","widgetTicks","widgetWindow","sidebarLimitHTML","popupWindows","popupRenewal","popupLimitHTML","limitsDraw","limitsApply","limitsEvent","limitsRestart","limitsFetch",{"statement":"subscribeLiveEvents(even"},"SB","spendBilling","spPolicy",{"statement":"document.addEventListener('click',async e=>{const b="},"spBadge","spTokens","spAmount","SW","windowKey","spendWindows","spWindowUsage","spQuotaGraph","spProvider","spHistory","spFilters","spRouter","spCalendar","spendDraw","spNumber","spMetrics","spHistoryRow","spValid","spendHistory","spendFetch","spendCsv","limitsDialog","closeLimits","openLimits",{"statement":"addEventListener('keydown',ev"},"spOpenCard",{"statement":"addEventListener('live:status',()=>{if(l"},{"statement":"addEventListener('pagehide',()=>{c"},{"statement":"addEventListener('pageshow',event=>{if(event.persisted)S"},{"statement":"document.addEventListener('click',async event=>{const t"},{"statement":"document.addEventListener('keydown',event=>{if(["},{"statement":"document.addEventListener('ch"},{"statement":"document.addEventListener('keydown',event=>{if(!"},{"statement":"if(PAGE==='spend')docume"},{"statement":"hooks.push(limitsDraw);"},{"statement":"if(PAGE==='spend'){\n    "}],
 live_hEvent_to_hEvent: ["hEvent"],
 live_TEAM_KINDS_to_proposalCard: ["TEAM_KINDS","TEAM_KIND_LABELS","TEAM_MODE_LABELS","proposalCurrent","proposalKindKey","proposalSeatKind","proposalValid","proposalsNotify","proposalMember","proposalStateText","proposalRow","openTeamChat","createTeamRole","proposalCard"],
 live_SWARM_to_if: ["SWARM","swarmRoot","swCount","swNumber","swRecord","swarmValid","swarmCurrent","swarmReset","swState","swName","swDate","swMock","swEmpty","swarmSummary","swarmDraw","swarmClose","swarmShow","swarmSheet","swarmFetch","swarmRefresh","swarmSync",{"statement":"if(PAGE==='swarm'&&!docu"}],
 live_TRACE_to_window: ["TRACE","traceUUID","traceBinding","traceSame","tracePost","traceFailures","traceWindowFailure",{"statement":"addEventListener('error'"},{"statement":"addEventListener('unhand"},{"statement":"addEventListener('live:status',()=>{if(!"},"traceAction","traceCapture","traceRequest","traceReply","traceControls","traceSelectLabel","traceSelectAction","traceMark",{"statement":"traceMark();"},{"statement":"if(typeof MutationObserv"},{"statement":"addEventListener('click'"},{"statement":"addEventListener('submit"},{"statement":"addEventListener('change"},{"statement":"addEventListener('keydown',e=>{i"},{"statement":"addEventListener('popsta"},{"statement":"addEventListener('pagehide',()=>{t"},{"statement":"addEventListener('pageshow',e="},{"statement":"window.HARNESS_TRACE={ac"}],
 live_TRACE_VIEW_to_if: ["TRACE_VIEW","tracePanel","tracePanelMount","tracePanelDraw","tracePanelFetch","tracePanelReset",{"statement":"if(['events','log'].incl"}],
 live_guidanceState_to_chatGuidanceDraw: ["guidanceState","guidanceKey","orchestratorOfferForced","chatGuidanceDraw"],
 live_ckBox_to_ckBox: ["ckBox"],
 live_SEL_to_document: ["SEL","plain","selStart","restoreTransferFocus","selChars","selUpdate","selBar",{"statement":"document.addEventListener('focusi"},{"statement":"document.addEventListener('focuso"},{"statement":"document.addEventListener('p"},{"statement":"document.addEventListener('i"},{"statement":"addEventListener('live:status',()=>{if(S"},{"statement":"addEventListener('pagehide',()=>{S"},{"statement":"document.addEventListener('click',async e=>{const c"}],
 live_closeLAMenus_to_laMulti: ["closeLAMenus","dismissLAMenu","laMenu","projectPathValue","laPath","noteHandoff","laMulti"],
 live_document_to_document: [{"statement":"document.addEventListener('click',async e=>{ const l"}],
 live_statNumber_to_messageUsage: ["statNumber","messageUsage"],
 live_finish_to_updateTurn: ["finish","transferHTML","toolErrorEntry","updateTurn"],
 live_isDirect_to_ask: ["isDirect","ask"],
 live_promotionBusy_to_promoteConversation: ["promotionBusy","promoteConversation"],
 live_reply_to_onSend: ["reply","ATTACHMENT_LIMIT","attachmentRef","attachmentKey","attachmentStore","attachmentRefs","attachmentSet","attachmentRestore","attachmentPendingRefs","attachmentLocal","attachmentPane","attachmentModelSupports","attachmentFailure","attachmentState","attachmentPreview","attachmentDraw","attachmentsDraw","attachmentChanged","attachmentError","attachmentBytes64","attachmentUpload","attachmentFiles","attachmentRemove","pickImages","composerState",{"statement":"document.addEventListener('click',event=>{const r"},"renumberQuotes","onSend"],
 live_FIRST_to_if: ["FIRST","firstRoot","FIRST_MODELS","firstMode","firstSupport","firstModels","firstSelected","firstPrograms","firstCatalog","firstModelsSync","firstModelCards","firstCheckLogin","firstOperationCurrent","firstBeginOperation","firstRequestOperation","firstCancelOperation","firstSelectPane","firstGo","firstDraw","firstChatMissing","firstRestart","firstFailure","firstSimpleChat","firstBack","firstNext","firstSend",{"statement":"if(PAGE==='first'){\n    "}],
 live_fmtN_to_document_2: ["fmtN","statNumber","messageUsage","turnStatsOpen","turnStatsKey","statMoney","statValue","turnStatsButton","turnStatsCard",{"statement":"document.addEventListener('click',async e=>{const bu"},"timePart","fullMessageTime","messageTime","messageTimeHTML","updateMessageTimes",{"statement":"if(typeof setInterval==="},"actsLine","ckBox","bubble","selectionElement","messageSelection","messageSelectionText","quoteBlock","nextQuoteNumber","insertQuote","quoteButton","clearQuoteButton","quoteSource","selectionForText","transferSelection","positionQuoteButton","drawQuoteButton",{"statement":"document.addEventListener('s"},{"statement":"document.addEventListener('m"},{"statement":"document.addEventListener('keyu"},{"statement":"addEventListener('pagehide',c"},{"statement":"if(window.harnessy&&typeof window.harnessy.onQ"},{"statement":"if(window.harnessy&&typeof window.harnessy.onT"},"cols","scrollEnd","markupNode","nodeKind","patchNode","feedSnapshot","positionFeedJump","feedJump","feedRestore","transferDisclosureSnapshot","transferDisclosureRestore","guidanceState","guidanceKey","orchestratorOfferForced","chatGuidanceDraw","showOrchestratorOffer",{"statement":"document.addEventListener('click',async event=>{const m"},"render",{"statement":"document.addEventListener('click',e=>{ if(e.target.closest('a"},"attachmentDialog","closeAttachmentDialog",{"statement":"document.addEventListener('click',e=>{if(e.target.closest('[data-a"}],
 live_api_to_document: ["api","captureProjectOperation","projectOperationCurrent","networkCodes","connectionTitle","networkLink","networkCause","exitName","networkPath","networkWarning","networkMenu","networkWaiting","warningSeen","warningEvent","consumeState","waitingControls","showWaiting","unsentJoin","renderWaiting","showRestore","attemptRequests",{"statement":"document.addEventListener('click',async e=>{ const b"}],
 live_transferHTML_to_hEvent: ["transferHTML","toolErrorEntry","updateTurn","hEvent"],
 live_finish_to_finish: ["finish"],
 live_failedTurnHTML_to_failedTurnHTML: ["failedTurnHTML"],
 live_loadAttemptNotes_to_recoverStoppedTurn: ["loadAttemptNotes","loadChat","beginActiveRecovery","recoverActiveTurns","recoverStoppedTurn"],
 live_NOW_to_addEventListener: ["NOW","nowCurrent","nowAttemptDisabled","nowDate","nowAge","nowReset","nowWaitingValid","nowValid","nowFetch","nowItems","nowButton","nowDraw","nowOpen","nowLive",{"statement":"if(PAGE==='now'){\n    ad"},{"statement":"document.addEventListener('click',async e=>{\n"},"suspendPage","resumePage",{"statement":"addEventListener('pageshow',event=>{if(event.persisted)r"}],
 live_openChatRow_to_openChatRow: ["openChatRow"],
 live_document_to_document_2: [{"statement":"document.addEventListener('click',async e=>{ const t"}],
 live_refreshStatus_to_refreshStatus: ["refreshStatus"],
 live_finish_to_hEvent: ["finish","transferHTML","toolErrorEntry","updateTurn","hEvent"],
 live_markupNode_to_feedRestore: ["markupNode","nodeKind","patchNode","feedSnapshot","positionFeedJump","feedJump","feedRestore","transferDisclosureSnapshot","transferDisclosureRestore"],
 live_render_to_render: ["render"],
 proto_if_to_renderWorkspaceHeader: [{"statement":"if(!document.documentEle"},"FILE","PAGES","TIP","TOP","PATH_FILES","PLAN_TABS","planTab","planPage","SKETCH","KEY",{"statement":"document.documentElement.dataset.pa"},{"statement":"if(KEY==='plan'||KEY==='"},"SPEC","specificationLabels",{"statement":"specificationLabels();"},"PS2_MODE_KEY","ps2Mode",{"statement":"try{const saved=localSto"},{"statement":"document.documentElement.dataset.ps2M"},{"statement":"document.documentElement.dataset.ps2P"},"frames","cur","box","mobile","mode","fit","show","XI","ico",{"statement":"window.psIcon=ico;"},{"statement":"window.psKey=KEY;"},"html","state","inboxCounts",{"statement":"globalThis.HARNESS_INBOX"},"projectName","tag","currentProject","count","noun","roleCount","chatCount","projectItems","projectMenu","projectRow","chatRow","CURRENT_FOLD_KEY","currentClosed",{"statement":"try{const rows=JSON.parse(localStorage.getItem(C"},"currentProjectFolder","toggleCurrentProject","inboxRow","limits","profileMenu","profile","rail","newChat","others","roomGroup","chatPanel","projectPanel","inboxPanel","teamPanel","panelBody","modePanel","expandedPanel","projectFlyout","closeProjectMenu","positionProjectMenu","showProjectMenu","scheduleProjectClose",{"statement":"document.addEventListener('mouseov"},{"statement":"document.addEventListener('mouseou"},{"statement":"document.addEventListener('s"},"FOLDER_KEY","projectFolders",{"statement":"try{const rows=JSON.parse(localStorage.getItem(F"},"toggleProject","renderMobileProjects","projectChats","renderSide","widePanel",{"statement":"addEventListener('resize"},"togglePanel","setMode","setData","topProjectMenu","renderWorkspaceHeader",{"statement":"window.PS2={state,setDat"},{"statement":"document.addEventListener('click',e=>{const mo"},{"statement":"document.addEventListener('keydown',e=>{c"},{"statement":"document.addEventListener('click',e=>{const me"},{"statement":"document.addEventListener('click',e=>{i"},{"statement":"addEventListener('keydow"},{"statement":"document.addEventListener('d"},"keyboardActions","keyboardControls",{"statement":"keyboardControls();"},{"statement":"if(typeof MutationObserv"},{"statement":"document.addEventListener('keydown',e=>{i"},{"statement":"renderSide();"},{"statement":"renderWorkspaceHeader();"}],
 ctx_fmt_to_trackCardFocus: ["fmt","pct","windowKnown","distributionKnown","ago","SH","instance","current","capture","refresh","paint","matrix","tip","list","contextParts","readFacts","html","trackCardFocus"],
 live_warningSeen_to_consumeState: ["warningSeen","warningEvent","consumeState"],
 live_ask_to_autopilotDraw: ["ask","rememberLive","SECTION_PAGES","PS","sectionCurrent","sectionText","sectionValid","SECTION_LAYOUT","sectionDate","sectionItems","sectionMock","sectionMissing","sectionBody","sectionItemBinding","sectionClose","sectionKind","sectionCount","sectionRow","sectionFooter","sectionDraw","sectionOpenItem","sectionFetch","sectionSync","sectionChanging","sectionConversation","sectionRequest",{"statement":"if(SECTION_PAGES[PAGE]){"},"ownerProfile","profileDraw","autopilotText","autopilotDraw"],
 live_composer_to_document: ["composer",{"statement":"document.addEventListener('click',e=>{ if(e.target.closest('["}],
 live_stop_to_stop: ["stop"],
 live_curHTML_to_updateTurn: ["curHTML","turnPhase","phaseHTML","elapsed","toolWord","toolCount","toolGroup","turnContent","captureLiveGroups","restoreLiveGroup","footerUpdate","askHTML","phaseTimer","drawLive","failedTurnHTML","finish","transferHTML","toolErrorEntry","updateTurn"],
 live_fmtN_to_actsLine: ["fmtN","statNumber","messageUsage","turnStatsOpen","turnStatsKey","statMoney","statValue","turnStatsButton","turnStatsCard",{"statement":"document.addEventListener('click',async e=>{const bu"},"timePart","fullMessageTime","messageTime","messageTimeHTML","updateMessageTimes",{"statement":"if(typeof setInterval==="},"actsLine"],
 live_bubble_to_if: ["bubble","selectionElement","messageSelection","messageSelectionText","quoteBlock","nextQuoteNumber","insertQuote","quoteButton","clearQuoteButton","quoteSource","selectionForText","transferSelection","positionQuoteButton","drawQuoteButton",{"statement":"document.addEventListener('s"},{"statement":"document.addEventListener('m"},{"statement":"document.addEventListener('keyu"},{"statement":"addEventListener('pagehide',c"},{"statement":"if(window.harnessy&&typeof window.harnessy.onQ"},{"statement":"if(window.harnessy&&typeof window.harnessy.onT"}],
 cx_setSeat_to_setSeat: ["setSeat"],
 live_JR_to_document: ["JR","resetJournal","journalBefore","journalRange","kindCls","who","jtime","jdate","jrow","journalDraw","journalFetch","journalLive","jcard",{"statement":"document.addEventListener('click',async e=>{ i"}],
 live_PROJECT_FOLD_KEY_to_pinJobs: ["PROJECT_FOLD_KEY","projectExpanded","projectFolder","toggleProjectFolder","sideGeneration","pinJobs"],
 live_document_to_document_3: [{"statement":"document.addEventListener('click',e=>{ const d"}],
 live_waitingControls_to_waitingControls: ["waitingControls"],
 live_waitList_to_badges: ["waitList","badges"],
 live_selectionElement_to_if: ["selectionElement","messageSelection","messageSelectionText","quoteBlock","nextQuoteNumber","insertQuote","quoteButton","clearQuoteButton","quoteSource","selectionForText","transferSelection","positionQuoteButton","drawQuoteButton",{"statement":"document.addEventListener('s"},{"statement":"document.addEventListener('m"},{"statement":"document.addEventListener('keyu"},{"statement":"addEventListener('pagehide',c"},{"statement":"if(window.harnessy&&typeof window.harnessy.onQ"},{"statement":"if(window.harnessy&&typeof window.harnessy.onT"}],
 cx_allModels_to_chip: ["allModels","modelLabel","modelProviderNames","displayModel","currentModelSave","chip"],
 cx_render_to_render: ["render"],
 live_hConnect_to_hConnect_2: [{"statement":"hConnect().finally(async"}],
 proto_document_to_document: [{"statement":"document.addEventListener('click',e=>{const me"}],
 live_S_to_save: ["S","load","save"],
 live_PROJECT_FOLD_KEY_to_sideChats: ["PROJECT_FOLD_KEY","projectExpanded","projectFolder","toggleProjectFolder","sideGeneration","pinJobs","sideChats"],
 live_restoreLiveSnapshot_to_liveFirstPaint: ["restoreLiveSnapshot","liveFirstPaint"],
 live_paneName_to_hStatus: ["paneName","pickPane","modelName","hStatus"],
 live_LOADED_to_recoverStoppedTurn: ["LOADED","ONB",{"statement":"document.addEventListener('click',event=>{i"},{"statement":"addEventListener('pagehide',()=>{i"},"onboardOnce","loadAttemptNotes","loadChat","beginActiveRecovery","recoverActiveTurns","recoverStoppedTurn"],
 live_SCREENS_to_reset: ["SCREENS","pal","palList","openPal","closePal",{"statement":"addEventListener('keydown',e=>{ if(("},"searchWired","wireSearch","reset"],
 live_snapshot_boot: ["restoreLiveSnapshot","liveFirstPaint","EV","eventFeed","eventsReset","eventsValid","eventsDraw","eventsCurrent","eventsFetch","eventsRefresh","eventsSync",{"statement":"if(PAGE==='events'){\n   "},"TRACE_VIEW","tracePanel","tracePanelMount","tracePanelDraw","tracePanelFetch","tracePanelReset",{"statement":"if(['events','log'].incl"},"JR","resetJournal","journalBefore","journalRange","kindCls","who","jtime","jdate","jrow","journalDraw","journalFetch","journalLive","jcard",{"statement":"document.addEventListener('click',async e=>{ i"},"NOW","nowCurrent","nowAttemptDisabled","nowDate","nowAge","nowReset","nowWaitingValid","nowValid","nowFetch","nowItems","nowButton","nowDraw","nowOpen","nowLive",{"statement":"if(PAGE==='now'){\n    ad"},{"statement":"document.addEventListener('click',async e=>{\n"},"suspendPage","resumePage",{"statement":"addEventListener('pageshow',event=>{if(event.persisted)r"},{"statement":"window.LIVE={connect:hCo"},"TP","KN","knowledgeDraw","knowledgeSet","knowledgeFetch","knowledgeReset","knowledgeOpen",{"statement":"document.addEventListener('click',e=>{if(e.target.closest('[data-k"},{"statement":"addEventListener('pagehide',k"},"TEAM_KINDS","TEAM_KIND_LABELS","TEAM_MODE_LABELS","proposalCurrent","proposalKindKey","proposalSeatKind","proposalValid","proposalsNotify","proposalMember","proposalStateText","proposalRow","openTeamChat","createTeamRole","proposalCard","proposalsDraw","proposalsReset","pendingProposalLink","proposalLinkCurrent","clearProposalLink","readProposalLink","applyProposalLink","proposalsFetch","proposalsSync","showTeamProposal","requestTeamProposal","confirmProposal","closeProposalKinds","proposalKindLayoutChanged",{"statement":"addEventListener('resize',p"},{"statement":"addEventListener('scroll"},{"statement":"document.addEventListener('click',e=>{c"},{"statement":"document.addEventListener('keydown',e="},{"statement":"document.addEventListener('click',async e=>{const t"},{"statement":"addEventListener('pagehide',p"},{"statement":"composer();"},{"statement":"restoreUI();"},{"statement":"wireSearch();"},{"statement":"refresh();"},{"statement":"restoreLiveSnapshot();"},{"statement":"sideChats();"},{"statement":"if(PAGE==='chat'&&S.ui.s"},{"statement":"hConnect().finally(async"},{"statement":"addEventListener('resize',()=>{ w"},{"statement":"addEventListener('storag"}],
} as const;
