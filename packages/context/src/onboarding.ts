import {basename,join} from 'node:path';
import {memorySections} from './memory.ts';
import {trim,limited,slice,capitalize} from './strings.ts';
import type {SeatView,OnboardingDeps} from './types.ts';
export function onboarding(seat:SeatView,how:string,deps:OnboardingDeps):string{
 const proj=basename(deps.projectDir.replace(/\/+$/,''))||deps.projectDir,d=deps.now,pad=(v:number,n=2)=>String(v).padStart(n,'0'),when=pad(d.getDate())+'.'+pad(d.getMonth()+1)+'.'+pad(d.getFullYear(),4)+' '+pad(d.getHours())+':'+pad(d.getMinutes());
 const mem=memorySections(deps.memoryText),none='в памяти проекта пока не записано — уточни у владельца'+((seat.kind===undefined?seat.role:seat.kind)==='orchestrator'?'':' или оркестратора'),label=(mode:string)=>Object.hasOwn(deps.modeLabels,mode)?deps.modeLabels[mode]!:mode;
 const out=['Ты назначен(а) ролью «'+seat.label+'» в проекте «'+proj+'». Когда и кем: владелец, '+when+', '+how+'.'];
 out.push('Где: папка '+deps.projectDir+(deps.repoRoot&&deps.team?', git, интеграционная ветка '+deps.team.integrationBranch:', без git')+'. Память проекта: '+join(deps.projectDir,'.harness','MEMORY.md')+' (цель, решения, уроки, риски — читай; дополняется через оркестратора). Файл обмена ролей: '+join(deps.projectDir,'.harness','state','channel.ndjson')+' — записи «кто → кому · вид · текст».');
 const instr=trim(deps.instructionText);out.push(instr?'Что делаешь (инструкции роли):\n'+limited(instr,1500,'\n…(полный текст — в .harness/roles)'):'Инструкций роли в папке пока нет — действуй по общим правилам роли и по командам владельца или оркестратора.');
 out.push('Зачем (цель проекта): '+(mem.get('цель')||none)+'.','Что ожидаем: '+(mem.get('что ожидаем')||none)+'.','Критерии успеха: '+(mem.get('критерии успеха')||none)+'. Критерии провала: '+(mem.get('критерии провала')||none)+'.','Риски: '+(mem.get('риски')||none)+'.');
 const rest=[...mem].filter(([k,v])=>v&&!['цель','что ожидаем','критерии успеха','критерии провала','риски'].includes(k)).map(([k,v])=>capitalize(k)+':\n'+v).join('\n\n');if(rest)out.push('Остальное из памяти проекта:\n'+limited(rest,2500,'\n…(полный текст — в .harness/MEMORY.md)'));
 out.push('Артефакты клади в artifacts/ проекта и ссылайся на них относительным путём; таблицы — Markdown.');
 out.push('Твоя модель: '+seat.model+'; права: '+label(seat.mode)+'.');
 const peers=deps.peers.filter(p=>p.id!==seat.id&&p.id!=='room').map(p=>p.label+' · '+p.model+' · '+label(p.mode)+((p.kind===undefined?p.role:p.kind)==='orchestrator'?' — ведёт обмен и говорит с владельцем':''));
 out.push('Кто уже в команде проекта: '+(peers.length?peers.join('; '):'пока никого — ты первая роль')+'.');
 const summary=trim(deps.policySummary??'');if(summary)out.push('С кем и как взаимодействуешь (политика обмена):\n'+summary);
 const recent=deps.records.filter(r=>r.origin!=='onboarding').slice(-8);out.push(recent.length?'Что сейчас в журнале (последние записи):\n'+recent.map(r=>'№'+r.seq+' '+r.from+' → '+r.to.join(', ')+' · '+r.kind+': '+slice(trim(r.text),0,160)).join('\n'):'Журнал обмена пока пуст.');
 out.push((seat.kind===undefined?seat.role:seat.kind)==='orchestrator'?'Ответь владельцу коротко: ты оркестратор и ведёшь команду проекта «'+proj+'»; что развёрнуто (команда — кто есть, память проекта, '+(deps.repoRoot?'git, ':'')+'журнал обмена); что готов(а) начать — и спроси: чем будем заниматься?':'Прочитай и ответь одной-двумя фразами: кто ты и что готов(а) делать. Задач пока нет — жди команду.');
 return out.join('\n\n')
}

export function promotionIntro(project:string,conversation:string,documents:readonly {project:string;path:string}[]):string {
 return ['Ты — оркестратор команды этого проекта. Продолжай уже начатый разговор с владельцем; предметная область определяется обсуждением, а не разработкой кода по умолчанию.',
 'Папка проекта: '+project+'. Память проекта: '+join(project,'.harness','MEMORY.md')+'. Сформулируй собственную предметную вводную и предложи подходящие роли; не спрашивай заново, чем будем заниматься.',
 'Накопленный разговор:\n'+(conversation||'Разговор пока пуст; работай по первому поручению.'),
 'Документы — ссылки на исходные файлы, без копирования:\n'+(documents.map(d=>join(d.project,d.path)).join('\n')||'Документы не приложены.'),
 'Артефакты клади в artifacts/ проекта и ссылайся на них относительным путём; таблицы — Markdown.',
 'Следующая запись в этой пачке — первое поручение владельца. Ответь на него с учётом разговора.'].join('\n\n');
}
