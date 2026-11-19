'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {MonitorState}=require('../src/state.cjs');
function snapshot(state,thread,owner='owner',status='idle',revision=1){
 state.ingest({type:'broadcast',method:'thread-stream-state-changed',version:13,sourceClientId:owner,params:{hostId:'local',conversationId:thread,change:{type:'snapshot',revision,conversationState:{cwd:'D:/'+thread,threadRuntimeStatus:{type:status}}}}});
}
const observation=(threadId,viewKey='webview-a')=>({threadId,viewKey});
test('different viewing panels remain separate even when their sessions share an owner',()=>{
 const s=new MonitorState();s.connected();s.setViewers('local','a',['panel-a']);s.setViewers('local','b',['panel-b']);
 snapshot(s,'a');snapshot(s,'b','owner','active');
 const rows=s.windowSnapshot().rows;assert.equal(rows.length,2);
 assert.equal(rows.find(r=>r.viewClientId==='panel-a').status,'idle');assert.equal(rows.find(r=>r.viewClientId==='panel-b').status,'busy');
 assert.equal(s.snapshot().rows.length,2);assert.ok(s.snapshot().rows.every(r=>r.ownerClientId==='owner'));
});
test('unknown panel association keeps each session visible instead of grouping by owner',()=>{
 const s=new MonitorState();s.connected();snapshot(s,'a');snapshot(s,'b');
 assert.equal(s.windowSnapshot().rows.length,2);assert.ok(s.windowSnapshot().rows.every(r=>r.displayKind==='unassigned'&&r.requiresWindowSelection));
});
test('shared sessions keep one canonical state and all viewing panels invalidate on a revision gap',()=>{
 const s=new MonitorState();s.connected();s.setViewers('local','a',['panel-a','panel-b']);snapshot(s,'a');
 let out=s.windowSnapshot();assert.equal(out.rows.length,2);assert.equal(out.sessionCount,1);assert.ok(out.rows.every(r=>r.sharedSessionCount===1));
 s.setBlocked(out.rows[0].id,true,'pause');assert.equal(s.windowSnapshot().rows[1].blocked,false);
 s.ingest({type:'broadcast',method:'thread-stream-state-changed',version:13,sourceClientId:'owner',params:{hostId:'local',conversationId:'a',change:{type:'patches',baseRevision:4,revision:5,patches:[]}}});
 assert.ok(s.windowSnapshot().rows.every(r=>r.status==='unknown'));
 snapshot(s,'a','owner','active',6);assert.ok(s.windowSnapshot().rows.every(r=>r.status==='busy'));
});
test('switching subscriptions and changing owner preserve the viewing panel identity',()=>{
 let now=1000;const s=new MonitorState({clock:()=>now});s.connected();s.setViewers('local','a',['panel']);snapshot(s,'a');
 const id=s.windowSnapshot().rows[0].id;s.setBlocked(id,true,'fixture');
 // New subscription arrives before the old one is released.
 s.setViewers('local','b',['panel']);snapshot(s,'b','other');s.setViewers('local','a',[]);s.removeThread('a');
 let row=s.windowSnapshot().rows[0];assert.equal(row.id,id);assert.equal(row.blocked,true);assert.equal(row.sessions[0].threadId,'b');
 now=2000;s.removeThread('b','new-owner');snapshot(s,'b','new-owner');
 row=s.windowSnapshot().rows[0];assert.equal(row.id,id);assert.equal(row.ownerClientId,'new-owner');
 s.disconnected();assert.equal(s.windowSnapshot().rows[0].status,'unknown');
});
test('panel identity does not borrow workspace verification from a followed session',()=>{
 const s=new MonitorState();s.connected();s.setViewers('local','a',['panel']);s.setViewers('local','b',['panel']);snapshot(s,'a');snapshot(s,'b','owner','active');s.setMapping('owner','a','ide');
 const row=s.windowSnapshot().rows[0];assert.equal(row.projectAmbiguous,true);assert.equal(row.cwd,'');assert.equal(row.requiresWindowSelection,true);assert.notEqual(row.mapping,'project-match');
});

test('current session mode uses the selected session while preserving the panel and its blocking mark',()=>{
 const s=new MonitorState({currentSession:true});s.connected();
 s.setViewers('local','old',['panel']);s.setViewers('local','now',['panel']);
 snapshot(s,'old','owner','active');snapshot(s,'now');
 let row=s.windowSnapshot().rows[0],id=row.id;
 assert.equal(row.status,'unknown');
 s.setBlocked(id,true,'waiting');
 s.setCurrentSessions([observation('now')]);
 row=s.windowSnapshot().rows[0];
 assert.equal(row.id,id);assert.equal(row.blockReason,'waiting');
 assert.equal(row.status,'idle');assert.equal(row.name,'now');assert.equal(row.currentSession,'confirmed');
 assert.deepEqual(row.sessions.map(session=>session.threadId),['now']);
 assert.equal(s.snapshot().rows.length,2);
 s.setCurrentSessions([observation('old')]);
 assert.equal(s.windowSnapshot().rows[0].status,'busy');
 assert.equal(s.windowSnapshot().rows[0].sinceKnown,false);
 s.setCurrentSessions(null);
 assert.equal(s.windowSnapshot().rows[0].status,'unknown');
 assert.equal(s.windowSnapshot().currentSession,'unavailable');
});

