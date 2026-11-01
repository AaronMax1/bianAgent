import { formatEther } from 'ethers';
import { tokenAbi,routerAbi } from './chain.mjs';
import { BNAGENT } from './bnagent.mjs';
import { SELL_SLIPPAGE_BPS,simulationRejected } from './trade-policy.mjs';
import { check,address,uint,digest,sameAddress } from './util.mjs';
const USDT='0x55d398326f99059fF775485246999027B3197955';

export async function sellQuote({chain,config,wallet,input,amountRaw}) {
  const token=address(input.token),slippageBps=input.slippageBps??SELL_SLIPPAGE_BPS;
  check(Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=5000,'INVALID_SLIPPAGE','Sell slippage must be from 0 to 5000 bps');
  check(!sameAddress(token,config.wrapped),'UNSUPPORTED_PAIR','Wrapped native token needs an unwrap operation');
  const [balance,allowance]=await Promise.all([chain.call(token,tokenAbi,'balanceOf',[wallet]),chain.call(token,tokenAbi,'allowance',[wallet,config.router])]);
  if(balance[0]===0n)return {status:'NO_BALANCE',balanceRaw:'0',token};
  const amount=amountRaw?BigInt(uint(amountRaw,true)):input.amountRaw?BigInt(uint(input.amountRaw,true)):balance[0];
  check(amount<=balance[0],'INSUFFICIENT_BALANCE','Sell amount exceeds remaining token balance');
  // Only the reviewed BNAGENT deployment has a known 2% sell tax here.
  const sellTaxBps=sameAddress(token,BNAGENT.token)?200:0,net=amount*BigInt(10000-sellTaxBps)/10000n;
  const paths=[[token,config.wrapped],...(!sameAddress(token,USDT)?[[token,USDT,config.wrapped]]:[])];
  const routes=await Promise.allSettled(paths.map(async path=>({path,out:(await chain.call(config.router,routerAbi,'getAmountsOut',[net,path]))[0].at(-1)})));
  const best=routes.filter(r=>r.status==='fulfilled'&&r.value.out>0n).map(r=>r.value).sort((a,b)=>a.out>b.out?-1:1)[0];
  check(best,'NO_ROUTE','No supported PancakeSwap V2 sell route');
  const min=best.out*BigInt(10000-slippageBps)/10000n;check(min>0n,'DUST_OUTPUT','Sell output rounds to zero');
  return {status:'AVAILABLE',token,amountRaw:String(amount),balanceRaw:String(balance[0]),allowanceRaw:String(allowance[0]),needsApproval:allowance[0]<amount,
    path:best.path,slippageBps,sellTaxBps,expectedBnb:formatEther(best.out),minBnb:formatEther(min),minWei:String(min)};
}

