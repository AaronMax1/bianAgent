import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { BawAdapter } from '../src/baw.mjs';
import { Cache, epochMs } from '../src/util.mjs';
import { publicIP, projectUrl } from '../src/projects.mjs';
import { Vault } from '../src/vault.mjs';
import { mkdtempSync,rmSync,readFileSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture,mintRequest,A } from './helpers.mjs';

test('prepare is non-mutating; explicit matching preview confirmation is required',async()=>{
  const f=fixture();const op=await f.engine.prepare(mintRequest());
  assert.equal(op.state,'AWAITING_USER');assert(!f.wallet.calls.includes('execute'));assert(!('requestId'in op));
  await assert.rejects(f.engine.confirm({id:op.id,approved:true,confirmationToken:'wrong'}),{code:'CONFIRMATION_REQUIRED'});
  await assert.rejects(f.engine.confirm({id:op.id,confirmationToken:op.confirmationToken}),{code:'CONFIRMATION_REQUIRED'});
  assert(!f.wallet.calls.includes('execute'));f.store.close();
});
test('idempotency deduplicates preparation, conflicts on different parameters',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.engine.prepare(mintRequest()),f.engine.prepare(mintRequest())]);
  assert.equal(a.id,b.id);assert.equal(f.wallet.calls.filter(x=>x==='preview').length,1);
  await assert.rejects(f.engine.prepare({...mintRequest(),args:['2']}),{code:'IDEMPOTENCY_CONFLICT'});f.store.close();
});
test('explicit gas cap is preview-bound, validated and never silently dropped',async()=>{
  const f=fixture();
  try {
    const op=await f.engine.prepare({...mintRequest('custom-gas-800k'),gasLimit:800000});
    assert.equal(op.payload.gasLimit,800000);assert.equal(op.preview.gasLimit,800000);
    for(const gasLimit of [20999,15000001,800000.5,'800000'])await assert.rejects(f.engine.prepare({...mintRequest('bad-gas-'+gasLimit),gasLimit}),{code:'INVALID_GAS_LIMIT'});
    const preview=f.wallet.preview.bind(f.wallet);f.wallet.preview=async tx=>{const p=await preview(tx);delete p.gasLimit;return p;};
    await assert.rejects(f.engine.prepare({...mintRequest('dropped-gas-cap'),gasLimit:800000}),{code:'GAS_LIMIT_MISMATCH'});
    assert(!f.wallet.calls.includes('execute'));
  } finally {f.store.close();}
});
test('concurrent confirmation calls execute once; duplicate request returns original operation',async()=>{
  const f=fixture();const op=await f.engine.prepare(mintRequest());const req={id:op.id,approved:true,confirmationToken:op.confirmationToken};
  const result=await Promise.all([f.engine.confirm(req),f.engine.confirm(req)]);
  assert.equal(result[0].state,'BROADCASTED');assert.equal(f.wallet.calls.filter(x=>x==='execute').length,1);f.store.close();
});
test('expired preview and changed session do not execute',async()=>{
  const f=fixture();const op=await f.engine.prepare(mintRequest());const saved=f.store.get(op.id);saved.expiresAt=Date.now()-1;f.store.save(saved);
  await assert.rejects(f.engine.confirm({id:op.id,approved:true,confirmationToken:op.confirmationToken}),{code:'PREVIEW_EXPIRED'});
  saved.expiresAt=Date.now()+60000;f.store.save(saved);f.wallet.expire+=1000;
  await assert.rejects(f.engine.confirm({id:op.id,approved:true,confirmationToken:op.confirmationToken}),{code:'WALLET_CHANGED'});
  assert(!f.wallet.calls.includes('execute'));f.store.close();
});
test('wallet lock and changed payload prevent submission',async()=>{
  const f=fixture();const op=await f.engine.prepare(mintRequest());f.wallet.locked=true;
  const req={id:op.id,approved:true,confirmationToken:op.confirmationToken};
  await assert.rejects(f.engine.confirm(req),{code:'WALLET_LOCKED'});f.wallet.locked=false;
  const saved=f.store.get(op.id);saved.payload.value='1';f.store.save(saved);
  await assert.rejects(f.engine.confirm(req),{code:'PAYLOAD_MISMATCH'});f.store.close();
});
test('execute timeout is durable UNKNOWN_SUBMIT and blocks later writes after restart',async()=>{
  const f=fixture();f.wallet.errorBefore=true;
  const a=await f.engine.prepare(mintRequest());const result=await f.engine.confirm({id:a.id,approved:true,confirmationToken:a.confirmationToken});
  assert.equal(result.state,'UNKNOWN_SUBMIT');assert(f.store.get(a.id).submission);
  const restarted=new Engine(f);const b=await restarted.prepare(mintRequest('test-mint-2'));
  await assert.rejects(restarted.confirm({id:b.id,approved:true,confirmationToken:b.confirmationToken}),{code:'WALLET_BUSY'});
  await restarted.confirm({id:a.id,approved:true,confirmationToken:a.confirmationToken});assert.equal(f.wallet.calls.filter(x=>x==='execute').length,1);
  const recovered=await restarted.reconcile({id:a.id});assert.equal(recovered.state,'UNKNOWN_SUBMIT');assert.equal(recovered.recovery.needsReview,true);f.store.close();
});
test('crash between saved intent and wallet response recovers conservatively',async()=>{
  const f=fixture();const op=await f.engine.prepare(mintRequest());const saved=f.store.get(op.id);saved.state='EXECUTE_INTENT_SAVED';saved.submission={at:Date.now()};f.store.save(saved);
  new Engine(f);assert.equal(f.store.get(op.id).state,'UNKNOWN_SUBMIT');assert(!f.wallet.calls.includes('execute'));f.store.close();
});
test('user recovery override applies only to named unknown submissions and preserves them',async()=>{
  const f=fixture();try{
    f.wallet.errorBefore=true;const a=await f.engine.prepare(mintRequest('unknown-for-override'));
    await f.engine.confirm({id:a.id,approved:true,confirmationToken:a.confirmationToken});f.wallet.errorBefore=false;
    const b=await f.engine.prepare(mintRequest('user-authorized-new-intent'));
    const req={id:b.id,approved:true,confirmationToken:b.confirmationToken,acknowledgedUnknownOperationIds:[a.id]};
    await assert.rejects(f.engine.confirm(req),{code:'WALLET_BUSY'});
    f.wallet.locked=true;await assert.rejects(f.engine.confirm({...req,duplicatePaymentRiskAccepted:true}),{code:'WALLET_LOCKED'});f.wallet.locked=false;
    const result=await f.engine.confirm({...req,duplicatePaymentRiskAccepted:true});
    assert.equal(result.state,'BROADCASTED');assert.equal(f.store.get(a.id).state,'UNKNOWN_SUBMIT');
    assert.deepEqual(result.submission.userRecoveryOverride.operationIds,[a.id]);
  }finally{f.store.close();}
});
test('App confirmation is pending and cannot be cancelled locally',async()=>{
  const f=fixture();f.wallet.pending=true;const op=await f.engine.prepare(mintRequest());const result=await f.engine.confirm({id:op.id,approved:true,confirmationToken:op.confirmationToken});
  assert.equal(result.state,'PENDING_APP');assert.throws(()=>f.engine.cancel({id:op.id}),{code:'ALREADY_SUBMITTED'});f.store.close();
});
test('Developer Mode check precedes any quote or transaction build',async()=>{
  const f=fixture();f.wallet.devMode=false;
  await assert.rejects(f.engine.prepare(mintRequest()),{code:'DEV_MODE_REQUIRED'});assert.equal(f.chain.calls.length,0);f.store.close();
});
test('malformed amounts, unknown ABI and simulation failure never yield executable previews',async()=>{
  const f=fixture();
  await assert.rejects(f.engine.prepare({...mintRequest('bad-amount'),value:'1.1'}),{code:'INVALID_AMOUNT'});
  await assert.rejects(f.engine.prepare({...mintRequest('bad-method'),method:'notThere'}));
  f.wallet.previewError=true;await assert.rejects(f.engine.prepare(mintRequest('bad-preview')));assert(!f.store.all().some(x=>x.state==='AWAITING_USER'));f.store.close();
});
test('timestamp compatibility and wallet dev mode validation support actual CLI ISO responses',async()=>{
  assert.equal(epochMs('2026-11-05T22:27:16+08:00'),Date.parse('2026-11-05T22:27:16+08:00'));
  assert.equal(epochMs(1783390000),1783390000000);
  const adapter=new BawAdapter({chainId:56});const calls=[];
  adapter.run=async args=>{calls.push(args.join(' '));if(args[1]==='status')return{status:'CONNECTED'};if(args[1]==='settings')return{devMode:{enabled:true,expiresAt:new Date(Date.now()+3600000).toISOString()}};return{addresses:[{binanceChainId:'56',address:A}]};};
  assert.equal((await adapter.context({external:true})).address,A);assert(calls.indexOf('wallet settings')<calls.indexOf('wallet address'));
});
test('read cache coalesces simultaneous reads and does not cache failures',async()=>{
  const c=new Cache();let n=0;
  const run=()=>{n++;return{v:n};};const result=await Promise.all([c.get('x',1000,run),c.get('x',1000,run)]);
  assert.equal(n,1);result[0].v=99;assert.equal((await c.get('x',1000,run)).v,1);
  await assert.rejects(c.get('err',1000,()=>{throw Error('bad');}));assert.equal(await c.get('err',1000,()=>42),42);
});
test('project source reader rejects SSRF targets and credential-bearing URLs',()=>{
  for(const u of ['http://127.0.0.1','http://[::1]','http://169.254.169.254','https://user:password@example.com','file:///etc/passwd','http://localhost','http://192.168.1.1'])assert.throws(()=>projectUrl(u));
  assert.equal(publicIP('::ffff:127.0.0.1'),false);assert.equal(publicIP('8.8.8.8'),true);assert.equal(publicIP('10.0.0.1'),false);
});
test('project research import never invokes wallet and keeps unverified fields',async()=>{
  const f=fixture();const p=await f.engine.dispatch('project.import',{name:'Example',sources:[{url:'https://example.com'}],summary:'Research by Codex',contracts:[A],unverified:['ABI missing']});
  assert.equal(p.analysisBy,'Codex');assert.equal(f.wallet.calls.length,0);assert.equal((await f.engine.dispatch('projects')).length,1);f.store.close();
});
test('project-login message validates chain, wallet, audience and expiry; signatures never reach output',async()=>{
  const f=fixture();f.wallet.address=f.wallet.signerWallet.address;
  const typed={domain:{name:'Project Login',version:'1',chainId:56},primaryType:'SignIn',types:{SignIn:[{name:'wallet',type:'address'},{name:'audience',type:'string'},{name:'expiresAt',type:'uint256'}]},message:{wallet:f.wallet.address,audience:'example.com',expiresAt:String(Math.floor(Date.now()/1000)+3600)}};
  const req={kind:'message',idempotencyKey:'sign-in-1',purpose:'project-login',origin:'https://example.com',walletRequest:{method:'eth_signTypedData_v4',params:[f.wallet.address,JSON.stringify(typed)]}};
  const op=await f.engine.prepare(req);const signed=await f.engine.confirm({id:op.id,approved:true,confirmationToken:op.confirmationToken});
  assert.equal(signed.state,'SIGNED');assert(!('messageResult'in signed));assert(!('wrapper'in signed));assert.equal(signed.payload.purpose,'project-login');
  typed.message.audience='attacker.com';await assert.rejects(f.engine.prepare({...req,idempotencyKey:'sign-in-2',walletRequest:{...req.walletRequest,params:[f.wallet.address,JSON.stringify(typed)]}}),{code:'MESSAGE_AUDIENCE'});f.store.close();
});
test('altered stored preview and missing simulation are not executable',async()=>{
  const f=fixture();const op=await f.engine.prepare(mintRequest());const saved=f.store.get(op.id);saved.preview.parsedTx.value='999';f.store.save(saved);
  await assert.rejects(f.engine.confirm({id:op.id,approved:true,confirmationToken:op.confirmationToken}),{code:'PREVIEW_MISMATCH'});
  const original=f.wallet.preview.bind(f.wallet);f.wallet.preview=async tx=>{const result=await original(tx);delete result.simulationResult;return result;};
  await assert.rejects(f.engine.prepare(mintRequest('missing-simulation')),{code:'SIMULATION_FAILED'});f.store.close();
});
test('an unresolved operation older than the history page still blocks submission',async()=>{
  const f=fixture();const op=await f.engine.prepare(mintRequest());const saved=f.store.get(op.id);saved.state='UNKNOWN_SUBMIT';saved.submission={at:Date.now()};f.store.save(saved);
  for(let i=0;i<205;i++)f.store.save({id:'history-'+i,idempotencyKey:'history-key-'+i,state:'CANCELLED'});
  const next=await f.engine.prepare(mintRequest('new-after-history'));assert(!f.store.all().some(x=>x.id===op.id));
  await assert.rejects(f.engine.confirm({id:next.id,approved:true,confirmationToken:next.confirmationToken}),{code:'WALLET_BUSY'});f.store.close();
});
test('read-only CLI retries transient network errors, execute never retries',async()=>{
  const adapter=new BawAdapter({chainId:56});let calls=0;
  adapter.runOnce=async()=>{calls++;if(calls===1)throw Object.assign(Error('network'),{code:'NETWORK_ERROR'});return{status:'CONNECTED'};};
  assert.equal((await adapter.run(['wallet','status'])).status,'CONNECTED');assert.equal(calls,2);
  calls=0;await assert.rejects(adapter.run(['contract-call','execute','--requestId','x']),{code:'NETWORK_ERROR'});assert.equal(calls,1);
});
test('sliding inactivity expiry does not invalidate an unchanged session',()=>{
  const f=fixture();const a=f.engine.bindContext({address:A,chainId:56,settings:{signInMaxTime:'stable',sessionExpireTime:'first'}});
  const b=f.engine.bindContext({address:A,chainId:56,settings:{signInMaxTime:'stable',sessionExpireTime:'later'}});
  assert.equal(a.generation,b.generation);f.store.close();
});
test('signature vault survives restart, encrypts storage and exports only to a private file',()=>{
  const root=mkdtempSync(join(tmpdir(),'cw-vault-'));
  try {
    const vault=new Vault(root),sensitive={signature:'fixture-sensitive-signature',status:'COMPLETED'};
    const sealed=vault.seal(sensitive);assert(!JSON.stringify(sealed).includes(sensitive.signature));
    const reopened=new Vault(root);assert.deepEqual(reopened.open(sealed),sensitive);
    const exported=reopened.exportSignature({id:'safe-id',state:'SIGNED',messageResult:sealed,payload:{origin:'https://example.com'},messageExpiry:Date.now()+1000});
    assert(!JSON.stringify(exported).includes(sensitive.signature));assert.equal(statSync(exported.path).mode&0o777,0o600);
    assert.deepEqual(JSON.parse(readFileSync(exported.path,'utf8')),sensitive);
    assert.throws(()=>reopened.open({...sealed,tag:'00'.repeat(16)}));
  } finally {rmSync(root,{recursive:true,force:true});}
});
