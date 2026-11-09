import {readFileSync,realpathSync} from 'node:fs';
import {join,relative,isAbsolute,sep} from 'node:path';
import {parseCompat} from '@harnessy/journal';
import {object} from './files.ts';
import type {ProjectInfo,ProjectChat} from './types.ts';

// Only metadata from a registered project's own state; no session ids or transcript bodies.
export function projectChats(path:string):Pick<ProjectInfo,'chats'|'chatError'>{
 try{
  const root=realpathSync(path),file=realpathSync(join(root,'.harness/state/chats.json')),rel=relative(root,file);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('state outside project');
  const raw=parseCompat(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(file)));
  if(!object(raw)||!object(raw.chats))throw Error('invalid chats');
  const chats:ProjectChat[]=[];
  for(const [id,c] of Object.entries(raw.chats)){
   if(!object(c)||c.id!==id||typeof c.pane!=='string'||!c.pane||typeof c.title!=='string'||typeof c.created!=='number'||!Number.isFinite(c.created))throw Error('invalid chat');
   chats.push({id,pane:c.pane,title:c.title,created:c.created});
  }
  return {chats:chats.sort((a,b)=>b.created-a.created),chatError:null};
 }catch(e){return (e as NodeJS.ErrnoException).code==='ENOENT'?{chats:[],chatError:null}:{chats:null,chatError:'Не удалось прочитать чаты проекта'}}
}
