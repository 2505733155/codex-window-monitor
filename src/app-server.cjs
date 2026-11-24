'use strict';
const {ProjectedJSON}=require('./stream-json.cjs');

const runtimeStatus={type:'type',activeFlags:['type']};
const thread={id:'id',cwd:'path',status:runtimeStatus};
const shape={id:'id',method:'id',params:{thread,threadId:'id',turnId:'id',turn:{id:'id'},requestId:'id',status:runtimeStatus},
 result:{thread,status:'type'},error:{code:'number'}};
const threadMethods=new Set(['thread/start','thread/resume','thread/fork','thread/unsubscribe']);
const statuses=new Set(['idle','active','notLoaded','systemError','unknown']);
const maxSessions=128;

function observeLines(onMessage,onFault=()=>{}){
 let parser,bytes=0,discarding=false;
 return chunk=>{
  for(let offset=0;offset<chunk.length;){
   const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline;
   const part=chunk.subarray(offset,end);
   if(!discarding){
    try{
     bytes+=part.length;
     if(bytes>256*1024*1024)throw new Error('app-server message too large');
     if(part.length)(parser||=new ProjectedJSON(shape)).push(part);
     if(newline>=0&&parser)onMessage(parser.finish());
    }catch{discarding=true;onFault();}
   }
   if(newline>=0){parser=undefined;bytes=0;discarding=false;}
   offset=newline<0?chunk.length:newline+1;
  }
 };
}

const validId=id=>typeof id==='string'&&/^[\w-]{1,100}$/.test(id);
function requestId(id){
 return Number.isSafeInteger(id)||typeof id==='string'&&id.length<=100?JSON.stringify(id):null;
}
class AppServerStatus{
 constructor(){this.sessions=new Map();this.requests=new Map();this.questions=new Map();this.ready=false;}
 invalidate(){
  for(const row of this.sessions.values()){row.type='unknown';row.flags=[];}
  this.requests.clear();this.questions.clear();
 }
 fromClient(message){
  const id=requestId(message?.id),method=message?.method;
  if(id===null||method!=='initialize'&&!threadMethods.has(method))return;
  if(this.requests.size>=512)this.requests.clear();
  this.requests.set(id,{method,threadId:message.params?.threadId});
 }
 store(id,status,cwd){
  if(!validId(id))return;
  if(status?.type==='notLoaded'){this.remove(id);return;}
  if(this.sessions.size>=maxSessions&&!this.sessions.has(id))return;
  const previous=this.sessions.get(id);
  this.sessions.set(id,{threadId:id,cwd:typeof cwd==='string'?cwd.slice(0,4096):previous?.cwd||'',
   type:statuses.has(status?.type)?status.type:'unknown',
   flags:Array.isArray(status?.activeFlags)?status.activeFlags.filter(flag=>typeof flag==='string'&&flag.length<=50).slice(0,20):[]});
 }
 remove(id){
  this.sessions.delete(id);
  for(const [request,value]of this.questions)if(value.threadId===id)this.questions.delete(request);
 }
 fromServer(message){
  const id=requestId(message?.id),params=message?.params,threadId=params?.threadId;
  switch(message?.method){
   case 'thread/status/changed':this.store(threadId,params.status);return;
   case 'thread/started':if(params?.thread)this.store(params.thread.id,params.thread.status,params.thread.cwd);return;
   case 'thread/closed':case 'thread/archived':this.remove(threadId);return;
   case 'item/tool/requestUserInput':
    if(id!==null&&validId(threadId)&&this.questions.size<512)this.questions.set(id,{threadId,turnId:params.turnId});
    return;
   case 'serverRequest/resolved':{
    const resolved=requestId(params?.requestId);
    if(this.questions.get(resolved)?.threadId===threadId)this.questions.delete(resolved);
    return;
   }
   case 'turn/completed':
    if(validId(params?.turn?.id)){
     for(const [key,value]of this.questions)if(value.threadId===threadId&&value.turnId===params.turn.id)this.questions.delete(key);
    }
    return;
  }
  if(message?.method||id===null)return;
  const request=this.requests.get(id);
  if(!request)return;
  this.requests.delete(id);
  if(!message.result||message.error)return;
  if(request.method==='initialize'){this.ready=true;return;}
  if(request.method==='thread/unsubscribe'){
   if(['unsubscribed','notLoaded'].includes(message.result.status))this.remove(request.threadId);
   return;
  }
  const value=message.result.thread;
  if(value)this.store(value.id,value.status,value.cwd);
 }
 snapshot(){
  const counts=new Map();
  for(const {threadId}of this.questions.values())counts.set(threadId,(counts.get(threadId)||0)+1);
  return [...this.sessions.values()].map(row=>({...row,questions:counts.get(row.threadId)||0}));
 }
}

function validRelaySnapshot(value){
 return typeof value?.source==='string'&&/^[a-f0-9-]{36}$/.test(value.source)&&
  Array.isArray(value.sessions)&&value.sessions.length<=maxSessions&&
  value.sessions.every(row=>validId(row?.threadId)&&typeof row.cwd==='string'&&row.cwd.length<=4096&&statuses.has(row.type)&&
   Array.isArray(row.flags)&&row.flags.length<=20&&row.flags.every(flag=>typeof flag==='string'&&flag.length<=50)&&
   Number.isInteger(row.questions)&&row.questions>=0&&row.questions<=512)&&
  new Set(value.sessions.map(row=>row.threadId)).size===value.sessions.length;
}

module.exports={AppServerStatus,observeLines,validRelaySnapshot};
