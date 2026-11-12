'use strict';
// A bounded projection of canonical history. Text is decoded immediately into
// reply IDs; question bodies, chat, tool arguments and output never enter it.
const LIMIT=30000,ARRAY_LIMIT=10000;
const REPLY_METADATA=Symbol('monitor-reply-metadata');
const inputSchema=[{type:'type',text:'reply'}];
const itemSchema={type:'type',id:'id',delivery:'delivery',questions:['question'],status:'status',steerAcknowledged:'boolean',input:[{type:'type',text:'reply'}],content:[{type:'type',text:'reply'}]};
const schema={history:{isComplete:'boolean',entitiesByKey:{$map:{inherited:'boolean',isInherited:'boolean',rootTurnId:'id',turnId:'id',params:{input:inputSchema},items:[itemSchema]}},islands:[{entries:[{key:'id'}],newerBoundary:{status:'boundary'}}]}};
const messageFields={agentMessage:['type','id','delivery','questions'],userMessage:['type','content','input'],steeringUserMessage:['type','status','steerAcknowledged','input','content']};
const fieldsFor=type=>Object.hasOwn(messageFields,type)?messageFields[type]:null;
const own=(object,key)=>object!=null&&Object.hasOwn(object,key);
function child(shape,key){
 if(Array.isArray(shape))return /^(0|[1-9]\d*)$/.test(String(key))||key==='-'?shape[0]:undefined;
 if(shape&&typeof shape==='object')return shape.$map|| (own(shape,key)?shape[key]:undefined);
}
function replyMetadata(text,budget){
 const start='<send_user_message_question_reply>',end='</send_user_message_question_reply>';
 if(typeof text!=='string')return {ids:[],invalid:true};
 const trimmed=text.trim();
 if(!trimmed.startsWith(start))return {ids:[]};
 if(trimmed.length>262144||!trimmed.endsWith(end))return {ids:[],invalid:true};
 try{
  const decoded=JSON.parse(trimmed.slice(start.length,-end.length));const values=Array.isArray(decoded)?decoded:[decoded];
  if(values.length>1000)throw new Error();
  const ids=[];
  for(const value of values){
   if(--budget.left<0)return {ids,invalid:true};
   if(typeof value?.questionItemId!=='string'||value.questionItemId.length>1024||typeof value.question!=='string'||typeof value.answer!=='string')throw new Error();
   const id=JSON.parse(value.questionItemId);
   if(!Array.isArray(id)||id.length!==3||id[0]!=='request_user_input_async'||typeof id[1]!=='string'||id[1].length>512||!Number.isSafeInteger(id[2])||id[2]<0||id[2]>=1000)throw new Error();
   ids.push(JSON.stringify(id));
  }
  return {ids};
 }catch{return {ids:[],invalid:true};}
}
function compactReply(text,overflow=false){
 const value=overflow?{ids:[],invalid:true}:replyMetadata(text,{left:1000});
 return {[REPLY_METADATA]:value};
}
class InputState{
 constructor(){this.data=null;this.invalid=false;this.cached=null;}
 project(value,shape,budget){
  if(--budget.left<0){this.invalid=true;return null;}
  if(shape===itemSchema){
   const fields=fieldsFor(value?.type);
   // Keep an index placeholder for unrelated items so JSON patches still line
   // up, but never traverse their reasoning, tool output or other payloads.
   if(!fields)return null;
   value=Object.fromEntries(fields.filter(key=>own(value,key)).map(key=>[key,value[key]]));
  }
  if(shape==='question')return null;
  if(shape==='reply'){
   const prepared=value?.[REPLY_METADATA];
   const result=prepared?{ids:prepared.ids.slice(),...(prepared.invalid?{invalid:true}:{})}:replyMetadata(value,budget);
   if(prepared)budget.left-=result.ids.length;
   if(result.invalid||budget.left<0)this.invalid=true;return result;
  }
  if(shape==='boolean')return value===true;
  if(typeof shape==='string'){
   const allowed={type:['agentMessage','userMessage','steeringUserMessage','text'],delivery:['async'],status:['accepted'],boundary:['exhausted']};
   if(shape==='id')return typeof value==='string'&&value.length<=512?value:null;
   return allowed[shape]?.includes(value)?value:null;
  }
  if(Array.isArray(shape)){
   if(value==null)return [];
   if(!Array.isArray(value)){this.invalid=true;return [];}
   if(value.length>ARRAY_LIMIT)this.invalid=true;
   const result=[];
   for(const item of value.slice(0,ARRAY_LIMIT)){
    if(budget.left<=0){this.invalid=true;break;}
    result.push(this.project(item,shape[0],budget));
   }
   return result;
  }
  const result=Object.create(null);
  if(!value||typeof value!=='object'||Array.isArray(value)){this.invalid=true;return result;}
  for(const key of Object.keys(value)){
   const next=child(shape,key);if(!next)continue;
   if(key.length>512||budget.left<=0){this.invalid=true;break;}
   result[key]=this.project(value[key],next,budget);
  }
  return result;
 }
 snapshot(state){
  this.invalid=false;this.cached=null;
  this.data=state?.turnHistory?.kind==='canonical'?this.project(state.turnHistory,schema,{left:LIMIT}):null;
  if(this.size(this.data)>LIMIT){this.data=null;this.invalid=true;}
 }
 patch(at,op,value){
  if(at[0]!=='turnHistory')return;
  if(at[1]==='kind'){this.invalid=true;this.cached=null;return;}
  if(at.length===1){this.snapshot({turnHistory:op==='remove'?null:value});return;}
  if(at.length>6&&at[1]==='history'&&at[2]==='entitiesByKey'&&at[4]==='items'){
   const items=this.data?.history?.entitiesByKey?.[at[3]]?.items,index=at[5];
   if(own(items,index)){
    const item=items[index],fields=fieldsFor(item?.type);
    if(at[6]==='type'&&at.length===7&&(op==='remove'||value!==item?.type)){
     // A type-only transition cannot reconstruct fields discarded earlier.
     // Full item replacements, handled below, can recover those fields.
     if(fields||fieldsFor(value)){items[index]=null;this.invalid=true;this.cached=null;}
     return;
    }
    if(!fields?.includes(at[6]))return;
   }
  }
  let shape=schema;
  for(const key of at.slice(1)){shape=child(shape,key);if(!shape)return;}
  this.cached=null;
  // Descending into discarded question bodies is deliberately irrelevant.
  let target=this.data;
  for(const key of at.slice(1,-1)){
   if(!own(target,key)){this.invalid=true;return;}target=target[key];
  }
  if(!target||typeof target!=='object'){this.invalid=true;return;}
  const key=at.at(-1),budget={left:LIMIT};
  const projected=op==='remove'?undefined:this.project(value,shape,budget);
  if(Array.isArray(target)){
   const index=key==='-'&&op==='add'?target.length:Number(key);
   if(!Number.isSafeInteger(index)||index<0||index>target.length||op!=='add'&&index===target.length||op==='add'&&target.length>=ARRAY_LIMIT){this.invalid=true;return;}
   if(op==='remove')target.splice(index,1);else if(op==='add')target.splice(index,0,projected);else target[index]=projected;
  }else{
   if(key.length>512||op!=='add'&&!own(target,key)){this.invalid=true;return;}
   if(op==='remove')delete target[key];else target[key]=projected;
  }
  // Bound accumulation across a long patch stream as well as each snapshot.
  if(this.size(this.data)>LIMIT){this.data=null;this.invalid=true;}
 }
 size(value){
  if(!value||typeof value!=='object')return 1;
  let count=1;for(const key of Object.keys(value)){count+=this.size(value[key]);if(count>LIMIT)break;}return count;
 }
 interactionEntities(history){
  // entitiesByKey is a lookup table, not chronological order. Only an island
  // with a confirmed newest boundary can identify the current interaction.
  const tails=(history?.islands||[]).filter(island=>island?.newerBoundary?.status==='exhausted');
  if(tails.length!==1||!tails[0].entries?.length)return null;
  const ordered=[];let roots=new Set(),uncertain=false;const seen=new Set();
  for(const entry of tails[0].entries){
   const entity=history.entitiesByKey?.[entry?.key];if(!entity)return null;
   if(entity.inherited||entity.isInherited)continue;
   const root=entity.rootTurnId||entity.turnId;if(!root)return null;
   if(!seen.has(root)){
    const user=entity.items?.find(item=>item?.type==='userMessage');
    const parts=entity.params?.input?.length?entity.params.input:user?.input||user?.content||[];
    const replyOnly=parts.length>0&&parts.every(part=>part?.type==='text'&&part.text?.ids?.length&&!part.text.invalid);
    if(!parts.length&&roots.size)uncertain=true;
    else if(!replyOnly){roots=new Set();uncertain=false;}
    roots.add(root);seen.add(root);
   }
   ordered.push(entity);
  }
  return uncertain?null:ordered.filter(entity=>roots.has(entity.rootTurnId||entity.turnId));
 }
 summary(){
  if(this.cached)return this.cached;
  const pending=new Set(),answered=new Set();let invalid=this.invalid;
  const history=this.data?.history;
  const current=this.interactionEntities(history);if(!current)invalid=true;
  for(const entity of current||[]){
   if(!entity)continue;
   if(entity.inherited||entity.isInherited)continue;
   for(const item of entity.items||[]){
    if(!item)continue;
    if(item.type==='agentMessage'&&item.delivery==='async'&&item.questions?.length){
     if(!item.id||item.questions.length>1000){invalid=true;continue;}
     item.questions.forEach((_,index)=>pending.add(JSON.stringify(['request_user_input_async',item.id,index])));
    }
    if(item.type==='userMessage'||item.type==='steeringUserMessage'&&(item.status==='accepted'||item.steerAcknowledged)){
     for(const part of item.input||item.content||[]){if(part?.type!=='text')continue;invalid||=!!part.text?.invalid;for(const id of part.text?.ids||[])answered.add(id);}
    }
   }
  }
  for(const id of answered)pending.delete(id);
  return this.cached={pendingInputCount:pending.size,inputSync:invalid||!history?'unknown':history.isComplete===true?'complete':'partial'};
 }
}
module.exports={InputState,compactReply,fieldsFor,itemProjection:itemSchema,historyProjection:{kind:'type',...schema}};
