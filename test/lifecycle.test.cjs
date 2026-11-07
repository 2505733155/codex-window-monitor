const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {startService,findRunning,stopRunning}=require('../src/service.cjs');
const {spawn}=require('node:child_process');
test('singleton verifies identity; authenticated stop releases runtime; stale metadata never signals PIDs',async t=>{
 const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-monitor-lifecycle-'));
 fs.writeFileSync(path.join(runtimeDir,'instance.json'),JSON.stringify({app:'unrelated',pid:process.pid,port:1,token:'stale',instanceId:'stale'}));
 let service; t.after(async()=>{await service?.close();fs.rmSync(runtimeDir,{recursive:true,force:true});});
 service=await startService({runtimeDir,endpoint:process.platform==='win32'?'\\\\.\\pipe\\missing-codex-'+Date.now():path.join(runtimeDir,'missing.sock')});
 assert.equal(service.existing,false);assert.equal((await findRunning(runtimeDir)).instanceId,service.info.instanceId);
 const duplicate=await startService({runtimeDir});assert.equal(duplicate.existing,true);assert.equal(duplicate.info.instanceId,service.info.instanceId);
 assert.ok(process.kill(process.pid,0));
 assert.equal(await stopRunning(runtimeDir),true);
 assert.equal(await findRunning(runtimeDir),null);assert.equal(fs.existsSync(path.join(runtimeDir,'instance.json')),false);
 const again=await startService({runtimeDir,endpoint:process.platform==='win32'?'\\\\.\\pipe\\missing-codex-'+Date.now():path.join(runtimeDir,'missing.sock')});assert.equal(again.existing,false);assert.notEqual(again.info.instanceId,service.info.instanceId);await again.close();
});

test('automatic idle shutdown releases metadata and the singleton lock',async t=>{
 const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-monitor-auto-'));let service;
 t.after(async()=>{await service?.close();fs.rmSync(runtimeDir,{recursive:true,force:true});});
 const options={runtimeDir,startupTimeoutMs:1500,idleTimeoutMs:80,endpoint:process.platform==='win32'?'\\\\.\\pipe\\missing-codex-auto-'+Date.now():path.join(runtimeDir,'missing.sock')};
 service=await startService(options);const controller=new AbortController();
 const stream=await fetch(service.info.base+'/events',{headers:{Authorization:'Bearer '+service.info.token},signal:controller.signal});const reader=stream.body.getReader();await reader.read();
 controller.abort();await reader.cancel().catch(()=>{});
 for(let n=0;n<100&&fs.existsSync(path.join(runtimeDir,'instance.json'));n++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(fs.existsSync(path.join(runtimeDir,'instance.json')),false,'automatic stop must remove runtime metadata');
 assert.equal(await findRunning(runtimeDir),null);
 const previous=service.info.instanceId;service=await startService(options);assert.equal(service.existing,false);assert.notEqual(service.info.instanceId,previous);
});

for(const mode of ['never opened','last tab closed'])test('monitor child process exits naturally after '+mode,{timeout:6000},async t=>{
 const runtimeDir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-monitor-exit-'));
 const modulePath=path.resolve(__dirname,'../src/service.cjs');
 const program=`require(${JSON.stringify(modulePath)}).startService({runtimeDir:${JSON.stringify(runtimeDir)},startupTimeoutMs:${mode==='never opened'?120:2000},idleTimeoutMs:80,endpoint:${JSON.stringify(process.platform==='win32'?'\\\\.\\pipe\\missing-codex-child-'+path.basename(runtimeDir):path.join(runtimeDir,'missing.sock'))}}).then(s=>console.log(JSON.stringify({base:s.info.base,token:s.info.token})));`;
 const child=spawn(process.execPath,['-e',program],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='',errors='',forced=false;const timeout=setTimeout(()=>{forced=true;child.kill();},4000);
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 child.stderr.on('data',chunk=>errors+=chunk);
 const ready=new Promise(resolve=>child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n'))resolve(JSON.parse(output.split('\n')[0]));}));
 t.after(async()=>{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;fs.rmSync(runtimeDir,{recursive:true,force:true});});
 const first=await Promise.race([ready,exited.then(()=>{throw Error('monitor exited before ready: '+errors);})]);
 if(mode==='last tab closed'){
  const controller=new AbortController();const response=await fetch(first.base+'/events',{headers:{Authorization:'Bearer '+first.token},signal:controller.signal});
  const reader=response.body.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});
 }
 const result=await exited;clearTimeout(timeout);assert.equal(forced,false,'child must stop without being killed');assert.deepEqual(result,{code:0,signal:null});assert.equal(errors,'');
 assert.equal(fs.existsSync(path.join(runtimeDir,'instance.json')),false);
});
