import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface,parseEther } from 'ethers';
import { Engine } from '../src/engine.mjs';
import { allowanceNeedsReview,simulationRejected } from '../src/trade-policy.mjs';
import { fixture,anvilFixture,mintRequest,A,B } from './helpers.mjs';

const rejected=()=>Object.assign(new Error('simulation error'),{code:'BINANCE_API_ERROR',details:{apiCode:'953401'}});
const input=key=>({token:B,idempotencyKey:key,authorization:{approved:true,maxGasLimit:800000}});
function sellFixture(){
  const f=fixture();f.quoteReads=0;
  f.chain.call=async(_,__,method,args)=>{
    if(method==='balanceOf'||method==='allowance')return[1000n];
    if(method==='getAmountsOut'){f.quoteReads++;return[[args[0],args[0]*2n]];}
    throw Error('Unexpected read '+method);
  };return f;
}
test('sell defaults to 10% and preserves an explicitly requested smaller slippage',async()=>{
  const f=sellFixture();try{
    const a=await f.engine.dispatch('sell.v2.quote',{token:B});assert.equal(a.slippageBps,1000);assert.equal(a.minWei,'1800');
    const b=await f.engine.dispatch('sell.v2.quote',{token:B,slippageBps:100});assert.equal(b.minWei,'1980');
  }finally{f.store.close();}
});
test('explicit simulation rejection refreshes quote immediately with a bounded three-attempt limit',async()=>{
  const f=sellFixture();try{
    let calls=0;f.wallet.execute=async()=>{calls++;throw rejected();};f.wallet.history=async()=>{throw Error('must not poll history');};
    const result=await f.engine.dispatch('sell.v2',input('three-sell-attempts'));
    assert.equal(result.state,'FAILED');assert.equal(calls,3);assert.equal(f.quoteReads,6);
    assert(f.store.scan().every(o=>o.state==='FAILED'&&o.failure.broadcastRejected));
    assert.equal([...f.wallet.previews.values()][1].gasLimit,800000);
    await f.engine.dispatch('sell.v2',input('three-sell-attempts'));assert.equal(calls,3);
  }finally{f.store.close();}
});
test('transport uncertainty never starts a second sell attempt',async()=>{
  const f=sellFixture();try{
    let calls=0;f.wallet.execute=async()=>{calls++;throw Object.assign(Error('network timeout'),{code:'NETWORK_ERROR'});};
    const result=await f.engine.dispatch('sell.v2',input('unknown-sell-attempt'));
    assert.equal(result.state,'UNKNOWN_SUBMIT');assert.equal(calls,1);assert.equal(f.store.scan().length,1);
  }finally{f.store.close();}
});
test('known simulation codes do not override order/hash evidence or generic failures',()=>{
  assert.equal(simulationRejected(rejected()),true);
  assert.equal(simulationRejected({code:'BINANCE_API_ERROR',details:{apiCode:'351803'}}),false);
  assert.equal(simulationRejected({code:'NETWORK_ERROR',message:'simulation error'}),false);
  assert.equal(simulationRejected({...rejected(),details:{apiCode:'953401',submissionEvidence:true}}),false);
});
test('consuming an allowance needs no new approval; malformed data and real increases still do',async()=>{
  assert.equal(allowanceNeedsReview({preAmount:2.14e26,postAmount:0}),false);
  assert.equal(allowanceNeedsReview({preAmount:'100',postAmount:'90'}),false);
  assert.equal(allowanceNeedsReview({preAmount:'0',postAmount:'100'}),true);
  assert.equal(allowanceNeedsReview({}),true);
  const f=fixture();try{
    const preview=f.wallet.preview.bind(f.wallet);f.wallet.preview=async tx=>{const p=await preview(tx);p.simulationResult.allowanceChanges=[{preAmount:2.14e26,postAmount:0}];return p;};
    const result=await f.engine.submit({request:mintRequest('consumed-allowance'),authorization:{approved:true,maxValueWei:'0'}});
    assert.equal(result.state,'BROADCASTED');
  }finally{f.store.close();}
});
test('legacy explicit simulation rejection is released, while unknown transport stays blocked',async()=>{
  const f=fixture();try{
    const a=await f.engine.prepare(mintRequest('legacy-rejection'));const op=f.store.get(a.id);op.state='UNKNOWN_SUBMIT';op.submission={at:Date.now()};op.error={code:'BINANCE_API_ERROR',message:'simulation error',details:{apiCode:'953401'}};f.store.save(op);
    new Engine(f);assert.equal(f.store.get(a.id).state,'FAILED');assert(f.store.get(a.id).failure.reclassifiedAt);
  }finally{f.store.close();}
});
test('local chain: full sell, exact approval, one rejected execution, fresh retry and verified native receipt',async t=>{
  const f=await anvilFixture();t.after(()=>f.close());const token=await f.token.getAddress(),router=await f.router.getAddress(),amount=parseEther('0.001');
  await(await f.token.mint(f.wallet.address,amount)).wait();await(await f.signer.sendTransaction({to:router,value:parseEther('1')})).wait();
  const config={...f.config,wrapped:router},engine=new Engine({...f,config});let rejects=0;
  const execute=f.wallet.execute.bind(f.wallet);f.wallet.execute=async requestId=>{const tx=f.wallet.previews.get(requestId);if(tx.to===router&&rejects++===0)throw rejected();return execute(requestId);};
  const preview=f.wallet.preview.bind(f.wallet),approve=new Interface(['function approve(address,uint256) returns(bool)']);
  f.wallet.preview=async tx=>{const p=await preview(tx);if(tx.to===token){const decoded=approve.parseTransaction({data:tx.data});p.simulationResult.allowanceChanges=[{tokenAddress:token,owner:f.wallet.address,spender:router,preAmount:'0',postAmount:String(decoded.args[1])}];}return p;};
  const request={token,idempotencyKey:'local-native-sale',authorization:{approved:true,maxGasLimit:800000}};
  const result=await engine.dispatch('sell.v2',request);assert.equal(result.state,'CONFIRMED');assert.equal(result.businessResult.verified,true);
  assert.equal(result.saleQuote.slippageBps,1000);assert.equal(await f.token.balanceOf(f.wallet.address),0n);assert.equal(await f.token.allowance(f.wallet.address,router),0n);
  assert.equal(result.receivedBnb,'0.004');assert.equal(result.attempts.length,3);
  const again=await engine.dispatch('sell.v2',request);assert.equal(again.txHash,result.txHash);assert.equal(rejects,2);
});
