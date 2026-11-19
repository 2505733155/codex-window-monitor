const {test}=require('node:test');const assert=require('node:assert/strict');const net=require('node:net');const os=require('node:os');const path=require('node:path');const {randomUUID}=require('node:crypto');
const {Collector}=require('../src/collector.cjs');const {MonitorState}=require('../src/state.cjs');const {encode,FrameDecoder}=require('../src/protocol.cjs');
function until(emitter,predicate){if(predicate())return Promise.resolve();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{emitter.off('change',check);reject(new Error('state wait timed out'));},3000);function check(){if(predicate()){clearTimeout(timer);emitter.off('change',check);resolve();}}emitter.on('change',check);});}
test('oversized IPC frames retain a diagnostic through reconnect and recover after valid snapshots',async t=>{
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\codex-size-test-'+randomUUID():path.join(os.tmpdir(),'codex-size-'+randomUUID()+'.sock');
 const sockets=new Set();let connections=0,activeSocket,autoSnapshot=true;
 const server=net.createServer(socket=>{activeSocket=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));const index=++connections;
  const send=value=>socket.write(encode(value));const decoder=new FrameDecoder(m=>{
   if(m.type==='request')send({type:'response',requestId:m.requestId,resultType:'success',handledByClientId:'owner',result:m.method==='initialize'?{clientId:'observer'}:m.method==='ide-context'?{ideContext:{}}:{}});
   if(m.method==='initialize'){
    if(index===1){const header=Buffer.alloc(4);header.writeUInt32LE(2048);socket.write(header);}
    else send({type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:'owner',params:{hostId:'local',conversationId:'fixture',following:true}});
   }
   if(m.type==='broadcast'&&m.params.following&&autoSnapshot)send({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'fixture',change:{type:'snapshot',revision:1,conversationState:{cwd:'D:/fixture',threadRuntimeStatus:{type:'idle'}}}}});
  });socket.on('data',chunk=>decoder.push(chunk));
 });
 await new Promise(resolve=>server.listen(endpoint,resolve));const state=new MonitorState();const collector=new Collector(state,{endpoint,retryMs:20,maxFrameBytes:1024,recoveryMs:120});
 t.after(async()=>{collector.stop();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 collector.start();await until(state,()=>state.snapshot().diagnostic?.active===true);
 assert.equal(state.snapshot().diagnostic.code,'IPC_FRAME_TOO_LARGE');assert.equal(state.snapshot().diagnostic.observedBytes,2048);
 await until(state,()=>state.snapshot().connection==='connected'&&state.snapshot().rows[0]?.status==='idle'&&state.snapshot().diagnostic?.active===false);
 assert.equal(state.snapshot().diagnostic.count,1);assert.equal(connections,2);
 state.collectionError({code:'IPC_INVALID_JSON'});
 activeSocket.write(encode({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'fixture',change:{type:'snapshot',revision:2,conversationState:{cwd:'D:/fixture',threadRuntimeStatus:{type:'idle'}}}}}));
 await until(state,()=>state.snapshot().rows[0]?.revision===2);await new Promise(resolve=>setTimeout(resolve,70));autoSnapshot=false;
 activeSocket.write(encode({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'fixture',change:{type:'patches',baseRevision:4,revision:5,patches:[]}}}));
 await until(state,()=>state.snapshot().rows[0]?.status==='unknown');await new Promise(resolve=>setTimeout(resolve,20));
 activeSocket.write(encode({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'fixture',change:{type:'snapshot',revision:6,conversationState:{cwd:'D:/fixture',threadRuntimeStatus:{type:'idle'}}}}}));
 await until(state,()=>state.snapshot().rows[0]?.revision===6);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(state.snapshot().diagnostic.active,true,'a revision gap must restart the stable recovery interval');
 await until(state,()=>state.snapshot().diagnostic.active===false);
 state.collectionError({code:'IPC_INVALID_JSON'});state.removeClient('owner');await new Promise(resolve=>setTimeout(resolve,150));assert.equal(state.snapshot().diagnostic.active,true,'an empty session set cannot prove recovery');
});
test('real pipe discovery, read-only subscriptions, resync and reconnect',async t=>{
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\codex-monitor-test-'+randomUUID():path.join(os.tmpdir(),'codex-'+randomUUID()+'.sock');
 const sockets=new Set(),sent=[];let connections=0,revision=1,status='idle',autoSnapshot=true,thread='thread',owner='owner';
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));connections++;
  const send=m=>socket.write(encode(m));const snapshot=()=>send({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:owner,params:{hostId:'local',conversationId:thread,change:{type:'snapshot',revision,conversationState:{cwd:'D:\\测试项目',threadRuntimeStatus:{type:status},requests:[]}}}});
  socket.on('data',chunk=>decoder.push(chunk));const decoder=new FrameDecoder(m=>{sent.push(m);
   if(m.type==='request'){const result=m.method==='initialize'?{clientId:'observer'}:m.method==='ide-context'?{ideContext:{openTabs:[]}}:{supportsUntrustedAppInput:true};send({type:'response',requestId:m.requestId,method:m.method,resultType:'success',handledByClientId:m.method==='ide-context'?'ide-client':owner,result});
    if(m.method==='initialize')send({type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:'owner',params:{hostId:'local',conversationId:'thread',following:true}});
   }
   if(m.type==='broadcast'&&m.params.following&&autoSnapshot)snapshot();
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
 const state=new MonitorState();const collector=new Collector(state,{endpoint,retryMs:20,removeAfterMs:20});
 t.after(async()=>{collector.stop();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 collector.start();await until(state,()=>state.snapshot().rows[0]?.ideClientId==='ide-client');
 assert.equal(state.snapshot().rows[0].status,'idle');
 const message=(base,rev,type)=>({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'thread',change:{type:'patches',baseRevision:base,revision:rev,patches:[{op:'replace',path:['threadRuntimeStatus'],value:{type}}]}}});
 let socket=[...sockets][0];socket.write(encode(message(1,2,'active')));await until(state,()=>state.snapshot().rows[0]?.status==='busy');
 revision=6;status='idle';socket.write(encode(message(4,5,'idle')));await until(state,()=>state.snapshot().rows[0]?.revision===6);
 assert.equal(state.snapshot().rows[0].status,'idle');assert.ok(sent.some(m=>m.type==='broadcast'&&m.params.following===false));
 const disconnected=until(state,()=>state.snapshot().connection==='disconnected');socket.destroy();await disconnected;
 assert.equal(state.snapshot().rows[0].status,'unknown');
 await until(state,()=>state.snapshot().connection==='connected'&&state.snapshot().rows[0]?.status==='idle');assert.ok(connections>=2);
 socket=[...sockets][0];
 const announce=(source,conversationId,following)=>socket.write(encode({type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:source,params:{hostId:'local',conversationId,following}}));
 announce('owner','thread',false);await until(state,()=>state.snapshot().rows.length===0);
 thread='new-thread';announce('owner',thread,true);await until(state,()=>state.snapshot().rows[0]?.threadId==='new-thread');
 announce('viewer',thread,true);announce('owner',thread,false);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(state.snapshot().rows.length,1);
 socket.write(encode({type:'broadcast',method:'client-status-changed',version:0,params:{clientId:'viewer',status:'disconnected'}}));
 await until(state,()=>state.snapshot().rows.length===0);
 announce('owner',thread,true);await until(state,()=>state.snapshot().rows.length===1);
 announce('viewer',thread,true);announce('owner',thread,false);
 announce('viewer',thread,false);await until(state,()=>state.snapshot().rows.length===0);
 announce('owner',thread,true);await until(state,()=>state.snapshot().rows[0]?.ownerClientId==='owner');
 owner='new-owner';announce(owner,thread,true);await until(state,()=>state.snapshot().rows.length===1&&state.snapshot().rows[0].ownerClientId==='new-owner');
 assert.ok(sent.every(m=>m.type!=='request'||['initialize','thread-owner-discovery','ide-context'].includes(m.method)));
});

async function reconnectFixture(t,{version=11}={}){
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\codex-reconcile-test-'+randomUUID():path.join(os.tmpdir(),'codex-'+randomUUID()+'.sock');
 const state=new MonitorState(),sockets=new Set();
 const fixture={state,version,announced:['closed','live','slow'],snapshots:new Set(['closed','live','slow']),initialize:true,removeAfterMs:120};
 const owner=thread=>'owner-'+thread;
 const server=net.createServer(socket=>{
  fixture.socket=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  const send=message=>socket.write(encode(message));
  const announce=thread=>send({type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:owner(thread),params:{hostId:'local',conversationId:thread,following:true}});
  const decoder=new FrameDecoder(message=>{
   if(message.type==='request'){
    const respond=()=>send({type:'response',requestId:message.requestId,method:message.method,resultType:'success',handledByClientId:message.method==='ide-context'?'ide':owner(message.params.conversationId),result:message.method==='initialize'?{clientId:'observer'}:message.method==='ide-context'?{ideContext:{}}:{}});
    if(message.method==='initialize'){
     const initialize=()=>{respond();for(const thread of fixture.announced)announce(thread);};
     if(fixture.initialize)initialize();else fixture.pendingInitialize=initialize;
    }else if(message.method==='ide-context'&&fixture.onIdeContext)fixture.onIdeContext(message,respond);else respond();
   }
   if(message.type==='broadcast'&&message.params.following&&fixture.snapshots.has(message.params.conversationId)){
    const thread=message.params.conversationId;
    send({type:'broadcast',method:'thread-stream-state-changed',version:fixture.version,sourceClientId:owner(thread),params:{hostId:'local',conversationId:thread,change:{type:'snapshot',revision:1,conversationState:{cwd:'D:\\fixture-'+thread,threadRuntimeStatus:{type:'idle'}}}}});
   }
  });socket.on('data',chunk=>decoder.push(chunk));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
 const collector=new Collector(state,{endpoint,retryMs:10,removeAfterMs:fixture.removeAfterMs});fixture.collector=collector;
 t.after(async()=>{collector.stop();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 fixture.reconnect=async()=>{const offline=until(state,()=>state.connection==='disconnected');fixture.socket.destroy();await offline;await until(state,()=>state.connection==='connected');};
 collector.start();await until(state,()=>state.snapshot().rows.length===3);return fixture;
}

test('reconnect reconciliation removes undiscovered old rows but keeps announced slow sessions',async t=>{
 const f=await reconnectFixture(t),state=f.state;
 const live=state.windowSnapshot().rows.find(row=>row.threadId==='live');state.setBlocked(live.id,true,'fixture note');
 f.announced=['live','slow'];f.snapshots=new Set(['live']);await f.reconnect();
 assert.equal(state.snapshot().rows.find(row=>row.threadId==='closed').status,'unknown','retain old rows during discovery grace');
 await until(state,()=>state.snapshot().rows.length===2);
 assert.deepEqual(state.snapshot().rows.map(row=>row.threadId).sort(),['live','slow']);
 assert.equal(state.snapshot().rows.find(row=>row.threadId==='slow').status,'unknown','an announcement is enough; slow snapshots must not hide real windows');
 assert.equal(state.windowSnapshot().rows.find(row=>row.id===live.id).blocked,true);
 assert.equal(state.windowSnapshot().rows.find(row=>row.id===live.id).blockReason,'fixture note');
});
test('version 13 snapshots receive IDE mapping and recover alongside version 11 support',async t=>{
 const f=await reconnectFixture(t,{version:13});await until(f.state,()=>f.state.snapshot().rows.every(row=>row.status==='idle'&&row.ideClientId==='ide'));
 f.version=11;await f.reconnect();await until(f.state,()=>f.state.snapshot().rows.every(row=>row.status==='idle'&&row.ideClientId==='ide'));
});

test('reconnect reconciliation is cancelled during another disconnect and on stop',async t=>{
 const f=await reconnectFixture(t),state=f.state;
 f.announced=[];await f.reconnect();
 f.initialize=false;const offline=until(state,()=>state.connection==='disconnected');f.socket.destroy();await offline;
 await new Promise(resolve=>setTimeout(resolve,f.removeAfterMs*2));
 assert.equal(state.snapshot().rows.length,3,'an uninitialized or disconnected transport cannot prove windows disappeared');
 assert.ok(state.snapshot().rows.every(row=>row.status==='unknown'));
 assert.equal(typeof f.pendingInitialize,'function');
 const online=until(state,()=>state.connection==='connected');f.announced=['live'];f.snapshots=new Set(['live']);f.pendingInitialize();await online;
 assert.equal(state.snapshot().rows.length,3,'successful reconnection gets a fresh grace period');
 f.collector.stop();await new Promise(resolve=>setTimeout(resolve,f.removeAfterMs*2));
 assert.equal(state.snapshot().rows.length,3,'stop must cancel pending reconciliation');
});

test('workspace mapping rechecks cwd patches and ignores superseded IDE query responses',{timeout:5000},async t=>{
 const f=await reconnectFixture(t),state=f.state;await until(state,()=>state.snapshot().rows.every(row=>row.ideClientId==='ide'));
 let receive;f.onIdeContext=(message,respond)=>receive({message,respond});
 const expectRequest=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('new workspace was not checked')),1000);receive=value=>{clearTimeout(timer);resolve(value);};});
 const move=(base,revision,cwd)=>f.socket.write(encode({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner-live',params:{hostId:'local',conversationId:'live',change:{type:'patches',baseRevision:base,revision,patches:[{op:'replace',path:['cwd'],value:cwd}]}}}));
 const first=expectRequest();move(1,2,'D:/fixture-renamed');const oldQuery=await first;assert.equal(oldQuery.message.params.workspaceRoot,'D:/fixture-renamed');
 const next=expectRequest();move(2,3,'D:/fixture-newest');const currentQuery=await next;assert.equal(currentQuery.message.params.workspaceRoot,'D:/fixture-newest');
 oldQuery.respond();for(let n=0;n<100&&f.collector.pending.has(oldQuery.message.requestId);n++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(f.collector.pending.has(oldQuery.message.requestId),false);assert.equal(state.snapshot().rows.find(row=>row.threadId==='live').ideClientId,null,'late results cannot verify the new directory');
 currentQuery.respond();await until(state,()=>state.snapshot().rows.find(row=>row.threadId==='live').ideClientId==='ide');
 assert.equal(state.windowSnapshot().rows.find(row=>row.ownerClientId==='owner-live').name,'fixture-newest');
});

test('pipe viewer subscriptions separate a shared owner, replay on reconnect and release on switching',async t=>{
 const endpoint=process.platform==='win32'?'\\\\.\\pipe\\codex-panels-'+randomUUID():path.join(os.tmpdir(),'codex-panels-'+randomUUID()+'.sock');
 const sockets=new Set(),state=new MonitorState();let active,owner='owner';
 const event=(method,sourceClientId,params,version=1)=>({type:'broadcast',method,sourceClientId,params,version});
 const announce=(clientId,thread,following=true)=>active.write(encode(event('thread-stream-following-changed',clientId,{hostId:'local',conversationId:thread,following})));
 const server=net.createServer(socket=>{active=socket;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  const decoder=new FrameDecoder(m=>{
   if(m.type==='request')socket.write(encode({type:'response',requestId:m.requestId,resultType:'success',handledByClientId:owner,result:m.method==='initialize'?{clientId:'monitor'}:m.method==='ide-context'?{ideContext:{}}:{}}));
   if(m.method==='initialize'){
    socket.write(encode(event('client-status-changed','peer-monitor',{clientId:'peer-monitor',clientType:'codex-window-monitor',status:'connected'},0)));
    announce('peer-monitor','a');announce('panel-a','a');announce('panel-b','b');
   }
   if(m.type==='broadcast'&&m.params?.following){const thread=m.params.conversationId;socket.write(encode(event('thread-stream-state-changed',owner,{hostId:'local',conversationId:thread,change:{type:'snapshot',revision:1,conversationState:{cwd:'D:/'+thread,threadRuntimeStatus:{type:thread==='a'?'idle':'active'}}}},13)));}
  });socket.on('data',chunk=>decoder.push(chunk));
 });
 await new Promise(resolve=>server.listen(endpoint,resolve));const collector=new Collector(state,{endpoint,retryMs:10,removeAfterMs:30});
 t.after(async()=>{collector.stop();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 collector.start();await until(state,()=>state.snapshot().rows.length===2&&state.snapshot().rows.every(r=>r.status!=='unknown'));
 assert.deepEqual(state.windowSnapshot().rows.map(r=>r.viewClientId).sort(),['panel-a','panel-b']);
 const a=state.windowSnapshot().rows.find(r=>r.viewClientId==='panel-a');state.setBlocked(a.id,true,'fixture');
 const offline=until(state,()=>state.connection==='disconnected');active.destroy();await offline;
 await until(state,()=>state.connection==='connected'&&state.snapshot().rows.every(r=>r.status!=='unknown'));
 assert.equal(state.windowSnapshot().rows.find(r=>r.id===a.id).blocked,true);
 announce('panel-b','b',false);announce('panel-b','a');
 await until(state,()=>state.windowSnapshot().rows.length===2&&state.windowSnapshot().rows.every(r=>r.sharedSessionCount===1));
 assert.equal(state.windowSnapshot().sessionCount,1);assert.equal(state.snapshot().rows.length,1);
 active.write(encode(event('client-status-changed','panel-b',{clientId:'panel-b',status:'disconnected'},0)));
 await until(state,()=>state.windowSnapshot().rows.length===1);assert.equal(state.windowSnapshot().rows[0].sharedSessionCount,0);
 owner='replacement';active.write(encode(event('client-status-changed','owner',{clientId:'owner',status:'disconnected'},0)));
 await until(state,()=>state.snapshot().rows.length===1&&state.snapshot().rows[0].ownerClientId==='replacement'&&state.snapshot().rows[0].status==='idle');
 assert.equal(state.windowSnapshot().rows[0].id,a.id);assert.equal(state.windowSnapshot().rows[0].blocked,true);
});

test('reconnect also removes undiscovered panels that never received a canonical snapshot',async t=>{
 const f=await reconnectFixture(t);const thread='never-loaded';
 f.socket.write(encode({type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:'temporary-panel',params:{hostId:'local',conversationId:thread,following:true}}));
 await until(f.state,()=>f.state.windowSnapshot().rows.some(r=>r.viewClientId==='temporary-panel'));
 await f.reconnect();
 await new Promise(resolve=>setTimeout(resolve,f.removeAfterMs*2));
 assert.ok(!f.state.windowSnapshot().rows.some(r=>r.viewClientId==='temporary-panel'));
});
