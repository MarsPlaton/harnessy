import {hasPublicSecret} from '@harnessy/providers';
import {createHash,randomUUID} from 'node:crypto';
import {realpathSync,statSync} from 'node:fs';
import {isIP} from 'node:net';
import {homedir} from 'node:os';
import {resolve,relative,isAbsolute,join,sep} from 'node:path';
import {validRoute,validGeneration} from '@harnessy/llm';
import {object} from './files.ts';
import {ProjectError} from './errors.ts';
import {trustedSshDirectory} from './ssh-directory.ts';
export interface NetworkPrice {monthlyUsd?:number;perGbUsd?:number}
export type NetworkExit={id:string;label:string;expectedIp?:string;price?:NetworkPrice}&(
 {type:'direct'}|{type:'proxy';url:string;login?:string;passwordRef?:string;passwordGeneration?:string}|
 {type:'ssh';host:string;port:number;user:string;keyPath:string});
export type NetworkPolicy={mode:'fallback';silenceSeconds:number}|{mode:'rotation';rotationMinutes:number;silenceSeconds:number};
export const defaultNetworkPolicy:NetworkPolicy={mode:'fallback',silenceSeconds:60};
export function validateNetworkPolicy(raw:unknown):NetworkPolicy {
 networkFields(raw,['mode','rotationMinutes','silenceSeconds']);
 if(!Number.isInteger(raw.silenceSeconds)||Number(raw.silenceSeconds)<1||Number(raw.silenceSeconds)>3600)networkInvalid('Молчание: от 1 до 3600 секунд');
 if(raw.mode==='rotation'){if(!Number.isInteger(raw.rotationMinutes)||Number(raw.rotationMinutes)<1||Number(raw.rotationMinutes)>1440)networkInvalid('Ротация: от 1 до 1440 минут')}
 else if(raw.mode!=='fallback'||raw.rotationMinutes!==undefined)networkInvalid('Режим: основной + резервы или ротация');
 return structuredClone(raw) as NetworkPolicy;
}
export const chainRevision=(config:NetworkConfig,id:string)=>networkRevision(config.policies?.[id]?[config.chains[id],config.policies[id]]:config.chains[id]);
export interface NetworkConfig {generations?:Record<string,string>;legacyLabelsVersion?:1;policies?:Record<string,NetworkPolicy>;exits:Record<string,NetworkExit>;chains:Record<string,string[]>;migrated:boolean}
export const networkRevision=(value:unknown)=>value===undefined?null:createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Persist a new provider generation on every relevant edit, including A → B → A.
const providerNetwork=(c:NetworkConfig,id:string)=>[c.chains[id],c.policies?.[id]??defaultNetworkPolicy,...(c.chains[id]??[]).map(exit=>c.exits[exit])];
export const networkGeneration=(c:NetworkConfig,id:string)=>networkRevision([c.generations?.[id]??null,providerNetwork(c,id)])!;
export function advanceNetworkGenerations(before:NetworkConfig,next:NetworkConfig):void {
 const generations={...before.generations};
 for(const id of new Set([...Object.keys(before.chains),...Object.keys(next.chains)]))if(networkRevision(providerNetwork(before,id))!==networkRevision(providerNetwork(next,id)))generations[id]=randomUUID();
 if(Object.keys(generations).length)next.generations=generations;else delete next.generations;
}
export function networkInvalid(message='Некорректные настройки выхода'):never{throw new ProjectError('network_invalid',message)}
export function networkFields(raw:unknown,keys:string[]):asserts raw is Record<string,unknown>{if(!object(raw)||Object.keys(raw).some(k=>!keys.includes(k)))networkInvalid()}
const text=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\p{C}]/u.test(v);
export function validProviderId(id:unknown):id is string{return typeof id==='string'&&(id.startsWith('api:')?validRoute(id.slice(4)):validRoute(id))}
// Save-time check only: missing/moved keys must not make existing settings unreadable.
// The tunnel must repeat this check before opening a key (TS-22b).
export function validateSshKey(exit:NetworkExit){
 if(exit.type!=='ssh')return;
 try{
  const home=homedir(),{path:base}=trustedSshDirectory(home),expected=join(realpathSync(home),'.ssh');
  const path=realpathSync(exit.keyPath.startsWith('~/.ssh/')?join(home,exit.keyPath.slice(2)):exit.keyPath),rel=relative(base,path);
  if(base!==expected||!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!statSync(path).isFile())throw Error();
 }catch{throw new ProjectError('ssh_key_invalid','SSH: нужен существующий файл ключа внутри ~/.ssh; ссылка наружу недопустима')}
}
export function validateExit(raw:unknown):NetworkExit {
 if(!object(raw))networkInvalid();if(raw.type==='iface')throw new ProjectError('iface_unsupported','Интерфейс не маршрутизирует трафик, выберите прокси или SSH',409);
 if(!validRoute(raw.id)||!text(raw.label,120)||hasPublicSecret(String(raw.label))||raw.expectedIp!==undefined&&(typeof raw.expectedIp!=='string'||!isIP(raw.expectedIp)))networkInvalid();
 const common=['id','label','expectedIp','price'];
 if(raw.price!==undefined){networkFields(raw.price,['monthlyUsd','perGbUsd']);if(!Object.keys(raw.price).length||Object.values(raw.price).some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>Number.MAX_SAFE_INTEGER))networkInvalid('Цена выхода: неотрицательное число в долларах; пустое поле — цена не задана')}

 if(raw.type==='direct')networkFields(raw,[...common,'type']);
 else if(raw.type==='proxy'){
  networkFields(raw,[...common,'type','url','login','passwordRef','passwordGeneration']);
  if(!text(raw.url,2048)||raw.login!==undefined&&!text(raw.login,256))networkInvalid();
  let url:URL;try{url=new URL(raw.url as string)}catch{networkInvalid('Прокси: нужен адрес http, https или socks5h')}
  if(!['http:','https:','socks5h:'].includes(url!.protocol)||!url!.hostname||url!.username||url!.password||url!.search||url!.hash||!['','/'].includes(url!.pathname)||/\s/.test(raw.url as string))networkInvalid('Прокси: адрес без логина, пароля, пути и параметров; протокол http, https или socks5h');
  if(raw.passwordRef!==undefined&&(raw.passwordRef!==raw.id||!validGeneration(raw.passwordGeneration))||raw.passwordGeneration!==undefined&&raw.passwordRef===undefined)networkInvalid('Ссылка пароля не соответствует выходу');
 }else if(raw.type==='ssh'){
  networkFields(raw,[...common,'type','host','port','user','keyPath']);
  if(typeof raw.host!=='string'||!(isIP(raw.host)||/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(raw.host))||!Number.isInteger(raw.port)||Number(raw.port)<1||Number(raw.port)>65535||typeof raw.user!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(raw.user))networkInvalid('SSH: нужны host, port (1–65535) и user');
  if(!text(raw.keyPath,1024))networkInvalid('SSH: нужен путь к ключу внутри ~/.ssh');
  const value=raw.keyPath as string,base=join(homedir(),'.ssh'),path=value.startsWith('~/.ssh/')?join(homedir(),value.slice(2)):value,rel=relative(base,resolve(path));
  if(!isAbsolute(path)||!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||path.split('/').includes('..'))networkInvalid('SSH: нужен путь к ключу внутри ~/.ssh');
 }else networkInvalid('Тип выхода: direct, proxy или ssh');
 return structuredClone(raw) as NetworkExit;
}
export function validateNetwork(raw:unknown):NetworkConfig {
 if(raw===undefined)return {exits:{},chains:{},migrated:false};
 networkFields(raw,['exits','chains','migrated','policies','legacyLabelsVersion','generations']);if(raw.legacyLabelsVersion!==undefined&&raw.legacyLabelsVersion!==1)networkInvalid('Неизвестная версия переноса подписей выходов');if(!object(raw.exits)||!object(raw.chains)||typeof raw.migrated!=='boolean'||Object.keys(raw.exits).length>256||Object.keys(raw.chains).length>512)networkInvalid();
 const exits:Record<string,NetworkExit>={},chains:Record<string,string[]>={};
 for(const [id,value] of Object.entries(raw.exits)){const exit=validateExit(value);if(id!==exit.id)networkInvalid();exits[id]=exit}
 for(const [id,value] of Object.entries(raw.chains)){if(!validProviderId(id)||!Array.isArray(value)||value.length>32||value.some(x=>typeof x!=='string'||!Object.hasOwn(exits,x))||new Set(value).size!==value.length)networkInvalid('Цепочка содержит неизвестный или повторный выход');chains[id]=[...value]}
 const policies:Record<string,NetworkPolicy>={};if(raw.policies!==undefined){if(!object(raw.policies))networkInvalid();for(const [id,value]of Object.entries(raw.policies)){if(!Object.hasOwn(chains,id))networkInvalid();policies[id]=validateNetworkPolicy(value)}}
 const generations:Record<string,string>={};if(raw.generations!==undefined){if(!object(raw.generations))networkInvalid();for(const [id,value]of Object.entries(raw.generations)){if(!validProviderId(id)||!validGeneration(value))networkInvalid('Некорректное поколение настроек подключения');generations[id]=value as string}}
 return {...(Object.keys(generations).length?{generations}:{}),exits,chains,migrated:raw.migrated,...(raw.legacyLabelsVersion===1?{legacyLabelsVersion:1 as const}:{}),...(Object.keys(policies).length?{policies}:{})};
}
