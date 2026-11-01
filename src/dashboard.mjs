import { formatUnits } from 'ethers';

const catalog=[
  {key:'ptah',name:'Ptah',category:'空投 / 身份卡',url:'https://ptah.trade/iao',color:'forest',initial:'P',contracts:['0xa2556377118dD333F9f09600DE0bBCf54Cbc69A0','0xD87ADb2E47979d6cb323896B1A9320E0dd132213']},
  {key:'bnagent',name:'BNAGENT',category:'Mint',url:'https://bnagent.onrender.com',color:'sand',initial:'B',contracts:['0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0','0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB']},
  {key:'fagent',name:'FAGENT',category:'Mint / 分红',color:'purple',initial:'F',contracts:['0xbc2D8B6F4c4e2803c5E842E6E8250B79EE442b78']},
  {key:'agentry',name:'Agentry',category:'铭文',color:'blue',initial:'A',contracts:['0x6a4d42E9FC8E948226cd588707332F41e23d2944']},
  {key:'hash21',name:'Hash21',category:'注册',color:'rose',initial:'H',contracts:['0x6884D40B10c55A6c2faB2D3c829d41c3C798279D']},
  {key:'tosh',name:'TOSH',category:'NFT / 交易',color:'blue',initial:'T',contracts:['0x7FB867b51414cbB6C0EAc6E4e6b401dee1044d98','0xcb54CfBc2699c405e5C88cDec75CBa2ec8B7bfb3']},
  {key:'pancakeswap',name:'PancakeSwap / WBNB',category:'兑换 / 资产转换',color:'sand',initial:'⇄',contracts:['0x10ED43C718714eb63d5aA57B78B54704E256024E','0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c']}
];
const pending=new Set(['EXECUTE_INTENT_SAVED','SUBMITTING','UNKNOWN_SUBMIT','PENDING_APP','MARKET_PENDING','BROADCASTED','INCLUDED','RESULT_MISMATCH']);
const success=new Set(['CONFIRMED','SIGNED']);
const lower=s=>typeof s==='string'?s.toLowerCase():'';
const safeUrl=s=>{try{const u=new URL(s);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:undefined;}catch{return undefined;}};
export function projectFor(op,projects=[]) {
  const candidates=[op.payload?.to,op.saleQuote?.token,op.quote?.tokenIn,op.quote?.tokenOut,op.expected?.tokenOut];
  const known=catalog.find(p=>p.contracts.some(c=>candidates.some(a=>lower(a)===lower(c))));
  if(known)return known;
  if(op.kind==='market'||op.kind==='swap')return {key:'aggregator',name:'币安聚合交易',category:'兑换',color:'sand',initial:'⇄'};
  const imported=projects.find(p=>p.contracts?.some(c=>candidates.some(a=>lower(a)===lower(c))));
  if(imported)return {key:'contract:'+lower(op.payload?.to),name:imported.name,category:'合约',url:safeUrl(imported.sources?.[0]?.url),color:'blue',initial:imported.name.slice(0,1)};
  const origin=op.payload?.origin;
  if(origin)return {key:origin,name:new URL(origin).hostname,category:'项目登录',url:safeUrl(origin),color:'purple',initial:'S'};
  const contract=op.payload?.to;
  return {key:contract?'contract:'+lower(contract):'unclassified',name:contract?`${contract.slice(0,6)}…${contract.slice(-4)}`:'未分类记录',category:'合约',color:'gray',initial:'◇'};
}
export function summarizeOperation(op,account,projects=[]) {
  const project=projectFor(op,projects),method=op.decoded?.method||op.kind;
  let action=op.kind==='market'||op.kind==='swap'?'兑换':/claim/i.test(method)?'领取':/mint/i.test(method)?'Mint':/approve/i.test(method)?'授权':/register/i.test(method)?'注册':op.kind==='message'?'登录签名':'合约交互';
  let result=null;
  if(op.state==='CONFIRMED'&&op.businessResult?.verified){
    const values=op.businessResult.values||{};
    if(project.key==='ptah'&&op.businessResult.event==='AirdropClaimed'&&/^\d+$/.test(values.amount))result={label:'已领取',value:formatUnits(values.amount,18),symbol:'IAO'};
    else if(project.key==='ptah'&&values.tokenId)result={label:'PoA',value:values.tokenId,symbol:'Agent #'};
    else if(op.receivedAmount||op.businessResult.receivedAmount)result={label:'已收到',value:op.receivedAmount||op.businessResult.receivedAmount,symbol:op.saleQuote?.toCoinSymbol||''};
  }
  return {id:op.id,accountId:account.id,accountAlias:account.alias,accountName:account.displayName||account.alias,projectKey:project.key,projectName:project.name,
    label:op.label||action,kind:op.kind,action,method,state:op.state,createdAt:op.createdAt,updatedAt:op.updatedAt,txHash:op.txHash,
    contractAddress:op.payload?.to,batchId:op.batchId,businessVerified:op.businessResult?.verified===true,result,
    error:op.error?{code:op.error.code,message:String(op.error.message||'').slice(0,500)}:null};
}
export function dashboardSnapshot(accounts) {
  const accountRows=[],operations=[],groups=new Map();
  const allProjects=accounts.registry.accounts.flatMap(a=>accounts.get(a.id).store.projects());
  for(const account of accounts.registry.accounts){
    const runtime=accounts.get(account.id),raw=runtime.store.scan();
    const ops=raw.map(op=>summarizeOperation(op,account,allProjects));operations.push(...ops);
    for(let i=0;i<ops.length;i++){
      const op=ops[i];
      // Unsubmitted previews and cancelled checks remain in history, not participation.
      if(!raw[i].submission&&!success.has(op.state)&&op.state!=='FAILED')continue;
      const p=projectFor(raw[i],allProjects);
      if(!groups.has(p.key))groups.set(p.key,{...p,contracts:[],accountIds:[],confirmedAccountIds:[],operationIds:[],confirmedCount:0,failedCount:0,pendingCount:0,lastActivity:0});
      const group=groups.get(p.key);
      group.operationIds.push(op.id);group.lastActivity=Math.max(group.lastActivity,op.createdAt||0);
      if(!group.accountIds.includes(account.id))group.accountIds.push(account.id);
      if(success.has(op.state)){group.confirmedCount++;if(!group.confirmedAccountIds.includes(account.id))group.confirmedAccountIds.push(account.id);}
      if(['FAILED','REJECTED'].includes(op.state))group.failedCount++;
      if(pending.has(op.state))group.pendingCount++;
      if(op.contractAddress&&!group.contracts.some(c=>lower(c)===lower(op.contractAddress)))group.contracts.push(op.contractAddress);
    }
    accountRows.push({...accounts.public(account),operationCount:ops.length,confirmedCount:ops.filter(op=>success.has(op.state)).length,
      pendingCount:ops.filter(op=>pending.has(op.state)).length,lastActivity:Math.max(0,...ops.map(op=>op.createdAt||0))});
  }
  const projects=[...groups.values()].sort((a,b)=>b.lastActivity-a.lastActivity);
  for(const a of accountRows)a.projectCount=projects.filter(p=>p.confirmedAccountIds.includes(a.accountId)).length;
  operations.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  return {generatedAt:Date.now(),chainId:56,accounts:accountRows,projects,operations,
    totals:{accounts:accountRows.length,projects:projects.filter(p=>p.confirmedCount>0).length,confirmed:operations.filter(op=>success.has(op.state)).length,pending:operations.filter(op=>pending.has(op.state)).length},
    scope:'local-service-history'};
}
