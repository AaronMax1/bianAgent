const icons={
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
 layers:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5"/>',
 history:'<path d="M3 11a9 9 0 1 1 2.7 6.4M3 4v7h7m2-4v5l3 2"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',refresh:'<path d="M20 7a8 8 0 0 0-13.6-2L3 9m0-6v6h6m-5 8a8 8 0 0 0 13.6 2L21 15m0 6v-6h-6"/>',
 arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',chevron:'<path d="m9 5 7 7-7 7"/>',external:'<path d="M14 3h7v7m-1-6L10 14m0-10H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5"/>',
 search:'<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
 dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',wallet:'<path d="M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v12H5a3 3 0 0 1-3-3V6m18 7h-5v4h5"/>',qr:'<path d="M3 3h6v6H3zm12 0h6v6h-6zM3 15h6v6H3zm12 0h2v2h4v4h-6v-2m6-7h-3m-6 0v3"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>'
};
const icon=(name,cls='')=>`<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}">${icons[name]||icons.layers}</svg>`;
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={overview:'总览',accounts:'账户管理',projects:'项目记录',transactions:'交易记录'};
const state={data:null,csrf:'',route:names[location.hash.slice(1)]?location.hash.slice(1):'overview',statuses:new Map(),search:'',accountFilter:'all',statusFilter:'all',archived:false,page:1,refreshing:false,modal:null};
const pendingStates=new Set(['EXECUTE_INTENT_SAVED','SUBMITTING','UNKNOWN_SUBMIT','PENDING_APP','MARKET_PENDING','BROADCASTED','INCLUDED','RESULT_MISMATCH']);
const stateLabels={CONFIRMED:'已确认',SIGNED:'已签名',FAILED:'失败',REJECTED:'已拒绝',CANCELLED:'已取消',AWAITING_USER:'待执行',PREPARING:'准备中',BROADCASTED:'已广播',INCLUDED:'确认中',UNKNOWN_SUBMIT:'待核实',PENDING_APP:'待 App 确认',MARKET_PENDING:'订单处理中',RESULT_MISMATCH:'结果待核实',SUBMITTING:'提交中',EXECUTE_INTENT_SAVED:'提交中'};
const main=document.querySelector('#main'),modal=document.querySelector('#modal');
let toastTimer,pairingTimer,pairingClock,refreshTimer;
const accountName=a=>a.displayName||(a.alias==='default'?'主账户':a.alias==='account2'?'第二账户':a.alias);
const accountById=id=>state.data?.accounts.find(a=>a.accountId===id);
const short=(s,start=6,end=4)=>s?`${s.slice(0,start)}…${s.slice(-end)}`:'尚未绑定钱包';
const pretty=value=>{const n=Number(value);return Number.isFinite(n)?new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(n):value;};
const date=(ts,full=false)=>ts?new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',...(full?{year:'numeric'}:{})}).format(ts):'—';
const ago=ts=>{if(!ts)return '暂无记录';const diff=Math.max(0,Date.now()-ts),minutes=Math.floor(diff/60000);return minutes<1?'刚刚':minutes<60?`${minutes} 分钟前`:minutes<1440?`${Math.floor(minutes/60)} 小时前`:`${Math.floor(minutes/1440)} 天前`;};
const badge=(label,type='neutral')=>`<span class="badge ${type}"><span class="dot"></span>${e(label)}</span>`;
const opBadge=op=>badge(stateLabels[op.state]||op.state,['CONFIRMED','SIGNED'].includes(op.state)?'success':pendingStates.has(op.state)?'pending':['FAILED','REJECTED'].includes(op.state)?'failed':'neutral');
const connection=a=>{const s=state.statuses.get(a.accountId);return s?.walletStatus==='CONNECTED'?badge('已连接','success'):s?.walletStatus==='UNCONNECTED'?badge('未登录','neutral'):s?.error?badge('连接待检查','pending'):badge('检查中','neutral');};
const projectIcon=p=>`<span class="project-icon ${e(p?.color||'gray')}">${e(p?.initial||'◇')}</span>`;
const projectByKey=key=>state.data.projects.find(p=>p.key===key);
const btn=(text,action,cls='',extra='')=>`<button class="btn ${cls}" data-action="${action}" ${extra}>${text}</button>`;
const copyBtn=value=>value?`<button class="icon-btn" data-action="copy" data-value="${e(value)}" title="复制地址" aria-label="复制地址">${icon('copy')}</button>`:'';
const empty=(title,description,ico='layers')=>`<div class="empty-state">${icon(ico)}<h3>${e(title)}</h3><p>${e(description)}</p></div>`;
async function api(path,options={}){
 const response=await fetch('/api'+path,{...options,headers:{...(options.method?{'content-type':'application/json','x-wallet-csrf':state.csrf}:{}),...options.headers}});
 const result=await response.json();if(!response.ok||!result.success)throw Object.assign(new Error(result.error?.message||'服务暂时无法访问'),{code:result.error?.code});return result.data;
}
const messages={ACCOUNT_EXISTS:'账户标识已存在，请换一个。',INVALID_ALIAS:'账户标识请用字母、数字、短横线或下划线。',DUPLICATE_WALLET:'这个钱包已绑定其他账户。',ACCOUNT_WALLET_MISMATCH:'扫码钱包与账户绑定地址不同，请使用原账户登录。',INVALID_ADDRESS:'钱包地址格式不正确。',WEB_CSRF_DENIED:'页面连接已更新，请刷新后重试。',WALLET_DISCONNECTED:'账户尚未登录，请扫码连接。',SESSION_EXPIRED:'登录已过期，请重新扫码。'};
const errorText=err=>messages[err.code]||err.message||'操作未完成，请重试。';
function toast(text){const el=document.querySelector('#toast');el.textContent=text;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3500);}
function nav(){document.querySelector('#navigation').innerHTML=Object.entries(names).map(([key,name])=>`<a class="nav-item ${state.route===key?'active':''}" href="#${key}" aria-label="${name}" ${state.route===key?'aria-current="page"':''}>${icon({overview:'grid',accounts:'users',projects:'layers',transactions:'history'}[key])}<span>${name}</span>${key==='accounts'&&state.data?`<span class="nav-count">${state.data.accounts.filter(a=>!a.archived).length.toString().padStart(2,'0')}</span>`:''}</a>`).join('');document.querySelector('#breadcrumb-page').textContent=names[state.route];}
function heading(title,subtitle,eyebrow='WORKSPACE OVERVIEW'){
 return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="subheading">${subtitle}</p></div><div class="heading-actions">${btn(icon('refresh')+'<span class="refresh-label">刷新数据</span>','refresh',state.refreshing?'loading':'',state.refreshing?'disabled':'')}${btn(icon('plus')+'<span class="add-label">添加账户</span>','add','primary')}</div></div>`;
}
function stats(){
 const d=state.data,connected=d.accounts.filter(a=>state.statuses.get(a.accountId)?.walletStatus==='CONNECTED').length;
 const cards=[['管理账户',d.accounts.filter(a=>!a.archived).length,'个',`${connected} 个账户已连接`,'users',''],['已参与项目',d.totals.projects,'个','以已确认的参与记录统计','layers',''],['已确认交易',d.totals.confirmed,'笔','记录每一次链上参与','check','accent'],['进行中交易',d.totals.pending,'笔',d.totals.pending?'正在等待结果确认':'当前没有待核实交易','clock','']];
 return `<div class="stats-grid">${cards.map(([label,num,unit,note,i,cls])=>`<article class="stat-card ${cls}"><div class="stat-top"><span>${label}</span><span class="stat-icon">${icon(i)}</span></div><p class="stat-number">${num}<span>${unit}</span></p><div class="stat-bottom"><span class="pill-dot"></span>${e(note)}</div></article>`).join('')}</div>`;
}
function projectRow(p){return `<div class="project-row" data-action="project" data-id="${e(p.key)}" role="button" tabindex="0">${projectIcon(p)}<div class="project-row-info"><strong>${e(p.name)}</strong><p>${e(p.category)} <span class="footer-dot">·</span> ${p.confirmedAccountIds.length} 个账户参与</p></div><div class="project-time">${ago(p.lastActivity)}<small>${p.confirmedCount} 笔已确认</small></div><span class="arrow-icon">${icon('chevron')}</span></div>`;}
function overview(){
 const d=state.data,accounts=d.accounts.filter(a=>!a.archived),recent=d.operations.filter(o=>['CONFIRMED','SIGNED','FAILED','REJECTED'].includes(o.state)||pendingStates.has(o.state)).slice(0,6);
 return heading('账户、项目，尽在掌握。','在一个工作空间，管理多个账户的链上参与。')+stats()+`<div class="content-grid"><section class="panel"><div class="panel-heading"><h2>我的账户 <span class="count-tag">${accounts.length}</span></h2><a class="text-link" href="#accounts">管理账户 ${icon('arrow')}</a></div><div class="table-wrap account-summary-table"><table><thead><tr><th>账户</th><th>连接状态</th><th class="hide-mobile">参与项目</th><th class="hide-medium">最近活动</th><th></th></tr></thead><tbody>${accounts.slice(0,4).map((a,i)=>`<tr><td><div class="account-cell"><span class="avatar ${i%2?'blue':''}">${String(i+1).padStart(2,'0')}</span><div><strong>${e(accountName(a))}</strong><span class="secondary mono">${e(short(a.walletAddress))}</span></div></div></td><td>${connection(a)}</td><td class="hide-mobile"><span class="table-number">${a.projectCount}</span></td><td class="hide-medium secondary">${ago(a.lastActivity)}</td><td><button class="icon-btn" data-action="account" data-id="${e(a.accountId)}" title="查看账户" aria-label="查看${e(accountName(a))}">${icon('chevron')}</button></td></tr>`).join('')||'<tr><td colspan="5">暂无账户</td></tr>'}</tbody></table></div><div class="panel-note">${icon('shield')}每个账户独立登录，参与记录分别保留</div></section><section class="panel recent-projects"><div class="panel-heading"><h2>项目动态</h2><a href="#projects" class="text-link">全部项目 ${icon('arrow')}</a></div><div class="project-list">${d.projects.slice(0,3).map(projectRow).join('')||empty('还没有项目记录','完成参与后会显示在这里。')}</div></section></div><section class="panel activity-panel"><div class="panel-heading"><h2>最近交易 <span class="count-tag">ACTIVITY</span></h2><a href="#transactions" class="text-link">查看全部 ${icon('arrow')}</a></div>${transactionsTable(recent,false)}</section>`;
}
function searchBox(placeholder){return `<label class="search-box">${icon('search')}<input id="search" type="search" aria-label="搜索" value="${e(state.search)}" placeholder="${placeholder}"></label>`;}
function accountsPage(){
 const accounts=state.data.accounts.filter(a=>Boolean(a.archived)===state.archived&&[accountName(a),a.alias,a.walletAddress,a.notes].join(' ').toLowerCase().includes(state.search.toLowerCase()));
 return heading('每个账户，各有条理。','独立登录、集中管理，快速了解每个账户的参与情况。','ACCOUNT MANAGEMENT')+`<div class="toolbar"><div class="toolbar-left">${searchBox('搜索账户名称、地址或备注')}</div><div class="segmented"><button class="segment ${!state.archived?'active':''}" data-action="archive-filter" data-value="false">使用中</button><button class="segment ${state.archived?'active':''}" data-action="archive-filter" data-value="true">已归档</button></div></div><div class="account-grid">${accounts.map((a,i)=>`<article class="account-card"><div class="account-card-top"><span class="avatar ${i%2?'blue':''}">${String(state.data.accounts.indexOf(a)+1).padStart(2,'0')}</span><button class="icon-btn" data-action="edit" data-id="${e(a.accountId)}" title="编辑账户" aria-label="编辑${e(accountName(a))}">${icon('dots')}</button></div><div class="account-name"><h2>${e(accountName(a))}</h2>${connection(a)}</div><div class="address-line"><span class="mono">${e(short(a.walletAddress))}</span>${copyBtn(a.walletAddress)}</div><div class="account-metrics"><div class="account-metric"><strong>${a.projectCount}</strong><span>参与项目</span></div><div class="account-metric"><strong>${a.confirmedCount}</strong><span>确认交易</span></div><div class="account-metric"><strong>${a.pendingCount}</strong><span>进行中</span></div></div><div class="card-projects">${state.data.projects.filter(p=>p.confirmedAccountIds.includes(a.accountId)).slice(0,3).map(p=>`<span class="mini-project">${e(p.name)}</span>`).join('')||'<span class="secondary">尚未参与项目</span>'}</div><div class="account-card-footer"><p class="account-note" title="${e(a.notes||a.alias)}">${e(a.notes||a.alias)}</p>${btn('查看账户 '+icon('arrow'),'account','small',`data-id="${e(a.accountId)}"`)}</div></article>`).join('')}${!state.archived&&!state.search?`<button class="add-account-card" data-action="add"><span class="add-account-icon">${icon('plus')}</span><strong>连接一个新账户</strong><small>扫码登录，开始独立管理</small></button>`:''}${accounts.length===0&&(state.archived||state.search)?empty('没有匹配的账户','试试其他关键词，或切换账户分组。','users'):''}</div>`;
}
function accountSelect(){return `<select id="account-filter" class="select" aria-label="按账户筛选"><option value="all">全部账户</option>${state.data.accounts.map(a=>`<option value="${e(a.accountId)}" ${state.accountFilter===a.accountId?'selected':''}>${e(accountName(a))}</option>`).join('')}</select>`;}
function projectsPage(){
 const projects=state.data.projects.filter(p=>(state.accountFilter==='all'||p.accountIds.includes(state.accountFilter))&&[p.name,p.category,...p.contracts].join(' ').toLowerCase().includes(state.search.toLowerCase())).map(p=>{
  if(state.accountFilter==='all')return p;
  const ops=state.data.operations.filter(o=>o.accountId===state.accountFilter&&p.operationIds.includes(o.id));
  const confirmed=ops.filter(o=>['CONFIRMED','SIGNED'].includes(o.state));
  return {...p,accountIds:[state.accountFilter],confirmedAccountIds:confirmed.length?[state.accountFilter]:[],confirmedCount:confirmed.length,failedCount:ops.filter(o=>['FAILED','REJECTED'].includes(o.state)).length,pendingCount:ops.filter(o=>pendingStates.has(o.state)).length,lastActivity:Math.max(0,...ops.map(o=>o.createdAt||0))};
 });
 return heading('参与过什么，一目了然。','按项目汇总账户参与和交易进展，随时回看每一次操作。','PROJECT ACTIVITY')+`<div class="toolbar"><div class="toolbar-left">${searchBox('搜索项目名称或合约地址')}${accountSelect()}</div><span class="filters-count">${projects.length} 个项目</span></div><div class="project-grid">${projects.map(p=>`<article class="project-card"><div class="project-card-head">${projectIcon(p)}${p.pendingCount?badge('进行中','pending'):p.confirmedCount?badge('已参与','success'):badge('仅尝试','neutral')}</div><h2>${e(p.name)}</h2><span class="category">${e(p.category)}</span><div class="project-card-meta"><div><strong>${p.confirmedAccountIds.length}</strong><span>参与账户</span></div><div><strong>${p.confirmedCount}</strong><span>确认交易</span></div><div><strong>${p.failedCount}</strong><span>失败记录</span></div></div><div class="project-accounts">${p.accountIds.slice(0,3).map(id=>`<span class="project-account-tag">${e(accountName(accountById(id)))}</span>`).join('')}</div><div class="project-card-footer"><span>更新于 ${ago(p.lastActivity)}</span><button class="text-link" data-action="project" data-id="${e(p.key)}">查看记录 ${icon('arrow')}</button></div></article>`).join('')||empty('还没有匹配的项目','选择其他账户，或查看全部项目。')}</div><p class="history-footnote">根据当前服务保存的交易记录归类；成功参与、失败尝试分别统计。</p>`;
}
function resultCell(op){if(!op.result)return '<span class="muted">—</span>';return `<span class="result-amount">${op.result.symbol==='Agent #'?'#':''}${e(op.result.symbol==='Agent #'?op.result.value:pretty(op.result.value))}<small>${op.result.symbol==='Agent #'?'PoA':e(op.result.symbol)}</small></span>`;}
function transactionsTable(ops,full=true){return `<div class="table-wrap"><table><thead><tr><th>项目 / 操作</th><th class="table-account">执行账户</th><th>状态</th><th>结果</th><th class="activity-date">时间</th><th></th></tr></thead><tbody>${ops.map(op=>`<tr><td><div class="activity-title">${projectIcon(projectByKey(op.projectKey))}<div><strong>${e(op.projectName)}</strong><small>${e(op.action)}${op.method&&full?' · '+e(op.method.replace(/\(.*/,'')):''}</small></div></div></td><td class="table-account">${e(accountName(accountById(op.accountId)))}</td><td>${opBadge(op)}</td><td>${resultCell(op)}</td><td class="activity-date secondary">${date(op.createdAt)}</td><td><button class="icon-btn" data-action="transaction" data-id="${e(op.id)}" title="查看交易详情" aria-label="查看交易详情">${icon('external')}</button></td></tr>`).join('')||'<tr><td colspan="6"><div class="empty-state">暂无匹配的交易记录</div></td></tr>'}</tbody></table></div>`;}
function transactionsPage(){
 const ops=state.data.operations.filter(op=>(state.accountFilter==='all'||state.accountFilter===op.accountId)&&(state.statusFilter==='all'||state.statusFilter==='pending'&&pendingStates.has(op.state)||state.statusFilter==='success'&&['CONFIRMED','SIGNED'].includes(op.state)||state.statusFilter==='failed'&&['FAILED','REJECTED'].includes(op.state))&&[op.projectName,op.label,op.method,op.txHash,op.contractAddress].join(' ').toLowerCase().includes(state.search.toLowerCase()));
 const pages=Math.max(1,Math.ceil(ops.length/12));state.page=Math.min(state.page,pages);
 return heading('每一笔操作，都有记录。','跨账户查看交易状态、领取结果和链上凭证。','TRANSACTION HISTORY')+`<div class="toolbar"><div class="toolbar-left">${searchBox('搜索项目、操作或交易哈希')}${accountSelect()}<select class="select" id="status-filter" aria-label="按状态筛选">${[['all','全部状态'],['success','已确认'],['pending','进行中 / 待核实'],['failed','失败 / 已拒绝']].map(([key,label])=>`<option value="${key}" ${state.statusFilter===key?'selected':''}>${label}</option>`).join('')}</select></div><span class="filters-count">${ops.length} 条记录</span></div><section class="panel">${transactionsTable(ops.slice((state.page-1)*12,state.page*12))}<div class="pagination"><span>第 ${state.page} / ${pages} 页 · 共 ${ops.length} 条</span><div class="pagination-buttons">${btn('上一页','prev','small',state.page<=1?'disabled':'')}${btn('下一页','next','small',state.page>=pages?'disabled':'')}</div></div></section><p class="history-footnote">只读历史记录 · 查看详情不会提交新的交易。</p>`;
}
function render(){
 nav();if(!state.data)return;
 const focus=document.activeElement?.id==='search',position=focus?document.activeElement.selectionStart:null;
 main.innerHTML=({overview,accounts:accountsPage,projects:projectsPage,transactions:transactionsPage}[state.route])();
 if(focus){const input=document.querySelector('#search');input?.focus();try{input?.setSelectionRange(position,position);}catch{}}
}
async function refreshStatuses(){
 if(!state.data)return;
 const accounts=[...state.data.accounts];
 let cursor=0;
 await Promise.allSettled(Array.from({length:Math.min(3,accounts.length)},async()=>{
  while(cursor<accounts.length){const a=accounts[cursor++];try{const s=await api(`/accounts/${encodeURIComponent(a.accountId)}/status`);state.statuses.set(a.accountId,s);}catch(error){state.statuses.set(a.accountId,{error:errorText(error)});}}
 }));
 render();
}
async function refresh(checkStatus=false){
 if(state.refreshing)return;state.refreshing=true;render();
 try{state.data=await api('/overview');document.querySelector('#service-text').textContent='本地服务运行中';document.querySelector('#service-dot').style.background='';document.querySelector('#last-sync').textContent=`最近同步 ${new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date())}`;if(checkStatus)await refreshStatuses();}
 catch(error){document.querySelector('#service-text').textContent='服务连接失败';document.querySelector('#service-dot').style.background='#c69b79';if(!state.data)main.innerHTML=empty('暂时无法连接服务',errorText(error),'wallet')+btn('重新连接','refresh');else toast(errorText(error));}
 finally{state.refreshing=false;render();}
}
function setRoute(route,filter=null){
 state.search='';state.page=1;if(filter!==null)state.accountFilter=filter;
 if(state.route===route){render();return;}location.hash=route;
}
function stopPairing(){clearInterval(pairingTimer);clearInterval(pairingClock);pairingTimer=null;pairingClock=null;}
function closeModal(){stopPairing();state.modal=null;modal.close();document.querySelector('#modal-content').replaceChildren();}
function showModal(title,body,type,id){
 stopPairing();state.modal={type,id};
 document.querySelector('#modal-content').innerHTML=`<div class="modal-header"><h2 id="modal-title">${e(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="关闭弹窗">${icon('close')}</button></div><div class="modal-body">${body}</div>`;
 if(!modal.open)modal.showModal();
}
function accountModal(id){
 const a=accountById(id),projects=state.data.projects.filter(p=>p.accountIds.includes(id));
 showModal(accountName(a),`<div class="details-row"><span>账户标识</span><strong class="mono">${e(a.alias)}</strong></div><div class="details-row"><span>钱包地址</span><strong class="mono">${e(a.walletAddress||'尚未绑定')} ${copyBtn(a.walletAddress)}</strong></div><div class="details-row"><span>连接状态</span>${connection(a)}</div>${a.notes?`<div class="details-row"><span>备注</span><strong>${e(a.notes)}</strong></div>`:''}<h3 class="subsection-title">独立设备档案</h3><div class="device-grid">${[['主机名',a.deviceProfile.hostname],['MAC',a.deviceProfile.mac],['系统',a.deviceProfile.osName+' '+a.deviceProfile.release],['时区',a.deviceProfile.timezone]].map(([key,value])=>`<div><span>${key}</span><strong>${e(value)}</strong></div>`).join('')}</div><div class="detail-project-list"><h3>参与项目 · ${a.projectCount}</h3>${projects.slice(0,6).map(projectRow).join('')||'<p class="secondary">暂无项目记录</p>'}</div><div class="modal-actions">${btn('编辑账户','edit','',`data-id="${e(id)}"`)}${btn('查看交易','account-transactions','',`data-id="${e(id)}"`)}${btn(icon('qr')+'扫码登录','connect','primary',`data-id="${e(id)}"`)}</div>`,'account',id);
}
function addModal(){
 let index=state.data.accounts.length+1;while(state.data.accounts.some(a=>a.alias==='account'+index))index++;
 showModal('添加一个新账户',`<p class="modal-lead">为新账户创建独立档案，再用币安 App 扫码登录。</p><form id="add-form"><label class="form-field"><span>账户名称</span><input name="displayName" placeholder="例如：空投账户、工作账户" maxlength="60" required></label><label class="form-field"><span>账户标识</span><input name="alias" value="account${index}" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{0,47}" maxlength="48" required><small class="field-help">用于命令行和账户识别，创建后固定。</small></label><label class="form-field"><span>预期钱包地址（选填）</span><input name="expectedAddress" placeholder="0x…" pattern="0x[a-fA-F0-9]{40}"><small class="field-help">填写后，扫码钱包必须与该地址相同。</small></label><div id="form-error"></div><div class="modal-actions">${btn('取消','close-modal')}<button class="btn primary" type="submit">创建并扫码登录 ${icon('arrow')}</button></div></form>`,'add');
}
function editModal(id){const a=accountById(id);
 showModal('编辑账户',`<form id="edit-form" data-id="${e(id)}"><label class="form-field"><span>账户名称</span><input name="displayName" value="${e(accountName(a))}" maxlength="60" required></label><label class="form-field"><span>备注</span><textarea name="notes" maxlength="500" placeholder="记录账户用途，方便日后区分">${e(a.notes||'')}</textarea></label><div class="details-row"><span>账户标识</span><strong class="mono">${e(a.alias)}</strong></div><p class="field-help">名称和备注不会改变钱包地址或登录会话。</p><div id="form-error"></div><div class="modal-actions">${btn(a.archived?'恢复账户':'归档账户','archive','danger',`data-id="${e(id)}" data-value="${!a.archived}"`)}${btn('取消','close-modal')}<button type="submit" class="btn primary">保存修改</button></div></form>`,'edit',id);
}
async function connectModal(id){
 const a=accountById(id);
 showModal(`登录 · ${accountName(a)}`,`<div class="qr-loading"><span class="spinner"></span>正在准备登录二维码…</div>`,'pairing',id);
 try{const pairing=await api(`/accounts/${encodeURIComponent(id)}/connect`,{method:'POST',body:'{}'});if(state.modal?.type!=='pairing'||state.modal?.id!==id)return;showPairing(id,pairing);}
 catch(error){if(state.modal?.type!=='pairing'||state.modal?.id!==id)return;showModal('暂时无法登录',`<div class="form-error">${e(errorText(error))}</div><div class="modal-actions">${btn('关闭','close-modal')}${btn('重试','connect','primary',`data-id="${e(id)}"`)}</div>`,'pairing',id);}
}
function showPairing(id,p){
 const a=accountById(id);stopPairing();
 if(p.state==='CONNECTED'){
  showModal('账户已连接',`<div class="qr-wrap"><div class="pairing-success">${icon('check')}</div><h3>${e(accountName(a))} 登录成功</h3><p class="qr-caption">可以在控制台查看该账户的项目和交易记录。</p></div><div class="modal-actions">${btn('完成','close-modal','primary')}</div>`,'connected',id);
  api(`/accounts/${encodeURIComponent(id)}/status`).then(s=>{state.statuses.set(id,s);return refresh();}).catch(error=>toast(errorText(error)));return;
 }
 if(['FAILED','EXPIRED','NONE'].includes(p.state)){
  showModal('登录未完成',`<p class="modal-lead">${e(p.state==='EXPIRED'?'二维码已过期，请重新生成。':p.error?errorText(p.error):'请重新生成二维码后扫码。')}</p><div class="modal-actions">${btn('关闭','close-modal')}${btn('重新生成','connect','primary',`data-id="${e(id)}"`)}</div>`,'pairing',id);return;
 }
 showModal(`登录 · ${accountName(a)}`,`<div class="qr-wrap"><p class="modal-lead">使用币安 App 扫描二维码，并核对配对码。</p>${p.qrDataUrl?`<img class="qr-image" src="${e(p.qrDataUrl)}" width="228" height="228" alt="${e(accountName(a))}的币安登录二维码">`:'<p class="qr-caption">二维码正在生成，请稍候。</p>'}<p class="pairing-code">${e(p.pairingCode||'—')}</p><p class="qr-caption">${icon('clock')} 等待 App 确认<br>账户：${e(a.alias)}${a.walletAddress?` · ${e(short(a.walletAddress))}`:''}</p><p class="qr-timer" id="qr-timer"></p></div><div class="modal-actions">${btn('稍后继续','close-modal')}${btn('检查登录状态','check-pairing','',`data-id="${e(id)}"`)}</div>`,'pairing',id);
 const tick=()=>{const seconds=Math.max(0,Math.ceil((p.expireAt-Date.now())/1000));const el=document.querySelector('#qr-timer');if(el)el.textContent=`二维码有效期 ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;if(seconds===0)showPairing(id,{state:'EXPIRED'});};
 tick();pairingClock=setInterval(tick,1000);
 let checking=false;
 pairingTimer=setInterval(async()=>{if(checking)return;checking=true;try{const next=await api(`/accounts/${encodeURIComponent(id)}/pairing`);if(state.modal?.id===id&&state.modal.type==='pairing'&&next.state!=='VERIFYING')showPairing(id,next);}catch{/* Keep the existing code available during transient connection errors. */}finally{checking=false;}},2000);
}
function projectModal(key){
 const p=projectByKey(key),ops=state.data.operations.filter(o=>o.projectKey===key&&(state.accountFilter==='all'||o.accountId===state.accountFilter));
 showModal(p.name,`<div class="project-detail">${projectIcon(p)}<p class="modal-lead">${e(p.category)} · ${p.confirmedAccountIds.length} 个账户已参与</p></div><div class="table-wrap"><table><thead><tr><th>账户 / 操作</th><th>状态</th><th>结果</th></tr></thead><tbody>${ops.slice(0,20).map(op=>`<tr><td><button class="text-link" data-action="transaction" data-id="${e(op.id)}">${e(accountName(accountById(op.accountId)))} · ${e(op.action)}</button><span class="secondary">${date(op.createdAt)}</span></td><td>${opBadge(op)}</td><td>${resultCell(op)}</td></tr>`).join('')}</tbody></table></div><p class="field-help">显示最近 20 条，可在交易记录中查看全部。</p><div class="modal-actions">${p.url?`<a class="btn" href="${e(p.url)}" target="_blank" rel="noreferrer noopener">项目网站 ${icon('external')}</a>`:''}${btn('查看全部交易','project-transactions','primary',`data-id="${e(key)}"`)}</div>`,'project',key);
}
function transactionModal(id){
 const op=state.data.operations.find(o=>o.id===id);
 showModal('交易详情',`<div class="details-row"><span>项目</span><strong>${e(op.projectName)}</strong></div><div class="details-row"><span>执行账户</span><strong>${e(accountName(accountById(op.accountId)))}</strong></div><div class="details-row"><span>操作</span><strong>${e(op.action)} · <span class="mono">${e(op.method)}</span></strong></div><div class="details-row"><span>状态</span>${opBadge(op)}</div><div class="details-row"><span>创建时间</span><strong>${date(op.createdAt,true)}</strong></div>${op.result?`<div class="details-row"><span>业务结果</span><strong>${resultCell(op)}</strong></div>`:''}${op.contractAddress?`<div class="details-row"><span>合约地址</span><strong class="mono">${e(op.contractAddress)}</strong></div>`:''}${op.txHash?`<div class="details-row"><span>交易哈希</span><strong class="mono">${e(op.txHash)}</strong></div>`:''}${op.error?`<div class="form-error">${e(op.error.code)} · ${e(op.error.message)}</div>`:''}${op.state==='CONFIRMED'?`<div class="receipt-status">${op.businessVerified?'交易已确认，业务结果已核验。':'交易回执已确认；这笔历史记录未设置项目结果校验。'}</div>`:''}<p class="field-help">${e(op.label)}</p><div class="modal-actions">${btn('关闭','close-modal')}${op.txHash?`<a class="btn primary" href="https://bscscan.com/tx/${e(op.txHash)}" target="_blank" rel="noopener noreferrer">在 BscScan 查看 ${icon('external')}</a>`:''}</div>`,'transaction',id);
}
document.addEventListener('click',async event=>{
 if(event.target.closest('.nav-item')){state.search='';state.accountFilter='all';state.statusFilter='all';state.page=1;}
 const el=event.target.closest('[data-action]');if(!el||el.disabled)return;const {action,id,value}=el.dataset;
 try{
  if(action==='refresh'){await refresh(true);return;}
  if(action==='add'){addModal();return;}
  if(action==='close-modal'){closeModal();return;}
  if(action==='copy'){await navigator.clipboard.writeText(value);toast('地址已复制');return;}
  if(action==='account'){accountModal(id);return;}
  if(action==='edit'){editModal(id);return;}
  if(action==='connect'){await connectModal(id);return;}
  if(action==='check-pairing'){el.disabled=true;try{const p=await api(`/accounts/${encodeURIComponent(id)}/pairing`);if(p.state==='VERIFYING')toast('等待币安 App 扫码确认');else showPairing(id,p);}finally{el.disabled=false;}return;}
  if(action==='archive-filter'){state.archived=value==='true';render();return;}
  if(action==='archive'){el.disabled=true;await api(`/accounts/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({archived:value==='true'})});closeModal();await refresh();toast(value==='true'?'账户已归档，历史记录保留':'账户已恢复');return;}
  if(action==='project'){projectModal(id);return;}
  if(action==='transaction'){transactionModal(id);return;}
  if(action==='account-transactions'){closeModal();setRoute('transactions',id);return;}
  if(action==='project-transactions'){const p=projectByKey(id);closeModal();state.search=p.name;state.page=1;if(state.route==='transactions')render();else location.hash='transactions';return;}
  if(action==='prev'||action==='next'){state.page+=action==='next'?1:-1;render();}
 }catch(error){toast(errorText(error));el.disabled=false;}
});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('.project-row'))event.target.click();});
document.addEventListener('input',event=>{if(event.target.id==='search'){state.search=event.target.value;state.page=1;render();}});
document.addEventListener('change',event=>{if(event.target.id==='account-filter'){state.accountFilter=event.target.value;state.page=1;render();}if(event.target.id==='status-filter'){state.statusFilter=event.target.value;state.page=1;render();}});
document.addEventListener('submit',async event=>{
 const form=event.target;if(!['add-form','edit-form'].includes(form.id))return;event.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;
 const fields=Object.fromEntries(new FormData(form));
 try{
  if(form.id==='add-form'){
   if(!fields.expectedAddress)delete fields.expectedAddress;
   const account=await api('/accounts',{method:'POST',body:JSON.stringify(fields)});await refresh();await connectModal(account.accountId);
  }else{await api(`/accounts/${encodeURIComponent(form.dataset.id)}`,{method:'PATCH',body:JSON.stringify(fields)});closeModal();await refresh();toast('账户信息已保存');}
 }catch(error){const el=document.querySelector('#form-error');if(el)el.innerHTML=`<div class="form-error" role="alert">${e(errorText(error))}</div>`;else toast(errorText(error));}
 finally{button.disabled=false;}
});
modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeModal();}});
modal.addEventListener('cancel',()=>{stopPairing();state.modal=null;document.querySelector('#modal-content').replaceChildren();});
window.addEventListener('hashchange',()=>{state.route=names[location.hash.slice(1)]?location.hash.slice(1):'overview';render();main.focus({preventScroll:true});});
window.addEventListener('beforeunload',()=>{stopPairing();clearInterval(refreshTimer);});
(async()=>{
 nav();try{state.csrf=(await api('/session')).csrf;await refresh(true);refreshTimer=setInterval(()=>{if(!document.hidden&&!state.modal)refresh(true);},30000);}
 catch(error){main.innerHTML=empty('暂时无法连接控制台',errorText(error),'wallet');}
})();
