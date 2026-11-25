'use strict';
const {validRelaySnapshot}=require('./app-server.cjs');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');

function readThreadDirectory(threadId,root=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')){
 let db;
 try{
  const file=fs.readdirSync(root).filter(name=>/^state_\d+\.sqlite$/.test(name))
   .sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))[0];
  if(!file)return '';
  const {DatabaseSync}=require('node:sqlite');
  db=new DatabaseSync(path.join(root,file),{readOnly:true});
  const cwd=db.prepare('SELECT cwd FROM threads WHERE id = ?').get(threadId)?.cwd;
  return typeof cwd==='string'&&cwd.length<=4096?cwd:'';
 }catch{return '';}finally{db?.close();}
}

class RelayCollector{
 constructor(state,leaseMs=7000,lookupDirectory=readThreadDirectory){
  this.state=state;this.leaseMs=leaseMs;this.sources=new Map();this.stopped=false;this.lookupDirectory=lookupDirectory;
 }
 start(){this.state.disconnected('等待新版 Codex 转发程序连接，请确认已配置并重载 VS Code');}
 accept(snapshot){
  if(this.stopped||!validRelaySnapshot(snapshot))return false;
  const {source,sessions}=snapshot,id='relay-'+source;
  let entry=this.sources.get(source);
  if(!entry){
   if(this.sources.size>=64)return false;
   entry={threads:new Map(),directories:new Map(),revision:0};this.sources.set(source,entry);
  }
  clearTimeout(entry.timer);
  entry.timer=setTimeout(()=>this.expire(source),this.leaseMs);
  entry.timer.unref();
  if(this.state.connection!=='connected')this.state.connected();
  const live=new Set(sessions.map(row=>row.threadId));
  for(const thread of entry.threads.keys()){
   if(!live.has(thread)){
    entry.threads.delete(thread);entry.directories.delete(thread);this.state.removeThread(id+':'+thread);
   }
  }
  let lookups=0;
  const now=Date.now();
  for(const row of sessions){
   let cwd=row.cwd;
   if(!cwd){
    let cached=entry.directories.get(row.threadId);
    if((!cached||cached.until<=now)&&lookups<4){
     lookups++;
     const value=this.lookupDirectory(row.threadId)||'';
     cached={value,until:now+(value?60000:15000)};
     entry.directories.set(row.threadId,cached);
    }
    cwd=cached?.value||'';
   }else entry.directories.delete(row.threadId);
   const threadId=id+':'+row.threadId;
   const prior=entry.threads.get(row.threadId);
   const signature=JSON.stringify([cwd,row.type,row.flags,row.questions]);
   if(prior===signature)continue;
   entry.threads.set(row.threadId,signature);
   if(prior===undefined)this.state.setViewers('local',threadId,[id]);
   this.state.ingest({type:'broadcast',method:'thread-stream-state-changed',version:13,sourceClientId:id,
    params:{hostId:'local',conversationId:threadId,change:{type:'snapshot',revision:++entry.revision,
     conversationState:{cwd,threadRuntimeStatus:{type:row.type,activeFlags:row.flags},
      relayThreadId:row.threadId,relayQuestions:row.questions}}}});
  }
  return true;
 }
 expire(source){
  const entry=this.sources.get(source);
  if(!entry)return;
  this.sources.delete(source);
  clearTimeout(entry.timer);
  const id='relay-'+source;
  for(const thread of entry.threads.keys())this.state.removeThread(id+':'+thread);
  this.state.removeViewer(id);
  if(!this.sources.size)this.state.disconnected('新版 Codex 转发已断开，等待重连');
 }
 stop(){
  this.stopped=true;
  for(const source of this.sources.keys())this.expire(source);
 }
}

module.exports={RelayCollector,readThreadDirectory};
