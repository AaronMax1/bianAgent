import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/accounts.mjs';
import { BatchRunner } from '../src/batches.mjs';
import { BSC } from '../src/config.mjs';
import { BNAGENT } from '../src/bnagent.mjs';
import { NATIVE } from '../src/market-sell.mjs';
import { keccak256 } from 'ethers';
import { FakeWallet,FakeChain,mintRequest,A,B,C,anvilFixture } from './helpers.mjs';

function setup(overrides={}){
  const root=mkdtempSync(join(tmpdir(),'cw-batches-'));
  const config={...BSC,root,dbPath:join(root,'state.sqlite'),socket:join(root,'s.sock'),...overrides};
  const accounts=new AccountManager({config,chain:new FakeChain(),wallet:new FakeWallet(),walletFactory:(_c,a)=>{const w=new FakeWallet();w.address=a.alias==='b'?B:C;return w;}});
  accounts.add({alias:'b'});accounts.add({alias:'c'});
  const batches=new BatchRunner({accounts,config});
  return {root,config,accounts,batches,async close(){await this.batches.close();await this.accounts.close();rmSync(root,{recursive:true,force:true});}};
}
function input(key='batch-plan-fixture',accountIds=['default','b'],value='0'){
  return {idempotencyKey:key,accountIds,action:'submit',params:{request:{...mintRequest(),abi:['function mint(uint256 quantity) payable'],value,
    expected:{kind:'event',abi:['event Minted(address indexed receiver,uint256 quantity)'],event:'Minted',args:{receiver:'$wallet',quantity:'1'}}}},
    limits:{maxValueWeiPerAccount:value,maxTotalValueWei:String(BigInt(value)*BigInt(accountIds.length))}};
}
async function settle(runner){for(let i=0;i<50;i++){if(!runner.active.size)return;await Promise.all([...runner.active.values()]);}throw new Error('Batch did not settle');}
test('batch plan binds selected wallets and confirmation; retrying plan or run cannot submit twice',async()=>{
  const f=setup();
  try{
    const request=input(),plan=await f.batches.plan(request);
    assert.equal(plan.tasks.length,2);assert.equal(plan.tasks[0].preview.expected.args.receiver,A);assert.equal(plan.tasks[1].preview.expected.args.receiver,B);
    assert(!f.accounts.get().wallet.calls.includes('execute'));assert(!f.accounts.get('c').wallet.calls.includes('preview'));
    assert.equal((await f.batches.plan(request)).id,plan.id);
    await assert.rejects(f.accounts.dispatch('confirm',{id:plan.tasks[0].operationId,approved:true,confirmationToken:plan.tasks[0].confirmationToken}),{code:'BATCH_EXECUTION_REQUIRED'});
    assert.throws(()=>f.batches.run({id:plan.id,approved:true,planToken:'wrong'}),{code:'CONFIRMATION_REQUIRED'});
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    const result=f.batches.status({id:plan.id});assert.equal(result.state,'PENDING');
    for(const alias of ['default','b'])assert.equal(f.accounts.get(alias).wallet.calls.filter(c=>c==='execute').length,1);
    assert(!f.accounts.get('c').wallet.calls.includes('execute'));
    assert.equal(f.accounts.get('b').store.scan().length,1);
  }finally{await f.close();}
});
test('total budget is checked before any batch execution and concurrent reservations stay capped',async()=>{
  const f=setup();
  try{
    const request=input('batch-over-budget',['default','b'],'5');request.limits.maxTotalValueWei='9';
    const plan=await f.batches.plan(request);assert.equal(plan.error.code,'BATCH_BUDGET_EXCEEDED');
    assert.throws(()=>f.batches.run({id:plan.id,approved:true,planToken:plan.planToken}),{code:'BATCH_BUDGET_EXCEEDED'});
    assert(!f.accounts.get().wallet.calls.includes('execute'));
    const valid=await f.batches.plan(input('batch-exact-budget',['default','b'],'5'));
    f.batches.run({id:valid.id,approved:true,planToken:valid.planToken});await settle(f.batches);
    assert.equal(f.batches.status({id:valid.id}).reservedValueWei,'10');
  }finally{await f.close();}
});
test('unselected accounts do not execute and a new account never joins an approved selection',async()=>{
  const f=setup();
  try{
    const plan=await f.batches.plan(input('batch-single-selection',['b']));
    f.accounts.add({alias:'later'});
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    assert.equal(f.accounts.get('b').wallet.calls.filter(c=>c==='execute').length,1);
    assert(!f.accounts.get().wallet.calls.includes('execute'));assert(!f.accounts.runtimes.has(f.accounts.resolve('later').id));
    await assert.rejects(f.batches.plan(input('batch-duplicate-selection',['b','b'])),{code:'DUPLICATE_ACCOUNT'});
    await assert.rejects(f.batches.plan(input('batch-empty-selection',[])),{code:'INVALID_ACCOUNTS'});
  }finally{await f.close();}
});
test('all selection expands to an immutable list at planning time',async()=>{
  const f=setup();
  try{
    const plan=await f.batches.plan(input('batch-all-selection','all'));
    assert.equal(plan.accountIds.length,3);f.accounts.add({alias:'later'});
    assert.equal(f.batches.status({id:plan.id}).accountIds.length,3);
  }finally{await f.close();}
});
test('expired previews, account changes and tampered previews cannot execute',async()=>{
  const f=setup();
  try{
    const plan=await f.batches.plan(input('batch-expiry-test',['b']));
    const expired=f.accounts.get('b').store.get(plan.tasks[0].operationId);expired.expiresAt=0;f.accounts.get('b').store.save(expired);
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    assert.equal(f.batches.status({id:plan.id}).tasks[0].state,'EXPIRED');assert(!f.accounts.get('b').wallet.calls.includes('execute'));
    const other=await f.batches.plan(input('batch-account-change',['default']));f.accounts.get().wallet.address=C;
    f.batches.run({id:other.id,approved:true,planToken:other.planToken});await settle(f.batches);
    assert.equal(f.batches.status({id:other.id}).tasks[0].state,'FAILED');assert(!f.accounts.get().wallet.calls.includes('execute'));
    f.accounts.get().wallet.address=A;
    const third=await f.batches.plan(input('batch-preview-tamper',['default']));
    const r=f.accounts.get(),op=r.store.get(third.tasks[0].operationId);op.preview.parsedTx.value='1000';r.store.save(op);
    f.batches.run({id:third.id,approved:true,planToken:third.planToken});await settle(f.batches);
    assert.equal(f.batches.status({id:third.id}).tasks[0].error.code,'PREVIEW_MISMATCH');
  }finally{await f.close();}
});
test('a timeout is durable pending, does not block another account and is never automatically retried',async()=>{
  const f=setup();
  try{
    f.accounts.get().wallet.errorBefore=true;
    const plan=await f.batches.plan(input('batch-timeout-test'));
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    const result=f.batches.status({id:plan.id});
    assert.equal(result.tasks[0].result.state,'UNKNOWN_SUBMIT');assert.equal(result.tasks[1].result.state,'BROADCASTED');
    f.batches.resume({id:plan.id});await settle(f.batches);
    assert.equal(f.accounts.get().wallet.calls.filter(c=>c==='execute').length,1);
  }finally{await f.close();}
});
test('global batch concurrency, per-account exclusion, pause and cancel apply to queued items',async()=>{
  const f=setup({batchConcurrency:1});
  let release;
  try{
    const gate=new Promise(r=>release=r),wallet=f.accounts.get().wallet,original=wallet.execute.bind(wallet);
    wallet.execute=async(...args)=>{await gate;return original(...args);};
    const plan=await f.batches.plan(input('batch-pause-test',['default','b','c']));
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});
    await new Promise(r=>setTimeout(r,10));assert.equal(f.batches.active.size,1);
    f.batches.pause({id:plan.id});release();await settle(f.batches);
    assert(!f.accounts.get('b').wallet.calls.includes('execute'));
    f.batches.cancel({id:plan.id});f.batches.resume({id:plan.id});await settle(f.batches);
    assert.equal(f.batches.status({id:plan.id}).tasks.filter(t=>t.state==='CANCELLED').length,2);
  }finally{release?.();await f.close();}
});
test('restart pauses queued work and links interrupted submissions by durable operation IDs',async()=>{
  const f=setup();
  try{
    const plan=await f.batches.plan(input('batch-restart-test',['b']));
    f.batches.stopping=true;f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});
    const b=f.batches.get(plan.id);b.tasks[0].state='RUNNING';f.batches.save(b);
    const runtime=f.accounts.get('b'),op=runtime.store.get(plan.tasks[0].operationId);
    op.submission={at:Date.now(),minNonce:'0'};op.state='UNKNOWN_SUBMIT';runtime.store.save(op);
    await f.batches.close();
    const second=new BatchRunner({accounts:f.accounts,config:f.config});f.batches=second;second.start();
    const recovered=second.status({id:plan.id});assert.equal(recovered.state,'PAUSED');assert.equal(recovered.tasks[0].state,'PENDING');
    second.resume({id:plan.id});await settle(second);assert(!runtime.wallet.calls.includes('execute'));
  }finally{await f.close();}
});
test('pause arriving during final wallet checks prevents submission and resume uses the same approved item',async()=>{
  const f=setup();let release;
  try{
    const plan=await f.batches.plan(input('batch-pause-final-check',['b']));
    const wallet=f.accounts.get('b').wallet,gate=new Promise(r=>release=r);let entered;
    const started=new Promise(r=>entered=r);wallet.lock=async()=>{entered();await gate;return{status:'UNLOCKED'};};
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await started;
    f.batches.pause({id:plan.id});release();await settle(f.batches);
    assert(!wallet.calls.includes('execute'));assert.equal(f.batches.status({id:plan.id}).tasks[0].state,'QUEUED');
    f.batches.resume({id:plan.id});await settle(f.batches);assert.equal(wallet.calls.filter(c=>c==='execute').length,1);
  }finally{release?.();await f.close();}
});
test('changing selected accounts or budgets invalidates the stored plan',async()=>{
  const f=setup();
  try{
    const plan=await f.batches.plan(input('batch-tamper-budget',['b']));
    const b=f.batches.get(plan.id);b.limits.maxTotalValueWei='1000';f.batches.save(b);
    assert.throws(()=>f.batches.run({id:b.id,approved:true,planToken:plan.planToken}),{code:'BATCH_PLAN_MISMATCH'});
    assert(!f.accounts.get('b').wallet.calls.includes('execute'));
  }finally{await f.close();}
});
function marketSetup(){
  const f=setup({marketWaitMs:0}),chain=f.accounts.chain;
  chain.call=async(_,__,method,args)=>method==='decimals'?[18n]:method==='balanceOf'?[args[0]===A?1000000000000000000n:2000000000000000000n]:[];
  for(const alias of ['default','b']){
    const w=f.accounts.get(alias).wallet;w.placements=[];
    w.marketQuote=async p=>({fromCoinAmount:p.amount,toCoinAmount:'0.01'});
    w.marketSwap=async p=>{w.placements.push(p);return{orderId:'order-'+alias};};
    w.marketOrders=async()=>({list:[{orderId:'order-'+alias,status:'PENDING'}]});
  }
  return f;
}
test('aggregated batch sell fixes each wallet amount, keeps order IDs separate and does not repeat placements',async()=>{
  const f=marketSetup();
  try{
    const plan=await f.batches.plan({idempotencyKey:'batch-sell-amounts',accountIds:['default','b'],action:'sell',params:{token:C},limits:{maxValueWeiPerAccount:'0',maxTotalValueWei:'0'}});
    assert(plan.tasks.every(t=>t.state==='READY'));
    assert.equal(plan.tasks[0].params.amountRaw,'1000000000000000000');assert.equal(plan.tasks[1].params.amountRaw,'2000000000000000000');
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    const status=f.batches.status({id:plan.id});assert.equal(status.counts.PENDING,2);
    assert.notEqual(status.tasks[0].result.orderId,status.tasks[1].result.orderId);
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    assert.equal(f.accounts.get().wallet.placements.length,1);assert.equal(f.accounts.get('b').wallet.placements.length,1);
  }finally{await f.close();}
});
test('a changed sell amount invalidates approval and an over-budget native input cannot be placed',async()=>{
  const f=marketSetup();
  try{
    const plan=await f.batches.plan({idempotencyKey:'batch-sell-tamper',accountIds:['b'],action:'sell',params:{token:C},limits:{maxValueWeiPerAccount:'0',maxTotalValueWei:'0'}});
    const b=f.batches.get(plan.id);b.tasks[0].params.amountRaw='999';f.batches.save(b);
    assert.throws(()=>f.batches.run({id:plan.id,approved:true,planToken:plan.planToken}),{code:'BATCH_PLAN_MISMATCH'});
    const rpc=f.accounts.chain.rpc.bind(f.accounts.chain);f.accounts.chain.rpc=(m,...args)=>m==='eth_getBalance'?Promise.resolve('0x100000'):rpc(m,...args);
    const native=await f.batches.plan({idempotencyKey:'batch-native-over-cap',accountIds:['b'],action:'sell',params:{token:NATIVE,toToken:'0x55d398326f99059fF775485246999027B3197955',amountRaw:'100'},limits:{maxValueWeiPerAccount:'99',maxTotalValueWei:'99'}});
    assert.equal(native.tasks[0].state,'FAILED');assert.equal(native.tasks[0].error.code,'SPEND_LIMIT');assert.equal(f.accounts.get('b').wallet.placements.length,0);
  }finally{await f.close();}
});
test('market pause during a quote resumes safely using the same fixed amount and key',async()=>{
  const f=marketSetup();let release;
  try{
    const plan=await f.batches.plan({idempotencyKey:'batch-sell-pause',accountIds:['b'],action:'sell',params:{token:C},limits:{maxValueWeiPerAccount:'0',maxTotalValueWei:'0'}});
    const w=f.accounts.get('b').wallet;let entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
    w.marketQuote=async p=>{entered();await gate;return{fromCoinAmount:p.amount,toCoinAmount:'0.01'};};
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await started;
    f.batches.pause({id:plan.id});release();await settle(f.batches);assert.equal(w.placements.length,0);
    f.batches.resume({id:plan.id});await settle(f.batches);assert.equal(w.placements.length,1);
  }finally{release?.();await f.close();}
});
test('BNAGENT batch prepares wallet-specific recipients and enforces table price and native caps',async()=>{
  const f=setup();
  try{
    const chain=f.accounts.chain;chain.config={chainId:56};
    chain.call=async(_,__,method)=>({walletStatus:[true,1n,0n,10n,false],paused:[false],mintableNow:[100n],costOf:[1000000000000000000n],bnbQuote:[100n]})[method];
    const request={idempotencyKey:'batch-bnagent-under-cap',accountIds:['default','b'],action:'project.mint',params:{url:BNAGENT.origin,shares:'1',maxCostUsdt:'1'},limits:{maxValueWeiPerAccount:'102',maxTotalValueWei:'204'}};
    // Stub only the reviewed deployment's code hash for this adapter fixture; execution remains FakeWallet.
    const originalPrepare=async engine=>{
      const fn=engine.prepare.bind(engine);
      engine.prepare=input=>fn({...input,expectedCodeHash:keccak256('0x60006000')});
    };
    await originalPrepare(f.accounts.get().engine);await originalPrepare(f.accounts.get('b').engine);
    const plan=await f.batches.plan(request);assert(plan.tasks.every(t=>t.state==='READY'));
    assert.equal(plan.tasks[0].preview.expected.args.to,A);assert.equal(plan.tasks[1].preview.expected.args.to,B);
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    assert.equal(f.batches.status({id:plan.id}).reservedValueWei,'204');
    const rejected=await f.batches.plan({...request,idempotencyKey:'batch-bnagent-price-cap',params:{...request.params,maxCostUsdt:'0.5'}});
    assert(rejected.tasks.every(t=>t.error.code==='PRICE_LIMIT'));
  }finally{await f.close();}
});
test('offline accounts are reported individually and ready accounts still execute',async()=>{
  const f=setup();
  try{
    f.accounts.get('b').wallet.connected=false;
    const plan=await f.batches.plan(input('batch-offline-test'));
    assert.equal(plan.tasks[0].state,'READY');assert.equal(plan.tasks[1].state,'NEEDS_LOGIN');
    f.batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(f.batches);
    assert.equal(f.accounts.get().wallet.calls.filter(c=>c==='execute').length,1);
    f.accounts.get('b').wallet.connected=true;f.batches.resume({id:plan.id});await settle(f.batches);
    assert(!f.accounts.get('b').wallet.calls.includes('execute'));
  }finally{await f.close();}
});
test('local chain: selected wallets each mint once, reconcile independently and preserve business results',async()=>{
  const f=await anvilFixture();let accounts,batches;
  try{
    const secondSigner=await f.provider.getSigner(1),wallet2=new FakeWallet(secondSigner);wallet2.address=await secondSigner.getAddress();
    accounts=new AccountManager({config:f.config,chain:f.chain,wallet:f.wallet,store:f.store,walletFactory:()=>wallet2});
    accounts.add({alias:'b'});batches=new BatchRunner({accounts,config:f.config});
    const request=input('batch-local-chain',['default','b']);request.params.request={...mintRequest('unused-key',await f.project.getAddress()),expected:{kind:'event',abi:['event Minted(address indexed receiver,uint256 quantity)'],event:'Minted',args:{receiver:'$wallet',quantity:'1'}}};
    const plan=await batches.plan(request);assert(plan.tasks.every(t=>t.state==='READY'));
    batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(batches);
    for(const t of plan.tasks)await accounts.get(t.accountId).engine.reconcile({id:t.operationId});
    const result=batches.status({id:plan.id});assert.equal(result.state,'COMPLETED');assert.equal(result.counts.SUCCEEDED,2);
    assert(result.tasks.every(t=>t.result.businessResult.verified));assert.equal(await f.project.minted(),2n);
    batches.run({id:plan.id,approved:true,planToken:plan.planToken});await settle(batches);assert.equal(await f.project.minted(),2n);
  }finally{
    await batches?.close();
    // The fixture owns the injected default store and shared chain.
    if(accounts){for(const r of accounts.runtimes.values())if(r.store!==f.store)r.store.close();}
    await f.close();
  }
});