test('current session mode rejects shared, duplicate and conflicting panel matches',()=>{
 const s=new MonitorState({currentSession:true});s.connected();
 s.setViewers('local','shared',['panel-a','panel-b']);snapshot(s,'shared');
 s.setViewers('local','a',['panel-a']);snapshot(s,'a','owner','active');
 s.setViewers('local','other',['panel-a']);snapshot(s,'other');
 snapshot(s,'unassigned');
 for(const ids of [['shared'],['a','a'],['a','other']]){
  s.setCurrentSessions(ids.map((id,index)=>observation(id,'webview-'+index)));
  const rows=s.windowSnapshot().rows;
  assert.ok(rows.filter(row=>row.viewClientId).every(row=>row.status==='unknown'));
  assert.equal(rows.find(row=>row.displayKind==='unassigned').status,'idle');
 }
 s.setCurrentSessions([observation('a')]);s.disconnected();
 assert.equal(s.windowSnapshot().rows.find(row=>row.viewClientId==='panel-a').currentSession,'unconfirmed');
});

test('a shared conversation follows an anchored Webview and keeps its own panel state',()=>{
 const s=new MonitorState({currentSession:true});s.connected();
 const add=(id,viewers,status)=>{s.setViewers('local',id,viewers);snapshot(s,id,'owner',status);};
 add('anchor-a',['panel-a'],'active');add('anchor-b',['panel-b'],'active');add('shared',['panel-a','panel-b'],'idle');
 const panel=id=>s.windowSnapshot().rows.find(row=>row.viewClientId===id);
 s.setCurrentSessions([observation('anchor-a'),observation('anchor-b','webview-b')]);
 s.setBlocked(panel('panel-a').id,true,'pause');
 s.setCurrentSessions([observation('shared'),observation('shared','webview-b')]);
 assert.equal(panel('panel-a').status,'idle');assert.equal(panel('panel-a').blockReason,'pause');
 assert.equal(panel('panel-b').status,'idle');assert.equal(panel('panel-b').blocked,false);
 s.setViewers('local','anchor-a',['panel-a','panel-b']);
 assert.equal(panel('panel-a').currentSession,'unconfirmed');assert.equal(panel('panel-b').currentSession,'confirmed');
 s.setViewers('local','anchor-a',['panel-a']);
 assert.equal(panel('panel-a').currentSession,'unconfirmed','a disproved anchor must not be reused');
 s.setCurrentSessions([observation('shared','reloaded-b')]);
 assert.equal(panel('panel-b').currentSession,'unconfirmed');
});

test('probe loss and IPC disconnection invalidate shared-session panel anchors',()=>{
 const s=new MonitorState({currentSession:true});s.connected();
 s.setViewers('local','anchor',['panel-a']);snapshot(s,'anchor');
 s.setViewers('local','shared',['panel-a','panel-b']);snapshot(s,'shared');
 const status=()=>s.windowSnapshot().rows.find(row=>row.viewClientId==='panel-a').currentSession;
 for(const invalidate of [()=>s.setCurrentSessions(null),()=>s.removeViewer('panel-a'),()=>{s.disconnected();s.connected();}]){
  s.setViewers('local','anchor',['panel-a']);s.setViewers('local','shared',['panel-a','panel-b']);
  s.setCurrentSessions([observation('anchor')]);s.setCurrentSessions([observation('shared')]);
  assert.equal(status(),'confirmed');
  invalidate();
  s.setViewers('local','anchor',['panel-a']);s.setViewers('local','shared',['panel-a','panel-b']);
  s.setCurrentSessions([observation('shared')]);assert.equal(status(),'unconfirmed');
 }
});

test('cached IPC subscriptions cannot establish a new Webview anchor after reconnect',()=>{
 const s=new MonitorState({currentSession:true});s.connected();
 s.setViewers('local','anchor',['panel-a']);snapshot(s,'anchor');
 s.disconnected();s.connected();snapshot(s,'anchor');
 s.setCurrentSessions([observation('anchor')]);
 assert.equal(s.windowSnapshot().rows[0].currentSession,'unconfirmed');
 s.setViewers('local','anchor',['panel-a']);s.setCurrentSessions([observation('anchor')]);
 assert.equal(s.windowSnapshot().rows[0].currentSession,'confirmed');
});

