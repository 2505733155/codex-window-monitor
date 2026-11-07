const {test}=require('node:test');
const assert=require('node:assert/strict');
const {encode,FrameDecoder,validateOutbound}=require('../src/protocol.cjs');
const {MonitorState}=require('../src/state.cjs');
const snap=(owner='owner',status={type:'idle'},revision=1)=>({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:owner,params:{hostId:'local',conversationId:'thread',change:{type:'snapshot',revision,conversationState:{cwd:'D:\\中文项目',threadRuntimeStatus:status,requests:[],turns:[{text:'never retain this'}]}}}});
const patch=(base,revision,status,owner='owner')=>({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:owner,params:{hostId:'local',conversationId:'thread',change:{type:'patches',baseRevision:base,revision,patches:[{op:'replace',path:['threadRuntimeStatus'],value:status}]}}});
test('frames handle UTF-8 split at every byte and concatenated packets',()=>{
 const frames=[{name:'中文状态'},{status:'idle'}];const out=[];const decoder=new FrameDecoder(m=>out.push(m));
 for(const byte of Buffer.concat(frames.map(encode)))decoder.push(Buffer.from([byte]));
 assert.deepEqual(out,frames);
});
test('oversized and invalid JSON frames are rejected',()=>{
 const decoder=new FrameDecoder(()=>{}, {maxBytes:32});const header=Buffer.alloc(4);header.writeUInt32LE(33);
 assert.throws(()=>decoder.push(header),/frame/i);
 const bad=Buffer.from([2,0,0,0,123,34]);assert.throws(()=>new FrameDecoder(()=>{}).push(bad),/JSON/i);
});
test('outbound whitelist refuses task mutation, unknown and malformed subscription messages',()=>{
 assert.throws(()=>validateOutbound({type:'request',method:'turn/start',params:{}}),/read.only/i);
 assert.throws(()=>validateOutbound({type:'broadcast',method:'thread-stream-following-changed',params:{following:'yes'}}));
 assert.equal(validateOutbound({type:'broadcast',method:'thread-stream-following-changed',version:1,params:{conversationId:'t',hostId:'local',following:true}}),true);
});
test('state classifies real waiting flags without retaining chat bodies',()=>{
 const state=new MonitorState();state.connected();
 for(const [raw,want] of [[{type:'idle'},'idle'],[{type:'active',activeFlags:[]},'busy'],[{type:'active',activeFlags:['waitingOnUserInput']},'idle'],[{type:'active',activeFlags:['waitingOnApproval']},'attention'],[{type:'notLoaded'},'unknown']]){
  state.ingest(snap('owner',raw));assert.equal(state.snapshot().rows[0].status,want);
 }
 assert.ok(!JSON.stringify(state.snapshot()).includes('never retain'));
});
test('same directory instances remain distinct, and disconnect invalidates both',()=>{
 const state=new MonitorState();state.connected();state.ingest(snap());state.ingest(snap('second'));
 assert.equal(state.snapshot().rows.length,2);assert.ok(state.snapshot().rows.every(r=>r.mapping==='ambiguous'));
 state.disconnected('offline');assert.ok(state.snapshot().rows.every(r=>r.status==='unknown'));
});
test('revision gap cannot resurrect idle through later patches',()=>{
 const state=new MonitorState();state.connected();state.ingest(snap('owner',{type:'active'},1));
 let resync=0;state.on('resync',()=>resync++);
 state.ingest(patch(2,3,{type:'idle'}));state.ingest(patch(3,4,{type:'idle'}));
 assert.equal(state.snapshot().rows[0].status,'unknown');assert.equal(resync,1);
 state.ingest(snap('owner',{type:'idle'},5));assert.equal(state.snapshot().rows[0].status,'idle');
 state.ingest(patch(1,2,{type:'active'}));assert.equal(state.snapshot().rows[0].status,'idle');
});
test('initial duration is lower bound and duplicate snapshots preserve timer',()=>{
 let now=1000;const state=new MonitorState({clock:()=>now});state.connected();state.ingest(snap());
 now=5000;state.ingest(snap());assert.equal(state.snapshot().rows[0].since,1000);assert.equal(state.snapshot().rows[0].sinceKnown,false);
 state.ingest(patch(1,2,{type:'active'}));assert.equal(state.snapshot().rows[0].since,5000);assert.equal(state.snapshot().rows[0].sinceKnown,true);
});
test('unsupported versions and malformed status patches never retain confirmed idle',()=>{
 const state=new MonitorState();state.connected();state.ingest(snap());
 const message=patch(1,2,{type:'active'});message.version=999;state.ingest(message);
 assert.equal(state.snapshot().rows[0].status,'unknown');
 state.ingest(snap('owner',{type:'idle'},3));state.ingest(patch(3,4,{type:'made-up'}));
 assert.equal(state.snapshot().rows[0].status,'unknown');
});
test('stale recovery snapshots cannot cross the last observed revision watermark',()=>{
 const state=new MonitorState();state.connected();state.ingest(snap('owner',{type:'active'},10));
 state.ingest(patch(11,12,{type:'idle'}));state.ingest(snap('owner',{type:'idle'},1));assert.equal(state.snapshot().rows[0].status,'unknown');
 state.ingest(snap('owner',{type:'idle'},11));assert.equal(state.snapshot().rows[0].status,'unknown');
 state.ingest(snap('owner',{type:'idle'},12));assert.equal(state.snapshot().rows[0].status,'idle');
 state.disconnected();state.connected();state.ingest(snap('owner',{type:'idle'},1));assert.equal(state.snapshot().rows[0].status,'idle');
});
test('root replacement extracts current status; root removal and invalid operations resync',()=>{
 const state=new MonitorState();state.connected();state.ingest(snap());
 const replacement=patch(1,2,{type:'idle'});replacement.params.change.patches=[{op:'replace',path:[],value:{cwd:'D:\\replacement',threadRuntimeStatus:{type:'active'},turns:[{text:'private'}]}}];
 state.ingest(replacement);assert.equal(state.snapshot().rows[0].status,'busy');assert.equal(state.snapshot().rows[0].name,'replacement');
 let requests=0;state.on('resync',()=>requests++);
 const removal=patch(2,3,{type:'idle'});removal.params.change.patches=[{op:'remove',path:[]}];state.ingest(removal);
 assert.equal(state.snapshot().rows[0].status,'unknown');assert.equal(requests,1);
 state.ingest(snap('owner',{type:'idle'},4));const invalid=patch(4,5,{type:'active'});invalid.params.change.patches[0].op='move';state.ingest(invalid);
 assert.equal(state.snapshot().rows[0].status,'unknown');assert.equal(requests,2);
});

