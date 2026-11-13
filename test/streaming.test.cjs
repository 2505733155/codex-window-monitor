'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {FrameDecoder,encode}=require('../src/protocol.cjs');const {MonitorState}=require('../src/state.cjs');
const question={type:'agentMessage',id:'call_fixture',delivery:'async',questions:[{title:'SECRET QUESTION',options:['SECRET OPTION']}],text:'SECRET CHAT'};
const replyText='<send_user_message_question_reply>'+JSON.stringify([{questionItemId:'["request_user_input_async","call_fixture",0]',question:'SECRET QUESTION',answer:'SECRET ANSWER'}])+'</send_user_message_question_reply>';
const snapshot={type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'thread',change:{type:'snapshot',revision:1,conversationState:{cwd:'D:/fixture/中文',threadRuntimeStatus:{type:'active',activeFlags:[]},turns:[{output:'SECRET OUTPUT'}],turnHistory:{kind:'canonical',history:{isComplete:true,entitiesByKey:{turn:{rootTurnId:'root',params:{input:[{type:'text',text:'SECRET USER REQUEST'}]},items:[{type:'reasoning',id:'reason',content:[{type:'text',text:'SECRET REASONING'}]},question]}},islands:[{entries:[{key:'turn',value:'turn'}],newerBoundary:{status:'exhausted'}}]}}}}}};
function decode(message,bytewise=false){const out=[];const decoder=new FrameDecoder(m=>out.push(m),{streaming:true});const bytes=encode(message);if(bytewise)for(const byte of bytes)decoder.push(Buffer.from([byte]));else decoder.push(bytes);return {out,decoder};}
test('streamed snapshots preserve status and questions while discarding chat, reasoning and output',()=>{
 const {out}=decode(snapshot,true);assert.equal(out.length,1);assert.doesNotMatch(JSON.stringify(out),/SECRET/);
 const state=new MonitorState({clock:()=>1000});state.connected();state.ingest(out[0]);const row=state.windowSnapshot().rows[0];
 assert.equal(row.cwd,'D:/fixture/中文');assert.equal(row.status,'busy');assert.equal(row.pendingInputCount,1);assert.equal(row.inputSync,'complete');
 for(const patches of [[{op:'add',path:['turnHistory','history','entitiesByKey','turn','items','-'],value:{type:'userMessage',content:[{type:'text',text:replyText}]}}],[{value:replyText,path:'/turnHistory/history/entitiesByKey/turn/items/2/content/0/text',op:'replace'}]]){
  const message={...snapshot,params:{...snapshot.params,change:{type:'patches',baseRevision:1,revision:2,patches}}};
  const projected=decode(message,true).out[0];assert.doesNotMatch(JSON.stringify(projected),/SECRET/);
  if(patches[0].op==='add')state.ingest(projected);
 }
 assert.equal(state.windowSnapshot().rows[0].pendingInputCount,0);
});
test('version 13 streaming keeps pending questions and clears accepted replies',()=>{
 const state=new MonitorState();state.connected();state.ingest(decode({...snapshot,version:13},true).out[0]);
 assert.equal(state.windowSnapshot().rows[0].pendingInputCount,1);assert.equal(state.windowSnapshot().rows[0].inputSync,'complete');
 state.ingest(decode({...snapshot,version:13,params:{...snapshot.params,change:{type:'patches',baseRevision:1,revision:2,patches:[{op:'add',path:['turnHistory','history','entitiesByKey','turn','items','-'],value:{type:'userMessage',content:[{type:'text',text:replyText}]}}]}}},true).out[0]);
 assert.equal(state.windowSnapshot().rows[0].status,'busy');assert.equal(state.windowSnapshot().rows[0].pendingInputCount,0);
});
test('streaming consumes a large irrelevant string without a whole-frame buffer and aligns following frames',()=>{
 const out=[],decoder=new FrameDecoder(m=>out.push(m),{streaming:true});
 const prefix=Buffer.from('{"type":"broadcast","params":{"ignored":"'),suffix=Buffer.from('","hostId":"local"}}'),chunk=Buffer.alloc(1024*1024,120),header=Buffer.alloc(4);
 header.writeUInt32LE(prefix.length+65*chunk.length+suffix.length);decoder.push(Buffer.concat([header,prefix]));
 assert.ok(decoder.body===null,'streaming must not allocate the advertised frame body');
 for(let n=0;n<65;n++)decoder.push(chunk);
 decoder.push(Buffer.concat([suffix,encode({type:'response',requestId:'r',resultType:'success',result:{clientId:'observer'}})]));
 assert.equal(out.length,2);assert.equal(out[0].params.hostId,'local');assert.equal(out[1].result.clientId,'observer');assert.ok(JSON.stringify(out).length<1000);
});
test('streaming validates JSON even inside discarded fields',()=>{
 for(const raw of ['{"ignored":"bad\\q"}','{"ignored":[1,]}','{"ignored":{"a":1,}}','{"ignored":01}','{"ignored":"line\nfeed"}','{"type":"response"} true']){
  const body=Buffer.from(raw),header=Buffer.alloc(4);header.writeUInt32LE(body.length);
  assert.throws(()=>new FrameDecoder(()=>assert.fail('Malformed JSON must not be delivered'),{streaming:true}).push(Buffer.concat([header,body])),/JSON|resource/i,raw);
 }
});
test('oversized headers expose a stable diagnostic without allocating the body',()=>{
 const d=new FrameDecoder(()=>assert.fail(),{streaming:true,maxBytes:1024});const h=Buffer.alloc(4);h.writeUInt32LE(2048);
 assert.throws(()=>d.push(h),error=>error.code==='IPC_FRAME_TOO_LARGE'&&error.observedBytes===2048&&error.limitBytes===1024);assert.equal(d.body,null);
});
test('streaming drops unknown field names and bounds selected scalar arrays',()=>{
 const {out}=decode({type:'response',params:{'SECRET FIELD':false},'SECRET TOP':[]});assert.doesNotMatch(JSON.stringify(out),/SECRET/);
 const value={...snapshot,params:{...snapshot.params,change:{...snapshot.params.change,conversationState:{threadRuntimeStatus:{type:'active',activeFlags:Array(100001).fill(null)}}}}};
 assert.throws(()=>decode(value),error=>error.code==='IPC_JSON_RESOURCE_LIMIT');
});
test('patch values preceding their paths preserve replies and skip large irrelevant output',()=>{
 const patches=[{value:'SECRET OUTPUT'.repeat(30000),path:['turnHistory','history','entitiesByKey','turn','items',0,'output'],op:'replace'},
  {value:replyText,path:['turnHistory','history','entitiesByKey','turn','items',2,'content',0,'text'],op:'replace'},
  {value:{rootTurnId:'root',items:[question,{type:'userMessage',content:[{type:'text',text:replyText}]}]},op:'replace',path:['turnHistory','history','entitiesByKey','turn']}];
 const message={...snapshot,params:{...snapshot.params,change:{type:'patches',baseRevision:1,revision:2,patches}}};
 const {out}=decode(message);assert.doesNotMatch(JSON.stringify(out),/SECRET/);
 const state=new MonitorState({clock:()=>1000});state.connected();state.ingest(decode(snapshot).out[0]);
 // The intermediate text patch targets a missing item, so use the final
 // whole-entity replacement to check order-independent metadata conversion.
 out[0].params.change.patches.splice(1,1);state.ingest(out[0]);assert.equal(state.windowSnapshot().rows[0].pendingInputCount,0);
});
test('escaped keys, split unicode escapes, empty containers and primitive tokens preserve JSON semantics',()=>{
 const raw='{"ty\\u0070e":"response","requestId":"\\u4e2d\\u6587","version":1e1,"params":{"following":true,"ignored":{"k":[null,false,{},[]]}},"result":{"clientId":"a\\\\b\\\"c"}}';
 const body=Buffer.from(raw),h=Buffer.alloc(4);h.writeUInt32LE(body.length);const out=[];const d=new FrameDecoder(m=>out.push(m),{streaming:true});
 for(const byte of Buffer.concat([h,body]))d.push(Buffer.from([byte]));
 assert.equal(out[0].type,'response');assert.equal(out[0].requestId,'中文');assert.equal(out[0].version,10);assert.equal(out[0].params.following,true);assert.equal(out[0].result.clientId,'a\\b"c');
});
test('value-first array patches are equivalent to path-first patches for every metadata array',()=>{
 const cases=[[['turnHistory','history','entitiesByKey','turn','items'],[question]],
 [['turnHistory','history','entitiesByKey','turn','params','input'],[{type:'text',text:replyText}]],
 [['turnHistory','history','islands',0,'entries'],[{key:'turn',value:'turn'}]],
 [['turnHistory','history','islands'],[{entries:[{key:'turn'}],newerBoundary:{status:'exhausted'}}]]];
 for(const [path,value]of cases){
  const message=patch=>({...snapshot,params:{...snapshot.params,change:{type:'patches',baseRevision:1,revision:2,patches:[patch]}}});
  const states=[{value,path,op:'replace'},{path,value,op:'replace'}].map(patch=>{
   const state=new MonitorState({clock:()=>1000});state.connected();state.ingest(decode(snapshot).out[0]);state.ingest(decode(message(patch),true).out[0]);return state.windowSnapshot();
  });
  assert.deepEqual(states[0],states[1],path.join('/'));
 }
});
test('invalid UTF-8 and a UTF-8 BOM produce stable JSON diagnostics',()=>{
 for(const body of [Buffer.from([0x7b,0x22,0xc0,0xaf,0x22,0x3a,0x31,0x7d]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{"type":"response"}')])]){
  const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
  assert.throws(()=>new FrameDecoder(()=>assert.fail(),{streaming:true}).push(Buffer.concat([header,body])),error=>error.code==='IPC_INVALID_JSON');
 }
});
test('discarding an incomplete stream releases it and permits a new connection frame',()=>{
 const out=[],d=new FrameDecoder(m=>out.push(m),{streaming:true});d.push(encode(snapshot).subarray(0,100));d.discard();
 assert.equal(d.parser,null);assert.ok(d.body===null);d.push(encode({type:'response',requestId:'fresh',resultType:'success',result:{clientId:'fresh'}}));
 assert.equal(out.length,1);assert.equal(out[0].requestId,'fresh');
});
test('long reasoning histories do not consume the selected metadata budget',()=>{
 for(const typeFirst of [true,false]){
  const items=[...Array.from({length:7500},()=>{const fields={id:'unused',content:Array.from({length:3},()=>({type:'text',text:'SECRET REASONING'})),input:[{type:'text',text:'SECRET INPUT'}]};return typeFirst?{type:'reasoning',...fields}:{...fields,type:'reasoning'};}),question];
  const message=structuredClone(snapshot);message.params.change.conversationState.turnHistory.history.entitiesByKey.turn.items=items;
  const state=new MonitorState({clock:()=>1000});state.connected();const projected=decode(message).out[0];state.ingest(projected);
  assert.equal(state.windowSnapshot().rows[0].pendingInputCount,1);assert.equal(state.windowSnapshot().rows[0].inputSync,'complete');assert.doesNotMatch(JSON.stringify(projected),/SECRET/);
  for(const patch of [{value:items,path:['turnHistory','history','entitiesByKey','turn','items'],op:'replace'},{path:['turnHistory','history','entitiesByKey','turn','items'],value:items,op:'replace'}]){
   state.ingest(decode({...snapshot,params:{...snapshot.params,change:{type:'patches',baseRevision:state.snapshot().rows[0].revision,revision:state.snapshot().rows[0].revision+1,patches:[patch]}}}).out[0]);assert.equal(state.windowSnapshot().rows[0].pendingInputCount,1);assert.equal(state.windowSnapshot().rows[0].inputSync,'complete');
  }
 }
});
test('large discarded content can be streamed under a small V8 heap budget',()=>{
 const {spawnSync}=require('node:child_process');
 const script=`const {FrameDecoder}=require('./src/protocol.cjs');let count=0;const d=new FrameDecoder(()=>count++,{streaming:true});const a=Buffer.from('{"type":"broadcast","ignored":"'),b=Buffer.from('"}'),h=Buffer.alloc(4),chunk=Buffer.alloc(1048576,120);h.writeUInt32LE(a.length+65*chunk.length+b.length);d.push(Buffer.concat([h,a]));for(let i=0;i<65;i++)d.push(chunk);d.push(b);if(count!==1||d.body!==null)process.exit(1);`;
 const result=spawnSync(process.execPath,['--max-old-space-size=32','-e',script],{cwd:require('node:path').join(__dirname,'..'),encoding:'utf8',timeout:15000,windowsHide:true});
 assert.equal(result.status,0,(result.stderr||result.error?.message||'').slice(0,500));
});
