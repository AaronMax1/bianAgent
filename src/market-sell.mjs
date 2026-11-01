import { formatUnits } from 'ethers';
import { tokenAbi } from './chain.mjs';
import { SELL_SLIPPAGE_BPS,simulationRejected } from './trade-policy.mjs';
import { check,address,uint,id,digest,sameAddress,publicError } from './util.mjs';
export const NATIVE='0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const OUTPUTS=[NATIVE,'0x55d398326f99059fF775485246999027B3197955','0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'];

export async function aggregatedSellQuote({engine,input,wallet,amountRaw,requireBalance=false}) {
  const token=address(input.token),toToken=address(input.toToken||NATIVE),slippageBps=input.slippageBps??SELL_SLIPPAGE_BPS;
  check(OUTPUTS.some(a=>sameAddress(a,toToken))&&!sameAddress(token,toToken),'UNSUPPORTED_PAIR','Sell output must be BNB, USDT or USDC on BSC');
  check(Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=5000,'INVALID_SLIPPAGE','Invalid sell slippage');
  const nativeIn=sameAddress(token,NATIVE);
  check(!nativeIn||amountRaw!==undefined||input.amountRaw!==undefined,'NATIVE_AMOUNT_REQUIRED','Provide an explicit BNB amount; reserve native currency for gas');
  const [balance,decimals]=await Promise.all([nativeIn?engine.chain.rpc('eth_getBalance',[wallet,'latest']).then(value=>[BigInt(value)]):engine.chain.call(token,tokenAbi,'balanceOf',[wallet]),nativeIn?[18n]:engine.chain.call(token,tokenAbi,'decimals',[])]);
  const amount=amountRaw||input.amountRaw||String(balance[0]);uint(amount);
  if(BigInt(amount)===0n)return {status:'NO_BALANCE',provider:'binance-aggregator',token,balanceRaw:'0'};
  if(requireBalance)check(balance[0]>=BigInt(amount),'INSUFFICIENT_BALANCE','Insufficient sell balance');
  const params={fromToken:token,toToken,amount:formatUnits(amount,Number(decimals[0])),slippageBps,mev:input.mev??true,gasLevel:input.gasLevel||'MEDIUM'};
  check(typeof params.mev==='boolean'&&['LOW','MEDIUM','HIGH'].includes(params.gasLevel),'INVALID_MARKET_OPTIONS','Invalid MEV or gas level');
  const result=await engine.wallet.marketQuote(params);
  check(typeof result.toCoinAmount==='string'&&/^\d+(?:\.\d+)?$/.test(result.toCoinAmount)&&Number(result.toCoinAmount)>0,'NO_ROUTE','Binance aggregator returned no positive sell quote');
  return {status:'AVAILABLE',provider:'binance-aggregator',token,toToken,amountRaw:String(amount),balanceRaw:String(balance[0]),decimals:Number(decimals[0]),slippageBps,
    ...Object.fromEntries(['fromCoinSymbol','fromCoinAmount','toCoinSymbol','toCoinAmount','feeDetail','gasDetails'].filter(k=>result[k]!==undefined).map(k=>[k,result[k]])),params};
}

