'use strict';
// Loaded Codex histories can exceed 64 MiB. Keep a finite wire-frame limit;
// MonitorState separately bounds the metadata retained after decoding.
const MAX_BYTES=256*1024*1024;
function encode(message){const body=Buffer.from(JSON.stringify(message));const out=Buffer.allocUnsafe(4+body.length);out.writeUInt32LE(body.length);body.copy(out,4);return out;}
class FrameDecoder{
 constructor(onMessage,{maxBytes=MAX_BYTES,streaming=false}={}){this.onMessage=onMessage;this.maxBytes=maxBytes;this.streaming=streaming;this.header=Buffer.alloc(4);this.headerUsed=0;this.body=null;this.remaining=0;this.used=0;}
 discard(){this.parser=null;this.body=null;this.remaining=0;this.used=0;this.headerUsed=0;}
 push(chunk){
  let offset=0;
  while(offset<chunk.length){
   if(!this.body&&!this.remaining){
    const n=Math.min(4-this.headerUsed,chunk.length-offset);chunk.copy(this.header,this.headerUsed,offset);offset+=n;this.headerUsed+=n;
    if(this.headerUsed<4)continue;
    const size=this.header.readUInt32LE();this.headerUsed=0;
    if(size<2||size>this.maxBytes)throw Object.assign(new Error('Invalid IPC frame length'),{code:size>this.maxBytes?'IPC_FRAME_TOO_LARGE':'IPC_INVALID_FRAME',observedBytes:size,limitBytes:this.maxBytes});
    if(this.streaming){this.parser=new (require('./stream-json.cjs').ProjectedJSON)();this.remaining=size;}
    else{this.body=Buffer.allocUnsafe(size);this.used=0;}
   }
   if(this.streaming){
    const n=Math.min(this.remaining,chunk.length-offset);this.parser.push(chunk.subarray(offset,offset+n));offset+=n;this.remaining-=n;
    if(!this.remaining){const parser=this.parser;this.parser=null;this.onMessage(parser.finish());}continue;
   }
   const n=Math.min(this.body.length-this.used,chunk.length-offset);chunk.copy(this.body,this.used,offset);this.used+=n;offset+=n;
   if(this.used===this.body.length){const body=this.body;this.body=null;this.used=0;let message;try{message=JSON.parse(body.toString('utf8'));}catch{throw new Error('Invalid IPC JSON');}this.onMessage(message);}
  }
 }
}
function validateOutbound(m){
 const fail=()=>{throw new Error('Read-only IPC message rejected');};
 if(!m||typeof m!=='object')fail();
 if(m.type==='client-discovery-response'){if(m.response?.canHandle!==false)fail();return true;}
 if(m.type==='request'){
  if(m.method==='initialize'){if(m.params?.clientType!=='codex-window-monitor')fail();}
  else if(m.method==='thread-owner-discovery'){if(m.params?.hostId!=='local'||typeof m.params.conversationId!=='string'||m.version!==1)fail();}
  else if(m.method==='ide-context'){if(typeof m.params?.workspaceRoot!=='string')fail();}
  else fail();
 }else if(m.type==='broadcast'){
  if(m.method!=='thread-stream-following-changed'||m.version!==1||typeof m.params?.following!=='boolean'||m.params.hostId!=='local'||typeof m.params.conversationId!=='string')fail();
 }else fail();
 return true;
}
module.exports={encode,FrameDecoder,validateOutbound};