async function settle(engine,op) {
  const deadline=Date.now()+(engine.config.sellReceiptWaitMs??8000);
  while(['BROADCASTED','INCLUDED'].includes(op.state)) {
    op=await engine.reconcileInner({id:op.id});
    if(!['BROADCASTED','INCLUDED'].includes(op.state)||Date.now()>=deadline)break;
    await new Promise(r=>setTimeout(r,200));
  }
  return op;
}
export async function runSell(engine,input) {
  check(input.authorization?.approved===true,'CONFIRMATION_REQUIRED','Sell requires user authorization');
  if(input.gasLimit!==undefined)check(Number.isSafeInteger(input.authorization.maxGasLimit)&&input.gasLimit<=input.authorization.maxGasLimit,'GAS_LIMIT_AUTHORIZATION','Custom gas must stay within the authorized cap');
  check(typeof input.idempotencyKey==='string'&&input.idempotencyKey.length>=8&&input.idempotencyKey.length<=90,'IDEMPOTENCY_REQUIRED','Sell needs a stable 8–90 character key');
  const name='sell:'+input.idempotencyKey,hash=digest(input),job=engine.store.kv(name)||{hash,saleAttempts:0,approvalAttempts:0,attempts:[]};
  check(job.hash===hash,'IDEMPOTENCY_CONFLICT','Sell key belongs to different parameters');
  const save=()=>engine.store.kv(name,job);
  if(job.result?.state==='CONFIRMED')return job.result;
  if(job.activeKey) {const active=engine.store.byKey(job.activeKey);if(active)job[job.activeStage+'Id']=active.id;}
  const ctx=await engine.context(),wallet=ctx.address;
  check(!job.wallet||sameAddress(job.wallet,wallet),'WALLET_CHANGED','Sell belongs to a different wallet');job.wallet=wallet;save();
  const auth={...input.authorization,approved:true,maxValueWei:'0'};
  async function attempt(request,stage,tokenApproval) {
    job.activeKey=request.idempotencyKey;job.activeStage=stage;save();let op;
    try{op=await engine.submitInner({request,authorization:{...auth,...(tokenApproval?{tokenApproval}:{})}},ctx);}
    catch(e){if(!simulationRejected(e)||!e.details?.operationId)throw e;op=engine.view(engine.store.get(e.details.operationId));}
    job[stage+'Id']=op.id;job.attempts.push({id:op.id,stage});delete job.activeKey;save();return settle(engine,op);
  }
  for(;;) {
    if(job.saleId) {
      const op=await settle(engine,engine.view(engine.store.get(job.saleId)));
      if(op.state==='CONFIRMED'&&op.businessResult?.verified) {
        job.result={...op,saleQuote:job.quote,attempts:job.attempts,receivedBnb:formatEther(BigInt(op.businessResult.values.wad))};save();return job.result;
      }
      if(op.state!=='FAILED'||!simulationRejected(op.error)||job.saleAttempts>=3)return {...op,...(op.state==='AWAITING_USER'?{needsReview:true}:{}),attempts:job.attempts};
      delete job.saleId;save(); // Explicit rejection: immediately refresh price/deadline, never poll history.
    }
    if(job.approvalId) {
      const op=await settle(engine,engine.view(engine.store.get(job.approvalId)));
      if(op.state==='CONFIRMED'&&op.businessResult?.verified)delete job.approvalId;
      else if(op.state==='FAILED'&&simulationRejected(op.error)&&job.approvalAttempts<3)delete job.approvalId;
      else return {...op,...(op.state==='AWAITING_USER'?{needsReview:true}:{}),stage:'approval',attempts:job.attempts};
      save();
    }
    const quote=await sellQuote({chain:engine.chain,config:engine.config,wallet,input,amountRaw:job.amountRaw});
    if(quote.status!=='AVAILABLE')return quote;
    job.amountRaw ||= quote.amountRaw;job.quote=quote;save();
    let gasLimit=input.gasLimit;
    if((job.saleAttempts||job.approvalAttempts)&&gasLimit===undefined&&Number.isSafeInteger(auth.maxGasLimit))gasLimit=auth.maxGasLimit;
    const gas=gasLimit===undefined?{}:{gasLimit};
    if(quote.needsApproval) {
      check(job.approvalAttempts<3,'RETRY_LIMIT','Approval simulation rejected three attempts');
      const request={kind:'contract',idempotencyKey:input.idempotencyKey+'-approval-'+(++job.approvalAttempts),label:'Exact sell approval',to:quote.token,
        abi:['function approve(address spender,uint256 value) returns(bool)'],method:'approve',args:[engine.config.router,quote.amountRaw],value:'0',...gas,
        expected:{kind:'event',address:quote.token,abi:['event Approval(address indexed owner,address indexed spender,uint256 value)'],event:'Approval',args:{owner:wallet,spender:engine.config.router,value:quote.amountRaw}}};
      const op=await attempt(request,'approval',{token:quote.token,spender:engine.config.router,amountRaw:quote.amountRaw});
      if(op.needsReview)return op;
      continue;
    }
    check(job.saleAttempts<3,'RETRY_LIMIT','Sell simulation rejected three attempts');
    const request={kind:'contract',idempotencyKey:input.idempotencyKey+'-sale-'+(++job.saleAttempts),label:'Sell tokens for BNB',to:engine.config.router,
      abi:['function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'],method:'swapExactTokensForETHSupportingFeeOnTransferTokens',
      args:[quote.amountRaw,quote.minWei,quote.path,wallet,Math.floor(Date.now()/1000)+180],value:'0',...gas,
      expected:{kind:'event',address:engine.config.wrapped,abi:['event Withdrawal(address indexed src,uint256 wad)'],event:'Withdrawal',args:{src:engine.config.router}}};
    const op=await attempt(request,'sale');if(op.needsReview)return op;
  }
}
