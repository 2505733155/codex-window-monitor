'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

test('the Windows launcher starts debug VS Code only when opted in and available', {skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-launcher-'));
 try{
  fs.mkdirSync(path.join(root,'.runtime'));
  fs.mkdirSync(path.join(root,'VS Code','bin'),{recursive:true});
  fs.writeFileSync(path.join(root,'VS Code','Code.exe'),'');
  fs.copyFileSync(path.join(__dirname,'../Start.ps1'),path.join(root,'Start.ps1'));
  const fixture=path.join(root,'fixture.ps1');
  fs.writeFileSync(fixture,`
param([string]$Scenario)
function Get-Command {
 param($Name,$CommandType)
 if ($Name -eq 'node') { [pscustomobject]@{ Source = 'node.exe' } }
 if ($Name -eq 'code') { [pscustomobject]@{ Source = (Join-Path $PSScriptRoot 'VS Code\\bin\\code.cmd') } }
}
function Get-Process {
 param($Name)
 if ($Scenario -eq 'running') { [pscustomobject]@{ ProcessName = 'Code' } }
}
function Get-NetTCPConnection {
 param($LocalPort,$State)
 if ($Scenario -eq 'occupied') { [pscustomobject]@{ LocalPort = $LocalPort } }
}
function Start-Process {
 param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle)
 [pscustomobject]@{ File = $FilePath; Arguments = $ArgumentList } | ConvertTo-Json -Compress
}
& (Join-Path $PSScriptRoot 'Start.ps1') -WarningAction SilentlyContinue
`);
  const run=(scenario,port)=>{
   fs.writeFileSync(path.join(root,'.runtime','current-session.json'),JSON.stringify({port}));
   const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fixture,scenario],{encoding:'utf8',windowsHide:true});
   return output.trim().split(/\r?\n/).map(line=>JSON.parse(line));
  };
  const [editor,monitor]=run('free',9222);
  assert.equal(editor.File,path.join(root,'VS Code','Code.exe'));
  assert.ok(editor.Arguments.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(editor.Arguments.includes('--remote-debugging-port=9222'));
  assert.equal(monitor.File,'node.exe');
  for(const [scenario,port]of [['disabled',null],['running',9222],['occupied',9222]]){
   assert.deepEqual(run(scenario,port).map(call=>call.File),['node.exe']);
  }
 }finally{
  const resolved=fs.realpathSync(root);
  if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('monitor-launcher-')){
   fs.rmSync(resolved,{recursive:true,force:true});
  }
 }
});
