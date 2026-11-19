'use strict';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const methods=new Set(['Page.getFrameTree','Target.getTargetInfo','DOM.getDocument','DOM.getFrameOwner',
 'DOM.describeNode','DOM.pushNodesByBackendIdsToFrontend','DOM.querySelectorAll','DOM.getAttributes']);
const attribute='data-above-composer-conversation-id';
const selector='[data-app-shell-active-page="true"] ['+attribute+']:not([data-app-shell-active-page="false"] *)';

function validDebugPort(port){return Number.isInteger(port)&&port>=1&&port<=65535;}

async function connect(url,signal,run){
 const socket=new WebSocket(url),pending=new Map();
 let id=0;
 const stop=()=>{
  for(const {reject}of pending.values())reject(new Error('调试连接已关闭'));
  pending.clear();
  if(socket.readyState===WebSocket.CONNECTING||socket.readyState===WebSocket.OPEN)socket.close();
 };
 signal.addEventListener('abort',stop,{once:true});
 socket.addEventListener('close',stop);
 socket.addEventListener('message',event=>{
  if(typeof event.data!=='string'){stop();return;}
  if(event.data.startsWith('{"method":'))return;
  if(event.data.length>1024*1024){stop();return;}
  let response;try{response=JSON.parse(event.data);}catch{stop();return;}
  const request=pending.get(response.id);
  if(!request)return;
  pending.delete(response.id);
  if(response.error)request.reject(new Error('调试命令未获确认'));
  else request.resolve(response.result);
 });
 try{
  signal.throwIfAborted();
  await new Promise((resolve,reject)=>{
   socket.addEventListener('open',resolve,{once:true});
   socket.addEventListener('close',()=>reject(new Error('调试连接未建立')),{once:true});
   socket.addEventListener('error',()=>reject(new Error('调试连接未建立')),{once:true});
  });
  return await run((method,params={})=>{
   signal.throwIfAborted();
   if(!methods.has(method)||socket.readyState!==WebSocket.OPEN)throw new Error('调试连接不可用');
   return new Promise((resolve,reject)=>{
    const requestId=++id;
    socket.send(JSON.stringify({id:requestId,method,params}));
    pending.set(requestId,{resolve,reject});
   });
  });
 }finally{
  signal.removeEventListener('abort',stop);
  stop();
 }
}

function frames(tree){
 const queue=[tree],entries=[];
 while(queue.length){
  const node=queue.pop();
  if(typeof node?.frame?.id!=='string'||entries.length+queue.length>=64)throw new Error('调试帧列表无效');
  entries.push(node.frame);
  queue.push(...(node.childFrames||[]));
 }
 return entries;
}

async function readMarkers(send,entries){
 const {root}=await send('DOM.getDocument',{depth:0});
 const [rootFrame,...childFrames]=entries;
 const childDocuments=[];
 for(const frame of childFrames){
  const {backendNodeId}=await send('DOM.getFrameOwner',{frameId:frame.id});
  const {node}=await send('DOM.describeNode',{backendNodeId,depth:0,pierce:true});
  if(node.contentDocument?.backendNodeId)childDocuments.push({frame,backendNodeId:node.contentDocument.backendNodeId});
 }
 const {nodeIds:children}=childDocuments.length
  ?await send('DOM.pushNodesByBackendIdsToFrontend',{backendNodeIds:childDocuments.map(doc=>doc.backendNodeId)})
  :{nodeIds:[]};
 const documents=[{frame:rootFrame,nodeId:root.nodeId},...children.map((nodeId,i)=>({nodeId,frame:childDocuments[i].frame}))];
 let marker;
 for(const {frame,nodeId}of documents){
  const {nodeIds}=await send('DOM.querySelectorAll',{nodeId,selector});
  if(!Array.isArray(nodeIds)||nodeIds.length>32)return [null];
  for(const id of nodeIds){
   const {attributes}=await send('DOM.getAttributes',{nodeId:id});
   if(!Array.isArray(attributes))return [null];
   const index=attributes.findIndex((value,i)=>i%2===0&&value===attribute);
   const value=index<0?null:attributes[index+1];
   if(typeof value!=='string'||!uuid.test(value))return [null];
   if(marker&&(marker.threadId!==value||marker.frameId!==frame.id))return [null];
   marker={threadId:value,frameId:frame.id,loaderId:frame.loaderId};
  }
 }
 if(!marker)return [];
 if(typeof marker.loaderId!=='string'||!marker.loaderId)return [null];
 return [marker];
}

