const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
test('stalled SSE reconnects and confirms stable state without a new Codex mutation',()=>{
 const nodes=new Map();const node=()=>({value:'',checked:true,hidden:false,open:false,textContent:'',dataset:{},classList:{toggle(){}},append(){},replaceChildren(){},addEventListener(){},setAttribute(){},close(){},showModal(){},getBoundingClientRect(){return {}}});
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node,createTextNode:text=>({textContent:text}),querySelectorAll:()=>[]};
 const streams=[];class Stream{constructor(){this.handlers={};streams.push(this);}addEventListener(name,callback){this.handlers[name]=callback;}close(){this.closed=true;}}
 let time=1000,tick;const context=vm.createContext({document,EventSource:Stream,localStorage:{getItem:()=>null,setItem(){}},Date:{now:()=>time},setInterval(fn){tick=fn;}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
 streams[0].handlers.state({data:JSON.stringify({rows:[],connection:'connected'})});assert.equal(nodes.get('notice').hidden,true);
 time=27000;tick();assert.equal(streams[0].closed,true);assert.equal(streams.length,2);assert.equal(nodes.get('notice').hidden,false);
 streams[1].handlers.state({data:JSON.stringify({rows:[],connection:'connected'})});assert.equal(nodes.get('notice').hidden,true);
});

function browser({fetch=async()=>{throw new Error('Unexpected network request');}}={}){
 // The real app runs unchanged; these DOM primitives provide only its browser boundary.
 class TextNode{
  constructor(value){this.value=String(value);this.writes=0;}
  get textContent(){return this.value;}set textContent(value){this.value=String(value);this.writes++;}
 }
 class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this.dataset={};this.classList={toggle(){}};this.value='';this.checked=true;this.open=false;this.hidden=false;this.replacements=0;}
  get firstChild(){return this.children[0];}
  get textContent(){return this.children.map(child=>child.textContent).join('');}
  set textContent(value){this.children=[new TextNode(value)];}
  append(...values){this.children.push(...values.map(value=>typeof value==='string'?new TextNode(value):value));}
  replaceChildren(...values){this.replacements++;this.children=[];this.append(...values);}
  addEventListener(type,fn){this.listeners[type]=fn;}
  setAttribute(){}focus(){this.focused=true;}showModal(){this.open=true;}close(){this.open=false;}
 }
 const ids=['search','idle-first','rows','count-all','count-idle','count-busy','count-other','showing','connection','notice','detail','detail-title','detail-fields','close-detail','window-message','block-dialog','block-form','block-project','block-reason','block-error','save-block','cancel-block','close-block'];
 const nodes=new Map(ids.map(id=>[id,new Element()]));
 const descendants=node=>[node,...(node.children||[]).flatMap(descendants)];
 const all=()=>[...nodes.values()].flatMap(descendants);
 const document={getElementById:id=>nodes.get(id)||all().find(node=>node.id===id)||null,createElement:tag=>new Element(tag),createTextNode:value=>new TextNode(value),querySelectorAll:selector=>selector==='[data-duration]'?all().filter(node=>node.dataset?.duration):selector==='[data-block-action]'?all().filter(node=>node.dataset?.blockAction):[]};
 const streams=[];class Stream{constructor(){this.handlers={};streams.push(this);}addEventListener(type,fn){this.handlers[type]=fn;}close(){this.closed=true;}}
 let now=0,tick;class Clock extends Date{static now(){return now;}}
 const context=vm.createContext({document,fetch,AbortSignal,EventSource:Stream,localStorage:{getItem:()=>null,setItem(){}},Date:Clock,setInterval(fn){tick=fn;}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
 return {nodes,context,all,setTime:value=>{now=value;},tick:()=>{streams.at(-1).handlers.heartbeat?.();tick();},send:rows=>streams.at(-1).handlers.state({data:JSON.stringify({rows,connection:'connected'})})};
}
const sampleRow={id:'owner:local:thread',ownerClientId:'owner',threadId:'thread',cwd:'D:\\project',name:'project',status:'idle',reason:'等待输入',mapping:'project-match',since:0,sinceKnown:true,lastSeen:null};

test('list durations show whole minutes at boundaries and preserve uncertainty',()=>{
 const page=browser();
 const format=row=>vm.runInContext('duration('+JSON.stringify(row)+')',page.context);
 for(const [time,want]of [[0,'不到 1 分钟'],[59000,'不到 1 分钟'],[60000,'1 分钟'],[119000,'1 分钟'],[120000,'2 分钟'],[3599000,'59 分钟'],[3600000,'1 小时 0 分'],[3661000,'1 小时 1 分']]){
  page.setTime(time);assert.equal(format(sampleRow),want);
 }
 page.setTime(65000);assert.equal(format({...sampleRow,sinceKnown:false}),'至少 1 分钟');
 assert.equal(format({...sampleRow,status:'unknown'}),'—');
 assert.equal(format({...sampleRow,since:70000}),'不到 1 分钟');
});

test('detail ticks show live seconds without rebuilding the dialog or rewriting unchanged list time',()=>{
 const page=browser();page.setTime(65000);page.send([sampleRow]);
 const list=page.all().find(node=>node.dataset?.duration===sampleRow.id);const listText=list.firstChild;
 const details=page.nodes.get('detail-fields');const table=page.nodes.get('rows');
 page.all().find(node=>node.tagName==='button'&&node.textContent==='详情 ↗').listeners.click();
 const detailTime=()=>{const index=details.children.findIndex(node=>node.textContent==='状态持续');return details.children[index+1].textContent;};
 assert.equal(detailTime(),'1 分 5 秒');const replacements=details.replacements,tableReplacements=table.replacements;
 page.setTime(66000);page.tick();assert.equal(detailTime(),'1 分 6 秒');
 assert.equal(listText.textContent,'1 分钟');assert.equal(listText.writes,0);
 assert.equal(details.replacements,replacements);assert.equal(table.replacements,tableReplacements);
 page.setTime(120000);page.tick();assert.equal(listText.textContent,'2 分钟');assert.equal(listText.writes,1);assert.equal(detailTime(),'2 分 0 秒');
 page.setTime(3661000);page.tick();assert.equal(detailTime(),'1 小时 1 分 1 秒');
 page.nodes.get('close-detail').listeners.click();const closedTime=detailTime();page.setTime(3662000);page.tick();assert.equal(detailTime(),closedTime);
});

test('open detail preserves lower-bound timing and invalidates stale state after disconnect',()=>{
 const page=browser();page.setTime(65000);page.send([{...sampleRow,sinceKnown:false}]);
 page.all().find(node=>node.tagName==='button'&&node.textContent==='详情 ↗').listeners.click();
 const details=page.nodes.get('detail-fields');const value=()=>details.children[details.children.findIndex(node=>node.textContent==='状态持续')+1].textContent;
 assert.equal(value(),'至少 1 分 5 秒');page.setTime(66000);page.tick();assert.equal(value(),'至少 1 分 6 秒');
 vm.runInContext('stream.onerror()',page.context);assert.equal(value(),'—');
 assert.equal(page.all().find(node=>node.dataset?.duration===sampleRow.id).firstChild.textContent,'—');
});

test('blocked windows sort last with either idle-first setting and keep their real state',()=>{
 const page=browser();
 const blocked={...sampleRow,id:'blocked',name:'A',blocked:true,blockReason:'等待资料'};
 const busy={...sampleRow,id:'busy',name:'B',status:'busy'},idle={...sampleRow,id:'idle',name:'Z'};
 const order=()=>page.nodes.get('rows').children.map(row=>row.children[2].children[0].dataset.duration);
 page.send([blocked,busy,idle]);assert.deepEqual(order(),['idle','busy','blocked']);
 page.nodes.get('idle-first').checked=false;page.nodes.get('idle-first').listeners.change();assert.deepEqual(order(),['busy','idle','blocked']);
 const blockedRow=page.nodes.get('rows').children.at(-1);assert.match(blockedRow.textContent,/空闲/);assert.match(blockedRow.textContent,/已阻塞/);assert.match(blockedRow.textContent,/等待资料/);
 page.send([{...blocked,blocked:false,blockReason:''},busy,idle]);assert.deepEqual(order(),['blocked','busy','idle']);
});

test('blocking editor preserves typed reasons across live updates and permits retry and restore',async()=>{
 const requests=[];let fail=false;
 const page=browser({fetch:async(url,options)=>{requests.push({url,...JSON.parse(options.body)});return {ok:!fail,json:async()=>fail?{error:'窗口已离线'}:{blocked:JSON.parse(options.body).blocked}};}});
 const click=label=>page.all().find(node=>node.tagName==='button'&&node.textContent===label).listeners.click();
 const dialog=page.nodes.get('block-dialog'),input=page.nodes.get('block-reason'),form=page.nodes.get('block-form'),error=page.nodes.get('block-error');
 page.send([sampleRow]);click('标记阻塞');assert.equal(dialog.open,true);assert.equal(input.value,'');assert.equal(input.focused,true);
 const reason='<img src=x onerror=alert(1)> 等待资料';input.value=reason;
 page.send([{...sampleRow,status:'busy'}]);assert.equal(input.value,reason,'SSE must not overwrite an in-progress edit');
 await form.listeners.submit({preventDefault(){}});assert.equal(dialog.open,false);
 assert.deepEqual(requests[0],{url:'/api/block',rowId:sampleRow.id,blocked:true,reason});
 page.send([{...sampleRow,blocked:true,blockReason:reason}]);assert.equal(page.all().find(node=>node.className==='block-note').textContent,reason,'reason remains literal text');
 click('编辑原因');assert.equal(input.value,reason);input.value='改为等待回复';fail=true;
 await form.listeners.submit({preventDefault(){}});assert.equal(dialog.open,true);assert.equal(input.value,'改为等待回复');assert.equal(error.hidden,false);assert.match(error.textContent,/离线/);assert.equal(page.nodes.get('save-block').disabled,false);
 fail=false;await form.listeners.submit({preventDefault(){}});assert.equal(dialog.open,false);
 await click('解除阻塞');assert.deepEqual(requests.at(-1),{url:'/api/block',rowId:sampleRow.id,blocked:false,reason:''});
});

test('ambiguous windows remain searchable by every member project name and directory',()=>{
 const page=browser();const row={...sampleRow,name:'多项目窗口',cwd:'',projectAmbiguous:true,mapping:'ambiguous',sessions:[{...sampleRow,name:'fixture-current',cwd:'D:/fixture-current'},{...sampleRow,id:'history',name:'fixture-history',cwd:'D:/fixture-history'}]};
 page.send([row]);
 for(const query of ['fixture-current','d:/fixture-history']){page.nodes.get('search').value=query;page.nodes.get('search').listeners.input();assert.ok(page.all().some(node=>node.dataset?.duration===row.id),query);}
 page.nodes.get('search').value='no-such-project';page.nodes.get('search').listeners.input();assert.ok(!page.all().some(node=>node.dataset?.duration===row.id));
});
