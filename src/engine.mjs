import { Interface, keccak256, TypedDataEncoder, verifyTypedData, getBytes } from 'ethers';
import { check, fail, id, digest, address, sameAddress, uint, hex, epochMs, redact, Mutex, publicError } from './util.mjs';
import { tokenAbi } from './chain.mjs';
import { fetchProject, projectUrl } from './projects.mjs';
import { Vault } from './vault.mjs';
import { projectPreflight } from './project-preflight.mjs';
import { bnagentMintRequest,checkBnagentPrice } from './bnagent.mjs';
import { simulationRejected,allowanceNeedsReview } from './trade-policy.mjs';
import { runSell,sellQuote } from './sell.mjs';
import { runAggregatedSell,aggregatedSellQuote,reconcileMarket } from './market-sell.mjs';

const BLOCKING = new Set(['EXECUTE_INTENT_SAVED','SUBMITTING','UNKNOWN_SUBMIT','PENDING_APP','MARKET_PENDING','BROADCASTED','INCLUDED','RESULT_MISMATCH']);
const FINAL = new Set(['CONFIRMED','FAILED','REJECTED','CANCELLED','SIGNED']);
const previewToken=op=>digest({id:op.id,version:op.previewVersion,payload:op.payloadHash,preview:op.preview,
  ...(op.previewVersion>=2?{accountId:op.accountId,wallet:op.wallet,chainId:op.chainId,deviceProfileVersion:op.deviceProfileVersion,batchId:op.batchId}: {})});
