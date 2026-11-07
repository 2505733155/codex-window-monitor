const {test}=require('node:test');const assert=require('node:assert/strict');
const {createWeb}=require('../src/web.cjs');const {MonitorState}=require('../src/state.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check){for(let n=0;n<100;n++){if(check())return;await wait(10);}assert.fail('timed out waiting for monitor shutdown');}
async function openStream(web){
 const controller=new AbortController();
 const response=await fetch(web.base+'/events',{headers:{Authorization:'Bearer '+web.token},signal:controller.signal});
 assert.equal(response.status,200);const reader=response.body.getReader();await reader.read();
 return async()=>{controller.abort();await reader.cancel().catch(()=>{});};
}
test('HTTP auth, cookie bootstrap, Origin isolation, SSE and authenticated stop',async t=>{
 const state=new MonitorState();let stopped=0;
 const web=await createWeb(state,{port:0,onStop:()=>stopped++});t.after(()=>web.close());
 const base=new URL('/',web.url).href;const headers={Authorization:'Bearer '+web.token};
 assert.equal((await fetch(base+'api/state')).status,403);
 const bootstrap=await fetch(web.url,{redirect:'manual'});assert.equal(bootstrap.status,303);
 const cookie=bootstrap.headers.get('set-cookie').split(';')[0];
 const page=await fetch(base,{headers:{Cookie:cookie}});assert.equal(page.status,200);assert.match(page.headers.get('cache-control'),/no-store/);
 assert.equal((await fetch(base+'api/state',{headers:{...headers,Origin:'https://unrelated.example'}})).status,403);
 assert.equal((await fetch(base+'api/state',{headers})).status,200);
 const controller=new AbortController();const stream=await fetch(base+'events',{headers,signal:controller.signal});
 const reader=stream.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: state/);
 controller.abort();await reader.cancel().catch(()=>{});
 assert.equal((await fetch(base+'api/stop',{method:'POST'})).status,403);assert.equal(stopped,0);
 assert.equal((await fetch(base+'api/stop',{method:'POST',headers})).status,200);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,1);
});

test('startup without a browser expires even with authenticated health and unauthorized event requests',async t=>{
 let stopped=0;const web=await createWeb(new MonitorState(),{startupTimeoutMs:100,onStop:()=>stopped++});t.after(()=>web.close());
 assert.equal((await fetch(web.base+'/events')).status,403);
 assert.equal((await fetch(web.base+'/health',{headers:{Authorization:'Bearer '+web.token}})).status,200);
 await waitFor(()=>stopped===1);
 assert.equal((await fetch(web.base+'/events',{headers:{Authorization:'Bearer '+web.token}})).status,503);
 await wait(130);assert.equal(stopped,1);
});

test('multiple browser streams keep monitoring until the last disconnect and its grace expires',async t=>{
 let stopped=0;const web=await createWeb(new MonitorState(),{startupTimeoutMs:100,idleTimeoutMs:80,onStop:()=>stopped++});t.after(()=>web.close());
 const first=await openStream(web);const second=await openStream(web);t.after(first);t.after(second);
 await wait(150);assert.equal(stopped,0,'a live background stream cancels startup expiry');
 await first();await wait(130);assert.equal(stopped,0,'another browser is still connected');
 await second();await wait(25);assert.equal(stopped,0,'last browser gets a grace period');
 await waitFor(()=>stopped===1);
});

test('refresh and repeated reconnects cancel the last-disconnect timer',async t=>{
 let stopped=0;const web=await createWeb(new MonitorState(),{startupTimeoutMs:1000,idleTimeoutMs:160,onStop:()=>stopped++});t.after(()=>web.close());
 let disconnect=await openStream(web);t.after(async()=>disconnect());
 for(let n=0;n<2;n++){
  await disconnect();await wait(30);disconnect=await openStream(web);await wait(200);assert.equal(stopped,0);
 }
 await disconnect();await waitFor(()=>stopped===1);
});

test('explicit close cancels startup and last-disconnect shutdown timers',async()=>{
 let stopped=0;const options={startupTimeoutMs:80,idleTimeoutMs:80,onStop:()=>stopped++};
 const neverOpened=await createWeb(new MonitorState(),options);await neverOpened.close();
 const opened=await createWeb(new MonitorState(),options);const disconnect=await openStream(opened);await disconnect();await opened.close();
 await wait(160);assert.equal(stopped,0);
});

test('manual stop wins over a pending automatic shutdown and only notifies once',async t=>{
 let stopped=0;const web=await createWeb(new MonitorState(),{startupTimeoutMs:80,onStop:()=>stopped++});t.after(()=>web.close());
 for(let n=0;n<2;n++)assert.equal((await fetch(web.base+'/api/stop',{method:'POST',headers:{Authorization:'Bearer '+web.token}})).status,200);
 await wait(160);assert.equal(stopped,1);
});

test('blocking API authenticates, validates and synchronizes manual notes to two SSE clients',{timeout:5000},async t=>{
 const state=new MonitorState();state.connected();state.ingest({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'owner',params:{hostId:'local',conversationId:'thread',change:{type:'snapshot',revision:1,conversationState:{cwd:'D:\\example',threadRuntimeStatus:{type:'idle'}}}}});
 const web=await createWeb(state);t.after(()=>web.close());const id=state.windowSnapshot().rows[0].id;
 const headers={Authorization:'Bearer '+web.token,'Content-Type':'application/json'};
 const post=(value,extra={})=>fetch(web.base+'/api/block',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
 const body={rowId:id,blocked:true,reason:'<img src=x onerror=alert(1)> 等资料'};
 assert.equal((await fetch(web.base+'/api/block',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
 assert.equal((await post(body,{Origin:'https://unrelated.example'})).status,403);
 assert.equal((await post(body,{'Content-Type':'text/plain'})).status,415);
 for(const value of [null,[],{...body,blocked:'yes'},{...body,reason:42},{...body,reason:'x'.repeat(501)},{...body,extra:true}])assert.equal((await post(value)).status,400);
 assert.equal((await post({...body,reason:'x'.repeat(9000)})).status,413);
 assert.equal((await post({...body,rowId:'missing'})).status,404);
 async function watch(){
  const controller=new AbortController();const response=await fetch(web.base+'/events',{headers,signal:controller.signal});const reader=response.body.getReader();
  t.after(async()=>{controller.abort();await reader.cancel().catch(()=>{});});let buffer='';
  return async()=>{while(true){const end=buffer.indexOf('\n\n');if(end>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=event.match(/^data: (.+)$/m);if(event.startsWith('event: state')&&data)return JSON.parse(data[1]);}else{const part=await reader.read();assert.equal(part.done,false);buffer+=new TextDecoder().decode(part.value);}}};
 }
 const first=await watch(),second=await watch();await first();await second();
 assert.equal((await post(body)).status,200);
 for(const snapshot of await Promise.all([first(),second()])){assert.equal(snapshot.rows[0].blocked,true);assert.equal(snapshot.rows[0].blockReason,body.reason);assert.equal(snapshot.rows[0].status,'idle');}
 const refreshed=await (await fetch(web.base+'/api/state',{headers})).json();assert.equal(refreshed.rows[0].blockReason,body.reason);
 assert.equal((await post({rowId:id,blocked:false})).status,200);
 for(const snapshot of await Promise.all([first(),second()])){assert.equal(snapshot.rows[0].blocked,false);assert.equal(snapshot.rows[0].blockReason,'');}
 assert.equal((await fetch(web.base+'/api/stop',{method:'POST',headers})).status,200);
 assert.equal((await post(body)).status,503);
});