test('manual blocking belongs to a window without changing session status or duration',()=>{
 let now=1000;const state=new MonitorState({clock:()=>now});state.connected();state.ingest(snap());state.ingest(snap('second'));
 const another=snap();another.params.conversationId='other-thread';state.ingest(another);
 const row=state.windowSnapshot().rows.find(row=>row.ownerClientId==='owner'),since=row.since;
 now=5000;state.setBlocked(row.id,true,'  等待外部资料  ');
 let blocked=state.windowSnapshot().rows.find(value=>value.id===row.id);
 assert.equal(blocked.blocked,true);assert.equal(blocked.blockReason,'等待外部资料');assert.equal(blocked.since,since);assert.equal(blocked.status,'idle');assert.equal(blocked.sessionCount,2);
 assert.equal(state.windowSnapshot().rows.find(value=>value.ownerClientId==='second').blocked,false);
 assert.ok(state.snapshot().rows.every(value=>value.blocked===undefined),'collector snapshots stay per-session and unchanged');
 state.ingest(patch(1,2,{type:'active'}));blocked=state.windowSnapshot().rows.find(value=>value.id===row.id);
 assert.equal(blocked.blocked,true);assert.equal(blocked.status,'busy');assert.equal(blocked.blockReason,'等待外部资料');
 state.setBlocked(row.id,true,'');assert.equal(state.windowSnapshot().rows.find(value=>value.id===row.id).blockReason,'');
 state.setBlocked(row.id,false);blocked=state.windowSnapshot().rows.find(value=>value.id===row.id);
 assert.equal(blocked.blocked,false);assert.equal(blocked.blockReason,'');assert.equal(blocked.status,'busy');
});

test('manual blocking validates input and is forgotten when the window is removed',()=>{
 const state=new MonitorState();state.connected();state.ingest(snap());const id=state.windowSnapshot().rows[0].id;
 assert.throws(()=>state.setBlocked(id,'yes',''),{status:400});
 assert.throws(()=>state.setBlocked(id,true,'x'.repeat(501)),{status:400});
 assert.throws(()=>state.setBlocked('missing',true,''),{status:404});
 state.setBlocked(id,true,'暂缓');state.disconnected();assert.equal(state.windowSnapshot().rows[0].blocked,true);
 state.removeClient('owner');state.ingest(snap());assert.equal(state.windowSnapshot().rows[0].blocked,false);
});
