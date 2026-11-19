'use strict';
const path=require('node:path');
const {execFile}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {normalizeDirectory}=require('./state.cjs');

function problem(message,status=409){return Object.assign(new Error(message),{status});}
const identity=window=>window.Handle+':'+window.ProcessId+':'+window.ProcessStarted;
const scope=row=>row.viewClientId?row.id:row.cwd;
const matches=(window,name)=>{
 const title=window.Title.replace(/^[\u25cf\u2022]\s*/, '').toLowerCase();
 const suffix=name.toLowerCase()+' - visual studio code';
 return title===suffix||title.endsWith(' - '+suffix);
};
// Unmatched/custom titles need an exact guard, not a guessed workspace name.
function association(window,row){
 const projects=new Map();
 for(const project of [row,...(row.sessions||[])]){
  if(project.cwd&&matches(window,project.name))projects.set(normalizeDirectory(project.cwd),project);
 }
 const project=projects.size===1?[...projects.values()][0]:null;
 return {scope:scope(row),identity:identity(window),projectName:project?.name||null,workspace:project?.cwd||null,title:window.Title};
}
const stillAssociated=(window,value)=>identity(window)===value.identity&&(value.projectName?matches(window,value.projectName):window.Title===value.title);

class WindowNavigator{
 constructor(getSnapshot,onWorkspace=()=>{}){this.getSnapshot=getSnapshot;this.onWorkspace=onWorkspace;this.bindings=new Map();this.choices=new Map();this.busy=false;this.closed=false;this.child=null;}
 native(request){
  if(this.closed)return Promise.reject(problem('监控正在停止',503));
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve,reject)=>{
   const child=execFile(executable,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'native/window-bridge.ps1')],{windowsHide:true,encoding:'utf8',timeout:12000,maxBuffer:1024*1024},(error,stdout)=>{
    if(this.child===child)this.child=null;
    if(this.closed){reject(problem('监控已停止',503));return;}
    let value;try{value=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());}catch{}
    if(error||!value?.ok){reject(problem('无法操作 VS Code 窗口，请确认窗口仍然打开后重试',502));return;}
    resolve(value);
   });
   this.child=child;child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
  });
 }
 async activate({rowId,choiceId}){
  if(process.platform!=='win32')throw problem('前往窗口仅支持本机 Windows',501);
  if(this.closed)throw problem('监控正在停止',503);
  if(this.busy)throw problem('正在切换窗口，请稍候',409);
  this.busy=true;
  try{
   let row=this.getSnapshot().rows.find(row=>row.id===rowId);
   if(!row)throw problem('该监控实例已离线，请刷新后重试',404);
   const {windows}=await this.native({action:'list'});
   if(!Array.isArray(windows)||!windows.length)throw problem('没有找到可前往的 VS Code 窗口，请确认窗口仍然打开',404);
   const current=this.getSnapshot().rows.find(value=>value.id===row.id);
   if(!current||scope(current)!==scope(row))throw problem('实例或项目目录已变化，请重新点击',409);
   row=current;
   for(const [key,value]of this.choices)if(value.expires<Date.now())this.choices.delete(key);
   const liveIds=new Set(this.getSnapshot().rows.map(value=>value.id));
   for(const [key,binding]of this.bindings){
    if(!liveIds.has(key)||!windows.some(window=>stillAssociated(window,binding))){
     this.bindings.delete(key);
     if(binding.workspace)this.onWorkspace(key,null);
    }
   }
   row=this.getSnapshot().rows.find(value=>value.id===rowId)||row;
   let target;
   if(choiceId){
    const choice=this.choices.get(choiceId);
    if(!choice||choice.rowId!==rowId||choice.scope!==scope(row))throw problem('窗口选择已过期，请重新点击“前往窗口”',409);
    target=windows.find(window=>stillAssociated(window,choice));
    if(!target)throw problem('窗口已关闭或切换项目，请重新点击“前往窗口”',409);
   }else{
    const binding=this.bindings.get(rowId);
    if(binding?.scope===scope(row))target=windows.find(window=>stillAssociated(window,binding));
    if(!target){
     const candidates=windows.filter(window=>row.name&&matches(window,row.name));
     const sameNameRows=this.getSnapshot().rows.filter(value=>value.name.toLowerCase()===row.name.toLowerCase());
     if(!row.requiresWindowSelection&&candidates.length===1&&sameNameRows.length===1&&row.mapping!=='ambiguous')target=candidates[0];
     else{
      for(const [key,value]of this.choices)if(value.rowId===rowId)this.choices.delete(key);
      const options=(row.requiresWindowSelection?windows:candidates.length?candidates:windows).map(window=>{
       const choiceId=randomUUID();this.choices.set(choiceId,{rowId,...association(window,row),expires:Date.now()+120000});
       return {choiceId,title:window.Title,desktop:window.DesktopLabel,current:window.OnCurrentDesktop,minimized:window.Minimized};
      });
      return {status:'choose',reason:candidates.length?'存在多个可能的面板或窗口，请选择要前往的 VS Code 窗口。':'未能按项目名称唯一定位，请选择对应的 VS Code 窗口。',windows:options};
     }
    }
   }
   const {result}=await this.native({action:'activate',handle:target.Handle,processId:target.ProcessId,processStarted:target.ProcessStarted,title:target.Title});
   if(!result?.Activated)throw problem('Windows 未能将窗口切到前台，请再次点击；若仍失败，可先通过 Win+Tab 切换',409);
   const latest=this.getSnapshot().rows.find(value=>value.id===rowId);
   if(latest&&scope(latest)===scope(row)){
    const binding=association(result.Window,latest);
    this.bindings.set(rowId,binding);
    if(latest.viewClientId)this.onWorkspace(rowId,binding.workspace);
   }
   for(const [key,value]of this.choices)if(value.rowId===rowId)this.choices.delete(key);
   return {status:'activated',title:result.Window.Title,desktop:result.Window.DesktopLabel};
  }finally{this.busy=false;}
 }
 close(){this.closed=true;this.choices.clear();this.bindings.clear();this.child?.kill();}
}
module.exports={WindowNavigator};