test('a temporary missing active marker keeps only the anchor for a verified live document',()=>{
 const s=new MonitorState({currentSession:true});s.connected();
 s.setViewers('local','anchor',['panel-a']);snapshot(s,'anchor');
 s.setViewers('local','shared',['panel-a','panel-b']);snapshot(s,'shared');
 const row=()=>s.windowSnapshot().rows.find(row=>row.viewClientId==='panel-a');
 s.setCurrentSessions([observation('anchor')]);
 s.setCurrentSessions([],['webview-a']);
 assert.equal(row().status,'unknown');
 s.setCurrentSessions([observation('shared')],['webview-a']);
 assert.equal(row().currentSession,'confirmed');
 s.setCurrentSessions([],['another-document']);
 s.setCurrentSessions([observation('shared')],['webview-a']);
 assert.equal(row().currentSession,'unconfirmed');
});

test('a shared session is confirmed on startup when another verified Webview rules out its other viewer',()=>{
 const s=new MonitorState({currentSession:true});s.connected();
 s.setViewers('local','shared',['panel-a','panel-b']);snapshot(s,'shared','owner','active');
 s.setViewers('local','exclusive',['panel-b']);snapshot(s,'exclusive');
 const row=()=>s.windowSnapshot().rows.find(item=>item.viewClientId==='panel-a');
 s.setCurrentSessions([observation('shared'),observation('exclusive','webview-b')]);
 assert.equal(row().status,'busy');
 assert.equal(row().currentSession,'confirmed');
 s.setViewers('local','shared',['panel-a','panel-b','panel-c']);
 assert.equal(row().status,'unknown');
 s.setViewers('local','shared',['panel-a','panel-b']);
 assert.equal(row().status,'busy');
 s.setCurrentSessions([observation('shared')]);
 assert.equal(row().currentSession,'unconfirmed','losing the other document removes the exclusion');
});

test('two Webviews competing for the same remaining shared-session viewer stay unconfirmed',()=>{
 const s=new MonitorState({currentSession:true});s.connected();
 for(const thread of ['shared-a','shared-b']){
  s.setViewers('local',thread,['panel-a','panel-b']);snapshot(s,thread);
 }
 s.setViewers('local','exclusive',['panel-b']);snapshot(s,'exclusive');
 s.setCurrentSessions([observation('shared-a'),observation('shared-b','webview-c'),observation('exclusive','webview-b')]);
 assert.equal(s.windowSnapshot().rows.find(row=>row.viewClientId==='panel-a').currentSession,'unconfirmed');
});

test('blocking survives a release-first conversation switch but not panel disconnection',()=>{
 const s=new MonitorState();s.connected();s.setViewers('local','a',['panel']);snapshot(s,'a');const id=s.windowSnapshot().rows[0].id;s.setBlocked(id,true,'pause');
 s.setViewers('local','a',[]);s.removeThread('a');assert.equal(s.windowSnapshot().rows.length,0);
 s.setViewers('local','b',['panel']);snapshot(s,'b');assert.equal(s.windowSnapshot().rows[0].blocked,true);
 s.removeViewer('panel');assert.ok(s.windowSnapshot().rows.every(r=>!r.blocked));
});

test('native navigation asks for a physical window even when a session name uniquely matches', {skip:process.platform!=='win32'},async()=>{
 const {WindowNavigator}=require('../src/windows.cjs');
 const windows=[{Handle:'1',ProcessId:1,ProcessStarted:'start-1',Title:'a - Visual Studio Code',DesktopLabel:'1'},{Handle:'2',ProcessId:2,ProcessStarted:'start-2',Title:'other - Visual Studio Code',DesktopLabel:'2'}];
 let row={id:'panel:view:local',viewClientId:'view',name:'a',cwd:'D:/a',mapping:'unconfirmed',requiresWindowSelection:true};
 const calls=[],navigator=new WindowNavigator(()=>({rows:[row]}));
 navigator.native=async request=>{calls.push(request);return request.action==='list'?{windows}:{result:{Activated:true,Window:windows.find(w=>w.Handle===request.handle)}};};
 const choice=await navigator.activate({rowId:row.id});assert.equal(choice.status,'choose');assert.equal(choice.windows.length,2);assert.ok(calls.every(r=>r.action==='list'));
 await navigator.activate({rowId:row.id,choiceId:choice.windows[1].choiceId});assert.equal(calls.at(-1).handle,'2');
 // Opening a different project's conversation does not change this panel's physical binding.
 row={...row,name:'different',cwd:'D:/different'};
 assert.equal((await navigator.activate({rowId:row.id})).status,'activated');assert.equal(calls.at(-1).handle,'2');
 windows[1]={...windows[1],ProcessStarted:'replaced'};
 assert.equal((await navigator.activate({rowId:row.id})).status,'choose','reused handles cannot reuse a stale binding');navigator.close();
});
