'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {MonitorState}=require('../src/state.cjs');
function snapshot(state,thread,owner='owner',status='idle',revision=1){
 state.ingest({type:'broadcast',method:'thread-stream-state-changed',version:13,sourceClientId:owner,params:{hostId:'local',conversationId:thread,change:{type:'snapshot',revision,conversationState:{cwd:'D:/'+thread,threadRuntimeStatus:{type:status}}}}});
}
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
