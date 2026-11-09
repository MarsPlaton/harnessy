import {execFileSync} from 'node:child_process';
import {lstatSync,realpathSync,type Stats} from 'node:fs';
import {resolve} from 'node:path';

const sidPattern=/^S-1-\d+(?:-\d+)+$/;
const allowedSystemSids=new Set(['S-1-5-18','S-1-5-32-544']);
const fullControl=2032127;
type Rule={sid:string;type:string;rights:number;inherited:boolean};
type Descriptor={current:string;owner:string;protected:boolean;rules:Rule[]};
const inspectScript=`$ErrorActionPreference='Stop';$p=$env:HARNESSY_ACL_PATH;$a=Get-Acl -LiteralPath $p;$s=[System.Security.Principal.SecurityIdentifier];$r=@($a.GetAccessRules($true,$true,$s)|ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights;inherited=$_.IsInherited} });@{current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;owner=$a.GetOwner($s).Value;protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Compress -Depth 5`;
function descriptor(path:string):Descriptor {
 const {PSModulePath:_ignored,...env}=process.env;
 const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',inspectScript],{
  env:{...env,HARNESSY_ACL_PATH:path},encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024
 });
 const value=JSON.parse(output) as Descriptor;
 if(!value||!sidPattern.test(value.current)||!sidPattern.test(value.owner)||typeof value.protected!=='boolean'||!Array.isArray(value.rules)||value.rules.some(r=>!r||!sidPattern.test(r.sid)||!['Allow','Deny'].includes(r.type)||!Number.isInteger(r.rights)||typeof r.inherited!=='boolean'))throw Error('invalid Windows security descriptor');
 return value;
}
export function validatePrivateAcl(value:Descriptor,requireProtected:boolean):void {
 if(value.owner!==value.current||requireProtected&&!value.protected||value.rules.some(r=>r.type==='Allow'&&r.sid!==value.current&&!allowedSystemSids.has(r.sid))||!value.rules.some(r=>r.type==='Allow'&&r.sid===value.current&&(r.rights&fullControl)===fullControl))throw Error('unsafe Windows permissions');
}
function privateDescriptor(path:string,requireProtected:boolean):void {validatePrivateAcl(descriptor(path),requireProtected)}
function plain(path:string,file:boolean):Stats {
 const stat=lstatSync(path);
 if(stat.isSymbolicLink()||(file?!stat.isFile():!stat.isDirectory())||process.platform==='win32'&&realpathSync(path)!==resolve(path))throw Error('unsafe private path');
 return stat;
}
export function assertPrivateDirectory(path:string):Stats {
 const before=plain(path,false);
 if(process.platform==='win32')privateDescriptor(path,true);
 else if(typeof process.getuid!=='function'||before.uid!==process.getuid()||(before.mode&0o077)!==0)throw Error('unsafe POSIX permissions');
 const after=plain(path,false);
 if(before.dev!==after.dev||before.ino!==after.ino)throw Error('private path changed');
 return after;
}
export function assertPrivateFile(path:string):Stats {
 const before=plain(path,true);
 if(process.platform==='win32')privateDescriptor(path,false);
 else if(typeof process.getuid!=='function'||before.uid!==process.getuid()||(before.mode&0o077)!==0)throw Error('unsafe POSIX permissions');
 const after=plain(path,true);
 if(before.dev!==after.dev||before.ino!==after.ino)throw Error('private path changed');
 return after;
}
/** Harden an empty/generated directory before writing private data into it. */
export function hardenPrivateDirectory(path:string):Stats {
 const before=plain(path,false);
 if(process.platform==='win32'){
  const current=descriptor(path).current;
  execFileSync('icacls.exe',[path,'/inheritance:r','/grant:r',`*${current}:(OI)(CI)F`],{windowsHide:true,timeout:10000,maxBuffer:1024*1024});
 }
 const after=assertPrivateDirectory(path);
 if(before.dev!==after.dev||before.ino!==after.ino)throw Error('private path changed');
 return after;
}
