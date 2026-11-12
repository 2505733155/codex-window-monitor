'use strict';
const {TextDecoder}=require('node:util');
const {compactReply,historyProjection,fieldsFor,itemProjection}=require('./input-state.cjs');
const ANY=Symbol('patch-value'),ELEMENT=Symbol('array-element'),PATCH=Symbol('patch'),SKIP=Symbol('skip');
const conversation={cwd:'path',threadRuntimeStatus:{type:'type',activeFlags:['type']},turnHistory:historyProjection};
const patchShape={op:'type',path:['path'],value:ANY};
const islandShape=historyProjection.history.islands[0];
const elementShape={...itemProjection,text:'reply',entries:islandShape.entries,newerBoundary:islandShape.newerBoundary,key:'id'};
const commonElementFields=['type','text','entries','newerBoundary','key'];
const envelope={type:'type',method:'id',version:'number',sourceClientId:'id',requestId:'id',resultType:'type',handledByClientId:'id',error:'path',
 result:{clientId:'id',supportsUntrustedAppInput:'boolean',ideContext:{}},
 params:{hostId:'id',conversationId:'id',clientId:'id',status:'type',following:'boolean',change:{type:'type',revision:'number',baseRevision:'number',conversationState:conversation,patches:[PATCH]}}};
const union=Object.create(null);
function collect(shape){if(Array.isArray(shape)){collect(shape[0]);return;}if(!shape||typeof shape!=='object')return;for(const [key,value]of Object.entries(shape)){if(key!=='$map'){union[key]=value;collect(value);}else collect(value);}}
collect(conversation);
function atPath(value){
 const parts=Array.isArray(value)?value.map(String):typeof value==='string'?(value===''?[]:value.startsWith('/')?value.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~')):null):null;
 if(!parts)return undefined;let shape=conversation;
 for(const key of parts){shape=Array.isArray(shape)?shape[0]:shape&&typeof shape==='object'?(shape.$map|| (Object.hasOwn(shape,key)?shape[key]:undefined)):undefined;if(!shape)break;}
 return shape;
}
function child(shape,key,parent){
 if(shape===itemProjection&&key!=='type'&&Object.hasOwn(parent,'type')&&!fieldsFor(parent.type)?.includes(key))return SKIP;
 if(shape===PATCH){if(key==='value'&&Object.hasOwn(parent,'path'))return atPath(parent.path)||SKIP;shape=patchShape;}
 if(shape===ANY)return Array.isArray(parent)?ELEMENT:ANY;
 if(shape===ELEMENT){
  if(Object.hasOwn(parent,'type')&&!commonElementFields.includes(key)&&!fieldsFor(parent.type)?.includes(key))return SKIP;
  return Object.hasOwn(elementShape,key)?elementShape[key]:SKIP;
 }
 if(Array.isArray(shape))return shape[0];
 if(shape&&typeof shape==='object')return shape.$map||(Object.hasOwn(shape,key)?shape[key]:SKIP);
 return SKIP;
}
function prune(value,shape){
 if(shape===itemProjection&&!fieldsFor(value?.type))return null;
 if(shape==='question')return null;
 if(shape==='reply')return typeof value==='string'?compactReply(value):value;
 if(Array.isArray(shape))return Array.isArray(value)?value.map(item=>prune(item,shape[0])):value;
 if(shape&&typeof shape==='object'&&value&&typeof value==='object'&&!Array.isArray(value)){
  const out=Object.create(null);for(const key of Object.keys(value)){const next=child(shape,key,out);if(next!==SKIP)out[key]=prune(value[key],next);}return out;
 }
 return value;
}
function footprint(value){
 let nodes=1,characters=typeof value==='string'?value.length:0;
 if(value&&typeof value==='object'){
  for(const [key,child]of Object.entries(value)){const cost=footprint(child);nodes+=cost.nodes;characters+=key.length+cost.characters;}
  for(const symbol of Object.getOwnPropertySymbols(value))for(const id of value[symbol]?.ids||[]){nodes++;characters+=id.length;}
 }
 return {nodes,characters};
}
function fail(code='IPC_INVALID_JSON'){throw Object.assign(new Error(code==='IPC_INVALID_JSON'?'Invalid IPC JSON':'IPC JSON resource limit exceeded'),{code});}
// Incremental JSON grammar with a schema projection. Discarded strings are
// validated in place, never concatenated; no buffer scales with frame size.
class ProjectedJSON{
 constructor(){this.decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});this.stack=[];this.root=undefined;this.done=false;this.token=null;this.nodes=0;this.characters=0;}
 retain(value){
  if(typeof value==='string')this.characters+=value.length;
  else if(value&&typeof value==='object')for(const symbol of Object.getOwnPropertySymbols(value))for(const id of value[symbol]?.ids||[]){this.characters+=id.length;this.nodes++;}
  if(this.characters>8*1024*1024||this.nodes>200000)fail('IPC_JSON_RESOURCE_LIMIT');
 }
 role(){const p=this.stack.at(-1);return p?child(p.role,p.kind==='array'?p.index:p.key,p.out):envelope;}
 accept(value){
  const p=this.stack.at(-1);
  if(!p){if(this.done)fail();this.root=value;this.done=true;return;}
  const selected=this.role()!==SKIP;
  if(p.out&&selected&&++this.nodes>200000)fail('IPC_JSON_RESOURCE_LIMIT');
  if(p.kind==='array'){if(p.out)p.out.push(value===undefined?null:value);p.index++;p.state='comma';}
  else{if(p.out&&selected&&p.key!==undefined){if(p.role===itemProjection&&p.key==='type'&&Object.hasOwn(p.out,'type'))fail();p.out[p.key]=value===undefined?null:value;}p.state='comma';p.key=undefined;}
 }
 open(kind){
  const role=this.role(),keep=role!==SKIP&&role!=='question';
  const beforeNodes=this.nodes,beforeCharacters=this.characters;
  if(this.stack.length>=128||keep&&++this.nodes>200000)fail('IPC_JSON_RESOURCE_LIMIT');
  this.stack.push({kind,role:keep?role:SKIP,out:keep?(kind==='array'?[]:Object.create(null)):null,state:kind==='array'?'first':'key',index:0,key:undefined,beforeNodes,beforeCharacters});
 }
 close(){
  const p=this.stack.pop();let value=p.out;
  if(p.kind==='object'&&(p.role===itemProjection||p.role===ELEMENT)){
   if(p.role===itemProjection)value=prune(value,itemProjection);
   else if(value&&Object.hasOwn(value,'type')){const allowed=[...commonElementFields,...fieldsFor(value.type)||[]];value=Object.fromEntries(Object.entries(value).filter(([key])=>allowed.includes(key)));}
   const cost=footprint(value);this.nodes=p.beforeNodes+cost.nodes;this.characters=p.beforeCharacters+cost.characters;
  }
  if(p.role===PATCH&&value){const shape=atPath(value.path);if(!shape)delete value.value;else if(p.truncated)fail('IPC_JSON_RESOURCE_LIMIT');else if(Object.hasOwn(value,'value')){value.value=prune(value.value,shape);this.retain(value.value);}}
  this.accept(value);
 }
 startString(key=false){
  let role=key?'key':this.role();const p=this.stack.at(-1);
  if(role===ANY&&p?.key==='text')role='reply';
  const candidate=role===ANY;
  const incompatible=role&&typeof role==='object'&&!(p?.role===PATCH&&p.key==='path');
  const keep=!incompatible&&role!==SKIP&&role!=='question'&&(!key||p?.role!==SKIP)&&(!candidate||p?.kind==='array'||p?.role===PATCH&&p.key==='value'||typeof union[p?.key]==='string');
  this.token={kind:'string',role,keep,incompatible,parts:[],length:0,overflow:false,escape:false,unicode:0,limit:key?4096:role==='reply'||role===ANY?262144:4096};
 }
 append(text){const t=this.token;if(!t.keep||t.overflow)return;t.length+=text.length;if(t.length>t.limit){t.overflow=true;t.parts=[];return;}t.parts.push(text);}
 endString(){
  const t=this.token;let value=t.incompatible?0:null;
  if(t.keep&&!t.overflow){try{value=JSON.parse('"'+t.parts.join('')+'"');}catch{fail();}}
  if(t.role==='key'){this.retain(value);this.stack.at(-1).key=t.overflow?undefined:value;this.stack.at(-1).state='colon';}
  else{
   if(t.keep&&++this.nodes>200000)fail('IPC_JSON_RESOURCE_LIMIT');
   if(t.role==='reply')value=compactReply(value,t.overflow);
   else if(t.overflow&&t.keep){
    const deferred=this.stack.findLast(p=>p.role===PATCH&&p.key==='value'&&!Object.hasOwn(p.out,'path'));
    if(deferred)deferred.truncated=true;else fail('IPC_JSON_RESOURCE_LIMIT');
   }
   this.retain(value);this.accept(value);
  }
  this.token=null;
 }
 finishAtom(){
  const t=this.token;let value;try{value=JSON.parse(t.raw);}catch{fail();}
  this.token=null;this.accept(t.keep?value:null);
 }
 write(text){
  let i=0;
  while(i<text.length){
   const t=this.token;
   if(t?.kind==='string'){
    if(t.unicode){const c=text[i++];if(!/[0-9a-fA-F]/.test(c))fail();this.append(c);t.unicode--;continue;}
    if(t.escape){const c=text[i++];if(!'"\\/bfnrtu'.includes(c))fail();this.append(c);t.escape=false;if(c==='u')t.unicode=4;continue;}
    const start=i;while(i<text.length&&text.charCodeAt(i)>=32&&text[i]!=='"'&&text[i]!=='\\')i++;
    this.append(text.slice(start,i));if(i===text.length)continue;
    const c=text[i++];if(c==='"'){this.endString();continue;}if(c==='\\'){this.append(c);t.escape=true;continue;}fail();
   }
   if(t?.kind==='atom'){
    const c=text[i];if(/[\s,\]}]/.test(c)){this.finishAtom();continue;}t.raw+=c;if(t.raw.length>128)fail('IPC_JSON_RESOURCE_LIMIT');i++;continue;
   }
   const c=text[i];if(c===' '||c==='\n'||c==='\r'||c==='\t'){i++;continue;}
   const p=this.stack.at(-1);if(this.done&&!p)fail();
   if(p?.kind==='object'&&(p.state==='key'||p.state==='nextKey')){if(c==='}'&&p.state==='key'){i++;this.close();continue;}if(c!=='"')fail();this.startString(true);i++;continue;}
   if(p?.state==='colon'){if(c!==':')fail();p.state='value';i++;continue;}
   if(p?.state==='comma'){
    if(c===(p.kind==='array'?']':'}')){i++;this.close();continue;}
    if(c!==',')fail();p.state=p.kind==='array'?'value':'nextKey';i++;continue;
   }
   if(p?.kind==='array'&&p.state==='first'&&c===']'){i++;this.close();continue;}
   if(c==='{'||c==='['){this.open(c==='{'?'object':'array');i++;continue;}
   if(c==='"'){this.startString();i++;continue;}
   if(c==='t'||c==='f'||c==='n'||c==='-'||c>='0'&&c<='9'){this.token={kind:'atom',raw:c,keep:this.role()!==SKIP};i++;continue;}
   fail();
  }
 }
 push(bytes){try{for(let i=0;i<bytes.length;i+=65536)this.write(this.decoder.decode(bytes.subarray(i,i+65536),{stream:true}));}catch(error){if(error.code?.startsWith('IPC_'))throw error;fail();}}
 finish(){try{this.write(this.decoder.decode());}catch(error){if(error.code?.startsWith('IPC_'))throw error;fail();}if(this.token?.kind==='atom')this.finishAtom();if(this.token||this.stack.length||!this.done)fail();const cost=footprint(this.root);if(cost.nodes>100000||cost.characters>4*1024*1024)fail('IPC_JSON_RESOURCE_LIMIT');return this.root;}
}
module.exports={ProjectedJSON};
