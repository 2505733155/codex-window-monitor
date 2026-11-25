'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AppServerStatus,observeLines}=require('../src/app-server.cjs');
const {startService}=require('../src/service.cjs');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');

test('app-server projection follows loaded threads, status and native requests without retaining payloads',()=>{
 const status=new AppServerStatus();
 const client=observeLines(message=>status.fromClient(message));
 const server=observeLines(message=>status.fromServer(message));
 const send=(input,event)=>input(Buffer.from(JSON.stringify(event)+'\n'));
 send(client,{id:1,method:'initialize'});send(server,{id:1,result:{}});
 send(client,{id:2,method:'thread/resume',params:{threadId:'thread-a'}});
 send(server,{id:2,result:{thread:{id:'thread-a',cwd:'D:/fixture',status:{type:'idle'},turns:[{text:'private'}]}}});
 send(server,{method:'thread/status/changed',params:{threadId:'thread-a',status:{type:'active'}}});
 send(server,{id:9,method:'item/tool/requestUserInput',params:{threadId:'thread-a',isBlocking:false,questions:[{question:'private'}]}});
 assert.equal(status.ready,true);
 assert.deepEqual(status.snapshot(),[{threadId:'thread-a',cwd:'D:/fixture',type:'active',flags:[],questions:1}]);
 send(server,{method:'serverRequest/resolved',params:{requestId:9,threadId:'thread-a'}});
 assert.equal(status.snapshot()[0].questions,0);
 send(server,{id:10,method:'item/tool/requestUserInput',params:{threadId:'thread-a',turnId:'turn-a'}});
 send(server,{method:'turn/completed',params:{threadId:'thread-a',turn:{id:'turn-a'}}});
 assert.equal(status.snapshot()[0].questions,0);
 send(server,{method:'thread/closed',params:{threadId:'thread-a'}});
 assert.deepEqual(status.snapshot(),[]);
});

test('relay status goes through the normal HTTP state API and expires independently',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-app-server-test-'));
 let service;
 try{
  service=await startService({runtimeDir:root,relay:true,relayLeaseMs:100});
  const {base,token}=service.info;
  const data={source:'11111111-1111-4111-8111-111111111111',sessions:[
   {threadId:'thread-a',cwd:'D:/fixture',type:'active',flags:[],questions:1}
  ]};
  const send=(headers,body=data)=>fetch(base+'/api/app-server',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await send({Cookie:'codex_monitor='+token})).status,403);
  assert.equal((await send({Authorization:'Bearer '+token})).status,200);
  const rows=()=>service.state.windowSnapshot().rows;
  assert.equal(rows()[0].status,'busy');
  assert.equal(rows()[0].pendingInputCount,1);
  const second={...data,source:'22222222-2222-4222-8222-222222222222',sessions:[{...data.sessions[0],cwd:'D:/other',type:'idle',questions:0}]};
  assert.equal((await send({Authorization:'Bearer '+token},second)).status,200);
  assert.deepEqual(rows().map(row=>row.status),['busy','idle']);
  assert.equal(service.state.windowSnapshot().sessionCount,1);
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.deepEqual(rows(),[]);
  assert.equal(service.state.connection,'disconnected');
 }finally{
  await service?.close();
  fs.rmdirSync(root);
 }
});

test('plugin metadata fills cwd without replacing live status or loading history rows',()=>{
 const status=new AppServerStatus();
 const client=observeLines(message=>status.fromClient(message));
 const server=observeLines(message=>status.fromServer(message));
 const send=(input,event)=>input(Buffer.from(JSON.stringify(event)+'\n'));
 send(server,{method:'thread/status/changed',params:{threadId:'thread-a',status:{type:'active'}}});
 send(client,{id:1,method:'thread/read',params:{threadId:'thread-a'}});
 send(server,{id:1,result:{thread:{id:'thread-a',cwd:'D:/fixture',status:{type:'idle'}}}});
 send(client,{id:2,method:'thread/list'});
 send(server,{id:2,result:{data:[{id:'stored-only',cwd:'D:/other',status:{type:'idle'}}]}});
 assert.deepEqual(status.snapshot(),[{threadId:'thread-a',cwd:'D:/fixture',type:'active',flags:[],questions:0}]);
});

test('relay fills the missing cwd from metadata and normalizes the Windows extended path',()=>{
 const {MonitorState}=require('../src/state.cjs');
 const {RelayCollector}=require('../src/relay-collector.cjs');
 const state=new MonitorState(),collector=new RelayCollector(state,7000,id=>id==='thread-a'?'\\\\?\\D:\\fixture':null);
 try{
  collector.accept({source:'11111111-1111-4111-8111-111111111111',sessions:[{threadId:'thread-a',cwd:'',type:'active',flags:[],questions:0}]});
  const row=state.windowSnapshot().rows[0];
  state.setPanelWorkspace(row.id,'D:/fixture');
  assert.equal(state.windowSnapshot().rows[0].status,'busy');
 }finally{collector.stop();}
});
