import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateSync,gzipSync} from 'node:zlib';

import {testSite,copyTestSite} from './site-test-helpers.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const guard=join(root,'ui/deploy/forbidden_guard.py');
const markers=join(root,'ui/deploy/forbidden-strings.txt');
const require=createRequire(import.meta.url);
const afterPack=require(join(root,'ui/desktop/after-pack.cjs')) as (context:{appOutDir:string;electronPlatformName?:string;packager:{appInfo:{productFilename:string}}})=>Promise<void>;
const runGuard=(path:string)=>process.platform==='win32'?spawnSync('py',['-3','-X','utf8',guard,path],{cwd:root,encoding:'utf8'}):spawnSync('python3',[guard,path],{cwd:root,encoding:'utf8'});
const crc32=(data:Buffer)=>{let crc=0xffffffff;for(const value of data){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return (crc^0xffffffff)>>>0};
const pngChunk=(kind:string,body:Buffer)=>{const name=Buffer.from(kind),out=Buffer.alloc(body.length+12);out.writeUInt32BE(body.length);name.copy(out,4);body.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([name,body])),out.length-4);return out};
const pngText=(kind:'zTXt'|'iTXt',text:string)=>{const ihdr=Buffer.from('00000001000000010806000000','hex'),packed=deflateSync(Buffer.from(text)),metadata=kind==='zTXt'?Buffer.concat([Buffer.from('Comment\0\0'),packed]):Buffer.concat([Buffer.from('Comment\0'),Buffer.from([1,0,0,0]),packed]);return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',ihdr),pngChunk(kind,metadata),pngChunk('IDAT',deflateSync(Buffer.from([0,0,0,0,255]))),pngChunk('IEND',Buffer.alloc(0))])};
const align4=(size:number)=>(size+3)&~3;
const pickle=(payload:Buffer)=>{const size=align4(payload.length),out=Buffer.alloc(4+size);out.writeUInt32LE(size);payload.copy(out,4);return out};
const asar=(files:Record<string,Buffer>)=>{let offset=0;const body:Buffer[]=[],entries:Record<string,{size:number;offset:string}>={};for(const [name,data] of Object.entries(files)){entries[name]={size:data.length,offset:String(offset)};body.push(data);offset+=data.length}const json=Buffer.from(JSON.stringify({files:entries})),headerPayload=Buffer.alloc(4+align4(json.length));headerPayload.writeInt32LE(json.length);json.copy(headerPayload,4);const header=pickle(headerPayload),size=Buffer.alloc(4);size.writeUInt32LE(header.length);return Buffer.concat([pickle(size),header,...body])};

test('TS-32: one marker list rejects owner data, absolute project roots and credential-shaped values with the file name',t=>{
 const dir=mkdtempSync(join(tmpdir(),'harnessy-ts32-guard-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(join(dir,'nested'));
 writeFileSync(join(dir,'masked.txt'),'you@example.com\nsk-…8f2a\n~/Harnessy-Projects\n');assert.equal(runGuard(dir).status,0);
 const cases:ReadonlyArray<readonly [string,string]>=[['profile.html','9616166@gmail.com'],['home.txt','/Users/tester/Harnessy-Projects/demo'],['windows-home.txt','C:\\Users\\Test Owner\\Harnessy-Projects\\private'],['windows-json.txt',JSON.stringify({project:'C:\\Users\\Test Owner\\Harnessy-Projects\\private'})],['token.js','const access_token="sk-live-0123456789abcdefghijklmnop"']];
 for(const [name,value] of cases){
  const path=join(dir,'nested',name);writeFileSync(path,value);const blocked=runGuard(dir);assert.equal(blocked.status,1,name);assert.match(blocked.stderr.replaceAll('\\','/'),new RegExp('nested/'+name.replace('.','\\.')));assert.doesNotMatch(blocked.stderr,/9616166|sk-live-0123456789/);rmSync(path);
 }
 const list=readFileSync(markers,'utf8');assert.match(list,/literal:kostenchuksergey/);assert.match(list,/PRIVATE KEY/);
});

test('TS-32: build.py and electron-builder afterPack use the same guard; bundled Resources are checked',async t=>{
 const build=readFileSync(join(root,'ui/deploy/build.py'),'utf8'),builder=readFileSync(join(root,'ui/desktop/electron-builder.yml'),'utf8');assert.match(build,/from forbidden_guard import assert_clean/);assert.match(build,/assert_clean\(\[OUT\]\)/);assert.match(builder,/afterPack: \.\/after-pack\.cjs/);
 const out=mkdtempSync(join(tmpdir(),'harnessy-ts32-pack-')),resources=join(out,'Harnessy-alpha.app','Contents','Resources');t.after(()=>rmSync(out,{recursive:true,force:true}));mkdirSync(resources,{recursive:true});writeFileSync(join(resources,'main.js'),'clean fixture');
 await afterPack({appOutDir:out,packager:{appInfo:{productFilename:'Harnessy-alpha'}}});writeFileSync(join(resources,'engine.js'),'github_pat_0123456789abcdefghijklmnop');await assert.rejects(afterPack({appOutDir:out,packager:{appInfo:{productFilename:'Harnessy-alpha'}}}),/engine\.js/);
});

test('Windows afterPack checks the actual resources directory and rejects embedded secrets',async t=>{
 const out=mkdtempSync(join(tmpdir(),'harnessy-win-pack-')),resources=join(out,'resources');t.after(()=>rmSync(out,{recursive:true,force:true}));mkdirSync(resources);
 const context={appOutDir:out,electronPlatformName:'win32',packager:{appInfo:{productFilename:'Harnessy-alpha'}}};
 writeFileSync(join(resources,'main.js'),'clean fixture');await afterPack(context);
 writeFileSync(join(resources,'main.js'),'C:\\Users\\Test Owner\\Harnessy-Projects\\private');await assert.rejects(afterPack(context),/main\.js/);
 writeFileSync(join(resources,'main.js'),'github_pat_0123456789abcdefghijklmnop');await assert.rejects(afterPack(context),/main\.js/);
});

test('TS-32 r2: guard opens names, PNG text, UTF-16, gzip in ASAR and refuses unknown or oversized containers',{timeout:30000},t=>{
 const dir=mkdtempSync(join(tmpdir(),'harnessy-ts32-containers-')),nested=join(dir,'nested'),marker='kostenchuksergey';t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(nested);
 const blocked=(name:string,data:Buffer,reason:RegExp=/маркер/)=>{const path=join(nested,name);writeFileSync(path,data);const result=runGuard(dir);rmSync(path);assert.equal(result.status,1,name);assert.match(result.stderr.replaceAll('\\','/'),new RegExp('nested/'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),name);assert.match(result.stderr,reason,name)};
 blocked(marker+'.txt',Buffer.from('clean'));
 blocked('compressed-z.png',pngText('zTXt',marker));
 blocked('compressed-i.png',pngText('iTXt',marker));
 blocked('little.bin',Buffer.from(marker,'utf16le'));
 const bigEndian=Buffer.from(marker,'utf16le');for(let index=0;index<bigEndian.length;index+=2){const first=bigEndian[index]!;bigEndian[index]=bigEndian[index+1]!;bigEndian[index+1]=first}blocked('big.bin',bigEndian);
 const unicodePath='"project" = "/Users/Иван/Harnessy-Projects/demo";';
 blocked('unicode-le.strings',Buffer.from(unicodePath,'utf16le'));
 blocked('unicode-be.strings',Buffer.from(unicodePath,'utf16le').swap16());
 blocked('unicode-le-bom.strings',Buffer.from('\uFEFF'+unicodePath,'utf16le'));
 blocked('unicode-be-bom.strings',Buffer.from('\uFEFF'+unicodePath,'utf16le').swap16());
 const secret='sk-review-0123456789abcdefghijklmnop';
 blocked('surrogate-trail-le.strings',Buffer.from(secret+'\uDC00','utf16le'));
 blocked('surrogate-trail-be.strings',Buffer.from(secret+'\uDC00','utf16le').swap16());
 blocked('surrogate-lead-le.strings',Buffer.from('\uD800'+secret,'utf16le'));
 blocked('surrogate-lead-be.strings',Buffer.from('\uD800'+secret,'utf16le').swap16());
 blocked('app.asar',asar({'profile.gz':gzipSync(Buffer.from(marker))}));
 blocked('bomb.gz',gzipSync(Buffer.alloc(16*1024*1024+1,65)),/предел/);
 blocked('unknown.zip',Buffer.from('PK\x03\x04clean'),/неизвестный тип контейнера/);
});

test('TS-32: profile specifications are neutral and generated site passes its guard',{timeout:20000},()=>{
 const files=['01-chat.html','06-settings.html','10-new-chat.html','11-connections.html','27-limits-widget.html'].map(name=>join(root,'ui/sketches/disarto',name));
 for(const file of files){const text=readFileSync(file,'utf8');assert.doesNotMatch(text,/9616166@gmail\.com|kostenchuksergey|>Serge</,file);assert.match(text,/Владелец|you@example\.com/,file)}
 const design=readFileSync(join(root,'ui/sketches/disarto/00-design-code.html'),'utf8');assert.match(design,/профиль · учётная запись движка/);assert.match(design,/Без подтверждённой учётной записи строка почты не рисуется/);
 assert.equal(runGuard(testSite()).status,0);
});


test('TS-45.1: damaging a private site copy cannot contaminate the shared guarded build',t=>{
 const clean=testSite(),copy=copyTestSite();t.after(copy.close);
 assert.notEqual(copy.site,clean);
 const relative='sketches/proto/01-chat.html',original=readFileSync(join(clean,relative));
 writeFileSync(join(copy.site,relative),'kostenchuksergey');
 const blocked=runGuard(copy.site);assert.equal(blocked.status,1);assert.match(blocked.stderr,/01-chat\.html/);
 assert.deepEqual(readFileSync(join(clean,relative)),original);
 assert.equal(runGuard(clean).status,0);
});
