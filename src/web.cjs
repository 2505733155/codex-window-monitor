'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const {randomBytes,randomUUID,timingSafeEqual}=require('node:crypto');
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function windowRequest(req){
 return new Promise((resolve,reject)=>{
  const chunks=[];let size=0,finished=false;
  const fail=(message,status=400)=>{if(finished)return;finished=true;reject(Object.assign(new Error(message),{status}));};
  req.on('data',chunk=>{if(finished)return;size+=chunk.length;if(size>8192){fail('请求过大',413);return;}chunks.push(chunk);});
  req.on('error',()=>fail('请求已中断'));req.on('aborted',()=>fail('请求已中断'));
  req.on('end',()=>{
   if(finished)return;
   let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('无效的窗口请求');return;}
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['rowId','choiceId'].includes(key))||typeof value.rowId!=='string'||!value.rowId.length||value.rowId.length>500||value.choiceId!==undefined&&(typeof value.choiceId!=='string'||!/^[a-f0-9-]{36}$/.test(value.choiceId))){fail('无效的窗口请求');return;}
   finished=true;resolve(value);
  });
 });
}
async function createWeb(state,{port=0,token=randomBytes(32).toString('hex'),instanceId=randomUUID(),onStop=()=>{},onWindow,startupTimeoutMs=60000,idleTimeoutMs=10000}={}){
 const clients=new Set();let updateTimer,exitTimer,stopping=false,closed=false,base;
 function requestStop(){
  if(stopping||closed)return;stopping=true;clearTimeout(exitTimer);
  setImmediate(()=>{if(!closed)onStop();});
 }
 function scheduleStop(delay){
  clearTimeout(exitTimer);
  exitTimer=setTimeout(()=>{if(!clients.size)requestStop();},delay);exitTimer.unref();
 }
 const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
 function sendState(res){if(!res.write('event: state\ndata: '+JSON.stringify(state.windowSnapshot())+'\n\n'))res.destroy();}
 const changed=()=>{if(!updateTimer)updateTimer=setTimeout(()=>{updateTimer=null;for(const res of clients)sendState(res);},75);};
 const server=http.createServer((req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};
  function json(status,value){res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
  const host=req.headers.host;
  if(host!=='127.0.0.1:'+server.address().port&&host!=='localhost:'+server.address().port){json(403,{error:'invalid host'});return;}
  if(req.headers.origin&&req.headers.origin!=='http://'+host){json(403,{error:'invalid origin'});return;}
  let url;try{url=new URL(req.url,'http://'+host);}catch{json(400,{error:'invalid URL'});return;}
  const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('codex_monitor='))?.slice('codex_monitor='.length);
  const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):undefined;
  if(req.method==='GET'&&url.pathname==='/'&&equal(url.searchParams.get('key'),token)){
   res.writeHead(303,{...headers,'Set-Cookie':'codex_monitor='+token+'; HttpOnly; SameSite=Strict; Path=/','Location':'/'});res.end();return;
  }
  if(!equal(cookie,token)&&!equal(bearer,token)){json(403,{error:'请使用启动入口打开面板'});return;}
  if(req.method==='GET'&&url.pathname==='/health'){json(200,{app:'codex-window-monitor',instanceId});return;}
  if(req.method==='GET'&&url.pathname==='/api/state'){json(200,state.windowSnapshot());return;}
  if(req.method==='POST'&&url.pathname==='/api/window'){
   if(stopping){req.resume();json(503,{error:'监控正在停止'});return;}
   if(!onWindow){req.resume();json(501,{error:'当前服务不支持窗口跳转'});return;}
   if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){req.resume();json(415,{error:'请发送 JSON 窗口请求'});return;}
   windowRequest(req).then(value=>onWindow(value)).then(value=>{if(!res.destroyed&&!res.writableEnded)json(200,value);}).catch(error=>{
    if(!res.destroyed&&!res.writableEnded)json(Number.isInteger(error.status)&&error.status>=400&&error.status<600?error.status:500,{error:error.status?error.message:'窗口操作失败，请重试'});
   });return;
  }
  if(req.method==='GET'&&url.pathname==='/events'){
   if(stopping){json(503,{error:'监控正在停止，请使用启动入口重新打开'});return;}
   res.writeHead(200,{...headers,'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive'});
   clearTimeout(exitTimer);clients.add(res);
   res.once('close',()=>{clients.delete(res);if(!closed&&!stopping&&!clients.size)scheduleStop(idleTimeoutMs);});
   sendState(res);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/stop'){
   req.resume();json(200,{stopping:true});requestStop();return;
  }
  const asset=assets.get(url.pathname);
  if(req.method==='GET'&&asset){
   try{const body=fs.readFileSync(path.join(__dirname,'../public',asset[0]));res.writeHead(200,{...headers,'Content-Type':asset[1]});res.end(body);}
   catch{json(500,{error:'页面文件缺失'});}return;
  }
  json(404,{error:'not found'});
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 base='http://127.0.0.1:'+server.address().port;
 scheduleStop(startupTimeoutMs);
 state.on('change',changed);
 const heartbeat=setInterval(()=>{for(const res of clients)if(!res.write('event: heartbeat\ndata: '+Date.now()+'\n\n'))res.destroy();},10000);heartbeat.unref();
 let closePromise;
 function close(){
  if(closePromise)return closePromise;
  closed=true;stopping=true;
  clearTimeout(exitTimer);clearInterval(heartbeat);clearTimeout(updateTimer);state.off('change',changed);
  for(const res of clients)res.end();clients.clear();
  closePromise=new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});return closePromise;
 }
 return {server,url:base+'/?key='+token,base,token,instanceId,close};
}
module.exports={createWeb};
