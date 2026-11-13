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
test('large valid snapshots above 64 MiB decode without losing the next frame or retaining chat',()=>{
 const state=new MonitorState();state.connected();let messages=0;
 const decoder=new FrameDecoder(message=>{messages++;state.ingest(message);});
 const prefix=Buffer.from('{"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"fixture-owner","params":{"hostId":"local","conversationId":"fixture-thread","change":{"type":"snapshot","revision":1,"conversationState":{"cwd":"D:/fixture","threadRuntimeStatus":{"type":"idle"},"turns":[{"text":"');
 const suffix=Buffer.from('"}]}}}}'),chunk=Buffer.alloc(1024*1024,120),header=Buffer.alloc(4);
 header.writeUInt32LE(prefix.length+65*chunk.length+suffix.length);
 decoder.push(Buffer.concat([header,prefix]));
 for(let n=0;n<65;n++)decoder.push(chunk);
 decoder.push(Buffer.concat([suffix,encode({type:'fixture-marker'})]));
 assert.equal(messages,2);assert.equal(state.snapshot().rows[0].status,'idle');
 assert.ok(JSON.stringify([...state.rows.values()]).length<10000);
 assert.doesNotMatch(JSON.stringify([...state.rows.values()]),/x{32}/);
});
test('default decoder still rejects excessive declared frame sizes before allocating a body',()=>{
 const decoder=new FrameDecoder(()=>assert.fail('No oversized message should be delivered'));
 const header=Buffer.alloc(4);header.writeUInt32LE(1024*1024*1024);
 assert.throws(()=>decoder.push(header),/frame/i);assert.equal(decoder.body,null);
});
test('collection diagnostics expose only stable metadata and survive reconnect until recovery',()=>{
 const state=new MonitorState({clock:()=>1000});state.connected();state.ingest(snap());
 state.collectionError({code:'IPC_FRAME_TOO_LARGE',observedBytes:300*1024*1024,limitBytes:256*1024*1024,message:'SECRET RAW PAYLOAD'});
 state.disconnected();state.connected();const diagnostic=state.snapshot().diagnostic;
 assert.equal(diagnostic.code,'IPC_FRAME_TOO_LARGE');assert.equal(diagnostic.active,true);assert.equal(diagnostic.observedBytes,314572800);assert.equal(diagnostic.limitBytes,268435456);assert.equal(diagnostic.count,1);
 state.collectionError({code:'IPC_FRAME_TOO_LARGE',observedBytes:314572800,limitBytes:268435456});assert.equal(state.snapshot().diagnostic.count,2);
 assert.doesNotMatch(JSON.stringify(state.snapshot()),/SECRET/);state.collectionRecovered();assert.equal(state.snapshot().diagnostic.active,false);
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
test('audited stream versions 11 and 13 coexist while unaudited versions remain unknown',()=>{
 const state=new MonitorState();state.connected();state.ingest(snap('legacy'));
 state.ingest({...snap('modern',{type:'active',activeFlags:[]}),version:13});
 assert.equal(state.snapshot().rows.find(row=>row.ownerClientId==='modern').status,'busy');assert.equal(state.windowSnapshot().rows.length,2);
 state.ingest({...patch(1,2,{type:'active',activeFlags:['waitingOnApproval']},'modern'),version:13});assert.equal(state.snapshot().rows.find(row=>row.ownerClientId==='modern').status,'attention');
 state.ingest({...snap('unsupported'),version:12});const unsupported=state.snapshot().rows.find(row=>row.ownerClientId==='unsupported');
 assert.equal(unsupported.status,'unknown');assert.match(unsupported.reason,/12/);assert.match(unsupported.reason,/11.*13/);
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

function projectSession(thread,cwd,type='idle',revision=1,owner='owner'){
 const message=snap(owner,{type},revision);message.params.conversationId=thread;message.params.change.conversationState.cwd=cwd;return message;
}

test('window identity prefers the verified workspace independently of session status and recency',()=>{
 let now=1000;const state=new MonitorState({clock:()=>now});state.connected();
 state.ingest(projectSession('current','D:/fixture-current'));state.setMapping('owner','current','ide-current');
 const id=state.windowSnapshot().rows[0].id;state.setBlocked(id,true,'fixture note');
 now=5000;state.ingest(projectSession('history','D:/fixture-history','active'));
 let row=state.windowSnapshot().rows[0];
 assert.equal(row.name,'fixture-current');assert.equal(row.cwd,'D:/fixture-current');assert.equal(row.ideClientId,'ide-current');assert.equal(row.mapping,'project-match');
 assert.equal(row.status,'busy');assert.equal(row.sessionCount,2);assert.equal(row.lastSeen,5000);assert.equal(row.blocked,true);assert.equal(row.blockReason,'fixture note');
 assert.deepEqual(row.sessions.map(value=>value.cwd).sort(),['D:/fixture-current','D:/fixture-history']);
 now=9000;state.ingest(projectSession('history','D:/fixture-history','idle',2));row=state.windowSnapshot().rows[0];
 assert.equal(row.name,'fixture-current');assert.equal(row.status,'idle');assert.equal(row.id,id);
 assert.equal(state.snapshot().rows.find(value=>value.threadId==='history').name,'fixture-history','raw collector state remains per-session');
});

test('window identity exposes conflicting project directories instead of guessing from the latest session',()=>{
 const state=new MonitorState();state.connected();state.ingest(projectSession('first','D:/fixture-first'));state.ingest(projectSession('second','D:/fixture-second','active'));
 let row=state.windowSnapshot().rows[0];assert.equal(row.name,'多项目窗口');assert.equal(row.cwd,'');assert.equal(row.mapping,'ambiguous');assert.equal(row.status,'busy');
 state.setMapping('owner','first','ide-first');assert.equal(state.windowSnapshot().rows[0].name,'fixture-first');
 state.setMapping('owner','second','ide-second');row=state.windowSnapshot().rows[0];
 assert.equal(row.name,'多项目窗口');assert.equal(row.cwd,'');assert.equal(row.ideClientId,null);assert.equal(row.mapping,'ambiguous');assert.equal(row.sessionCount,2);
});

test('window identity normalizes verified directories and detects duplicate windows after identity selection',()=>{
 const state=new MonitorState();state.connected();state.ingest(projectSession('current','D:/Fixture-Current'));state.setMapping('owner','current','ide-current');
 const same=projectSession('same','d:/fixture-current/');state.ingest(same);state.setMapping('owner','same','ide-current');
 state.ingest(projectSession('history','D:/fixture-history','active'));let row=state.windowSnapshot().rows[0];
 assert.equal(row.name,'Fixture-Current');assert.equal(row.mapping,'project-match');assert.equal(row.sessionCount,3);
 state.ingest(projectSession('other','d:/fixture-current','idle',1,'another-owner'));
 const rows=state.windowSnapshot().rows;assert.equal(rows.length,2);assert.ok(rows.every(value=>value.mapping==='ambiguous'),'directory ambiguity uses the selected display identity');
});

test('workspace mapping expires on directory changes and rejects late results for old directories',()=>{
 const state=new MonitorState();state.connected();state.ingest(projectSession('moving','D:/fixture-a'));state.setMapping('owner','moving','ide-a');
 state.ingest(projectSession('moving','D:/fixture-b','idle',2));assert.equal(state.snapshot().rows[0].ideClientId,null);
 state.setMapping('owner','moving','late-ide-a','D:/fixture-a');assert.equal(state.snapshot().rows[0].ideClientId,null);
 state.setMapping('owner','moving','ide-b','D:/fixture-b');
 const update=projectSession('moving','D:/fixture-b','idle',3);update.params.change={type:'patches',baseRevision:2,revision:3,patches:[{op:'replace',path:['cwd'],value:'D:/fixture-c'}]};state.ingest(update);
 assert.equal(state.snapshot().rows[0].ideClientId,null);
 state.setMapping('owner','moving','ide-c','D:/fixture-c');update.params.change={type:'patches',baseRevision:3,revision:4,patches:[{op:'replace',path:[],value:{cwd:'D:/fixture-d',threadRuntimeStatus:{type:'idle'}}}]};state.ingest(update);
 assert.equal(state.snapshot().rows[0].ideClientId,null);
});

test('window identity preserves drive roots while normalizing equivalent directories',()=>{
 const state=new MonitorState();state.connected();state.ingest(projectSession('root-a','D:/'));state.setMapping('owner','root-a','ide-root');
 state.ingest(projectSession('root-b','D:'+String.fromCharCode(92)));state.setMapping('owner','root-b','ide-root');
 let row=state.windowSnapshot().rows[0];assert.equal(row.mapping,'project-match');assert.ok(row.cwd);assert.equal(row.projectAmbiguous,false);
 state.ingest(projectSession('another-root','d:/','idle',1,'another-owner'));
 assert.ok(state.windowSnapshot().rows.every(value=>value.mapping==='ambiguous'));
});
