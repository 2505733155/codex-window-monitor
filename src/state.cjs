'use strict';
const {EventEmitter}=require('node:events');
const path=require('node:path');
const {InputState}=require('./input-state.cjs');
const {STREAM_VERSIONS,supportsStreamVersion}=require('./protocol.cjs');
function normalizeDirectory(cwd){
 if(!cwd)return '';
 let value=path.win32.normalize(cwd);const root=path.win32.parse(value).root;
 while(value.length>root.length&&value.endsWith(path.win32.sep))value=value.slice(0,-1);
 return value.toLowerCase();
}
function runtime(value){
 if(!value||typeof value.type!=='string')return null;
 return {type:value.type,activeFlags:Array.isArray(value.activeFlags)?value.activeFlags.filter(v=>typeof v==='string').slice(0,20):[]};
}
function classify(value){
 if(value?.type==='idle')return ['idle','等待下一条输入'];
 if(value?.type==='active'){
  const flags=value.activeFlags||[];
  if(flags.includes('waitingOnApproval'))return ['attention','等待审批或确认操作'];
  if(flags.includes('waitingOnUserInput'))return ['idle','等待用户回答'];
  if(flags.length)return ['unknown','存在未识别的等待状态'];
  return ['busy','当前轮正在执行'];
 }
 return ['unknown',value?.type==='notLoaded'?'会话未加载':'无法确认执行状态'];
}
function inputSummary(row,connection){
 if(!row.synced||row.status==='unknown'||connection!=='connected')return {pendingInputCount:0,inputSync:'unknown',awaitingInput:false};
 const input=row.inputState?.summary()||{pendingInputCount:0,inputSync:'unknown'};
 const waiting=row.raw?.activeFlags.includes('waitingOnUserInput');
 return {...input,pendingInputCount:Math.max(input.pendingInputCount,waiting?1:0),awaitingInput:!!waiting||input.pendingInputCount>0,
  inputSync:waiting&&!input.pendingInputCount&&input.inputSync==='complete'?'partial':input.inputSync};
}
class MonitorState extends EventEmitter{
 constructor({clock=Date.now,currentSession=false}={}){super();this.clock=clock;this.rows=new Map();this.viewers=new Map();this.windowTimings=new Map();this.windowBlocks=new Map();this.connection='connecting';this.connectionReason='正在连接 Codex';this.sequence=0;this.currentSessionEnabled=currentSession;this.currentSessions=null;this.currentPanels=new Map();this.currentSessionFreshThreads=new Set();}
 changed(){this.sequence++;this.windowSnapshot();this.emit('change',this.snapshot());}
 soleViewer(threadId){
  if(!this.currentSessionFreshThreads.has(threadId))return null;
  const viewers=this.viewers.get('local:'+threadId);
  return viewers?.size===1?[...viewers][0]:null;
 }
 setCurrentSessions(observations,documentKeys=observations?.map(({viewKey})=>viewKey)){
  if(!this.currentSessionEnabled)return;
  const next=observations===null?null:[...observations].sort((a,b)=>a.viewKey.localeCompare(b.viewKey));
  const previous=this.currentPanels,panels=new Map();
  if(this.connection==='connected'&&next){
   const live=new Set(documentKeys);
   for(const [key,binding]of previous){
    if(live.has(key)&&this.soleViewer(binding.anchor)===binding.viewer)panels.set(key,binding);
   }
   const threads=new Map(),views=new Map(),claims=new Map();
   for(const {threadId,viewKey}of next){
    threads.set(threadId,(threads.get(threadId)||0)+1);
    views.set(viewKey,(views.get(viewKey)||0)+1);
   }
   for(const {threadId,viewKey}of next){
    if(!live.has(viewKey)||panels.has(viewKey)||views.get(viewKey)!==1||threads.get(threadId)!==1)continue;
    const viewer=this.soleViewer(threadId);
    if(viewer)panels.set(viewKey,{viewer,anchor:threadId});
   }
   for(const {viewer}of panels.values())claims.set(viewer,(claims.get(viewer)||0)+1);
   for(const [viewKey,{viewer}]of panels)if(claims.get(viewer)!==1||(views.get(viewKey)||0)>1)panels.delete(viewKey);
  }
  const samePanels=panels.size===previous.size&&[...panels].every(([key,{viewer,anchor}])=>{
   const before=previous.get(key);return before?.viewer===viewer&&before.anchor===anchor;
  });
  if(samePanels&&JSON.stringify(this.currentSessions)===JSON.stringify(next))return;
  this.currentSessions=next;this.currentPanels=panels;this.changed();
 }
 connected(){this.connection='connected';this.connectionReason='已连接 Codex';this.changed();}
 collectionError(error){
  const messages={IPC_FRAME_TOO_LARGE:'Codex 状态消息超过接收上限',IPC_INVALID_FRAME:'Codex 状态消息帧长度无效',IPC_INVALID_JSON:'Codex 状态消息格式无效',IPC_JSON_RESOURCE_LIMIT:'Codex 状态消息超过解析资源上限'};
  const code=Object.hasOwn(messages,error?.code)?error.code:'IPC_PROCESSING_ERROR',now=this.clock();
  const bytes=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff?value:null;
  this.diagnostic={code,message:messages[code]||'Codex 状态消息处理失败',observedBytes:bytes(error?.observedBytes),limitBytes:bytes(error?.limitBytes),lastOccurredAt:now,count:(this.diagnostic?.count||0)+1,active:true,scope:'connection'};
  this.changed();
 }
 collectionRecovered(){if(this.diagnostic?.active){this.diagnostic={...this.diagnostic,active:false};this.changed();}}
 disconnected(reason='采集连接中断'){
  this.connection='disconnected';this.connectionReason=reason;
  this.currentSessions=null;this.currentPanels.clear();this.currentSessionFreshThreads.clear();
  for(const row of this.rows.values()){row.synced=false;row.revision=null;row.minimumRevision=0;this.unknown(row,reason);}
  this.changed();
 }
 unknown(row,reason){if(row.status!=='unknown'){row.since=this.clock();row.sinceKnown=false;}row.status='unknown';row.reason=reason;}
 clientGone(clientId){for(const row of this.rows.values())if(row.ownerClientId===clientId){row.synced=false;this.unknown(row,'Codex 面板已断开');}this.changed();}
 removeClient(clientId){for(const [id,row]of this.rows)if(row.ownerClientId===clientId)this.rows.delete(id);this.changed();}
 removeThread(threadId,exceptOwner){for(const [id,row]of this.rows)if(row.threadId===threadId&&row.ownerClientId!==exceptOwner)this.rows.delete(id);if(exceptOwner===undefined){this.viewers.delete('local:'+threadId);this.currentSessionFreshThreads.delete(threadId);}this.changed();}
 setViewers(hostId,threadId,clientIds){
  if(hostId!=='local'||typeof threadId!=='string'||threadId.length>200)return;
  const viewers=new Set(clientIds.filter(id=>typeof id==='string'&&id.length>0&&id.length<=200));
  if(this.currentSessionEnabled&&this.connection==='connected'){
   if(viewers.size)this.currentSessionFreshThreads.add(threadId);else this.currentSessionFreshThreads.delete(threadId);
  }
  this.viewers.set(hostId+':'+threadId,viewers);this.changed();
 }
 removeViewer(clientId){
  for(const viewers of this.viewers.values())viewers.delete(clientId);
  this.windowBlocks.delete('panel:'+clientId+':local');this.changed();
 }
 reconcileViewers(){
  const live=new Set([...this.viewers.values()].flatMap(ids=>[...ids]).map(id=>'panel:'+id+':local'));
  for(const id of this.windowBlocks.keys())if(id.startsWith('panel:')&&!live.has(id))this.windowBlocks.delete(id);
 }
 setDirectory(row,cwd){
  const next=typeof cwd==='string'?cwd.slice(0,4096):'';
  if(normalizeDirectory(row.cwd)!==normalizeDirectory(next))row.ideClientId=null;
  row.cwd=next;row.name=next?path.win32.basename(next)||next:'未识别项目';
 }
 setMapping(ownerId,threadId,ideClientId,cwd){
  let changed=false;
  for(const row of this.rows.values())if(row.ownerClientId===ownerId&&row.threadId===threadId&&(cwd===undefined||normalizeDirectory(row.cwd)===normalizeDirectory(cwd))){row.ideClientId=ideClientId||null;changed=true;}
  if(changed)this.changed();
 }
 setBlocked(rowId,blocked,reason=''){
  if(typeof rowId!=='string'||!rowId.length||rowId.length>500||typeof blocked!=='boolean'||typeof reason!=='string'||reason.length>500)throw Object.assign(new Error('无效的阻塞标记或原因过长（最多 500 字）'),{status:400});
  if(!this.windowSnapshot().rows.some(row=>row.id===rowId))throw Object.assign(new Error('该窗口已离线，请刷新后重试'),{status:404});
  const blockReason=blocked?reason.trim():'';
  if(blocked)this.windowBlocks.set(rowId,blockReason);else this.windowBlocks.delete(rowId);
  this.changed();return {id:rowId,blocked,blockReason};
 }
 ingest(m){
  if(m?.method!=='thread-stream-state-changed'||m.type!=='broadcast')return;
  const p=m.params,c=p?.change;
  if(p?.hostId!=='local'||typeof p.conversationId!=='string'||typeof m.sourceClientId!=='string'||!c)return;
  const id=m.sourceClientId+':'+p.hostId+':'+p.conversationId;
  let row=this.rows.get(id);
  if(!row){row={id,ownerClientId:m.sourceClientId,hostId:'local',threadId:p.conversationId,cwd:'',name:'未识别项目',status:'unknown',reason:'等待完整快照',since:this.clock(),sinceKnown:false,lastSeen:null,revision:null,minimumRevision:0,synced:false,raw:null,ideClientId:null};this.rows.set(id,row);}
  const invalidate=reason=>{
   const previouslySynced=row.synced;row.synced=false;
   if(Number.isSafeInteger(c.revision)&&c.revision>=0)row.minimumRevision=Math.max(row.minimumRevision,c.revision);
   this.unknown(row,reason);this.changed();
   if(previouslySynced)this.emit('resync',{ownerClientId:row.ownerClientId,hostId:row.hostId,threadId:row.threadId});
   return false;
  };
  if(!supportsStreamVersion(m.version)){row.synced=false;const actual=Number.isSafeInteger(m.version)&&m.version>=0?m.version:'未知';this.unknown(row,'Codex 协议版本不兼容（收到 '+actual+'，支持 '+STREAM_VERSIONS.join('、')+'）');this.changed();return;}
  const before=row.status;
  if(c.type==='snapshot'){
   if(!Number.isSafeInteger(c.revision)||c.revision<0||!c.conversationState||typeof c.conversationState!=='object')return invalidate('无效的会话快照');
   if(c.revision<row.minimumRevision||row.revision!==null&&c.revision<row.revision)return false;
   const s=c.conversationState;row.raw=runtime(s.threadRuntimeStatus);
   row.inputState||=new InputState();row.inputState.snapshot(s);
   this.setDirectory(row,s.cwd);

   row.revision=c.revision;row.minimumRevision=c.revision;row.synced=true;
  }else if(c.type==='patches'){
   if(!row.synced){if(Number.isSafeInteger(c.revision)&&c.revision>=0)row.minimumRevision=Math.max(row.minimumRevision,c.revision);return false;}
   if(Number.isSafeInteger(c.revision)&&c.revision<=row.revision)return;
   if(c.baseRevision!==row.revision||!Number.isSafeInteger(c.revision)||!Array.isArray(c.patches)){
    return invalidate('状态消息不连续，正在重新同步');
   }
   for(const patch of c.patches){
    if(!patch||!['add','replace','remove'].includes(patch.op)||!Array.isArray(patch.path)&&typeof patch.path!=='string')return invalidate('无法解释状态增量，正在重新同步');
    const at=Array.isArray(patch.path)?patch.path.map(String):patch.path===''?[]:patch.path.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'));
    if(at.length===0){
     if(patch.op==='remove'||!patch.value||typeof patch.value!=='object')return invalidate('会话状态被移除，正在重新同步');
     row.raw=runtime(patch.value.threadRuntimeStatus);this.setDirectory(row,patch.value.cwd);row.inputState.snapshot(patch.value);continue;
    }
    if(at[0]==='threadRuntimeStatus'){
     if(at.length===1)row.raw=patch.op==='remove'?null:runtime(patch.value);
     else if(at.length===2&&at[1]==='type'){row.raw=runtime({...row.raw,type:patch.op==='remove'?undefined:patch.value});}
     else if(at[1]==='activeFlags'){
      row.raw||={type:'invalid',activeFlags:[]};
      if(at.length===2){if(patch.op!=='remove'&&(!Array.isArray(patch.value)||patch.value.some(v=>typeof v!=='string')))return invalidate('无效的等待状态');row.raw.activeFlags=patch.op==='remove'?[]:patch.value.slice(0,20);}
      else{const index=Number(at[2]);if(at.length!==3||!Number.isSafeInteger(index)||index<0||index>20||patch.op!=='remove'&&typeof patch.value!=='string')return invalidate('无效的等待状态增量');const flags=row.raw.activeFlags||=[];if(patch.op==='remove')flags.splice(index,1);else if(patch.op==='add')flags.splice(index,0,patch.value);else flags[index]=patch.value;}
     }else return invalidate('未知状态字段变更');
    }
    if(at.length===1&&at[0]==='cwd'&&typeof patch.value==='string')this.setDirectory(row,patch.value);
    row.inputState.patch(at,patch.op,patch.value);
   }
   row.revision=c.revision;row.minimumRevision=c.revision;
  }else return;
  const [status,reason]=classify(row.raw);row.status=status;row.reason=reason;row.lastSeen=this.clock();
  if(before!==status){row.since=this.clock();row.sinceKnown=c.type==='patches'&&before!=='unknown';}
  this.changed();return true;
 }
 windowSnapshot(){
  // Keep per-thread snapshots intact for collector ownership and revision checks.
  const snapshot=this.snapshot(),groups=new Map(),viewClients=new Map(),now=this.clock();
  const add=(id,row,viewer=null)=>{if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);viewClients.set(id,viewer);};
  const assigned=new Set();
  for(const [key,viewers]of this.viewers){
   if(!viewers.size)continue;
   const members=snapshot.rows.filter(row=>row.hostId+':'+row.threadId===key);
   const threadId=key.slice(6);
   // Keep the viewing panel visible while ownership changes or a snapshot
   // is still missing. This placeholder never confirms execution status.
   if(!members.length)members.push({id:'pending:'+key,ownerClientId:'',hostId:'local',threadId,cwd:'',name:'待识别会话',status:'unknown',reason:'等待会话拥有者的完整快照',since:now,sinceKnown:false,lastSeen:null,pendingInputCount:0,awaitingInput:false,inputSync:'unknown'});
   for(const viewer of viewers)for(const row of members){add('panel:'+viewer+':local',row,viewer);assigned.add(row.id);}
  }
  for(const row of snapshot.rows){
   if(!assigned.has(row.id))add('session:'+row.id,row);
  }
  const activeByPanel=new Map();
  if(this.connection==='connected'&&this.currentSessions){
   for(const [key,{viewer,anchor}]of this.currentPanels){
    if(this.soleViewer(anchor)!==viewer)this.currentPanels.delete(key);
   }
   const reserved=new Set([...this.currentPanels.values()].map(binding=>binding.viewer));
   const observedThreads=new Map(),remainingByView=new Map(),claims=new Map();
   for(const {threadId}of this.currentSessions)observedThreads.set(threadId,(observedThreads.get(threadId)||0)+1);
   for(const {threadId,viewKey}of this.currentSessions){
    if(this.currentPanels.has(viewKey)||observedThreads.get(threadId)!==1||!this.currentSessionFreshThreads.has(threadId))continue;
    const viewers=this.viewers.get('local:'+threadId);
    if(!viewers||viewers.size<2)continue;
    const remaining=[...viewers].filter(viewer=>!reserved.has(viewer));
    if(remaining.length!==1)continue;
    const [viewer]=remaining;
    remainingByView.set(viewKey,viewer);
    claims.set(viewer,(claims.get(viewer)||0)+1);
   }
   for(const {threadId,viewKey}of this.currentSessions){
    // Exclusions depend on live evidence and never become document anchors.
    const remaining=remainingByView.get(viewKey);
    const viewer=this.currentPanels.get(viewKey)?.viewer||(claims.get(remaining)===1?remaining:null);
    if(!viewer)continue;
    if(!this.currentSessionFreshThreads.has(threadId)||!this.viewers.get('local:'+threadId)?.has(viewer))continue;
    const id='panel:'+viewer+':local';
    const matching=groups.get(id)?.filter(row=>row.threadId===threadId)||[];
    if(matching.length===1)activeByPanel.set(id,matching[0]);
   }
  }
  const rows=[];const directory=row=>normalizeDirectory(row.cwd);
  for(const [id,followed]of groups){
   const viewClientId=viewClients.get(id);
   const experimental=this.currentSessionEnabled&&!!viewClientId;
   const active=experimental?activeByPanel.get(id):null;
   const unconfirmed=experimental&&!active;
   const members=active?[active]:followed;
   const counts={busy:0,attention:0,unknown:0,idle:0};for(const row of members)counts[row.status]++;
   const status=unconfirmed?'unknown':['busy','attention','unknown','idle'].find(value=>counts[value]>0)||'unknown';
   const candidates=members.filter(row=>row.status===status).sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0)||a.id.localeCompare(b.id));
   const representative=candidates[0]||members[0];
   // Project identity is independent of whichever session currently drives the status.
   const projects=members.filter(row=>row.cwd);
   const identityCandidates=projects;
   const projectAmbiguous=new Set(identityCandidates.map(directory)).size>1;
   const project=projectAmbiguous?null:identityCandidates.sort((a,b)=>a.id.localeCompare(b.id))[0]||representative;
   let timing=this.windowTimings.get(id);
   const sameMembers=timing&&timing.members.size===members.length&&members.every(row=>timing.members.has(row.id));
   if(!timing)timing={status,since:experimental?now:Math.min(...candidates.map(row=>row.since)),sinceKnown:false};
   else if(timing.status!==status)timing={status,since:now,sinceKnown:timing.status!=='unknown'&&status!=='unknown'&&sameMembers};
   else if(!sameMembers)timing={...timing,since:experimental?now:timing.since,sinceKnown:false};
   timing.members=new Set(members.map(row=>row.id));
   this.windowTimings.set(id,timing);
   const labels={busy:'执行中',attention:'待处理',unknown:'未知',idle:'空闲'};
   const reason=unconfirmed?'当前会话未确认':members.length===1?representative.reason:members.length+' 个会话：'+Object.keys(counts).filter(key=>counts[key]).map(key=>counts[key]+' '+labels[key]).join('，');
   const pendingInputCount=unconfirmed?0:members.reduce((sum,row)=>sum+row.pendingInputCount,0),awaitingInput=!unconfirmed&&members.some(row=>row.awaitingInput);
   const inputSync=unconfirmed?'unknown':members.every(row=>row.inputSync==='complete')?'complete':members.some(row=>row.inputSync==='unknown')?'unknown':'partial';
   const sessions=members.map(row=>({id:row.id,threadId:row.threadId,cwd:row.cwd,name:row.name,status:row.status,reason:row.reason,since:row.since,sinceKnown:row.sinceKnown,lastSeen:row.lastSeen,pendingInputCount:row.pendingInputCount,awaitingInput:row.awaitingInput,inputSync:row.inputSync,shared:(this.viewers.get(row.hostId+':'+row.threadId)?.size||0)>1}));
   const ideClientId=project?.ideClientId||null;
   const sharedSessionCount=sessions.filter(row=>row.shared).length;
   rows.push({...representative,id,viewClientId,displayKind:viewClientId?'panel':'unassigned',requiresWindowSelection:true,sharedSessionCount,name:project?.name||'多项目面板',cwd:project?.cwd||'',projectAmbiguous,blocked:this.windowBlocks.has(id),blockReason:this.windowBlocks.get(id)||'',status,reason,since:timing.since,sinceKnown:timing.sinceKnown,ideClientId,lastSeen:unconfirmed?null:Math.max(...members.map(row=>row.lastSeen||0))||null,sessionCount:sessions.length,sessions,pendingInputCount,awaitingInput,inputSync,...(experimental?{currentSession:active?'confirmed':'unconfirmed'}:{})});
  }
  for(const id of this.windowTimings.keys())if(!groups.has(id))this.windowTimings.delete(id);
  // An empty panel may just be switching conversations. Explicit client
  // disconnects (or reconnect reconciliation) clear its in-memory mark.
  for(const id of this.windowBlocks.keys())if(!groups.has(id)&&!id.startsWith('panel:'))this.windowBlocks.delete(id);
  const counts=new Map();
  for(const row of rows){const key=directory(row);if(key)counts.set(key,(counts.get(key)||0)+1);}
  for(const row of rows)row.mapping=row.projectAmbiguous||counts.get(directory(row))>1?'ambiguous':'unconfirmed';
  const sessionCount=new Set([...groups.values()].flatMap(members=>members.map(row=>row.hostId+':'+row.threadId))).size;
  return {...snapshot,sessionCount,rows,...(this.currentSessionEnabled?{currentSession:this.currentSessions===null?'unavailable':'enabled'}:{})};
 }
 snapshot(){
  const counts=new Map();for(const row of this.rows.values()){const key=row.cwd.toLowerCase();counts.set(key,(counts.get(key)||0)+1);}
  return {sequence:this.sequence,connection:this.connection,connectionReason:this.connectionReason,diagnostic:this.diagnostic||null,observedAt:this.clock(),
   rows:[...this.rows.values()].map(row=>{const {raw,synced,minimumRevision,inputState,...safe}=row;return {...safe,...inputSummary(row,this.connection),mapping:counts.get(row.cwd.toLowerCase())>1?'ambiguous':row.ideClientId?'project-match':'unconfirmed'};})};
 }
}
module.exports={MonitorState,classify,normalizeDirectory};