async function listTargets(fetch,port,signal){
 const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal,redirect:'error'});
 if(!response.ok||!response.body)throw new Error('无法读取调试页面列表');
 const reader=response.body.getReader(),chunks=[];
 let size=0;
 try{
  for(;;){
   const {value,done}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   if(size>256*1024)throw new Error('调试页面列表过大');
   chunks.push(value);
  }
 }finally{await reader.cancel();}
 const targets=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
 if(!Array.isArray(targets)||targets.length>128)throw new Error('调试页面列表无效');
 return targets.filter(target=>{
  if(typeof target?.id!=='string'||!/^[\w-]{1,100}$/.test(target.id))return false;
  if(target.webSocketDebuggerUrl!=='ws://127.0.0.1:'+port+'/devtools/page/'+target.id)return false;
  if(target.type==='page')return /^vscode-file:\/\/vscode-app\/(?:.*\/)?workbench(?:-dev)?\.html(?:[?#]|$)/.test(target.url);
  return target.type==='iframe'&&/^vscode-webview:\/\/[^/]+\//.test(target.url);
 });
}

async function readCurrentSessions(port,{signal,fetch=globalThis.fetch,connect:open=connect}={}){
 if(!validDebugPort(port))throw new Error('无效的 VS Code 调试端口');
 const timeout=AbortSignal.timeout(4500);
 const deadline=signal?AbortSignal.any([signal,timeout]):timeout;
 const targets=await listTargets(fetch,port,deadline);
 const pages=targets.filter(target=>target.type==='page');
 const views=targets.filter(target=>target.type==='iframe');
 const workbenches=await Promise.all(pages.map(page=>open(page.webSocketDebuggerUrl,deadline,
  async send=>new Set(frames((await send('Page.getFrameTree')).frameTree).map(frame=>frame.id)))));
 const observations=await Promise.all(views.map(view=>open(view.webSocketDebuggerUrl,deadline,async send=>{
  const {targetInfo}=await send('Target.getTargetInfo');
  const parents=workbenches.flatMap((tree,index)=>tree.has(targetInfo?.parentFrameId)?[index]:[]);
  if(parents.length!==1)return null;
  const entries=frames((await send('Page.getFrameTree')).frameTree);
  const markers=await readMarkers(send,entries).catch(()=>[null]);
  const checked=frames((await send('Page.getFrameTree')).frameTree);
  const keyFor=(id,loaderId)=>JSON.stringify([pages[parents[0]].id,view.id,id,loaderId]);
  const before=new Set(entries.filter(frame=>frame.loaderId).map(frame=>keyFor(frame.id,frame.loaderId)));
  const documentKeys=checked.filter(frame=>frame.loaderId).map(frame=>keyFor(frame.id,frame.loaderId)).filter(key=>before.has(key));
  const marker=markers[0];
  const viewKey=marker&&keyFor(marker.frameId,marker.loaderId);
  return {parent:parents[0],documentKeys,hasMarker:markers.length>0,
   observation:viewKey&&documentKeys.includes(viewKey)?{threadId:marker.threadId,viewKey}:null};
 })));
 const byWindow=new Map();
 const documentKeys=[];
 for(const view of observations.filter(Boolean)){
  documentKeys.push(...view.documentKeys);
  if(!view.hasMarker)continue;
  byWindow.set(view.parent,byWindow.has(view.parent)?null:view.observation);
 }
 return {observations:[...byWindow.values()].filter(Boolean),documentKeys};
}

class CurrentSessionProbe{
 constructor(port,onUpdate){
  this.port=port;this.onUpdate=onUpdate;this.controller=new AbortController();
 }
 start(){this.read();}
 async read(){
  const signal=this.controller.signal;
  let selected=null;
  try{selected=await readCurrentSessions(this.port,{signal});}catch{}
  if(signal.aborted)return;
  this.onUpdate(selected);
  this.timer=setTimeout(()=>this.read(),1500);
  this.timer.unref();
 }
 close(){clearTimeout(this.timer);this.controller.abort();}
}

module.exports={CurrentSessionProbe,readCurrentSessions,validDebugPort};