export class Engine {
  mutex = new Mutex();
  constructor({ store, wallet, chain, config }) {
    Object.assign(this,{store,wallet,chain,config});
    this.vault=new Vault(config.root);
    // A process may have died after recording intent and before receiving a response.
    for (const op of store.scan()) if (['SUBMITTING','EXECUTE_INTENT_SAVED','PREPARING'].includes(op.state)) {
      op.state = op.submission ? 'UNKNOWN_SUBMIT' : 'FAILED'; store.save(op);
    }
    for(const op of store.scan())if(op.state==='UNKNOWN_SUBMIT'&&op.kind!=='message'&&!op.txHash&&!op.orderId&&simulationRejected(op.error)) {
      op.state='FAILED';op.failure={stage:'execute-simulation',broadcastRejected:true,retryable:true,reclassifiedAt:Date.now()};store.save(op);
    }
  }
  async status() {
    const s = await this.wallet.status();
    let ctx;
    if (s.status === 'CONNECTED') {ctx = await this.wallet.context();this.bindContext(ctx);}
    return { mode:'codex-skill-local-service', chainId:this.config.chainId, walletStatus:s.status,
      walletTransport:this.wallet.transport||'cli',accountId:this.config.accountId,
      address:ctx?.address, settings:ctx?.settings, observedAt:Date.now(), pairing:this.wallet.pairing,
      pending:this.store.scan().filter(x=>BLOCKING.has(x.state)).map(x=>this.view(x)), timings:this.wallet.timings };
  }
  bindContext(ctx) {
    this.observeContext?.(ctx);
    const prev=this.store.kv('walletContext');
    // sessionExpireTime can slide with activity; it is not a stable session identity.
    const sessionKey=ctx.settings.signInMaxTime||null;
    const changed=!prev || !sameAddress(prev.address,ctx.address) || prev.sessionKey!==sessionKey ||
      (this.config.accountId&&prev.deviceProfileVersion!==this.config.deviceProfileVersion);
    const binding={address:address(ctx.address),chainId:ctx.chainId,sessionKey,generation:changed?id():prev.generation,
      ...(this.config.accountId?{accountId:this.config.accountId,deviceProfileVersion:this.config.deviceProfileVersion}: {})};
    this.store.kv('walletContext',binding); return binding;
  }
  async context({external=true}={}) { return this.bindContext(await this.wallet.context({external,fresh:true})); }
  view(op) {
    const clean=structuredClone(op);
    if(this.config.accountId){clean.accountId=this.config.accountId;clean.walletAddress=op.wallet;}
    delete clean.requestId; delete clean.wrapper; delete clean.messageResult;
    if(clean.preview) { delete clean.preview.requestId; clean.preview=redact(clean.preview); }
    if(clean.submission) delete clean.submission.requestId;
    // EIP-712 typed data itself can contain capability material: only parsed preview is public.
    if(clean.payload?.kind==='message') clean.payload={kind:'message',wallet:clean.payload.wallet,chainId:clean.payload.chainId,typedDataHash:clean.payload.typedDataHash,purpose:clean.payload.purpose};
    return redact(clean);
  }
  existing(input) {
    check(typeof input.idempotencyKey==='string' && input.idempotencyKey.length>=8 && input.idempotencyKey.length<=128,'IDEMPOTENCY_REQUIRED','Provide an idempotencyKey of 8–128 characters');
    const old=this.store.byKey(input.idempotencyKey);
    if(old) { check(old.inputHash===digest(input),'IDEMPOTENCY_CONFLICT','Key already used with different parameters'); return this.view(old); }
  }
  async quote(input) { const ctx=await this.context(); return this.chain.quote(input,ctx.address); }
  async prepare(input) { return this.mutex.run(()=>this.prepareInner(input)); }
  async prepareInner(input,ctx) {
    const old=this.existing(input); if(old)return old;
    ctx ||= await this.context();
    const op={id:id(),idempotencyKey:input.idempotencyKey,inputHash:digest(input),kind:input.kind,label:String(input.label||input.kind).slice(0,160),
      wallet:ctx.address,chainId:ctx.chainId,context:ctx,state:'PREPARING',createdAt:Date.now()};
    if(input.batchId)op.batchId=input.batchId;
    if(input.projectIntentHash)op.projectIntentHash=input.projectIntentHash;
    this.store.save(op);
    try {
      if(input.kind==='swap' || input.kind==='approval') {
        const q=await this.chain.quote(input,ctx.address); op.quote=q;
        const balances=await this.chain.balances(q,ctx.address);
        if(input.kind==='approval') {
          check(!q.nativeIn,'APPROVAL_NOT_NEEDED','Native coin requires no token approval');
          check(BigInt(balances.allowance)<BigInt(q.amountInRaw),'APPROVAL_NOT_NEEDED','Existing allowance is sufficient');
          op.payload={chainId:ctx.chainId,from:ctx.address,to:q.tokenIn,value:'0',data:tokenAbi.encodeFunctionData('approve',[q.router,q.amountInRaw])};
          op.decoded={method:'approve',spender:q.router,amountRaw:q.amountInRaw,token:q.tokenIn};
          op.expected={kind:'approval',token:q.tokenIn,spender:q.router,amountRaw:q.amountInRaw};
        } else {
          check(BigInt(balances.allowance)>=BigInt(q.amountInRaw),'APPROVAL_REQUIRED','Prepare and confirm an exact-amount approval first; then prepare a fresh swap');
          op.payload=this.chain.buildSwap(q,ctx.address);
          op.decoded={method:'swap',recipient:ctx.address,path:q.path,amountInRaw:q.amountInRaw,minOutRaw:q.minOutRaw,deadline:op.payload.deadline};
          op.expected={kind:'swap',tokenOut:q.tokenOut,nativeOut:q.nativeOut,minOutRaw:q.minOutRaw};
        }
      } else if(input.kind==='contract') {
        const to=address(input.to);
        check(Array.isArray(input.abi)&&input.abi.length>0&&input.abi.length<=100,'ABI_REQUIRED','Provide an explicit ABI array');
        const abi=new Interface(input.abi); const method=abi.getFunction(input.method);
        check(method && !['view','pure'].includes(method.stateMutability),'READ_ONLY_METHOD','Use inspect for read-only calls');
        const value=uint(input.value??'0');
        check(method.payable || value==='0','NONPAYABLE_VALUE','Nonpayable method cannot receive native coin');
        const data=hex(abi.encodeFunctionData(input.method,input.args||[]));
        const decoded=abi.parseTransaction({data,value});
        check(decoded?.signature===method.format('sighash'),'PAYLOAD_MISMATCH','Encoded method does not match requested ABI');
        op.payload={chainId:ctx.chainId,from:ctx.address,to,value,data};
        if(input.gasLimit!==undefined) {
          check(Number.isSafeInteger(input.gasLimit)&&input.gasLimit>=21000&&input.gasLimit<=15000000,'INVALID_GAS_LIMIT','gasLimit must be an integer from 21000 to 15000000');
          op.payload.gasLimit=input.gasLimit;
        }
        op.decoded={method:decoded.signature,args:decoded.args.toArray(true),valueWei:value};
        const code=await this.chain.rpc('eth_getCode',[to,'latest']);
        check(code!=='0x','NO_CONTRACT','Target has no deployed contract code');
        op.codeHash=keccak256(code);
        if(input.expectedCodeHash)check(op.codeHash===input.expectedCodeHash,'CODE_CHANGED','Contract deployment no longer matches the reviewed project');
        op.expected=this.validateExpected(input.expected,to);
      } else if(input.kind==='message') {
        check(input.purpose==='project-login','MESSAGE_SCOPE','This release supports project-login EIP-712 signatures; permits require a dedicated adapter');
        const origin=projectUrl(input.origin).origin;
        const w=input.walletRequest;
        check(w?.method==='eth_signTypedData_v4' && Array.isArray(w.params) && w.params.length===2 && sameAddress(w.params[0],ctx.address),'INVALID_MESSAGE','Provide a full eth_signTypedData_v4 request for the current wallet');
        const typed=typeof w.params[1]==='string'?JSON.parse(w.params[1]):w.params[1];
        check(typed.primaryType==='SignIn','MESSAGE_SCOPE','Project login must use primaryType SignIn');
        check(Number(typed.domain?.chainId)===ctx.chainId,'WRONG_CHAIN','Message chainId must match wallet chain');
        check(sameAddress(typed.message?.wallet,ctx.address),'MESSAGE_WALLET','SignIn message wallet must match connected wallet');
        check(typed.message?.audience===new URL(origin).host,'MESSAGE_AUDIENCE','SignIn audience must match project origin');
        check(epochMs(typed.message?.expiresAt)>Date.now(),'MESSAGE_EXPIRED','SignIn expiresAt is missing or expired');
        const types=Object.fromEntries(Object.entries(typed.types||{}).filter(([name])=>name!=='EIP712Domain'));
        const hash=TypedDataEncoder.hash(typed.domain,types,typed.message);
        op.payload={kind:'message',wallet:ctx.address,chainId:ctx.chainId,typedDataHash:hash,purpose:input.purpose,origin};
        op.wrapper={method:w.method,params:[ctx.address,JSON.stringify(typed)]};
        op.messageExpiry=epochMs(typed.message.expiresAt);
      } else fail('UNSUPPORTED_OPERATION','Supported kinds: swap, approval, contract, message');
      op.payloadHash=digest(op.payload);
      const preview=op.kind==='message'?await this.wallet.previewMessage(op.wrapper):await this.wallet.preview(op.payload);
      check(preview.requestId && epochMs(preview.expiresAt)>Date.now(),'INVALID_PREVIEW','Wallet returned no usable requestId or expiry');
      check(op.kind==='message'?preview.parsedMessage:preview.parsedTx,'INVALID_PREVIEW','Wallet preview missing parsed operation');
      const sim=preview.simulationResult;
      if(op.payload.gasLimit!==undefined)check(preview.gasLimit===op.payload.gasLimit,'GAS_LIMIT_MISMATCH','Wallet preview did not preserve the requested gas limit');
      if(op.kind!=='message')check(sim&&sim.simulationCode==='000000000'&&!sim.simulationErrorDetail,'SIMULATION_FAILED','Wallet simulation missing or failed');
      if(op.quote && op.kind==='swap') check(op.quote.expiresAt>Date.now(),'QUOTE_EXPIRED','Quote expired during preview; prepare again');
      op.preview=preview; op.requestId=preview.requestId;
      op.previewVersion=this.config.accountId?2:1;
      op.expiresAt=Math.min(epochMs(preview.expiresAt),op.kind==='swap'?op.quote.expiresAt:Infinity,op.messageExpiry||Infinity);
      op.confirmationToken=previewToken(op);
      op.state='AWAITING_USER';this.store.save(op);
      return this.view(op);
    } catch(e) { op.state='FAILED';op.error=publicError(e);this.store.save(op);throw Object.assign(e,{details:{...e.details,operationId:op.id}}); }
  }
  async submit(input) { return this.mutex.run(()=>this.submitInner(input)); }
  async submitInner({request,authorization},ctx) {
    check(authorization?.approved===true,'CONFIRMATION_REQUIRED','Direct submission requires explicit user authorization');
    check(request?.kind==='contract'||request?.kind==='swap','UNSUPPORTED_OPERATION','Direct submission supports contract calls and swaps');
    const maxValue=uint(authorization.maxValueWei);
    if(request.kind==='contract')check(BigInt(uint(request.value??'0'))<=BigInt(maxValue),'SPEND_LIMIT','Transaction exceeds the authorized native payment cap');
    if(request.gasLimit!==undefined)check(Number.isSafeInteger(authorization.maxGasLimit)&&request.gasLimit<=authorization.maxGasLimit,'GAS_LIMIT_AUTHORIZATION','Custom gas must be within the user-authorized gas cap');
    const existing=this.existing(request);
    if(existing?.submission||existing&&existing.state!=='AWAITING_USER')return existing;
    ctx ||= await this.context();
    const prepared=existing||await this.prepareInner(request,ctx);
    const op=this.store.get(prepared.id);
    check(BigInt(op.payload.value)<=BigInt(maxValue),'SPEND_LIMIT','Transaction exceeds the authorized native payment cap');
    const p=op.preview,r=p.risks||{},s=p.simulationResult||{};
    const approval=authorization.tokenApproval;
    const approvedAllowance=c=>approval&&op.decoded?.method==='approve(address,uint256)'&&sameAddress(op.payload.to,approval.token)&&sameAddress(op.decoded.args[0],approval.spender)&&op.decoded.args[1]===approval.amountRaw&&sameAddress(c.tokenAddress,approval.token)&&sameAddress(c.owner,op.wallet)&&sameAddress(c.spender,approval.spender)&&Number(c.postAmount)===Number(approval.amountRaw);
    const review=(r.riskDetails||[]).length||(r.riskBehaviors||[]).length||Object.values(r.addresses||{}).some(a=>(a.riskDetails||[]).length||Number(a.riskLevel)>0)||(s.allowanceChanges||[]).some(c=>allowanceNeedsReview(c)&&!approvedAllowance(c))||(s.authorityChanges||[]).length;
    if(review)return {...this.view(op),needsReview:true};
    op.authorization={approved:true,maxValueWei:maxValue,...(authorization.maxGasLimit===undefined?{}:{maxGasLimit:authorization.maxGasLimit}),at:Date.now()};this.store.save(op,false);
    return this.confirmInner({id:op.id,confirmationToken:op.confirmationToken,approved:true,acknowledgedUnknownOperationIds:authorization.acknowledgedUnknownOperationIds,duplicatePaymentRiskAccepted:authorization.duplicatePaymentRiskAccepted},{context:ctx,atomic:!existing});
  }
  async projectMint(input,quoteOnly=false) { return this.mutex.run(async()=>{
    check(quoteOnly||input.authorization?.approved===true,'CONFIRMATION_REQUIRED','Project mint requires explicit user authorization');
    if(!quoteOnly) {
      check(typeof input.idempotencyKey==='string'&&input.idempotencyKey.length>=8&&input.idempotencyKey.length<=128,'IDEMPOTENCY_REQUIRED','Provide a stable idempotencyKey');
      const prior=this.store.byKey(input.idempotencyKey);
      if(prior) {check(prior.projectIntentHash===digest(input),'IDEMPOTENCY_CONFLICT','Project key belongs to different parameters');return this.view(prior);}
      uint(input.authorization.maxValueWei);
    }
    const ctx=await this.context();
    const quote=await bnagentMintRequest({chain:this.chain,wallet:ctx.address,input});
    if(quoteOnly||quote.status!=='AVAILABLE')return quote;
    checkBnagentPrice(quote,input.maxCostUsdt);
    quote.request.projectIntentHash=digest(input);
    const result=await this.submitInner({request:quote.request,authorization:input.authorization},ctx);
    const op=this.store.get(result.id);op.projectIntentHash=digest(input);op.projectQuote={...quote,request:undefined};this.store.save(op,false);
    return {...result,projectQuote:op.projectQuote};
  }); }
  validateExpected(expected,to) {
    if(!expected)return {kind:'receipt-only'};
    check(expected.kind==='event' && Array.isArray(expected.abi) && expected.event,'INVALID_EXPECTED','Expected result must specify an event ABI');
    const abi=new Interface(expected.abi);const event=abi.getEvent(expected.event);
    check(event,'INVALID_EXPECTED','Expected event missing from ABI');
    check(expected.args && typeof expected.args==='object'&&!Array.isArray(expected.args),'INVALID_EXPECTED','Expected event args are required');
    for(const key of Object.keys(expected.args))check(event.inputs.some(i=>i.name===key),'INVALID_EXPECTED','Unknown expected event field');
    return {kind:'event',address:address(expected.address||to),abi:expected.abi,event:expected.event,args:expected.args};
  }
  async confirm(input) { return this.mutex.run(()=>this.confirmInner(input)); }
  async confirmInner({id:operationId,confirmationToken,approved,acknowledgedUnknownOperationIds=[],duplicatePaymentRiskAccepted=false},{context,atomic=false,beforeSubmit,batchId}={}) {
    const op=this.store.get(operationId);
    if(op.submission) return this.view(op); // Retry of the same local request never submits twice.
    check(!op.batchId||op.batchId===batchId,'BATCH_EXECUTION_REQUIRED','Batch operations must execute through their approved batch budget');
    check(op.state==='AWAITING_USER','INVALID_STATE','Operation is not awaiting confirmation');
    check(approved===true && confirmationToken===op.confirmationToken,'CONFIRMATION_REQUIRED','Explicit user confirmation must match the displayed preview token');
    check(op.requestId===op.preview.requestId && previewToken(op)===op.confirmationToken,'PREVIEW_MISMATCH','Stored preview changed after confirmation');
    if(op.previewVersion>=2)check(op.accountId===this.config.accountId&&op.deviceProfileVersion===this.config.deviceProfileVersion,'ACCOUNT_MISMATCH','Preview belongs to another account or device profile');
    check(Date.now()<op.expiresAt,'PREVIEW_EXPIRED','Preview or quote expired; prepare a new operation');
    const ctx=context||await this.context();
    check(ctx.generation===op.context.generation && sameAddress(ctx.address,op.wallet),'WALLET_CHANGED','Wallet session changed; prepare again');
    check(Array.isArray(acknowledgedUnknownOperationIds)&&acknowledgedUnknownOperationIds.every(x=>typeof x==='string'),'INVALID_RECOVERY_ACK','Expected explicit operation IDs');
    const blockers=this.store.scan().filter(x=>x.id!==op.id&&BLOCKING.has(x.state));
    check(!blockers.some(x=>!(x.state==='UNKNOWN_SUBMIT'&&duplicatePaymentRiskAccepted===true&&acknowledgedUnknownOperationIds.includes(x.id))),'WALLET_BUSY','An earlier operation needs confirmation or reconciliation');
    const acknowledgedUnknowns=blockers.map(x=>x.id);
    check(digest(op.payload)===op.payloadHash,'PAYLOAD_MISMATCH','Stored transaction payload changed');
    if(op.quote && op.kind==='swap') {
      check(Date.now()<op.quote.expiresAt,'QUOTE_EXPIRED','Quote expired; prepare again');
      const block=await this.chain.snapshot();
      check(block.number-op.quote.block.number<=this.config.maxQuoteBlocks,'QUOTE_EXPIRED','Quote block is too old');
      await this.chain.verifySnapshot(op.quote.block);
      await this.chain.balances(op.quote,op.wallet);
    }
    const [lock,nonce,code]=await Promise.all([this.wallet.lock(),this.chain.rpc('eth_getTransactionCount',[op.wallet,'pending']),op.codeHash&&!atomic?this.chain.rpc('eth_getCode',[op.payload.to,'latest']):undefined]);
    check(lock.status==='UNLOCKED','WALLET_LOCKED','Wallet has a pending transaction or App confirmation');
    if(code!==undefined)check(keccak256(code)===op.codeHash,'CODE_CHANGED','Contract code changed; prepare again');
    check(typeof nonce==='string'&&/^0x[0-9a-f]+$/i.test(nonce),'INVALID_NONCE_SNAPSHOT','Cannot establish pending nonce before submission');
    // Recheck expiry after network calls, immediately before durable intent.
    check(Date.now()<op.expiresAt,'PREVIEW_EXPIRED','Preview expired during final checks; prepare again');
    beforeSubmit?.();
    op.submission={requestId:op.requestId,at:Date.now(),confirmedAt:Date.now(),minNonce:BigInt(nonce).toString()};
    if(acknowledgedUnknowns.length)op.submission.userRecoveryOverride={operationIds:acknowledgedUnknowns,duplicatePaymentRiskAccepted:true,at:Date.now()};
    op.state='EXECUTE_INTENT_SAVED';this.store.save(op);
    try {
      op.state='SUBMITTING';this.store.save(op);
      const res=op.kind==='message'?await this.wallet.executeMessage(op.requestId):await this.wallet.execute(op.requestId);
      op.orderId=res.orderId;
      if(op.kind==='message'&&res.status==='COMPLETED') {
        this.verifyMessage(op,res);op.messageResult=this.vault.seal(res);op.state='SIGNED';
      } else if(res.status==='BROADCASTED' && /^0x[0-9a-fA-F]{64}$/.test(res.txHash)) { op.txHash=res.txHash;op.state='BROADCASTED'; }
      else if(res.status==='PENDING_CONFIRMATION'&&res.orderId) op.state='PENDING_APP';
      else { op.state='UNKNOWN_SUBMIT';op.error={code:'UNKNOWN_WALLET_RESULT',message:'Wallet returned an unrecognized execution result'}; }
    } catch(e) {
      op.state=op.kind!=='message'&&simulationRejected(e)?'FAILED':'UNKNOWN_SUBMIT';op.error=publicError(e);
      if(op.state==='FAILED')op.failure={stage:'execute-simulation',broadcastRejected:true,retryable:true};
    }
    this.store.save(op);return this.view(op);
  }
  verifyMessage(op,res) {
    const t=JSON.parse(op.wrapper.params[1]);
    let sig=res.signature;
    if(!sig?.startsWith('0x'))sig='0x'+sig;
    if(getBytes(sig).length===64&&res.signatureRecovery) sig+=res.signatureRecovery.replace(/^0x/,'');
    const types=Object.fromEntries(Object.entries(t.types||{}).filter(([name])=>name!=='EIP712Domain'));
    check(sameAddress(verifyTypedData(t.domain,types,t.message,sig),op.wallet),'INVALID_SIGNATURE','Returned signature does not recover the connected wallet');
  }
  async reconcile(input) { return this.mutex.run(()=>this.reconcileInner(input)); }
  async reconcileInner({id:operationId,txHash}) {
    const op=this.store.get(operationId);
    if(this.config.accountId&&(!op.txHash||op.kind==='market'||op.kind==='message')) {
      const ctx=await this.context({external:false});
      check(sameAddress(ctx.address,op.wallet),'WALLET_CHANGED','Recovery requires the original wallet');
    }
    if(op.kind==='market')return reconcileMarket(this,op);
    if(FINAL.has(op.state)&&op.state!=='CONFIRMED')return this.view(op);
    check(op.submission,'NOT_SUBMITTED','Operation has no submission intent');
    if(op.kind==='message') {
      if(!op.orderId)return this.view(op);
      const res=await this.wallet.messageResult(op.orderId);
      if(res.status==='COMPLETED') { this.verifyMessage(op,res);op.messageResult=this.vault.seal(res);op.state='SIGNED'; }
      else if(['REJECTED','EXPIRED'].includes(res.status))op.state='REJECTED';
      this.store.save(op);return this.view(op);
    }
    if(txHash) { check(/^0x[0-9a-fA-F]{64}$/.test(txHash),'INVALID_HASH','Expected a transaction hash');op.txHash=txHash; }
    if(!op.txHash) {
      // History is only evidence for candidate hashes. Exact transaction matching is done below.
      const history=await this.wallet.history(op.submission.at-30000);
      const candidates=[...new Set((history.transactions||[]).flatMap(t=>[t.txHash,...(t.txHashList||[]).map(x=>x.txHash)]).filter(x=>/^0x[0-9a-fA-F]{64}$/.test(x||'')))];
      const matches=[];
      for(const hash of candidates.slice(0,30)) {
        const t=await this.chain.rpc('eth_getTransactionByHash',[hash]);
        if(t&&this.txMatches(op,t))matches.push(hash);
      }
      if(matches.length===1)op.txHash=matches[0];
      else { op.recovery={needsReview:true,matchingCandidates:matches.length,walletLock:await this.wallet.lock()};this.store.save(op);return this.view(op); }
    }
    const tx=await this.chain.rpc('eth_getTransactionByHash',[op.txHash]);
    if(!tx&&!txHash) {
      op.state='BROADCASTED';delete op.receipt;delete op.businessResult;delete op.confirmations;this.store.save(op);return this.view(op);
    }
    check(tx&&this.txMatches(op,tx),'TRANSACTION_MISMATCH','Transaction does not match this operation; no success recorded');
    const receipt=await this.chain.rpc('eth_getTransactionReceipt',[op.txHash]);
    if(!receipt) { op.state='BROADCASTED';delete op.receipt;delete op.businessResult;delete op.confirmations;this.store.save(op);return this.view(op); }
    check(receipt.transactionHash?.toLowerCase()===op.txHash.toLowerCase(),'RECEIPT_MISMATCH','Receipt transaction hash mismatch');
    const block=await this.chain.rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
    if(block?.hash!==receipt.blockHash) { op.state='BROADCASTED';delete op.receipt;delete op.businessResult;delete op.confirmations;this.store.save(op);return this.view(op); }
    op.receipt={transactionHash:receipt.transactionHash,blockNumber:Number(BigInt(receipt.blockNumber)),blockHash:receipt.blockHash,status:Number(BigInt(receipt.status)),gasUsed:BigInt(receipt.gasUsed).toString()};
    if(op.receipt.status!==1)op.state='FAILED';
    else {
      try { op.businessResult=await this.verifyOutcome(op,receipt); }
      catch(e) { op.state='RESULT_MISMATCH';op.error=publicError(e);this.store.save(op);return this.view(op); }
      const latest=await this.chain.snapshot();
      op.confirmations=latest.number-op.receipt.blockNumber+1;
      op.state=op.confirmations>=this.config.confirmations?'CONFIRMED':'INCLUDED';
    }
    this.store.save(op);return this.view(op);
  }
  txMatches(op,tx) {
    return sameAddress(tx.from,op.wallet)&&sameAddress(tx.to,op.payload.to)&&BigInt(tx.value)===BigInt(op.payload.value)&&
      hex(tx.input||tx.data||'0x')===op.payload.data&&(!tx.chainId||Number(BigInt(tx.chainId))===op.chainId)&&
      (op.submission?.minNonce===undefined||(tx.nonce!==undefined&&BigInt(tx.nonce)>=BigInt(op.submission.minNonce)));
  }
  async verifyOutcome(op,r) {
    const e=op.expected;
    if(e.kind==='receipt-only')return {verified:false,scope:'successful receipt only; no project-specific success assertion configured'};
    if(e.kind==='event') {
      const abi=new Interface(e.abi);
      const matches=(r.logs||[]).filter(l=>sameAddress(l.address,e.address)).map(l=>{try{return abi.parseLog(l);}catch{return null;}}).filter(l=>l?.name===e.event);
      const match=matches.find(l=>Object.entries(e.args).every(([k,v])=>String(l.args[k]).toLowerCase()===String(v).toLowerCase()));
      check(match,'EXPECTED_EVENT_MISSING','Expected project event was not found');
      return {verified:true,event:e.event,values:Object.fromEntries(abi.getEvent(e.event).inputs.filter(i=>i.name).map(i=>[i.name,String(match.args[i.name])]))};
    }
    if(e.kind==='approval') {
      const allowance=(await this.chain.call(e.token,tokenAbi,'allowance',[op.wallet,e.spender],r.blockNumber))[0];
      check(allowance>=BigInt(e.amountRaw),'APPROVAL_NOT_EFFECTIVE','Allowance below requested amount after confirmation');
      return {verified:true,allowance:allowance.toString()};
    }
    if(e.kind==='swap') {
      // Native output uses the final pair's wrapped-token Withdrawal event.
      let received=0n;
      if(e.nativeOut) {
        const withdrawal=new Interface(['event Withdrawal(address indexed src,uint256 wad)']);
        for(const l of r.logs||[])if(sameAddress(l.address,this.config.wrapped)){try{const p=withdrawal.parseLog(l);if(p&&sameAddress(p.args.src,op.quote.router))received+=p.args.wad;}catch{}}
      } else {
        for(const l of r.logs||[])if(sameAddress(l.address,e.tokenOut)){try{const p=tokenAbi.parseLog(l);if(p?.name==='Transfer'&&sameAddress(p.args.to,op.wallet))received+=p.args.value;}catch{}}
      }
      check(received>=BigInt(e.minOutRaw),'SWAP_RESULT_MISMATCH','Verified output below minimum or expected output events unavailable');
      return {verified:true,receivedRaw:received.toString(),asset:e.nativeOut?'native':e.tokenOut};
    }
    fail('UNSUPPORTED_EXPECTED','Unsupported business verification');
  }
  cancel({id:operationId}) {
    const op=this.store.get(operationId);check(!op.submission,'ALREADY_SUBMITTED','Cannot cancel locally after submission intent');
    op.state='CANCELLED';this.store.save(op);return this.view(op);
  }
  async dispatch(method,params={}) {
    switch(method) {
      case 'status':return this.status();
      case 'connect':return this.wallet.connect();
      case 'pairing':return this.wallet.pairing||{state:'NONE'};
      case 'quote':return this.quote(params);
      case 'prepare':return this.prepare(params);
      case 'submit':return this.submit(params);
      case 'sell':return this.mutex.run(()=>runAggregatedSell(this,params));
      case 'sell.quote':return aggregatedSellQuote({engine:this,wallet:(await this.context({external:false})).address,input:params});
      case 'sell.v2':return this.mutex.run(()=>runSell(this,params));
      case 'sell.v2.quote':return sellQuote({chain:this.chain,config:this.config,wallet:(await this.context()).address,input:params});
      case 'project.mint':return this.projectMint(params);
      case 'project.mint.quote':return this.projectMint(params,true);
      case 'confirm':return this.confirm(params);
      case 'reconcile':return this.reconcile(params);
      case 'cancel':return this.mutex.run(()=>this.cancel(params));
      case 'operation':return this.view(this.store.get(params.id));
      case 'operations':return this.store.all().map(x=>this.view(x));
      case 'events':return this.store.events(Number(params.after)||0);
      case 'metrics':return {timings:this.wallet.timings||[],httpTimings:this.wallet.api?.timings||[],walletTransport:this.wallet.transport||'cli',localService:'ready'};
      case 'inspect':return this.chain.inspect(params.contract);
      case 'project.fetch':return fetchProject(params.url);
      case 'project.preflight':return projectPreflight({url:params.url,chain:this.chain,store:this.store});
      case 'project.import': {
        check(typeof params.name==='string'&&params.name.length<=200&&Array.isArray(params.sources),'INVALID_PROJECT','Project needs name and sources');
        const p={name:params.name,sources:params.sources.map(s=>({url:projectUrl(s.url).href,observedAt:s.observedAt||Date.now()})),
          summary:String(params.summary||'').slice(0,10000),contracts:(params.contracts||[]).map(address),actions:params.actions||[],analysisBy:'Codex',unverified:params.unverified||[]};
        return this.store.project(p);
      }
      case 'projects':return this.store.projects();
      case 'signature.export':return this.vault.exportSignature(this.store.get(params.id));
      default:fail('UNKNOWN_METHOD','Unknown workbench method');
    }
  }
}
