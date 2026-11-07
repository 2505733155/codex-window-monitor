'use strict';
const fs=require('node:fs');const path=require('node:path');const net=require('node:net');const os=require('node:os');
const {randomUUID,createHash}=require('node:crypto');const {execFile}=require('node:child_process');
const {MonitorState}=require('./state.cjs');const {Collector}=require('./collector.cjs');const {createWeb}=require('./web.cjs');
const {WindowNavigator}=require('./windows.cjs');
const defaultDir=path.join(__dirname,'../.runtime');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function readInfo(runtimeDir){
 try{const info=JSON.parse(fs.readFileSync(path.join(runtimeDir,'instance.json'),'utf8'));
  if(info.app!=='codex-window-monitor'||!Number.isInteger(info.port)||info.port<1||info.port>65535||!/^[a-f0-9]{64}$/.test(info.token)||typeof info.instanceId!=='string'||info.instanceId.length>100)return null;
  info.base='http://127.0.0.1:'+info.port;info.url=info.base+'/?key='+info.token;return info;
 }catch{return null;}
}
async function findRunning(runtimeDir=defaultDir){
 const info=readInfo(runtimeDir);if(!info)return null;
 try{const response=await fetch(info.base+'/health',{headers:{Authorization:'Bearer '+info.token},signal:AbortSignal.timeout(600)});
  if(!response.ok)return null;const value=await response.json();return value.app===info.app&&value.instanceId===info.instanceId?info:null;
 }catch{return null;}
}
async function stopRunning(runtimeDir=defaultDir){
 const info=await findRunning(runtimeDir);if(!info)return false;
 const response=await fetch(info.base+'/api/stop',{method:'POST',headers:{Authorization:'Bearer '+info.token},signal:AbortSignal.timeout(2000)});
 if(!response.ok)throw new Error('停止请求未获确认');
 for(let n=0;n<40;n++){if(!await findRunning(runtimeDir))return true;await pause(50);}
 throw new Error('监控尚未退出，请稍后再试');
}
async function startService({runtimeDir=defaultDir,port=0,endpoint,startupTimeoutMs=60000,idleTimeoutMs=10000}={}){
 fs.mkdirSync(runtimeDir,{recursive:true,mode:0o700});
 const hash=createHash('sha256').update(path.resolve(runtimeDir).toLowerCase()).digest('hex').slice(0,24);
 const lockEndpoint=process.platform==='win32'?'\\\\.\\pipe\\codex-window-monitor-'+hash:path.join(os.tmpdir(),'codex-window-monitor-'+hash+'.sock');
 const lock=net.createServer(socket=>{socket.end();});lock.on('error',()=>{});
 let acquired=false;
 try{await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen(lockEndpoint,resolve);});acquired=true;}
 catch(error){
  if(error.code!=='EADDRINUSE')throw error;
  for(let n=0;n<20;n++){const info=await findRunning(runtimeDir);if(info)return {existing:true,info};await pause(100);}
  throw new Error('已有实例占用运行锁，但身份无法核实；未停止或覆盖该进程。');
 }
 let web,collector,navigator,closePromise;const instanceId=randomUUID();const state=new MonitorState();
 async function close(){
  if(closePromise)return closePromise;
  closePromise=(async()=>{navigator?.close();collector?.stop();await web?.close();if(acquired)await new Promise(resolve=>lock.close(resolve));
   if(readInfo(runtimeDir)?.instanceId===instanceId){try{fs.unlinkSync(path.join(runtimeDir,'instance.json'));}catch{}}
  })();return closePromise;
 }
 try{
  navigator=new WindowNavigator(()=>state.windowSnapshot());
  web=await createWeb(state,{port,instanceId,startupTimeoutMs,idleTimeoutMs,onWindow:value=>navigator.activate(value),onStop:()=>{close().catch(()=>{});}});
  const info={app:'codex-window-monitor',version:'0.1.0',pid:process.pid,instanceId,port:web.server.address().port,token:web.token,base:web.base,url:web.url,startedAt:new Date().toISOString()};
  const temporary=path.join(runtimeDir,'instance-'+instanceId+'.tmp');
  fs.writeFileSync(temporary,JSON.stringify(info,null,2),{mode:0o600});fs.renameSync(temporary,path.join(runtimeDir,'instance.json'));
  collector=new Collector(state,{endpoint});collector.start();
  return {existing:false,info,state,close};
 }catch(error){await close();throw error;}
}
function openUrl(url){
 const platform=process.platform;const command=platform==='win32'?'rundll32.exe':platform==='darwin'?'open':'xdg-open';
 const args=platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
 execFile(command,args,{windowsHide:true},()=>{});
}
if(require.main===module){
 (async()=>{
  if(process.argv.includes('--stop')){console.log(await stopRunning()?'监控已停止。':'没有正在运行的监控。');return;}
  const service=await startService();console.log(JSON.stringify({existing:service.existing,url:service.info.url}));
  if(process.argv.includes('--open'))openUrl(service.info.url);
  if(!service.existing){for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>service.close().catch(()=>{}));}
 })().catch(error=>{
  try{fs.mkdirSync(defaultDir,{recursive:true});const file=path.join(defaultDir,'error.log');if(fs.existsSync(file)&&fs.statSync(file).size>65536)fs.writeFileSync(file,'');fs.appendFileSync(file,new Date().toISOString()+' '+error.message+'\n');}catch{}
  console.error(error.message);process.exitCode=1;
 });
}
module.exports={startService,findRunning,stopRunning};
