import test from 'node:test';
import assert from 'node:assert/strict';
import {createContext,runInContext} from 'node:vm';
import {fixtureAssignment,fixtureSource,fixtureWrapper} from './live-fixture.ts';

test('TS-52: named declarations survive reordering and execute in the original VM context',()=>{
 const one="(function(){const seed=2; function answer(){return nested()+seed} function nested(){return 40}})();";
 const two="(function(){function nested(){return 40} const seed=2; function answer(){return nested()+seed}})();";
 for(const source of [one,two]){
  const context=createContext({});
  runInContext(fixtureSource(source,['seed','answer','nested'])+'\nglobalThis.answer=answer();',context);
  assert.equal(context.answer,42);
 }
});

test('TS-52: syntax-aware extraction handles regex, nested templates and multi-variable statements',()=>{
 const source='(function(){const a=/[{};]/.test(";"), b=`x${(()=>{return `y${1}`})()}`; function read(){return [a,b]} })();';
 const extracted=fixtureSource(source,['a','b','read']);
 const context=createContext({});runInContext(extracted+'\nglobalThis.value=read();',context);
 assert.deepEqual(Array.from(context.value),[true,'xy1']);
 assert.equal((extracted.match(/const a=/g)||[]).length,1);
});

test('TS-52: comments and nested impostors do not satisfy missing declarations',()=>{
 const source='(function(){/* function phantom(){} */ const text="function phantom(){}"; function outer(){function phantom(){} return phantom} })();';
 assert.throws(()=>fixtureSource(source,['phantom'],{filename:'live.js'}),/phantom.*не найдена.*live\.js/);
 assert.throws(()=>fixtureSource(source,['text','absent'],{filename:'cx.js'}),/absent.*не найдена.*cx\.js/);
});

test('TS-52: ambiguous declarations fail instead of picking the wrong scope',()=>{
 const source='(function(){const item=1})(); (function(){const item=2})();';
 assert.throws(()=>fixtureSource(source,['item']),/item.*неоднознач/);
});

test('TS-52: standalone event statements can be selected without surrounding neighbours',()=>{
 const source="(function(){function item(){return 7} document.addEventListener('click',()=>item()); document.addEventListener('keyup',()=>item())})();";
 const handlers:string[]=[];const context=createContext({document:{addEventListener:(name:string)=>handlers.push(name)}});
 runInContext(fixtureSource(source,['item',{statement:"document.addEventListener('click'"}]),context);
 assert.deepEqual(handlers,['click']);
 assert.throws(()=>fixtureSource(source,[{statement:'document.addEventListener('}]),/неоднознач/);
 assert.throws(()=>fixtureSource(source,[{statement:'document.addEventListener("missing"'}]),/не найдена/);
});

test('TS-52: a multiline statement is found after Windows CRLF checkout',()=>{
 const source="(function(){\r\nif(PAGE==='spend'){\r\n    globalThis.ready=true\r\n}})();";
 const extracted=fixtureSource(source,[{statement:"if(PAGE==='spend'){\n    "}]);
 const context=createContext({PAGE:'spend'});runInContext(extracted,context);
 assert.equal(context.ready,true);
});

test('TS-52: scoped blocks extract only the requested local declarations',()=>{
 const source="(function(){function outer(){const item=0; if(enabled){const item=4; const read=()=>item} if(other){const item=9}}})();";
 const context=createContext({});
 runInContext(fixtureSource(source,['item','read'],{scope:'outer',block:'if(enabled)'})+'globalThis.value=read();',context);
 assert.equal(context.value,4);
 assert.throws(()=>fixtureSource(source,['item'],{scope:'outer',block:'if(missing)'}),/Блок.*не найден/);
 assert.throws(()=>fixtureSource(source,['item'],{scope:'outer',block:'if('}),/Блок.*неоднозначен/);
 assert.throws(()=>fixtureSource(source,['item'],{scope:'missing'}),/Область.*не найдена/);
});

test('TS-52.1: nested event handlers select their block by condition, not source formatting',()=>{
 const block={identifier:'PAGE',equals:'chat'};
 for(const source of ["(function(){function connect(){if(PAGE==='chat'||PAGE==='first'){es.onopen=()=>42} if(PAGE==='new'){es.onopen=()=>0}}})();", "(function(){function connect(){if ( 'chat' === PAGE || PAGE === 'first' ) { es.onopen=()=>42 }}})();"]){
  const context=createContext({es:{}});runInContext(fixtureSource(source,[{statement:'es.onopen='}],{scope:'connect',block}),context);
  assert.equal((context.es as {onopen:()=>number}).onopen(),42);
 }
 const absent="(function(){function connect(){if(PAGE==='new'){es.onopen=()=>0}}})();";
 assert.throws(()=>fixtureSource(absent,[{statement:'es.onopen='}],{scope:'connect',block}),/Блок PAGE === "chat" не найден/);
 const duplicate="(function(){function connect(){if(PAGE==='chat'){es.onopen=()=>1} if(PAGE==='chat'){es.onopen=()=>2}}})();";
 assert.throws(()=>fixtureSource(duplicate,[{statement:'es.onopen='}],{scope:'connect',block}),/Блок PAGE === "chat" неоднозначен/);
});

test('TS-52: boot fixture extracts a complete selected IIFE and rejects an absent wrapper',()=>{
 const source='(function(){globalThis.boot=1})(); (function(){globalThis.boot=2})();';
 const context=createContext({});runInContext(fixtureWrapper(source,1,'proto.js'),context);
 assert.equal(context.boot,2);
 assert.throws(()=>fixtureWrapper(source,2,'proto.js'),/Обёртка 2 не найдена в proto\.js/);
});

test('TS-52 r2: conditionals are chosen by AST and declaration, not indentation or neighbours',()=>{
 const select={conditional:{identifier:'PAGE',equals:'doc',declaration:'apply'}};
 const first="(function(){ if (ready && PAGE === 'doc') { function apply(){return 7} } if(PAGE==='doc'){const version=1} })();";
 const reordered="(function(){\n    if(PAGE==='doc'){const version=1}\n    if(ready && 'doc' === PAGE){function apply(){return 7}} })();";
 for(const source of [first,reordered]){
  const context=createContext({PAGE:'doc',ready:true});
  runInContext(fixtureSource(source,[select]).replace('function apply(){return 7}','function apply(){return 7} globalThis.value=apply();'),context);
  assert.equal(context.value,7);
 }
 assert.throws(()=>fixtureSource(first,[{conditional:{...select.conditional,declaration:'absent'}}],{filename:'live.js'}),/PAGE === "doc" \/ absent.*не найдена.*live\.js/);
 const duplicate="(function(){if(PAGE==='doc'){function apply(){}} if(PAGE==='doc'){function apply(){}}})();";
 assert.throws(()=>fixtureSource(duplicate,[select]),/неоднозначна/);
});

test('TS-52 r2: global assignment is extracted as a whole and must be unique',()=>{
 const source='window.other=0; window.HX = (function(){ return {value:42}; })();';
 const context=createContext({window:{}});runInContext(fixtureAssignment(source,'window.HX','app.js'),context);
 assert.equal((context.window as {HX:{value:number}}).HX.value,42);
 assert.throws(()=>fixtureAssignment(source,'window.absent','app.js'),/window\.absent.*не найдено.*app\.js/);
 assert.throws(()=>fixtureAssignment("container['other'].window.HX={};",'window.HX'),/window\.HX.*не найдено/);
 assert.throws(()=>fixtureAssignment(source+'\nwindow.HX={};','window.HX'),/неоднозначно/);
});
