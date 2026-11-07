'use strict';
const net=require('node:net');const {randomUUID}=require('node:crypto');
const {encode,FrameDecoder,validateOutbound}=require('./protocol.cjs');
class Collector{
 constructor(state,{endpoint='\\\\.\\pipe\\codex-ipc',retryMs=500,removeAfterMs=10000}={}){
  this.state=state;this.endpoint=endpoint;this.retryMs=retryMs;this.removeAfterMs=removeAfterMs;
  this.pending=new Map();this.followed=new Map();this.checked=new Set();this.removals=new Map();this.resyncs=new Map();
  this.announcers=new Map();this.owners=new Map();this.ownerQueries=new Map();
  this.clientId='initializing-client';this.stopped=true;this.epoch=0;this.attempt=0;
  this.onResync=record=>this.resync(record);state.on('resync',this.onResync);
 }
 start(){if(!this.stopped)return;this.stopped=false;this.connect();}
 send(message){validateOutbound(message);if(this.socket?.writable&&!this.socket.destroyed)this.socket.write(encode(message));}
 request(method,params,version,callback,targetClientId){
  if(this.stopped||!this.socket?.writable)return;
  const requestId=randomUUID();const epoch=this.epoch;
  const timer=setTimeout(()=>{this.pending.delete(requestId);if(epoch===this.epoch&&!this.stopped)callback({resultType:'error',error:'timeout'});},5000);timer.unref();
  this.pending.set(requestId,{timer,callback,epoch});
  this.send({type:'request',requestId,method,params,version,sourceClientId:this.clientId,targetClientId,timeoutMs:4500});
 }
 following(p,following,targetClientIds){
  this.send({type:'broadcast',method:'thread-stream-following-changed',version:1,sourceClientId:this.clientId,targetClientIds,params:{hostId:'local',conversationId:p.threadId||p.conversationId,following}});
 }
 follow(p){
  const key=p.hostId+':'+p.conversationId;if(this.followed.has(key))return;
  this.followed.set(key,{hostId:p.hostId,conversationId:p.conversationId});
  this.following(p,true);
  this.queryOwner(p);
 }
 queryOwner(p){
  const key='local:'+p.conversationId;if(!this.followed.has(key)||this.ownerQueries.has(key))return;
  const query=Symbol();this.ownerQueries.set(key,query);
  this.request('thread-owner-discovery',{hostId:'local',conversationId:p.conversationId},1,message=>{
   if(this.ownerQueries.get(key)!==query)return;this.ownerQueries.delete(key);
   if(!this.followed.has(key)||message.resultType!=='success'||typeof message.handledByClientId!=='string')return;
   const owner=message.handledByClientId,previous=this.owners.get(key);this.owners.set(key,owner);
   this.state.removeThread(p.conversationId,owner);
   if(previous&&previous!==owner||!this.state.snapshot().rows.some(r=>r.threadId===p.conversationId&&r.ownerClientId===owner))this.following(p,true,[owner]);
  });
 }
 retire(p,{removeRows=true}={}){
  const key='local:'+p.conversationId;
  if(this.followed.has(key))this.following(p,false);
  this.followed.delete(key);this.announcers.delete(key);this.owners.delete(key);this.ownerQueries.delete(key);
  for(const name of this.checked)if(name.endsWith(':'+p.conversationId))this.checked.delete(name);
  for(const [name,timer]of this.resyncs)if(name.endsWith(':'+p.conversationId)){clearTimeout(timer);this.resyncs.delete(name);}
  if(removeRows)this.state.removeThread(p.conversationId);
 }
 checkMapping(p,owner,cwd){
  const key=owner+':'+p.conversationId;if(!cwd||this.checked.has(key))return;this.checked.add(key);
  this.request('ide-context',{workspaceRoot:cwd},0,message=>{
   if(message.resultType==='success'&&Object.hasOwn(message.result||{},'ideContext'))this.state.setMapping(owner,p.conversationId,message.handledByClientId);
   else this.checked.delete(key);
  });
 }
 resync(record,attempt=0){
  const key=record.ownerClientId+':'+record.threadId;
  if(this.stopped||this.state.connection!=='connected'||this.resyncs.has(key))return;
  this.following(record,false,[record.ownerClientId]);this.following(record,true,[record.ownerClientId]);
  const timer=setTimeout(()=>{this.resyncs.delete(key);if(attempt<2)this.resync(record,attempt+1);},2500);timer.unref();this.resyncs.set(key,timer);
 }
 handle(message,epoch){
  if(epoch!==this.epoch||!message||typeof message!=='object')return;
  if(message.type==='client-discovery-request'){
   this.send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});return;
  }
  if(message.type==='response'){
   const pending=this.pending.get(message.requestId);if(!pending)return;
   clearTimeout(pending.timer);this.pending.delete(message.requestId);
   if(pending.epoch===this.epoch)pending.callback(message);return;
  }
  if(message.type!=='broadcast')return;
  if(message.method==='client-status-changed'&&message.version===0){
   const p=message.params;
   if(p?.status==='disconnected'){
    const affected=this.state.snapshot().rows.filter(r=>r.ownerClientId===p.clientId);
    if(affected.length)this.state.clientGone(p.clientId);
    const ownedThreads=new Set(affected.map(row=>row.threadId));
    for(const [key,clients]of this.announcers){clients.delete(p.clientId);if(!clients.size){const threadId=key.slice(6);this.retire({conversationId:threadId},{removeRows:!ownedThreads.has(threadId)});}}
    if(!affected.length)return;
    for(const row of affected){this.followed.delete('local:'+row.threadId);this.checked.delete(p.clientId+':'+row.threadId);}
    clearTimeout(this.removals.get(p.clientId));
    const timer=setTimeout(()=>{this.removals.delete(p.clientId);if(this.state.connection==='connected')this.state.removeClient(p.clientId);},this.removeAfterMs);timer.unref();this.removals.set(p.clientId,timer);
   }return;
  }
  const p=message.params;
  if(p?.hostId!=='local'||typeof p.conversationId!=='string'||p.conversationId.length>200||message.sourceClientId===this.clientId)return;
  const key='local:'+p.conversationId;
  if(message.method==='thread-stream-following-changed'&&message.version===1&&typeof p.following==='boolean'){
   if(p.following){
    let clients=this.announcers.get(key);if(!clients){clients=new Set();this.announcers.set(key,clients);}clients.add(message.sourceClientId);
    const wasFollowed=this.followed.has(key);this.follow(p);if(wasFollowed)this.queryOwner(p);
   }else{
    const clients=this.announcers.get(key);if(clients?.delete(message.sourceClientId)&&clients.size===0)this.retire(p);
   }
   return;
  }
  if(message.method==='thread-stream-state-changed'){
   if(!this.followed.has(key)||!this.announcers.get(key)?.size)return;
   const owner=this.owners.get(key);
   if(owner&&owner!==message.sourceClientId){this.queryOwner(p);return;}
   const accepted=this.state.ingest(message);
   if(accepted&&p.change?.type==='snapshot'){
    const resyncKey=message.sourceClientId+':'+p.conversationId;clearTimeout(this.resyncs.get(resyncKey));this.resyncs.delete(resyncKey);
    clearTimeout(this.removals.get(message.sourceClientId));this.removals.delete(message.sourceClientId);
   }
   if(accepted&&message.version===11&&p.change?.type==='snapshot')this.checkMapping(p,message.sourceClientId,p.change.conversationState?.cwd);
  }
 }
 connect(){
  if(this.stopped)return;
  const epoch=++this.epoch;this.clientId='initializing-client';
  const socket=net.createConnection(this.endpoint);this.socket=socket;
  const decoder=new FrameDecoder(message=>this.handle(message,epoch));
  let initTimer=setTimeout(()=>socket.destroy(),6000);initTimer.unref();
  socket.on('connect',()=>{
   if(this.stopped||epoch!==this.epoch){socket.destroy();return;}
   this.request('initialize',{clientType:'codex-window-monitor'},0,message=>{
    if(message.resultType!=='success'||typeof message.result?.clientId!=='string'){socket.destroy();return;}
    clearTimeout(initTimer);this.clientId=message.result.clientId;this.attempt=0;this.state.connected();
   });
  });
  socket.on('data',chunk=>{try{decoder.push(chunk);}catch{this.state.disconnected('状态通信数据无效，正在重连');socket.destroy();}});
  socket.on('error',()=>{});
  socket.on('close',()=>{
   clearTimeout(initTimer);if(epoch!==this.epoch)return;
   this.clearTransient();this.followed.clear();this.checked.clear();this.announcers.clear();this.owners.clear();this.ownerQueries.clear();
   if(this.stopped)return;
   this.state.disconnected('尚未连接到 Codex，正在重试');
   this.retry=setTimeout(()=>this.connect(),Math.min(5000,this.retryMs*2**Math.min(this.attempt++,4)));
  });
 }
 clearTransient(){
  for(const {timer}of this.pending.values())clearTimeout(timer);this.pending.clear();
  for(const timer of this.removals.values())clearTimeout(timer);this.removals.clear();
  for(const timer of this.resyncs.values())clearTimeout(timer);this.resyncs.clear();
 }
 stop(){
  if(this.stopped)return;this.stopped=true;clearTimeout(this.retry);
  for(const p of this.followed.values())this.following(p,false);
  this.clearTransient();this.followed.clear();this.socket?.end();
  const socket=this.socket;setTimeout(()=>socket?.destroy(),300).unref();
  this.state.off('resync',this.onResync);this.state.disconnected('监控已停止');
 }
}
module.exports={Collector};
