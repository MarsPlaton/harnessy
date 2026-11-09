import {ApiAgent} from '../../runtime/src/api-agent.ts';
import {createLlmService} from '../../llm/src/service.ts';
import type {TestContext} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type ServerResponse} from 'node:http';
import {OllamaProvider,ollamaEntry,OLLAMA_URL,type OllamaOptions} from './ollama.ts';
import {executeCli} from './cli/process.ts';
export function ollamaAnswer(res:ServerResponse,content:string|{name:string;arguments:unknown},id='call-fixture'){
 res.writeHead(200,{'Content-Type':'text/event-stream'});const event=(delta:any,finish:any=null,usage?:any)=>res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})+'\n\n');event({role:'assistant'});if(typeof content==='string')event({content},'stop');else event({tool_calls:[{index:0,id,type:'function',function:{name:content.name,arguments:JSON.stringify(content.arguments)}}]},'tool_calls');event({},null,{prompt_tokens:12,completion_tokens:4,total_tokens:16,prompt_tokens_details:{cached_tokens:2}});res.end('data: [DONE]\n\n');
}
export async function ollamaFixture(t:TestContext){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'harnessy-ollama-'))),binary=join(dir,'ollama.cjs');let offline=false,tags:unknown={models:[{name:'glm-5.3:cloud',remote_model:'glm-5.3'},{name:'gemma4:latest'}]};const requests:string[]=[],turns:any[]=[],network:{url:string;headers:Record<string,string>}[]=[],commands:any[]=[];const pulls:string[]=[];let cloudReads=0;let respond=(res:ServerResponse,_body:any)=>ollamaAnswer(res,'готов');
 const server=createServer(async(req,res)=>{try{requests.push(req.url??'');let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):null;if(req.url==='/api/pull'){pulls.push(body.model);res.writeHead(500);res.end('unexpected pull');return}if(offline){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'SECRET-SERVER-BODY'}));return}if(req.url==='/v1/chat/completions'){turns.push(body);respond(res,body);return}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/api/version'?{version:'0.40.2'}:tags))}catch{res.destroy()}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
 writeFileSync(binary,'#!'+process.execPath+'\n'+`if(JSON.stringify(process.argv.slice(2))!=='["--version"]')process.exit(90);console.log('ollama version is 0.40.2');`,{mode:0o700});
 const fixedFetch:typeof fetch=(url,init)=>{const target=String(url);if(target==='https://ollama.com/api/tags'){cloudReads++;return Promise.resolve(new Response('unexpected cloud request',{status:503}))}if(!target.startsWith(OLLAMA_URL+'/api/')&&!target.startsWith(OLLAMA_URL+'/v1/'))throw Error('unexpected daemon address');network.push({url:target,headers:Object.fromEntries(new Headers(init?.headers).entries())});return fetch(target.replace(OLLAMA_URL,'http://127.0.0.1:'+port),init)};
 const options:OllamaOptions={binary,env:{PATH:process.env.PATH,OLLAMA_API_KEY:'SECRET-API-KEY',OPENAI_API_KEY:'SECRET-OPENAI-KEY',OLLAMA_HOST:'https://must-not-use.invalid'},cwd:dir,temporaryDirectory:dir,execute:(request,signal,hooks)=>{commands.push(request);if(request.binary!==binary||JSON.stringify(request.args)!=='["--version"]')throw Error('unexpected native agent');return executeCli(request,signal,hooks)},fetch:fixedFetch},entry=ollamaEntry(options);
 t.after(async()=>{await entry.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})});
 return {dir,entry,options,requests,network,commands,fetch:fixedFetch,pulls,get cloudReads(){return cloudReads},setOffline(v:boolean){offline=v},setTags(v:unknown){tags=v},setRespond(fn:typeof respond){respond=fn},capture:()=>turns};
}

export function ollamaTurnProvider(metadata:OllamaProvider,fetcher:typeof fetch){return new ApiAgent('ollama',{vendor:'ollama',prepareModel:(model,signal)=>metadata.prepareModel(model,signal),service:async signal=>{const models=await metadata.models(signal);return createLlmService({routes:()=>({ollama:{api:'openai-completions',baseURL:OLLAMA_URL+'/v1',models:models.map(m=>({id:m.id,name:m.label})),retryPolicy:{mode:'normal',maxRetries:0}}}),resolveKey:async()=>null,fetch:fetcher})}})}
