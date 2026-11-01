import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectBawAdapter } from '../src/baw-direct.mjs';
import { BinanceApi,ENDPOINTS } from '../src/binance-api.mjs';
import { fixture,A,B } from './helpers.mjs';
import { NATIVE } from '../src/market-sell.mjs';

test('direct market adapter matches official CLI human units, 10% conversion and order endpoints without CLI execution',async()=>{
  const calls=[],wallet=new DirectBawAdapter({chainId:56,bawBin:'/never-execute'},{api:{call:async(name,body)=>{
    calls.push({name,body});return name==='rwaTokens'?[]:name==='marketQuote'?{fromCoinAmount:'123.456',toCoinAmount:'0.01'}:name==='marketPlace'?{orderId:'order-1'}:{rows:[{orderId:'order-1',walletChainId:'56',status:'FINISHED',orderTxId:'hash',extend:JSON.stringify({refund:[{amount:'1',symbol:'T',tokenAddress:B}]})}]};
  }}});
  const p={fromToken:B,toToken:NATIVE,amount:'123.456',slippageBps:1000};
  await wallet.marketQuote(p);await wallet.marketSwap(p);const orders=await wallet.marketOrders('order-1');
  assert.deepEqual(calls.find(x=>x.name==='marketQuote').body,{binanceChainId:'56',fromToken:B,toToken:NATIVE,amount:'123.456',slippage:'0.1'});
  assert.deepEqual(calls.find(x=>x.name==='marketPlace').body,{binanceChainId:'56',fromToken:B,toToken:NATIVE,amount:'123.456',slippage:'0.1',mev:true,gasLevel:'MEDIUM'});
  assert.deepEqual(calls.find(x=>x.name==='marketOrders').body,{orderId:'order-1',page:1,pageSize:1});
  assert.equal(orders.list[0].refund[0].amount,'1');assert.equal(calls.filter(x=>x.name==='rwaTokens').length,1);
});
test('RWA tokens cannot silently use ordinary-crypto amount semantics',async()=>{
  let quotes=0;const wallet=new DirectBawAdapter({chainId:56},{api:{call:async name=>{if(name==='rwaTokens')return[{chainId:'56',contractAddress:B,multiplier:'100'}];quotes++;}}});
  await assert.rejects(wallet.marketQuote({fromToken:B,toToken:NATIVE,amount:'1',slippageBps:1000}),{code:'RWA_NOT_SUPPORTED'});assert.equal(quotes,0);
});
function marketFixture(){
  const f=fixture();f.config.marketWaitMs=0;f.config.confirmations=1;f.balance=1000000000000000000n;f.quotes=[];f.placements=[];f.status='PENDING';
  f.chain.call=async(_,__,method)=>{if(method==='balanceOf')return[f.balance];if(method==='decimals')return[18n];throw Error('No manual route/approval calls allowed: '+method);};
  const rpc=f.chain.rpc.bind(f.chain);f.chain.rpc=async(method,...params)=>method==='eth_getTransactionReceipt'?{status:'0x1',blockNumber:'0x64',blockHash:f.chain.block.hash,gasUsed:'0x5208'}:method==='eth_getBlockByNumber'?{hash:f.chain.block.hash}:rpc(method,...params);
  f.wallet.marketQuote=async p=>{f.quotes.push(p);return{fromCoinAmount:p.amount,toCoinAmount:'0.02',fromCoinSymbol:'T',toCoinSymbol:'BNB',slippage:0.1};};
  f.wallet.marketSwap=async p=>{f.placements.push(p);return{orderId:'order-1'};};
  f.wallet.marketOrders=async()=>({list:[{orderId:'order-1',chain:'56',fromToken:B,toToken:NATIVE,status:f.status,toTokenActualQty:'0.019',...(f.status==='FINISHED'?{txHash:'0x'+'ac'.repeat(32)}:{})}]});
  return f;
}
const request=key=>({token:B,idempotencyKey:key,authorization:{approved:true}});
test('orderId and PENDING are not success; only FINISHED plus canonical receipt can confirm',async()=>{
  const f=marketFixture();try {
    const input=request('pending-then-finished');const pending=await f.engine.dispatch('sell',input);
    assert.equal(pending.state,'MARKET_PENDING');assert(!pending.businessResult?.verified);assert.equal(f.placements.length,1);
    f.status='FINISHED';f.balance=0n;const done=await f.engine.dispatch('sell',input);
    assert.equal(done.state,'CONFIRMED');assert.equal(done.receivedBnb,'0.019');assert.equal(done.remainingTokenRaw,'0');assert.equal(done.partialFill,false);
    await f.engine.dispatch('sell',input);assert.equal(f.placements.length,1);assert.equal(f.quotes[0].amount,'1.0');assert.equal(f.quotes[0].slippageBps,1000);
  }finally{f.store.close();}
});
test('explicit simulation rejection requotes up to three times without narrowing to one DEX',async()=>{
  const f=marketFixture();try {
    f.wallet.marketSwap=async p=>{f.placements.push(p);throw Object.assign(Error('simulation error'),{code:'BINANCE_API_ERROR',details:{apiCode:'953401'}});};
    const input=request('aggregate-three-attempts'),result=await f.engine.dispatch('sell',input);
    assert.equal(result.state,'FAILED');assert.equal(f.placements.length,3);assert.equal(f.quotes.length,3);
    assert(f.quotes.every(q=>q.slippageBps===1000&&q.amount==='1.0'));
    await f.engine.dispatch('sell',input);assert.equal(f.placements.length,3);
  }finally{f.store.close();}
});
test('ambiguous placement never resubmits or falls back to a direct DEX',async()=>{
  const f=marketFixture();try {
    f.wallet.marketSwap=async p=>{f.placements.push(p);throw Object.assign(Error('timeout'),{code:'NETWORK_ERROR'});};
    const input=request('aggregate-network-unknown'),result=await f.engine.dispatch('sell',input);
    assert.equal(result.state,'UNKNOWN_SUBMIT');await f.engine.dispatch('sell',input);assert.equal(f.placements.length,1);
  }finally{f.store.close();}
});
test('FAILED order is reported failed, never as a completed swap',async()=>{
  const f=marketFixture();try{f.status='FAILED';const r=await f.engine.dispatch('sell',request('terminal-order-failed'));assert.equal(r.state,'FAILED');assert(!r.businessResult?.verified);assert.equal(f.placements.length,1);}finally{f.store.close();}
});
test('partial fill with refund and remaining balance is preserved',async()=>{
  const f=marketFixture();try{
    f.wallet.marketOrders=async()=>({list:[{orderId:'order-1',status:'FINISHED',toTokenActualQty:'0.01',txHash:'0x'+'ab'.repeat(32),refund:[{amount:'0.5',symbol:'T',tokenAddress:B}]}]});
    const r=await f.engine.dispatch('sell',request('partial-market-fill'));assert.equal(r.state,'CONFIRMED');assert.equal(r.partialFill,true);assert.equal(r.businessResult.refund[0].amount,'0.5');
  }finally{f.store.close();}
});
test('quote-only accepts explicit historical amount even after the token was fully sold',async()=>{
  const f=marketFixture();try{f.balance=0n;const r=await f.engine.dispatch('sell.quote',{token:B,amountRaw:'1230000000000000000'});assert.equal(r.status,'AVAILABLE');assert.equal(f.quotes[0].amount,'1.23');assert.equal(f.placements.length,0);}finally{f.store.close();}
});
test('an error containing an orderId is reconciled instead of placed again',async()=>{
  const f=marketFixture();try{
    f.wallet.marketSwap=async p=>{f.placements.push(p);throw Object.assign(Error('simulation error'),{code:'BINANCE_API_ERROR',details:{apiCode:'953401',orderId:'order-1',submissionEvidence:true}});};
    const result=await f.engine.dispatch('sell',request('error-with-existing-order'));assert.equal(result.state,'MARKET_PENDING');assert.equal(f.placements.length,1);
  }finally{f.store.close();}
});
test('nested placement rejection with transaction evidence never retries',async()=>{
  const f=marketFixture();let placements=0;
  const direct=new DirectBawAdapter({chainId:56},{api:{call:async name=>{
    if(name==='rwaTokens')return[];
    if(name==='marketPlace'){placements++;return{code:'953401',txHash:'0x'+'ad'.repeat(32),message:'simulation error'};}
    throw Error('Unexpected operation: '+name);
  }}});
  try{
    f.wallet.marketSwap=p=>direct.marketSwap(p);
    const input=request('nested-hash-unknown'),result=await f.engine.dispatch('sell',input);
    assert.equal(result.state,'UNKNOWN_SUBMIT');assert.equal(result.error.details.submissionEvidence,true);
    await f.engine.dispatch('sell',input);assert.equal(placements,1);
  }finally{f.store.close();}
});
test('successful market receipt waits for the configured confirmation depth',async()=>{
  const f=marketFixture();try{
    f.config.confirmations=3;f.status='FINISHED';
    const input=request('market-confirmation-depth');
    assert.equal((await f.engine.dispatch('sell',input)).state,'INCLUDED');
    const snapshot=f.chain.snapshot.bind(f.chain);f.chain.snapshot=async()=>({...await snapshot(),number:102});
    assert.equal((await f.engine.dispatch('sell',input)).state,'CONFIRMED');assert.equal(f.placements.length,1);
  }finally{f.store.close();}
});
test('sell traverses direct HTTP quote, placement and order reconciliation without a separate calldata or sign call',async()=>{
  const f=marketFixture(),calls=[],expiry=Date.now()+3600000;
  const api=new BinanceApi({}, {session:{credentials:async()=>({clientId:'11111111-2222-3333-4444-555555555555',sessionId:'unit-test-session-not-real'})},fetch:async(url,options)=>{
    const name=Object.keys(ENDPOINTS).find(k=>new URL(url).pathname===ENDPOINTS[k].path);
    const body=options.body?JSON.parse(options.body):undefined;calls.push({name,body});
    let data;
    if(name==='query')data={connectionStatus:'CONNECTED',walletCreateStatus:'CREATED',sessionExpireTime:expiry,signInMaxTime:expiry};
    else if(name==='settings')data={devMode:{enabled:false},dailyLimit:'100'};
    else if(name==='limits')data={};
    else if(name==='wallets')data=[{subWalletList:[{addresses:[{binanceChainId:'56',address:A}]}]}];
    else if(name==='networks')data=[{binanceChainId:'56',simpleName:'BSC'}];
    else if(name==='rwaTokens')data=[];
    else if(name==='marketQuote')data={fromCoinAmount:body.amount,toCoinAmount:'0.02'};
    else if(name==='marketPlace')data={orderId:'order-1',clientOrderId:'client-order-1'};
    else if(name==='marketOrders')data={total:1,rows:[{orderId:'order-1',walletChainId:'56',fromTokenAddress:B,toTokenAddress:NATIVE,fromTokenQty:'1.0',toTokenActualQty:f.status==='FINISHED'?'0.019':undefined,status:f.status,...(f.status==='FINISHED'?{orderTxId:'0x'+'ac'.repeat(32)}:{})}]};
    else throw Error('Unexpected endpoint: '+name);
    return new Response(JSON.stringify({code:'000000',data}),{status:200});
  }});
  f.engine.wallet=new DirectBawAdapter({...f.config,bawBin:'/must-not-execute'},{api});
  try{
    const input=request('direct-aggregated-sell-flow');
    const pending=await f.engine.dispatch('sell',input);assert.equal(pending.state,'MARKET_PENDING');
    assert.deepEqual(calls.find(c=>c.name==='marketPlace').body,{binanceChainId:'56',fromToken:B,toToken:NATIVE,amount:'1.0',slippage:'0.1',mev:true,gasLevel:'MEDIUM'});
    assert.deepEqual(calls.filter(c=>['marketQuote','marketPlace','marketOrders'].includes(c.name)).map(c=>c.name),['marketQuote','marketPlace','marketOrders']);
    f.status='FINISHED';f.balance=0n;
    const done=await f.engine.dispatch('sell',input);assert.equal(done.state,'CONFIRMED');assert.equal(done.receivedBnb,'0.019');assert.equal(done.businessResult.verified,true);
    await f.engine.dispatch('sell',input);
    assert.equal(calls.filter(c=>c.name==='marketPlace').length,1);
    assert.equal(calls.filter(c=>['preview','execute','messagePreview','messageExecute'].includes(c.name)).length,0);
  }finally{await api.close();f.store.close();}
});
test('native BNB input uses native balance and explicit amount, then confirms a stablecoin output',async()=>{
  const f=marketFixture(),usdt='0x55d398326f99059fF775485246999027B3197955';
  const rpc=f.chain.rpc.bind(f.chain);f.chain.rpc=async(method,...params)=>method==='eth_getBalance'?'0xde0b6b3a7640000':rpc(method,...params);
  f.chain.call=async()=>{throw Error('Native balance must not use ERC20 calls');};
  f.wallet.marketOrders=async()=>({list:[{orderId:'order-1',chain:'56',fromToken:NATIVE,toToken:usdt,status:'FINISHED',toTokenActualQty:'1.0',txHash:'0x'+'ac'.repeat(32)}]});
  try{
    const r=await f.engine.dispatch('sell',{token:NATIVE,toToken:usdt,amountRaw:'1000000000000000',slippageBps:100,idempotencyKey:'native-input-stablecoin',authorization:{approved:true}});
    assert.equal(r.state,'CONFIRMED');assert.equal(r.receivedAmount,'1.0');assert.equal(r.receivedBnb,undefined);assert.equal(f.placements[0].amount,'0.001');
    await assert.rejects(f.engine.dispatch('sell.quote',{token:NATIVE,toToken:usdt}),{code:'NATIVE_AMOUNT_REQUIRED'});
  }finally{f.store.close();}
});