export async function reconcileMarket(engine,op) {
  if(['CONFIRMED','FAILED','RESULT_MISMATCH'].includes(op.state)||!op.orderId)return engine.view(op);
  const result=await engine.wallet.marketOrders(op.orderId),row=result.list?.find(r=>String(r.orderId)===String(op.orderId));
  if(!row)return engine.view(op);
  check((!row.fromToken||sameAddress(row.fromToken,op.payload.fromToken))&&(!row.toToken||sameAddress(row.toToken,op.payload.toToken))&&(!row.chain||Number(row.chain)===engine.config.chainId),'ORDER_MISMATCH','Returned order does not match the sell intent');
  op.marketOrder=row;
  if(row.txHash)op.txHash=row.txHash;
  if(row.status==='FAILED') {
    op.state='FAILED';op.error={code:'MARKET_ORDER_FAILED',message:row.message||'Binance market order failed'};
    if(row.errorCode&&!row.txHash)op.error={code:'BINANCE_API_ERROR',message:row.message||'Market simulation rejected',details:{apiCode:String(row.errorCode)}};
  } else if(row.status==='FINISHED') {
    check(typeof row.toTokenActualQty==='string'&&/^\d+(?:\.\d+)?$/.test(row.toTokenActualQty)&&Number(row.toTokenActualQty)>0,'INVALID_MARKET_RESULT','Finished order has no valid received quantity');
    if(!/^0x[0-9a-fA-F]{64}$/.test(op.txHash||'')){engine.store.save(op);return engine.view(op);}
    const receipt=await engine.chain.rpc('eth_getTransactionReceipt',[op.txHash]);
    if(receipt) {
      if(BigInt(receipt.status)!==1n){op.state='FAILED';op.error={code:'TRANSACTION_REVERTED',message:'Market transaction reverted on-chain'};}
      else {
        const block=await engine.chain.rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
        if(block?.hash!==receipt.blockHash)return engine.view(op);
        const head=await engine.chain.snapshot();op.confirmations=head.number-Number(BigInt(receipt.blockNumber))+1;
        op.receipt={transactionHash:op.txHash,blockNumber:Number(BigInt(receipt.blockNumber)),blockHash:receipt.blockHash,status:1,gasUsed:String(BigInt(receipt.gasUsed))};
        op.state=op.confirmations>=engine.config.confirmations?'CONFIRMED':'INCLUDED';
        if(op.state==='CONFIRMED') {
          const remaining=sameAddress(op.payload.fromToken,NATIVE)?BigInt(await engine.chain.rpc('eth_getBalance',[op.wallet,'latest'])):(await engine.chain.call(op.payload.fromToken,tokenAbi,'balanceOf',[op.wallet]))[0];
          op.receivedAmount=row.toTokenActualQty;if(sameAddress(op.payload.toToken,NATIVE))op.receivedBnb=row.toTokenActualQty;
          delete op.error;
          op.remainingTokenRaw=String(remaining);op.partialFill=!!row.refund?.length||(op.sellAll&&remaining>0n);
          op.businessResult={verified:true,scope:'Binance FINISHED order and successful canonical receipt; received amount is reported by Binance',receivedAmount:row.toTokenActualQty,partialFill:op.partialFill,...(row.refund?.length?{refund:row.refund}:{})};
        }
      }
    }
  }
  engine.store.save(op);return engine.view(op);
}
async function waitMarket(engine,op) {
  const until=Date.now()+(engine.config.marketWaitMs??8000);
  do {
    op=await reconcileMarket(engine,engine.store.get(op.id));
    if(['CONFIRMED','FAILED','RESULT_MISMATCH'].includes(op.state)||Date.now()>=until)return op;
    await new Promise(r=>setTimeout(r,300));
  }while(true);
}
export async function runAggregatedSell(engine,input,{beforeSubmit}={}) {
  beforeSubmit?.();
  check(input.authorization?.approved===true,'CONFIRMATION_REQUIRED','Sell requires user authorization');
  check(input.gasLimit===undefined&&input.authorization.maxGasLimit===undefined,'MARKET_GAS_POLICY','Binance market orders use gasLevel, not contract-call gasLimit');
  check(typeof input.idempotencyKey==='string'&&input.idempotencyKey.length>=8&&input.idempotencyKey.length<=90,'IDEMPOTENCY_REQUIRED','Provide a stable sell idempotencyKey');
  const old=engine.store.byKey(input.idempotencyKey);
  if(old){check(old.inputHash===digest(input),'IDEMPOTENCY_CONFLICT','Sell key belongs to different parameters');if(old.state!=='BATCH_PAUSED'||old.submission)return old.orderId&&!['CONFIRMED','FAILED'].includes(old.state)?waitMarket(engine,old):engine.view(old);}
  const ctx=await engine.context({external:false}),wallet=ctx.address;
  check(!old||sameAddress(old.wallet,wallet),'WALLET_CHANGED','Paused sell belongs to a different wallet');
  let op=old||{id:id(),idempotencyKey:input.idempotencyKey,inputHash:digest(input),kind:'market',label:'Binance aggregated sell',provider:'binance-aggregator',wallet,chainId:engine.config.chainId,context:ctx,state:'PREPARING',attempts:[],createdAt:Date.now()};
  if(input.batchId)op.batchId=input.batchId;
  engine.store.save(op);
  try {
    check(!engine.store.scan().some(x=>x.id!==op.id&&['EXECUTE_INTENT_SAVED','SUBMITTING','UNKNOWN_SUBMIT','PENDING_APP','MARKET_PENDING','BROADCASTED','INCLUDED','RESULT_MISMATCH'].includes(x.state)),'WALLET_BUSY','An earlier transaction still needs reconciliation');
    for(let attempt=1;attempt<=3;attempt++) {
      const quote=await aggregatedSellQuote({engine,input,wallet,amountRaw:op.amountRaw,requireBalance:true});
      if(quote.status!=='AVAILABLE'){op.state='CANCELLED';op.result=quote;engine.store.save(op);return {...engine.view(op),status:quote.status};}
      op.amountRaw ||= quote.amountRaw;op.sellAll ??= !input.amountRaw;
      op.payload=quote.params;op.saleQuote={...quote,params:undefined};op.payloadHash=digest(op.payload);
      beforeSubmit?.();
      const entry={attempt,state:'SUBMITTING',at:Date.now()};op.attempts.push(entry);
      op.submission={at:Date.now(),attempt};op.state='SUBMITTING';delete op.orderId;delete op.txHash;delete op.error;engine.store.save(op);
      try {
        const result=await engine.wallet.marketSwap(op.payload);
        check(result.orderId,'UNKNOWN_WALLET_RESULT','Market placement returned no orderId');
        op.orderId=String(result.orderId);entry.orderId=op.orderId;entry.state='MARKET_PENDING';op.state='MARKET_PENDING';
      }catch(e) {
        op.error=publicError(e);entry.error=op.error;
        if(e.details?.orderId){op.orderId=String(e.details.orderId);op.state='MARKET_PENDING';entry.orderId=op.orderId;}
        else op.state=simulationRejected(e)?'FAILED':'UNKNOWN_SUBMIT';
        entry.state=op.state;
      }
      engine.store.save(op);
      if(op.orderId)op=engine.store.get((await waitMarket(engine,op)).id);
      op.attempts.at(-1).state=op.state;engine.store.save(op,false);
      if(op.state!=='FAILED'||!simulationRejected(op.error)||op.txHash||attempt===3)return engine.view(op);
      // An explicit rejection has no pending swap. Requote immediately; never
      // change the user's amount/slippage or fall back to a single DEX.
    }
  }catch(e){if(!op.submission){op.state=e.code==='BATCH_PAUSED'?'BATCH_PAUSED':e.code==='BATCH_CANCELLED'?'CANCELLED':'FAILED';op.error=publicError(e);engine.store.save(op);}throw e;}
}
