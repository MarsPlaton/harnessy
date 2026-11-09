import {execFileSync} from 'node:child_process';
import {lstatSync,type Stats} from 'node:fs';
import {dirname,isAbsolute,join,parse,sep} from 'node:path';

const sidPattern=/^S-1-\d+(?:-\d+)+$/;
const allowedSystemSids=new Set(['S-1-5-18','S-1-5-32-544']);
const fullControl=2032127;
type Rule={sid:string;type:string;rights:number;inherited:boolean};
type Descriptor={current:string;owner:string;admin:boolean;protected:boolean;rules:Rule[]};
const describeScript=`$s=[System.Security.Principal.SecurityIdentifier];$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();$admin=[System.Security.Principal.WindowsPrincipal]::new($identity).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);$r=@($a.GetAccessRules($true,$true,$s)|ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights;inherited=$_.IsInherited} });@{current=$identity.User.Value;owner=$a.GetOwner($s).Value;admin=$admin;protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Compress -Depth 5`;
const inspectScript=`$ErrorActionPreference='Stop';$p=$env:HARNESSY_ACL_PATH;$a=Get-Acl -LiteralPath $p;${describeScript}`;
const hardenScript=`$ErrorActionPreference='Stop';$p=$env:HARNESSY_ACL_PATH;$owner=Get-Acl -LiteralPath $p;$s=[System.Security.Principal.SecurityIdentifier];$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();$current=$identity.User;$admin=[System.Security.Principal.WindowsPrincipal]::new($identity).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator);$ownerSid=$owner.GetOwner($s).Value;if($ownerSid -ne $current.Value -and -not ($ownerSid -eq 'S-1-5-32-544' -and $admin)){throw 'unsafe Windows owner'};$a=[System.IO.Directory]::GetAccessControl($p,[System.Security.AccessControl.AccessControlSections]::Access);$a.SetAccessRuleProtection($true,$false);foreach($rule in @($a.GetAccessRules($true,$false,$s))){$a.RemoveAccessRuleSpecific($rule)};$grant=New-Object System.Security.AccessControl.FileSystemAccessRule($current,'FullControl',[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]'None',[System.Security.AccessControl.AccessControlType]'Allow');$a.AddAccessRule($grant);[System.IO.Directory]::SetAccessControl($p,$a);$a=Get-Acl -LiteralPath $p;${describeScript}`;
function descriptor(path:string,script=inspectScript):Descriptor {
 const env={...process.env};
 for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
 const windowsModules=join(process.env.WINDIR??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules');
 const powershell=join(process.env.WINDIR??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const output=execFileSync(powershell,['-NoProfile','-NonInteractive','-Command',script],{
  env:{...env,PSModulePath:windowsModules,HARNESSY_ACL_PATH:path},encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024
 });
 const value=JSON.parse(output) as Descriptor;
 if(!value||!sidPattern.test(value.current)||!sidPattern.test(value.owner)||typeof value.admin!=='boolean'||typeof value.protected!=='boolean'||!Array.isArray(value.rules)||value.rules.some(r=>!r||!sidPattern.test(r.sid)||!['Allow','Deny'].includes(r.type)||!Number.isInteger(r.rights)||typeof r.inherited!=='boolean'))throw Error('invalid Windows security descriptor');
 return value;
}
export function validatePrivateAcl(value:Descriptor,requireProtected:boolean):void {
 if(value.owner!==value.current&&!(value.owner==='S-1-5-32-544'&&value.admin)||requireProtected&&!value.protected||value.rules.some(r=>r.type==='Allow'&&r.sid!==value.current&&!allowedSystemSids.has(r.sid))||!value.rules.some(r=>r.type==='Allow'&&r.sid===value.current&&(r.rights&fullControl)===fullControl))throw Error('unsafe Windows permissions');
}
function privateDescriptor(path:string,requireProtected:boolean):void {validatePrivateAcl(descriptor(path),requireProtected)}
/** Reject links in every existing path component without mistaking Windows 8.3 aliases for links. */
export function assertNoLinkComponents(path:string):void {
 const native=process.platform==='win32'?path.replaceAll('/',sep):path;
 const full=isAbsolute(native)?native:process.cwd()+sep+native;
 let current=parse(full).root;
 for(const part of full.slice(current.length).split(sep)){
  if(!part||part==='.')continue;
  if(part==='..'){current=dirname(current);continue}
  current=current.endsWith(sep)?current+part:current+sep+part;
  if(lstatSync(current).isSymbolicLink())throw Error('unsafe linked path');
 }
}
function plain(path:string,file:boolean):Stats {
 const stat=lstatSync(path);
 if(stat.isSymbolicLink()||(file?!stat.isFile():!stat.isDirectory()))throw Error('unsafe private path');
 if(process.platform==='win32')assertNoLinkComponents(path);
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
  validatePrivateAcl(descriptor(path,hardenScript),true);
 }
 const after=process.platform==='win32'?plain(path,false):assertPrivateDirectory(path);
 if(before.dev!==after.dev||before.ino!==after.ino)throw Error('private path changed');
 return after;
}
