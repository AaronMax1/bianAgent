import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { anvilFixture,mintRequest } from './helpers.mjs';

const confirm=(engine,op)=>engine.confirm({id:op.id,approved:true,confirmationToken:op.confirmationToken});
test('local chain end-to-end: quote, native buy, exact approval, token sell and business receipts',async t=>{
  const f=await anvilFixture();t.after(()=>f.close());
  const token=await f.token.getAddress(),token2=await f.token2.getAddress();
  const input={tokenIn:'native',tokenOut:token,amount:'0.01',slippageBps:100};
  const quote=await f.engine.quote(input);
  assert.equal(quote.amountInRaw,'10000000000000000');assert.equal(quote.expectedOutRaw,'20000000000000000');
  assert.equal(quote.minOutRaw,'19800000000000000');
  await assert.rejects(f.chain.rpc('eth_sendTransaction',[]),{code:'RPC_WRITE_FORBIDDEN'});
  const op=await f.engine.prepare({...input,kind:'swap',idempotencyKey:'native-buy-1'});
  assert.equal(op.decoded.recipient,f.wallet.address);
  const sent=await confirm(f.engine,op);assert.equal(sent.state,'BROADCASTED');
  const done=await f.engine.reconcile({id:op.id});assert.equal(done.state,'CONFIRMED');assert.equal(done.businessResult.receivedRaw,'20000000000000000');
  const sell={tokenIn:token,tokenOut:token2,amount:'0.005',slippageBps:100};
  await assert.rejects(f.engine.prepare({...sell,kind:'swap',idempotencyKey:'no-approve-1'}),{code:'APPROVAL_REQUIRED'});
  const approval=await f.engine.prepare({...sell,kind:'approval',idempotencyKey:'approve-1'});
  assert.equal(approval.decoded.amountRaw,'5000000000000000');
  await confirm(f.engine,approval);const approved=await f.engine.reconcile({id:approval.id});
  assert.equal(approved.state,'CONFIRMED');assert.equal(approved.businessResult.allowance,'5000000000000000');
  const sellOp=await f.engine.prepare({...sell,kind:'swap',idempotencyKey:'token-sell-1'});
  // Two-hop path produces the greater quote in this fixture.
  assert.equal(sellOp.quote.path.length,3);
  await confirm(f.engine,sellOp);const sold=await f.engine.reconcile({id:sellOp.id});
  assert.equal(sold.state,'CONFIRMED');assert.equal(sold.businessResult.receivedRaw,'20000000000000000');
  assert.equal(await f.token.allowance(f.wallet.address,await f.router.getAddress()),0n);
});
test('local chain: contract mint event, timeout-after-broadcast recovery and restart persistence',async t=>{
  const f=await anvilFixture();t.after(()=>f.close());
  const request=mintRequest('actual-mint-1',await f.project.getAddress());request.expected.args.receiver=f.wallet.address;
  const op=await f.engine.prepare(request);f.wallet.errorAfter=true;
  const sent=await confirm(f.engine,op);assert.equal(sent.state,'UNKNOWN_SUBMIT');assert.equal(await f.project.minted(),1n);
  const restarted=new Engine(f);
  const recovered=await restarted.reconcile({id:op.id});
  assert.equal(recovered.state,'CONFIRMED');assert.equal(recovered.businessResult.verified,true);
  assert.equal(f.wallet.calls.filter(x=>x==='execute').length,1);
  await confirm(restarted,op);assert.equal(await f.project.minted(),1n);
});
test('local chain: wrong hash, missing event and reverted simulation cannot claim success',async t=>{
  const f=await anvilFixture();t.after(()=>f.close());
  const p=await f.project.getAddress();const req=mintRequest('wrong-event-1',p);req.expected.args.quantity='999';req.expected.args.receiver=f.wallet.address;
  const op=await f.engine.prepare(req);await confirm(f.engine,op);
  const result=await f.engine.reconcile({id:op.id});assert.equal(result.state,'RESULT_MISMATCH');assert.equal(result.error.code,'EXPECTED_EVENT_MISSING');
  await assert.rejects(f.engine.prepare({kind:'contract',idempotencyKey:'broken-preview-1',to:p,abi:['function broken()'],method:'broken',args:[]}));
  assert(!f.store.all().filter(x=>x.idempotencyKey==='broken-preview-1').some(x=>x.state==='AWAITING_USER'));
});
test('local chain: historical identical calls cannot be attached to a new operation',async t=>{
  const f=await anvilFixture();t.after(()=>f.close());
  const req=mintRequest('first-identical',await f.project.getAddress());req.expected.args.receiver=f.wallet.address;
  const first=await f.engine.prepare(req);const sent=await confirm(f.engine,first);await f.engine.reconcile({id:first.id});
  f.wallet.pending=true;const next=await f.engine.prepare({...req,idempotencyKey:'second-identical'});await confirm(f.engine,next);
  await assert.rejects(f.engine.reconcile({id:next.id,txHash:sent.txHash}),{code:'TRANSACTION_MISMATCH'});
  assert.equal(f.store.get(next.id).state,'PENDING_APP');
});
test('local chain: a reverted block removes prior success evidence',async t=>{
  const f=await anvilFixture();t.after(()=>f.close());
  const snapshot=await f.provider.send('evm_snapshot',[]);
  const req=mintRequest('reorg-mint-1',await f.project.getAddress());req.expected.args.receiver=f.wallet.address;
  const op=await f.engine.prepare(req);await confirm(f.engine,op);assert.equal((await f.engine.reconcile({id:op.id})).state,'CONFIRMED');
  await f.provider.send('evm_revert',[snapshot]);
  const after=await f.engine.reconcile({id:op.id});
  assert.equal(after.state,'BROADCASTED');assert.equal(after.businessResult,undefined);assert.equal(after.confirmations,undefined);
});
