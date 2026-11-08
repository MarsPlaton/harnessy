import {cpSync,existsSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..');
const compiled=join(here,'.engine-compiled');
const engine=join(here,'engine');
const skipInstall=process.argv.includes('--skip-install');
const readJson=file=>JSON.parse(readFileSync(file,'utf8'));
const writeJson=(file,value)=>writeFileSync(file,JSON.stringify(value,null,2)+'\n');

function run(command,args,options={}){
  const result=spawnSync(command,args,{cwd:options.cwd??here,env:{...process.env,...options.env},stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(command+' завершился с кодом '+result.status);
}

function prune(directory){
  if(!existsSync(directory))return;
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const target=join(directory,entry.name),lower=entry.name.toLowerCase();
    if(entry.isDirectory()){
      if(['test','tests','__tests__','fixtures','test-fixtures','examples'].includes(lower)){rmSync(target,{recursive:true,force:true});continue}
      prune(target);continue;
    }
    if(entry.isFile()&&(/\.(?:ts|tsx|map)$/i.test(entry.name)||/\.(?:test|spec)\.(?:js|cjs|mjs)$/i.test(entry.name)))rmSync(target,{force:true});
  }
}

function unsafeFiles(directory,out=[]){
  if(!existsSync(directory))return out;
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    const target=join(directory,entry.name);
    if(entry.isDirectory())unsafeFiles(target,out);
    else if(entry.isFile()&&(/\.(?:ts|tsx)$/i.test(entry.name)||/\.(?:test|spec)\.(?:js|cjs|mjs)$/i.test(entry.name)))out.push(relative(engine,target));
  }
  return out;
}

rmSync(compiled,{recursive:true,force:true});
rmSync(engine,{recursive:true,force:true});
const tsc=[join(here,'node_modules/typescript/bin/tsc'),join(root,'node_modules/typescript/bin/tsc')].find(existsSync);
if(!tsc)throw new Error('TypeScript не установлен: выполните npm install в корне или ui/desktop');
run(process.execPath,[tsc,'-p',join(here,'tsconfig.engine.json')],{cwd:root});

mkdirSync(engine,{recursive:true});
for(const name of ['package.json','package-lock.json'])cpSync(join(here,'runtime',name),join(engine,name));
if(!skipInstall){
  const npmCli=process.platform==='win32'?process.env.npm_execpath:null;
  if(process.platform==='win32'&&!npmCli)throw new Error('Windows engine build requires npm execpath');
  run(npmCli?process.execPath:'npm',[...(npmCli?[npmCli]:[]),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:engine});
}
mkdirSync(join(engine,'node_modules','@harnessy'),{recursive:true});

const packages=readdirSync(join(root,'packages'),{withFileTypes:true}).filter(entry=>entry.isDirectory()&&existsSync(join(root,'packages',entry.name,'package.json'))).map(entry=>entry.name).sort();
for(const name of packages){
  const source=join(compiled,'packages',name),target=join(engine,'node_modules','@harnessy',name);
  if(!existsSync(source))throw new Error('не собран пакет '+name);
  mkdirSync(target,{recursive:true});
  cpSync(source,join(target,'dist'),{recursive:true});
  if(name==='team')cpSync(join(root,'packages','team','templates'),join(target,'dist','templates'),{recursive:true});
  const manifest=readJson(join(root,'packages',name,'package.json'));
  manifest.exports='./dist/src/index.js';
  if(manifest.bin)for(const [key,value] of Object.entries(manifest.bin))manifest.bin[key]='./dist/'+String(value).replace(/^\.\//,'').replace(/\.ts$/,'.js');
  delete manifest.scripts;delete manifest.devDependencies;
  writeJson(join(target,'package.json'),manifest);
}

prune(join(engine,'node_modules'));
const unsafe=unsafeFiles(engine);
if(unsafe.length)throw new Error('в runtime-бандл попали исходники или тесты:\n'+unsafe.slice(0,20).join('\n'));
const runtime=readJson(join(here,'runtime','package.json'));
writeJson(join(engine,'manifest.json'),{version:readJson(join(here,'package.json')).version,entry:'node_modules/@harnessy/api/dist/bin/harnessy.js',packages,dependencies:runtime.dependencies});
rmSync(compiled,{recursive:true,force:true});
console.log('движок собран: '+packages.length+' пакетов · '+Object.keys(runtime.dependencies).length+' внешних зависимостей');
