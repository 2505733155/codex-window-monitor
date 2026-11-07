'use strict';
const $=id=>document.getElementById(id);
const labels={idle:'空闲',busy:'执行中',attention:'待处理',unknown:'未知'};
let snapshot={rows:[],connection:'connecting'},linked=false,lastMessage=0,selectedId=null,filter='all';
let navigating=false,navigationRowId=null;
try{filter=localStorage.getItem('codex-filter')||'all';$('search').value=localStorage.getItem('codex-search')||'';$('idle-first').checked=localStorage.getItem('codex-idle-first')!=='false';}catch{}
if(!['all','idle','busy','other'].includes(filter))filter='all';
function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function effective(row){return linked&&snapshot.connection==='connected'?row:{...row,status:'unknown',reason:'连接已中断，状态未确认'};}
function duration(row,precise=false){
 if(row.status==='unknown')return '—';
 const seconds=Math.max(0,Math.floor((Date.now()-row.since)/1000));let text;
 if(seconds<60)text=precise?seconds+' 秒':'不到 1 分钟';
 else if(seconds<3600)text=precise?Math.floor(seconds/60)+' 分 '+seconds%60+' 秒':Math.floor(seconds/60)+' 分钟';
 else text=Math.floor(seconds/3600)+' 小时 '+Math.floor(seconds%3600/60)+' 分'+(precise?' '+seconds%60+' 秒':'');
 return (row.sinceKnown?'':'至少 ')+text;
}
function save(){try{localStorage.setItem('codex-filter',filter);localStorage.setItem('codex-search',$('search').value);localStorage.setItem('codex-idle-first',$('idle-first').checked);}catch{}}
function render(){
 const rows=snapshot.rows.map(effective);const query=$('search').value.trim().toLowerCase();
 let visible=rows.filter(row=>(filter==='all'||row.status===filter||filter==='other'&&!['idle','busy'].includes(row.status))&&(row.name+' '+row.cwd).toLowerCase().includes(query));
 if($('idle-first').checked)visible.sort((a,b)=>(a.status==='idle'?0:1)-(b.status==='idle'?0:1)||a.name.localeCompare(b.name));
 const counts={all:rows.length,idle:0,busy:0,other:0};for(const row of rows)counts[['idle','busy'].includes(row.status)?row.status:'other']++;
 for(const key of Object.keys(counts))$('count-'+key).textContent=counts[key];
 document.querySelectorAll('[data-filter]').forEach(button=>{button.classList.toggle('active',button.dataset.filter===filter);button.setAttribute('aria-pressed',String(button.dataset.filter===filter));});
 const body=$('rows');body.replaceChildren();
 if(!visible.length){const tr=element('tr'),td=element('td','empty',rows.length?'没有匹配的窗口':'尚未发现 Codex 窗口；请确认 VS Code 中已打开 Codex 面板。');td.colSpan=4;tr.append(td);body.append(tr);}
 for(const row of visible){
  const tr=element('tr'),projectCell=element('td'),project=element('div','project'),folder=element('span','folder','▱'),info=element('div'),name=element('div','project-name',row.name);
  folder.setAttribute('aria-hidden','true');
  if(row.mapping==='ambiguous')name.append(element('span','short-id',row.ownerClientId.slice(0,6)));
  if(row.sessionCount>1)name.append(element('span','session-count',row.sessionCount+' 个会话'));
  const directory=element('div','project-path',row.cwd||'目录待识别');directory.title=row.cwd;info.append(name,directory);project.append(folder,info);projectCell.append(project);
  const statusCell=element('td'),badge=element('span','badge '+row.status),dot=element('i','dot');badge.append(dot,document.createTextNode(labels[row.status]||'未知'));statusCell.append(badge,element('div','state-note',row.reason));
  const timeCell=element('td'),elapsed=element('div','elapsed',duration(row));elapsed.dataset.duration=row.id;elapsed.append(element('small',null,row.status==='unknown'?'状态未确认':row.sinceKnown?(row.status==='idle'?'空闲时长':'当前状态时长'):'监测以来'));timeCell.append(elapsed);
  const actionCell=element('td'),actions=element('div','row-actions'),go=element('button','detail-button go-button',navigating&&navigationRowId===row.id?'正在前往…':'前往窗口');
  go.dataset.windowAction=row.id;go.disabled=navigating;go.setAttribute('aria-label','前往 '+row.name+' 所在的窗口');go.addEventListener('click',()=>navigateWindow(row.id));
  const button=element('button','detail-button','详情 ↗');button.setAttribute('aria-label','查看 '+row.name+' 的详情');button.addEventListener('click',()=>{selectedId=row.id;renderDetail();$('detail').showModal();});actions.append(go,button);actionCell.append(actions);
  tr.append(projectCell,statusCell,timeCell,actionCell);body.append(tr);
 }
 $('showing').textContent='显示 '+visible.length+' / '+rows.length+' 个已发现窗口 · 共 '+(snapshot.sessionCount??rows.length)+' 个会话';
 $('connection').textContent=linked?(snapshot.connection==='connected'?'● 实时连接':'○ 等待 Codex'):'○ 页面连接中断';
 $('notice').hidden=linked&&snapshot.connection==='connected';
 $('notice').textContent=linked?(snapshot.connectionReason||'等待连接 Codex'):'本机监控服务连接中断，旧状态已标为未知；正在重新连接。';
 if($('detail').open)renderDetail();
}
function renderDetail(){
 const original=snapshot.rows.find(row=>row.id===selectedId);if(!original){$('detail').close();return;}const row=effective(original);
 $('detail-title').textContent=row.name;$('detail-fields').replaceChildren();
 const fields=[['项目目录',row.cwd||'待识别'],['Codex 状态',(labels[row.status]||'未知')+' · '+row.reason],['状态持续',duration(row,true)],['窗口对应',row.mapping==='project-match'?'已按项目目录核对':row.mapping==='ambiguous'?'同目录存在多个窗口，实际归属待确认':'窗口归属待确认'],['最后确认',row.lastSeen?new Date(row.lastSeen).toLocaleString():'尚未确认'],['窗口标识',row.ownerClientId.slice(0,8)],['会话数量',String(row.sessionCount||1)]];
 for(const [title,value]of fields){const dd=element('dd',null,value);if(title==='状态持续')dd.id='detail-duration';$('detail-fields').append(element('dt',null,title),dd);}
 const list=$('detail-sessions');if(list){
  list.replaceChildren();
  for(const original of row.sessions||[row]){
   const session=effective(original),card=element('div','session-card'),head=element('div','session-head'),badge=element('span','badge '+session.status,labels[session.status]||'未知');
   head.append(element('span','session-id',session.threadId.slice(0,12)),badge);
   const elapsed=element('span','session-elapsed',duration(session,true));elapsed.dataset.sessionDuration=session.id;
   card.append(head,element('div','state-note',session.reason),elapsed);
   if(session.cwd&&session.cwd!==row.cwd)card.append(element('div','session-path',session.cwd));
   list.append(card);
  }
 }
}
function navigationMessage(message,error=false){const node=$('window-message');node.textContent=message;node.hidden=false;node.classList.toggle('error',error);}
function navigationButtons(){
 document.querySelectorAll('[data-window-action]').forEach(button=>{button.disabled=navigating;button.textContent=navigating&&button.dataset.windowAction===navigationRowId?'正在前往…':'前往窗口';});
 document.querySelectorAll('[data-window-choice]').forEach(button=>{button.disabled=navigating;});
 const close=$('close-window-picker');if(close)close.disabled=navigating;
}
async function navigateWindow(rowId,choiceId){
 if(navigating)return;navigating=true;navigationRowId=rowId;navigationButtons();navigationMessage('正在定位并切换窗口…');
 try{
  const response=await fetch('/api/window',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rowId,choiceId}),signal:AbortSignal.timeout(25000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'窗口跳转失败，请重试');
  if(result.status==='choose'){
   $('window-picker-reason').textContent=result.reason;$('window-choices').replaceChildren();
   for(const window of result.windows){
    const button=element('button','window-choice');button.dataset.windowChoice=window.choiceId;
    button.append(element('strong',null,window.title),element('span',null,[window.desktop,window.current?'当前桌面':'',window.minimized?'已最小化':''].filter(Boolean).join(' · ')));
    button.addEventListener('click',()=>navigateWindow(rowId,window.choiceId));$('window-choices').append(button);
   }
   if(!$('window-picker').open)$('window-picker').showModal();navigationMessage('请选择对应的 VS Code 窗口。');
  }else if(result.status==='activated'){
   if($('window-picker').open)$('window-picker').close();navigationMessage('已前往 '+result.desktop+'：'+result.title);
  }else throw new Error('窗口操作响应无效，请重试');
 }catch(error){
  if($('window-picker').open)$('window-picker').close();navigationMessage(error.name==='TimeoutError'?'窗口操作超时，请重试':error.message||'无法连接监控服务，请重新启动监控',true);
 }finally{navigating=false;navigationRowId=null;navigationButtons();}
}
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;save();render();}));
$('search').addEventListener('input',()=>{save();render();});$('idle-first').addEventListener('change',()=>{save();render();});
$('close-detail').addEventListener('click',()=>$('detail').close());$('detail').addEventListener('click',event=>{if(event.target===$('detail')){const r=$('detail').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('detail').close();}});
$('close-window-picker')?.addEventListener('click',()=>{if(!navigating)$('window-picker').close();});
$('window-picker')?.addEventListener('cancel',event=>{if(navigating)event.preventDefault();});
let stream;
function connect(){
 stream?.close();const current=new EventSource('/events');stream=current;
 current.addEventListener('state',event=>{if(stream!==current)return;try{const data=JSON.parse(event.data);if(!Array.isArray(data.rows))throw new Error('invalid state');snapshot=data;linked=true;lastMessage=Date.now();render();}catch{linked=false;render();}});
 current.addEventListener('heartbeat',()=>{if(stream===current)lastMessage=Date.now();});
 current.onerror=()=>{if(stream!==current)return;linked=false;render();};
}
connect();
setInterval(()=>{
 if(linked&&Date.now()-lastMessage>25000){linked=false;render();connect();return;}
 for(const node of document.querySelectorAll('[data-duration]')){const row=snapshot.rows.find(r=>r.id===node.dataset.duration);if(row&&node.firstChild){const text=duration(effective(row));if(node.firstChild.textContent!==text)node.firstChild.textContent=text;}}
 if($('detail').open){
  const row=snapshot.rows.find(r=>r.id===selectedId),node=$('detail-duration');if(row&&node){const text=duration(effective(row),true);if(node.textContent!==text)node.textContent=text;}
  if(row)for(const elapsed of document.querySelectorAll('[data-session-duration]')){const session=(row.sessions||[row]).find(value=>value.id===elapsed.dataset.sessionDuration);if(session){const text=duration(effective(session),true);if(elapsed.textContent!==text)elapsed.textContent=text;}}
 }
},1000);
render();
