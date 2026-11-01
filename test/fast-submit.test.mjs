import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,mintRequest,A } from './helpers.mjs';
import { bnagentMintRequest,checkBnagentPrice,BNAGENT } from '../src/bnagent.mjs';

const authorized=request=>({request,authorization:{approved:true,maxValueWei:request.value||'0',...(request.gasLimit===undefined?{}:{maxGasLimit:request.gasLimit})}});
test('authorized submit previews and executes once, reuses context and checks code once',async()=>{
  const f=fixture();try {
    const input=authorized(mintRequest('atomic-submit-once'));
    const result=await f.engine.submit(input);assert.equal(result.state,'BROADCASTED');
    assert.equal(f.wallet.calls.filter(x=>x==='context').length,1);
    assert.equal(f.chain.calls.filter(x=>x==='eth_getCode').length,1);
    assert.equal(f.wallet.calls.filter(x=>x==='preview').length,1);
    assert.equal(f.wallet.calls.filter(x=>x==='execute').length,1);
    assert.equal((await f.engine.submit(input)).id,result.id);
    assert.equal(f.wallet.calls.filter(x=>x==='execute').length,1);
  }finally{f.store.close();}
});
test('unauthorized or over-budget direct submissions never preview or execute',async()=>{
  const f=fixture();try {
    const request=mintRequest('direct-cap-check');
    await assert.rejects(f.engine.submit({request}),{code:'CONFIRMATION_REQUIRED'});
    await assert.rejects(f.engine.submit({request:{...request,value:'2'},authorization:{approved:true,maxValueWei:'1'}}),{code:'SPEND_LIMIT'});
    await assert.rejects(f.engine.submit({request:{...request,gasLimit:800000},authorization:{approved:true,maxValueWei:'0'}}),{code:'GAS_LIMIT_AUTHORIZATION'});
    assert(!f.wallet.calls.includes('preview'));assert(!f.wallet.calls.includes('execute'));
  }finally{f.store.close();}
});
test('new warnings and authority changes stop automatic execution after internal preview',async()=>{
  for(const field of ['risk','allowance','authority']) {
    const f=fixture();try {
      const original=f.wallet.preview.bind(f.wallet);
      f.wallet.preview=async tx=>{const p=await original(tx);if(field==='risk')p.risks.addresses={[A]:{riskLevel:5,riskDetails:[]}};else p.simulationResult[field==='allowance'?'allowanceChanges':'authorityChanges']=[{amount:'1'}];return p;};
      const result=await f.engine.submit(authorized(mintRequest('warning-stop-'+field)));
      assert.equal(result.state,'AWAITING_USER');assert.equal(result.needsReview,true);assert(!f.wallet.calls.includes('execute'));
    }finally{f.store.close();}
  }
});
test('failed simulation and unreviewed deployment cannot submit',async()=>{
  const f=fixture();try {
    f.wallet.previewError=true;await assert.rejects(f.engine.submit(authorized(mintRequest('simulation-rejected'))));
    f.wallet.previewError=false;await assert.rejects(f.engine.submit(authorized({...mintRequest('deployment-rejected'),expectedCodeHash:BNAGENT.codeHash})),{code:'CODE_CHANGED'});
    assert(!f.wallet.calls.includes('execute'));
  }finally{f.store.close();}
});
function projectChain(overrides={}) {
  const values={walletStatus:[true,1n,0n,10n,false],paused:[false],mintableNow:[100n],costOf:[14000000000000000000n],bnbQuote:[20000000000000000n],...overrides};
  return {config:{chainId:56},call:async(_,__,method)=>values[method]};
}
test('BNAGENT refreshes max quantity and table-price limit without a browser',async()=>{
  const input={url:BNAGENT.origin,shares:'max',idempotencyKey:'project-maximum',gasLimit:800000};
  const quote=await bnagentMintRequest({chain:projectChain(),wallet:A,input});
  assert.equal(quote.shares,10);assert.equal(quote.costUsdt,'14.0');assert.equal(quote.request.value,'20400000000000000');
  assert.equal(quote.request.expectedCodeHash,BNAGENT.codeHash);assert.equal(quote.request.gasLimit,800000);
  assert.doesNotThrow(()=>checkBnagentPrice(quote,'14'));
  assert.throws(()=>checkBnagentPrice(quote,'13'),{code:'PRICE_LIMIT'});
  assert.equal((await bnagentMintRequest({chain:projectChain({walletStatus:[true,1n,10n,10n,true]}),wallet:A,input})).status,'QUOTA_EXHAUSTED');
  await assert.rejects(bnagentMintRequest({chain:projectChain(),wallet:A,input:{...input,url:BNAGENT.origin+'.evil.example'}}),{code:'PROJECT_NOT_SUPPORTED'});
});
test('project price increase stops before wallet preview',async()=>{
  const f=fixture();try{
    f.chain.config={chainId:56};f.chain.call=projectChain().call;
    await assert.rejects(f.engine.projectMint({url:BNAGENT.origin,shares:'max',idempotencyKey:'price-increase-stop',maxCostUsdt:'13',authorization:{approved:true,maxValueWei:'30000000000000000'}}),{code:'PRICE_LIMIT'});
    assert(!f.wallet.calls.includes('preview'));assert(!f.wallet.calls.includes('execute'));
  }finally{f.store.close();}
});
