'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readCurrentSessions}=require('../src/current-session.cjs');

const first='a1234567-1234-1234-1234-123456789abc';
const second='b1234567-1234-1234-1234-123456789abc';
const base='http://127.0.0.1:9222';
const page={id:'page-1',type:'page',url:'vscode-file://vscode-app/workbench.html'};
const frame={id:'iframe-1',type:'iframe',url:'vscode-webview://example/index.html'};

function fixture(targets,values){
 const requests=[];
 const listing=targets.map(target=>({webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/'+target.id,...target}));
 const read=(id,method,params)=>{
  requests.push([id,method]);
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:id+'-root',loaderId:id+'-outer'},childFrames:[{frame:{id:id+'-child',loaderId:targets.find(target=>target.id===id).loader||id+'-inner'}}]}};
  if(method==='Target.getTargetInfo')return {targetInfo:{parentFrameId:targets.find(target=>target.id===id).parent||'page-1-root'}};
  if(method==='DOM.getDocument')return {root:{nodeId:1}};
  if(method==='DOM.getFrameOwner')return {backendNodeId:3};
  if(method==='DOM.describeNode')return {node:{contentDocument:{backendNodeId:4}}};
  if(method==='DOM.pushNodesByBackendIdsToFrontend')return {nodeIds:[2]};
  if(method==='DOM.querySelectorAll')return {nodeIds:params.nodeId===2?(values[id]||[]).map((_,i)=>10+i):[]};
  if(method==='DOM.getAttributes')return {attributes:['data-above-composer-conversation-id',values[id][params.nodeId-10]]};
  throw new Error('unexpected method');
 };
 const fetch=async(url,options)=>{
  assert.equal(url,base+'/json/list');assert.equal(options.redirect,'error');
  return new Response(JSON.stringify(listing));
 };
 const connect=async(url,signal,run)=>run((method,params)=>read(new URL(url).pathname.split('/').at(-1),method,params));
 return {requests,options:{fetch,connect}};
}

test('reads only local Codex Webview markers with a unique workbench parent',async()=>{
 const foreign={...frame,id:'foreign',webSocketDebuggerUrl:'ws://example.com/devtools/page/foreign'};
 const orphan={...frame,id:'orphan',parent:'missing'};
 const {options,requests}=fixture([page,frame,foreign,orphan],{'iframe-1':[first],foreign:[second],orphan:[second]});
 const {observations,documentKeys}=await readCurrentSessions(9222,options);
 assert.deepEqual(observations,[{threadId:first,viewKey:'["page-1","iframe-1","iframe-1-child","iframe-1-inner"]'}]);
 assert.ok(documentKeys.includes(observations[0].viewKey));
 assert.ok(!requests.some(([id,method])=>id==='foreign'||id==='orphan'&&method==='DOM.querySelectorAll'));
});

test('the Webview identity survives a conversation switch and changes on document reload',async()=>{
 const read=(target,id)=>readCurrentSessions(9222,fixture([page,target],{'iframe-1':[id]}).options);
 const [initial]=(await read(frame,first)).observations;
 const [switched]=(await read(frame,second)).observations;
 const [reloaded]=(await read({...frame,loader:'new-document'},second)).observations;
 assert.equal(initial.viewKey,switched.viewKey);
 assert.notEqual(switched.viewKey,reloaded.viewKey);
});

test('fails closed on ambiguous active markers or competing Webviews in a window',async()=>{
 const ambiguous=fixture([page,frame],{'iframe-1':[first,second]});
 assert.deepEqual((await readCurrentSessions(9222,ambiguous.options)).observations,[]);
 const competing=fixture([page,frame,{...frame,id:'iframe-2'}],{'iframe-1':[first],'iframe-2':[second]});
 assert.deepEqual((await readCurrentSessions(9222,competing.options)).observations,[]);
});

test('a blank Webview still reports the same live document identity',async()=>{
 const {options}=fixture([page,frame],{});
 const {observations,documentKeys}=await readCurrentSessions(9222,options);
 assert.deepEqual(observations,[]);
 assert.ok(documentKeys.includes('["page-1","iframe-1","iframe-1-child","iframe-1-inner"]'));
});
