import {buildTestSite} from '../../api/src/site-test-helpers.ts';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdtempSync,readFileSync,readdirSync,readlinkSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

export const OWNER_FILE_ENV=['HARNESS_PROJECTS_FILE','HARNESS_LAST_PROJECT_FILE','HARNESS_PINS_FILE','HARNESS_SETTINGS_FILE','HARNESS_CONNECTIONS_FILE'] as const;
export function testOwnerEnvironment(directory:string):Record<(typeof OWNER_FILE_ENV)[number],string>{
 return Object.fromEntries(OWNER_FILE_ENV.map(key=>[key,join(directory,key.toLowerCase())])) as Record<(typeof OWNER_FILE_ENV)[number],string>;
}
// Read metadata and hashes only; never restore or rewrite the owner's files.
export function ownerFilesSnapshot(home=homedir()):Map<string,string>{
 const result=new Map<string,string>();
 function visit(name:string){const path=join(home,name),stat=lstatSync(path,{bigint:true}),type=stat.isFile()?'file':stat.isDirectory()?'directory':stat.isSymbolicLink()?'symlink':'other';
  const content=stat.isFile()?createHash('sha256').update(readFileSync(path)).digest('hex'):stat.isSymbolicLink()?readlinkSync(path):'';
  result.set(name.split(sep).join('/'),JSON.stringify([type,String(stat.mode),String(stat.mtimeNs),String(stat.ctimeNs),content]));
  if(stat.isDirectory())for(const child of readdirSync(path).sort())visit(join(name,child));
 }
 for(const name of readdirSync(home).filter(name=>name.startsWith('.harness-')).sort())visit(name);
 return result;
}
export function checkOwnerFiles(run:()=>number,options:{home?:string;mode?:string;report?:(message:string)=>void}={}):number{
 const report=options.report??((message:string)=>process.stderr.write(message+'\n'));let before:Map<string,string>|null=null;
 try{before=ownerFilesSnapshot(options.home)}catch(e){report('HARNESS_OWNER_FILES_CHECK: снимок не прочитан: '+String(e))}
 let code=1;try{code=run()}catch(e){report(String(e))}
 let after:Map<string,string>|null=null;try{after=ownerFilesSnapshot(options.home)}catch(e){report('HARNESS_OWNER_FILES_CHECK: итоговый снимок не прочитан: '+String(e))}
 const changed=before&&after?[...new Set([...before.keys(),...after.keys()])].filter(name=>before!.get(name)!==after!.get(name)).sort():[];
 if(changed.length)report('HARNESS_OWNER_FILES_CHECK: изменились '+changed.join(', '));
 else if(before&&after)report('HARNESS_OWNER_FILES_CHECK: файлы владельца не изменились');
 return code||((!before||!after||changed.length)&&(options.mode??process.env.HARNESS_OWNER_FILES_CHECK)!=='warn'?1:0);
}
const ownFile=fileURLToPath(import.meta.url),main=process.argv[1]&&resolve(process.argv[1])===ownFile;
if(process.platform==='win32'&&!process.env.HARNESSY_TEST_ELECTRON){
 const electron=fileURLToPath(new URL('../../../ui/desktop/node_modules/electron/dist/electron.exe',import.meta.url));
 if(existsSync(electron))process.env.HARNESSY_TEST_ELECTRON=electron;
}
if(main&&process.argv[2]==='run'){
 // One full run, with isolation installed before test modules load in each worker.
 process.exitCode=checkOwnerFiles(()=>{
  const npmCli=process.platform==='win32'?process.env.npm_execpath:null;
  if(process.platform==='win32'&&!npmCli)throw Error('Windows test runner requires npm execpath');
  const build=spawnSync(npmCli?process.execPath:'npm',[...(npmCli?[npmCli]:[]),'run','build'],{stdio:'inherit'});if(build.error)throw build.error;if(build.status!==0)return build.status??1;
  process.env.HARNESSY_TEST_SITE=buildTestSite();
  const tests=spawnSync(process.execPath,['--import',pathToFileURL(ownFile).href,'--test',...(process.platform==='win32'?['--test-concurrency=4','--test-timeout=120000']:[]),'packages/*/src/**/*.test.ts'],{stdio:'inherit'});if(tests.error)throw tests.error;return tests.status??1;
 });
}else{
 const directory=mkdtempSync(join(tmpdir(),'harnessy-test-owner-'));
 Object.assign(process.env,testOwnerEnvironment(directory));
 process.on('exit',()=>rmSync(directory,{recursive:true,force:true}));
}
