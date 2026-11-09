import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import type {TestContext} from 'node:test';
import {CliProvider} from './provider.ts';
import {type TurnEvent,type ToolTrace,type TurnHandle} from '../types.ts';
import type {CliDescriptor,CliContext,CliSeat,CliEvent} from './types.ts';

export type Scenario='probe'|'ok'|'logged-out'|'bad-auth'|'denied'|'crash'|'hang'|'truncated'|'bad-json'|'mismatch'|'secret'|'late-failure';
const program=String.raw`
import {readFileSync,appendFileSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1],scenario=process.env.CLI_SCENARIO;
const log=data=>appendFileSync(process.env.CLI_CAPTURE,JSON.stringify(data)+'\n');
log({action:args[0],args,tokenInEnv:!!process.env.PANE_TOKEN,apiKeyInEnv:!!process.env.TEST_API_KEY,proxy:process.env.HTTPS_PROXY,electronEnv:Object.keys(process.env).filter(key=>key.startsWith('ELECTRON_')).sort()});
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(args[0]==='version')console.log('test-cli 1.0');
else if(args[0]==='auth'){if(scenario==='bad-auth')console.log('bad');else output({loggedIn:scenario!=='logged-out',email:'fixture@example.test',secret:'should-not-return'})}
else if(args[0]==='models')output([{id:'test-model',label:'Fixture model'}]);
else if(args[0]==='limits')output({ok:true,plan:'test',windows:[{label:'week',percentUsed:30,resetsAt:2000000000,windowMinutes:10080}],fetchedAt:1900000000,source:'fixture CLI'});
else if(args[0]==='sessions')output([{id:'session-1',title:'fixture',updated:1}]);
else if(args[0]==='history')output([{role:'ai',text:'fixture answer'}]);
else if(args[0]==='turn'){
 let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw),path=get('--mcp-config'),server=JSON.parse(readFileSync(path,'utf8')).mcpServers.panes;
 const acl=process.platform==='win32'?await import(process.env.TEST_ACL_MODULE):null;
 const privateAcl=acl?acl.assertPrivateDirectory(dirname(path)).isDirectory()&&acl.assertPrivateFile(path).isFile():null;
 log({configPath:path,mode:statSync(path).mode&511,directoryMode:statSync(dirname(path)).mode&511,privateAcl,input,serverCommand:server.command,serverArgs:server.args,tokenPresent:!!server.env.PANE_TOKEN,runAsNode:server.env.ELECTRON_RUN_AS_NODE??null});
 const format=get('--format'),emit=e=>{if(format==='stream-json')output(e)};
 if(scenario==='hang'){setInterval(()=>{},1000)}else if(scenario==='denied'){console.error('fixture permission denied');process.exitCode=23}
 else if(scenario==='crash'){console.error('fixture crash');process.exitCode=7}
 else if(scenario==='bad-json')console.log('not JSON');
 else if(scenario==='truncated'){emit({type:'delta',text:'partial'})}
 else {
 const events=[],push=e=>{events.push(e);emit(e)},sid=scenario==='mismatch'?'wrong-session':args.includes('--resume')?get('--resume'):'session-1';push({type:'session',id:sid});
 if(scenario!=='probe'){push({type:'tool.call',id:'call-1',name:'panes.send',input:{to:'reviewer',kind:'status',text:'fixture'}});
 const result=await new Promise((resolve,reject)=>{const p=spawn(server.command,server.args,{env:{...process.env,...server.env},stdio:['pipe','pipe','pipe']});let out='';p.stdout.on('data',b=>out+=b);p.on('error',reject);p.on('close',code=>{if(code!==0)return reject(Error('bridge failed'));resolve(JSON.parse(out.trim()).result)});p.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send',arguments:{to:'reviewer',kind:'status',text:'fixture'}}})+'\n')});
 if(result.isError)throw Error(JSON.stringify(result));push({type:'tool.result',id:'call-1',outcome:'ok',output:result});}
 const answer=scenario==='secret'?server.env.PANE_TOKEN:'fixture answer';
 if(scenario==='secret'){push({type:'delta',text:answer.slice(0,20)});push({type:'delta',text:answer.slice(20)})}else push({type:'delta',text:answer});
 push({type:'done',text:answer,sessionId:sid,usage:{input:10,output:2,cacheRead:3}});
 if(format==='json')output(events);else if(format==='text')process.stdout.write(answer);
 if(scenario==='late-failure')process.exitCode=7;
 }
}else process.exitCode=9;
`;
export async function cliFixture(t:TestContext,scenario:Scenario='ok',format:'json'|'stream-json'|'text'='stream-json'){
 const dir=mkdtempSync(join(tmpdir(),'harnessy-cli-test-')),file=join(dir,'fake.mjs'),capture=join(dir,'capture.ndjson');writeFileSync(file,program);writeFileSync(capture,'');
 const requests:{token:string|undefined;body:unknown}[]=[],tokens=new Set<string>(),registered:string[]=[],revoked:string[]=[],events:TurnEvent[]=[],traces:ToolTrace[]=[],sessions:string[]=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const token=req.headers['x-pane-token'] as string|undefined;requests.push({token,body:JSON.parse(raw)});res.writeHead(token&&tokens.has(token)?200:403,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:!!token&&tokens.has(token),seq:1,to:['reviewer']}))});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const command=(action:string)=>({args:[file,action]}),parse=(r:{stdout:string})=>JSON.parse(r.stdout);
 const description:CliDescriptor={id:'test-cli',name:'Fixture CLI',binary:process.execPath,login:command('login'),version:{command:command('version'),parse:r=>r.stdout.trim()},auth:{command:command('auth'),parse},models:{command:command('models'),parse},forbiddenEnv:['TEST_API_KEY'],
 modes:{read:()=>['--sandbox','read-only'],edit:i=>['--sandbox','workspace-write','--roots',JSON.stringify(i.writableRoots)],all:()=>['--sandbox','all']},
 turn:{format,command:i=>({args:[file,'turn','--format',format,'--model',i.seat.model],input:JSON.stringify({message:i.message,role:i.roleNote})}),decode:v=>Array.isArray(v)?v as CliEvent[]:[v as CliEvent]},resume:id=>['--resume',id],
 mcp:{serialize:panes=>JSON.stringify({mcpServers:{panes}}),args:path=>['--mcp-config',path],env:()=>({ELECTRON_RUN_AS_NODE:'forged',ELECTRON_ENABLE_LOGGING:'1'})},limits:{command:command('limits'),parse},sessions:{list:()=>({command:command('sessions'),parse}),messages:()=>({command:command('history'),parse})},failure:r=>({code:r.code===23?'permission_denied':'transport_lost',text:r.stderr||'CLI failed'})};
 const env={...process.env,CLI_SCENARIO:scenario,CLI_CAPTURE:capture,TEST_ACL_MODULE:new URL('../../../team/src/private-path.ts',import.meta.url).href,TEST_API_KEY:'fake-api-secret',PANE_TOKEN:'foreign-parent-token'};
 const provider=new CliProvider(description,{env,cwd:dir,temporaryDirectory:dir,probeTimeoutMs:5000,turnTimeoutMs:5000}),controller=new AbortController();let handle:TurnHandle|null=null,starts=0,started!:()=>void;const startedPromise=new Promise<void>(r=>{started=r});
 const seat:CliSeat={id:'worker',vendor:description.id,label:'Worker',model:'test-model',mode:'read',cwd:dir,sessionId:null,writePaths:[],worktree:null};
 const ctx:CliContext={signal:controller.signal,env:{HTTPS_PROXY:'http://fixture.invalid:1234'},roleNote:'fixture role',peers:[{id:'worker',label:'Worker',vendor:'test-cli'},{id:'reviewer',label:'Review',vendor:'codex'}],relayDepth:0,projectDir:dir,appUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port,writableRoots:[join(dir,'allowed')],publish:e=>events.push(e),traceEvent:e=>traces.push(e),askApproval:async()=>false,session:id=>sessions.push(id),modelStarted(){starts++;started()},setHandle:h=>{handle=h},registerProcessToken(token){registered.push(token);tokens.add(token)},revokeProcessToken(token){revoked.push(token);tokens.delete(token)},tools:{send:async()=>({ok:true,text:'unused'}),ask:async()=>({ok:true,text:'unused'}),readPane:async()=>({ok:true,text:'unused'}),merge:async()=>({ok:true,text:'unused'}),assignRole:async()=>({ok:true,text:'unused'}),proposeSeats:async()=>({ok:true,text:'unused'}),createSeats:async()=>({ok:true,text:'unused'})}};
 t.after(async()=>{await provider.close();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})});
 return {provider,description,env,dir,seat,ctx,controller,events,traces,sessions,requests,registered,revoked,started:startedPromise,get handle(){return handle},get starts(){return starts},capture:()=>readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,any>)};
}
