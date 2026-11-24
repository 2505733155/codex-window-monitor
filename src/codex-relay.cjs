'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {AppServerStatus,observeLines}=require('./app-server.cjs');

function bundledCli(directory){
 const arch={x64:'x86_64',arm64:'aarch64'}[process.arch];
 if(!arch)throw new Error('Unsupported Windows architecture');
 for(const entry of fs.readdirSync(directory).filter(name=>/^openai\.chatgpt-\d+\.\d+\.\d+-win32-(?:x64|arm64)$/.test(name))
  .sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))){
  const file=path.join(directory,entry,'bin','windows-'+arch,'codex.exe');
  if(fs.existsSync(file))return file;
 }
 throw new Error('Installed Codex CLI not found');
}

async function publish(runtimeDir,source,status,signal){
 try{
  const info=JSON.parse(fs.readFileSync(path.join(runtimeDir,'instance.json'),'utf8'));
  if(info.app!=='codex-window-monitor'||!Number.isInteger(info.port)||info.port<1||info.port>65535||!/^[a-f0-9]{64}$/.test(info.token))return;
  const response=await fetch('http://127.0.0.1:'+info.port+'/api/app-server',{
   method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(900)]),
   headers:{Authorization:'Bearer '+info.token,'Content-Type':'application/json'},
   body:JSON.stringify({source,sessions:status.snapshot()}),
  });
  await response.body?.cancel();
 }catch{}
}

function run(){
 const settings=JSON.parse(fs.readFileSync(path.join(__dirname,'settings.json'),'utf8').replace(/^\uFEFF/,''));
 const args=process.argv.slice(2);
 const executable=settings.codexExecutable||bundledCli(settings.extensionsDirectory||path.join(os.homedir(),'.vscode','extensions'));
 const observable=args.includes('app-server')&&!args.some(arg=>arg==='--help'||arg==='-h'||arg==='--print-startup-config');
 const child=spawn(executable,args,{stdio:['pipe','pipe','inherit'],windowsHide:true});
 process.stdin.pipe(child.stdin);
 child.stdout.pipe(process.stdout,{end:false});
 child.stdin.on('error',()=>{});
 child.stdout.on('error',()=>{});
 const controller=new AbortController(),status=new AppServerStatus(),source=randomUUID();
 let timer,reporting=false;
 if(observable){
  process.stdin.on('data',observeLines(message=>status.fromClient(message),()=>status.invalidate()));
  child.stdout.on('data',observeLines(message=>status.fromServer(message),()=>status.invalidate()));
  timer=setInterval(async()=>{
   if(!status.ready||reporting)return;
   reporting=true;
   try{await publish(path.dirname(__dirname),source,status,controller.signal);}finally{reporting=false;}
  },1500);
  timer.unref();
 }
 child.once('error',()=>{console.error('Codex monitor relay could not launch the configured CLI.');process.exitCode=1;});
 child.once('close',code=>{
  clearInterval(timer);controller.abort();
  process.stdin.unpipe(child.stdin);process.stdin.pause();
  process.exitCode=code??1;
 });
}

if(require.main===module){
 try{run();}catch(error){console.error('Codex monitor relay: '+error.message);process.exitCode=1;}
}
module.exports={bundledCli};
