'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {MonitorState}=require('../src/state.cjs');
const question={type:'agentMessage',id:'call_test',delivery:'async',questions:[{title:'SECRET QUESTION',options:[]},{title:'SECOND SECRET'}]};
const qid='["request_user_input_async","call_test",0]';
const reply=(status='accepted',ids=[qid])=>({type:'steeringUserMessage',status,input:[{type:'text',text:'<send_user_message_question_reply>\n'+JSON.stringify(ids.map(questionItemId=>({questionItemId,question:'SECRET QUESTION',answer:''})))+'\n</send_user_message_question_reply>'}]});
function harness(items=[question],complete=true){
 const state=new MonitorState();state.connected();let revision=1;
 const send=change=>state.ingest({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'thread',change}});
 const snapshot=(values=items,isComplete=complete)=>send({type:'snapshot',revision:revision++,conversationState:{cwd:'D:/fixture',threadRuntimeStatus:{type:'active',activeFlags:[]},turnHistory:{kind:'canonical',history:{isComplete,entitiesByKey:{'tail/0':{items:values}}}}}});
 snapshot();
 return {state,snapshot,row:()=>state.windowSnapshot().rows[0],patch:(path,value,op='replace')=>send({type:'patches',baseRevision:revision-1,revision:revision++,patches:[{op,path,value}]})};
}
test('async questions preserve busy timing and accepted replies clear only matching IDs without retaining bodies',()=>{
 const h=harness([question,{type:'tool',output:'SECRET OUTPUT'}]);const since=h.row().since;
 assert.equal(h.row().pendingInputCount,2);assert.equal(h.row().awaitingInput,true);assert.equal(h.row().status,'busy');assert.equal(h.row().inputSync,'complete');
 h.patch('/turnHistory/history/entitiesByKey/tail~10/items/-',reply('queued'),'add');assert.equal(h.row().pendingInputCount,2);
 h.patch('/turnHistory/history/entitiesByKey/tail~10/items/2/status','accepted');assert.equal(h.row().pendingInputCount,1);assert.equal(h.row().since,since);
 h.patch(['turnHistory','history','entitiesByKey','tail/0','items',3],reply('accepted',['["request_user_input_async","call_test",1]']),'add');
 assert.equal(h.row().pendingInputCount,0);assert.equal(h.row().awaitingInput,false);
 assert.doesNotMatch(JSON.stringify([...h.state.rows.values()]),/SECRET|SECOND|OUTPUT|send_user_message_question_reply/);
});
test('partial history and broken metadata updates never claim complete zero; snapshot recovers',()=>{
 const h=harness([],false);assert.equal(h.row().inputSync,'partial');
 h.patch(['turnHistory','history','entitiesByKey','absent','items',0],question,'add');assert.equal(h.row().inputSync,'unknown');assert.equal(h.row().status,'busy');
 h.snapshot([question]);assert.equal(h.row().inputSync,'partial');
 h.snapshot([question],true);assert.equal(h.row().inputSync,'complete');assert.equal(h.row().pendingInputCount,2);
 h.state.disconnected();assert.equal(h.row().awaitingInput,false);assert.equal(h.row().inputSync,'unknown');
});
test('ordinary user replies, empty skip answers, removal and native waiting markers are supported',()=>{
 const accepted={...reply(),type:'userMessage',content:reply().input};delete accepted.input;
 const h=harness([question,accepted]);assert.equal(h.row().pendingInputCount,1);
 h.patch(['turnHistory','history','entitiesByKey','tail/0','items',0],undefined,'remove');assert.equal(h.row().pendingInputCount,0);
 h.patch(['threadRuntimeStatus'],{type:'active',activeFlags:['waitingOnUserInput']});assert.equal(h.row().status,'idle');assert.equal(h.row().awaitingInput,true);assert.equal(h.row().inputSync,'partial');
 h.state.setBlocked(h.row().id,true,'fixture');assert.equal(h.row().blocked,true);
});
test('inherited questions are excluded and malformed replies do not silently clear pending work',()=>{
 const h=harness([question,reply('rejected')]);assert.equal(h.row().pendingInputCount,2);
 h.patch(['turnHistory','history','entitiesByKey','tail/0','inherited'],true,'add');assert.equal(h.row().pendingInputCount,0);
 h.snapshot([question,{type:'userMessage',content:[{type:'text',text:'<send_user_message_question_reply>broken</send_user_message_question_reply>'}]}]);
 assert.equal(h.row().pendingInputCount,2);assert.equal(h.row().inputSync,'unknown');
});
test('nullable optional fields and unrelated text patches do not spoil synchronization',()=>{
 const h=harness([{type:'agentMessage',id:'ordinary',delivery:null,questions:null},question]);
 assert.equal(h.row().inputSync,'complete');
 h.patch(['turnHistory','history','entitiesByKey','tail/0','items',1,'questions',0,'title'],'ANOTHER SECRET');
 assert.equal(h.row().inputSync,'complete');assert.equal(h.row().pendingInputCount,2);
 h.patch(['turnHistory','kind'],'unsupported');assert.equal(h.row().inputSync,'unknown');
});
test('oversized question arrays are unconfirmed and root replacement clears stale questions',()=>{
 const h=harness([{...question,questions:Array.from({length:10001},()=>({title:'SECRET'}))}]);
 assert.equal(h.row().inputSync,'unknown');assert.doesNotMatch(JSON.stringify([...h.state.rows.values()]),/SECRET/);
 h.snapshot([question],true);assert.equal(h.row().pendingInputCount,2);
 h.patch(['turnHistory','history','entitiesByKey','tail/0','items',1],reply('queued'),'add');
 h.patch(['turnHistory','history','entitiesByKey','tail/0','items',1,'steerAcknowledged'],true,'add');assert.equal(h.row().pendingInputCount,1);
 h.patch([], {cwd:'D:/fixture',threadRuntimeStatus:{type:'idle'}});assert.equal(h.row().awaitingInput,false);assert.equal(h.row().inputSync,'unknown');
});
test('pending counts aggregate by owner and host while revision gaps invalidate their own session',()=>{
 const h=harness();
 const conversationState={cwd:'D:/other',threadRuntimeStatus:{type:'idle'},turnHistory:{kind:'canonical',history:{isComplete:true,entitiesByKey:{turn:{items:[{...question,id:'second-call'}]}}}}};
 const second={type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'second',change:{type:'snapshot',revision:1,conversationState}}};
 h.state.ingest(second);assert.equal(h.row().sessionCount,2);assert.equal(h.row().pendingInputCount,4);assert.equal(h.row().status,'busy');
 h.state.ingest({...second,sourceClientId:'separate'});assert.equal(h.state.windowSnapshot().rows.length,2);
 h.state.ingest({...second,params:{...second.params,change:{type:'patches',baseRevision:3,revision:4,patches:[]}}});
 assert.equal(h.row().status,'busy');assert.equal(h.row().pendingInputCount,2);assert.equal(h.row().inputSync,'unknown');
});
test('projection exhaustion never crashes ingestion or disconnects the collector',()=>{
 const h=harness(Array.from({length:10000},()=>({...question,id:'fixture',questions:[{},{}],input:[]})));
 assert.equal(h.row().status,'busy');assert.equal(h.row().inputSync,'unknown');
});
test('reply identifiers share the projection budget rather than growing without a bound',()=>{
 const ids=Array.from({length:1000},(_,i)=>JSON.stringify(['request_user_input_async','fixture',i]));
 const h=harness(Array.from({length:100},()=>reply('accepted',ids)));
 assert.equal(h.row().inputSync,'unknown');assert.ok(JSON.stringify([...h.state.rows.values()]).length<2000000);
});
test('long histories preserve current questions without retaining unrelated reasoning and tool metadata',()=>{
 const history=Array.from({length:7500},(_,index)=>({type:index%2?'reasoning':'tool',id:'unused-'+index,content:[{type:'text',text:'SECRET HISTORY'}],input:[{type:'text',text:'SECRET TOOL INPUT'}],output:'SECRET OUTPUT'}));
 const h=harness([...history,question,reply()],false);
 assert.equal(h.row().pendingInputCount,1);assert.equal(h.row().awaitingInput,true);assert.equal(h.row().inputSync,'partial');assert.equal(h.row().status,'busy');
 assert.doesNotMatch(JSON.stringify([...h.state.rows.values()]),/SECRET|unused-/);
 const at=['turnHistory','history','entitiesByKey','tail/0','items'];
 h.patch([...at,0,'content',0,'text'],'SECRET UPDATED');assert.equal(h.row().inputSync,'partial');
 h.patch([...at,0],undefined,'remove');
 h.patch([...at,0],{type:'reasoning',id:'unused-added',content:[{type:'text',text:'SECRET NEW'}]},'add');
 h.patch([...at,7502],reply('accepted',['["request_user_input_async","call_test",1]']),'add');
 assert.equal(h.row().pendingInputCount,0);assert.equal(h.row().inputSync,'partial');
 h.patch([...at,7502],undefined,'remove');assert.equal(h.row().pendingInputCount,1);
 h.patch([...at,0],{...question,id:'replacement'},'replace');assert.equal(h.row().pendingInputCount,3);
 assert.doesNotMatch(JSON.stringify([...h.state.rows.values()]),/SECRET|unused-/);
});
test('unrelated assistant text and tool fields cannot invalidate question tracking',()=>{
 const h=harness([{type:'agentMessage',id:'ordinary',delivery:null,questions:null,content:'SECRET ASSISTANT',input:{arguments:'SECRET TOOL'}},question]);
 assert.equal(h.row().inputSync,'complete');assert.equal(h.row().pendingInputCount,2);
 h.patch(['turnHistory','history','entitiesByKey','tail/0','items',0,'content'],'SECRET UPDATE');
 assert.equal(h.row().inputSync,'complete');assert.doesNotMatch(JSON.stringify([...h.state.rows.values()]),/SECRET/);
});
test('accepted steering replies retain the content fallback in snapshots and patches',()=>{
 const message={...reply(),content:reply().input};delete message.input;
 const h=harness([question,message]);assert.equal(h.row().pendingInputCount,1);assert.equal(h.row().inputSync,'complete');
 h.patch(['turnHistory','history','entitiesByKey','tail/0','items',1,'content'],reply('accepted',['["request_user_input_async","call_test",1]']).input);
 assert.equal(h.row().pendingInputCount,1);
 h.patch(['turnHistory','history','entitiesByKey','tail/0','items',2],message,'add');assert.equal(h.row().pendingInputCount,0);
});
