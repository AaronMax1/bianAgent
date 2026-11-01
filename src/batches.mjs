import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { check,id,digest,json,uint,publicError,redact,Mutex } from './util.mjs';
import { checkBnagentPrice } from './bnagent.mjs';

const pending=new Set(['EXECUTE_INTENT_SAVED','SUBMITTING','UNKNOWN_SUBMIT','PENDING_APP','MARKET_PENDING','BROADCASTED','INCLUDED']);
const walletValue=(value,wallet)=>Array.isArray(value)?value.map(v=>walletValue(v,wallet)):value&&typeof value==='object'?
  Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walletValue(v,wallet)])):value==='$wallet'?wallet:value;
const fixedItem=(t,action)=>({accountId:t.accountId,walletAddress:t.walletAddress,deviceProfileVersion:t.deviceProfileVersion,idempotencyKey:t.idempotencyKey,
  ...(action==='sell'?{params:t.params}:{operationId:t.operationId,confirmationToken:t.confirmationToken}),paymentWei:t.paymentWei,expiresAt:t.expiresAt});

export class BatchRunner {
  control=new Mutex();active=new Map();busyAccounts=new Set();stopping=false;
  constructor({accounts,config}) {
    Object.assign(this,{accounts,config});
    this.concurrency=config.batchConcurrency??2;
    check(Number.isSafeInteger(this.concurrency)&&this.concurrency>=1&&this.concurrency<=8,'INVALID_CONCURRENCY','batchConcurrency must be 1–8');
    const path=join(config.root,'batches.sqlite');this.db=new DatabaseSync(path);chmodSync(path,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, body TEXT NOT NULL)');
    for(const b of this.rows())if(b.approved&&b.tasks.some(t=>['QUEUED','RUNNING','PENDING'].includes(t.state))){b.paused=true;b.pauseReason='service-restarted';this.save(b);}
  }
  rows(){return this.db.prepare('SELECT body FROM batches ORDER BY rowid').all().map(r=>JSON.parse(r.body));}
  get(batchId){const r=this.db.prepare('SELECT body FROM batches WHERE id=?').get(batchId);check(r,'NOT_FOUND','Batch not found');return JSON.parse(r.body);}
  save(b){b.updatedAt=Date.now();this.db.prepare('INSERT INTO batches(id,idem,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(b.id,b.idempotencyKey,json(b));return b;}
  result(b){
    const counts={};for(const t of b.tasks)counts[t.state]=(counts[t.state]||0)+1;
    let state=!b.approved?'PLANNED':b.paused?'PAUSED':b.tasks.some(t=>['QUEUED','RUNNING'].includes(t.state))?'RUNNING':
      b.tasks.some(t=>t.state==='PENDING')?'PENDING':b.tasks.some(t=>['NEEDS_REVIEW','NEEDS_LOGIN'].includes(t.state))?'NEEDS_REVIEW':
      b.tasks.every(t=>['SUCCEEDED','SKIPPED','CANCELLED'].includes(t.state))?'COMPLETED':b.tasks.some(t=>t.state==='SUCCEEDED')?'PARTIAL':'FAILED';
    const {definition,...visible}=b;
    return redact({...visible,state,counts,scope:'Native payment caps exclude gas; selected wallets execute separate transactions'});
  }
  verifyPlan(b){
    check(b.definition&&digest(b.definition)===b.planToken,'BATCH_PLAN_MISMATCH','Stored batch approval plan changed');
    check(digest({id:b.id,accountIds:b.accountIds,action:b.action,limits:b.limits})===digest({id:b.definition.id,accountIds:b.definition.accountIds,action:b.definition.action,limits:b.definition.limits}),'BATCH_PLAN_MISMATCH','Batch targets, action or limits changed');
    check(b.tasks.length===b.definition.items.length&&b.tasks.every((t,i)=>digest(fixedItem(t,b.action))===digest(b.definition.items[i].fixed)),'BATCH_PLAN_MISMATCH','An approved batch item changed');
  }
  plan(input){return this.control.run(()=>this.planInner(input));}
  async planInner(input) {
    check(typeof input.idempotencyKey==='string'&&input.idempotencyKey.length>=8&&input.idempotencyKey.length<=128,'IDEMPOTENCY_REQUIRED','Provide a stable batch idempotencyKey of 8–128 characters');
    const old=this.db.prepare('SELECT body FROM batches WHERE idem=?').get(input.idempotencyKey);
    if(old){const b=JSON.parse(old.body);check(b.inputHash===digest(input),'IDEMPOTENCY_CONFLICT','Batch key belongs to different parameters');return this.status({id:b.id});}
    check(['submit','project.mint','sell'].includes(input.action),'BATCH_ACTION_NOT_SUPPORTED','Batch supports submit, project.mint and sell');
    check(input.accountIds==='all'||Array.isArray(input.accountIds)&&input.accountIds.length>0&&input.accountIds.length<=100,'INVALID_ACCOUNTS','Select 1–100 accounts or all');
    const selected=input.accountIds==='all'?[...this.accounts.registry.accounts]:input.accountIds.map(s=>this.accounts.resolve(s));
    check(selected.length<=100,'INVALID_ACCOUNTS','Select at most 100 accounts');
    check(new Set(selected.map(a=>a.id)).size===selected.length,'DUPLICATE_ACCOUNT','An account was selected more than once');
    const maxPer=uint(input.limits?.maxValueWeiPerAccount),maxTotal=uint(input.limits?.maxTotalValueWei);
    if(input.limits.maxGasLimit!==undefined)check(Number.isSafeInteger(input.limits.maxGasLimit)&&input.limits.maxGasLimit>=21000&&input.limits.maxGasLimit<=15000000,'INVALID_GAS_LIMIT','Invalid batch gas unit cap');
    check(input.params&&typeof input.params==='object'&&!Array.isArray(input.params),'INVALID_BATCH_PARAMS','Provide action params');
    const b={id:id(),idempotencyKey:input.idempotencyKey,inputHash:digest(input),createdAt:Date.now(),accountIds:selected.map(a=>a.id),action:input.action,
      limits:{maxValueWeiPerAccount:maxPer,maxTotalValueWei:maxTotal,...(input.limits.maxGasLimit===undefined?{}:{maxGasLimit:input.limits.maxGasLimit})},tasks:[],approved:false,paused:false,reservedValueWei:'0'};
    // Save selection before preparing any operation. A crash during planning cannot authorize execution.
    this.save(b);
    for(const account of selected) {
      const runtime=this.accounts.get(account.id),engine=runtime.engine;
      const task={accountId:account.id,alias:account.alias,state:'PLANNING',idempotencyKey:'batch-'+digest({batchId:b.id,accountId:account.id}).slice(0,48)};
      b.tasks.push(task);this.save(b);
      try {
        const ctx=await engine.context({external:input.action!=='sell'});
        task.walletAddress=ctx.address;task.deviceProfileVersion=account.deviceProfileVersion;
        const params=walletValue(structuredClone(input.params),ctx.address);delete params.authorization;
        if(input.action==='sell') {
          check(params.gasLimit===undefined&&b.limits.maxGasLimit===undefined,'MARKET_GAS_POLICY','Batch market sell uses gasLevel, not maxGasLimit or gasLimit');
          const quote=await engine.dispatch('sell.quote',params);
          if(quote.status!=='AVAILABLE'){task.state='SKIPPED';task.result=quote;this.save(b);continue;}
          task.params={...params,amountRaw:quote.amountRaw,idempotencyKey:task.idempotencyKey,batchId:b.id};
          task.quote=quote;task.paymentWei=String(params.token?.toLowerCase()==='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'?quote.amountRaw:'0');
        } else {
          let request;
          if(input.action==='project.mint'){
            const quote=await engine.projectMint({...params,idempotencyKey:task.idempotencyKey},true);
            task.quote=quote;
            if(quote.status!=='AVAILABLE'){task.state='SKIPPED';this.save(b);continue;}
            checkBnagentPrice(quote,params.maxCostUsdt);request=quote.request;
          } else {request=params.request;check(request&&['contract','swap'].includes(request.kind),'BATCH_ACTION_NOT_SUPPORTED','Batch submit requires a contract or swap request');}
          request={...request,idempotencyKey:task.idempotencyKey,batchId:b.id};
          if(request.gasLimit!==undefined)check(Number.isSafeInteger(b.limits.maxGasLimit)&&request.gasLimit<=b.limits.maxGasLimit,'GAS_LIMIT_AUTHORIZATION','Custom gas exceeds the batch gas unit cap');
          if(request.kind==='contract')check(BigInt(uint(request.value??'0'))<=BigInt(maxPer),'SPEND_LIMIT','Account payment exceeds batch per-account cap');
          const op=await engine.prepare(request);
          task.operationId=op.id;task.confirmationToken=op.confirmationToken;task.preview=op;
          task.paymentWei=engine.store.get(op.id).payload.value;
        }
        check(BigInt(task.paymentWei)<=BigInt(maxPer),'SPEND_LIMIT','Account payment exceeds batch per-account cap');
        task.state='READY';task.expiresAt=task.preview?.expiresAt||Date.now()+(this.config.quoteTtlMs||120000);
      } catch(e){task.state=['WALLET_DISCONNECTED','SESSION_EXPIRED','NOT_LOGGED_IN'].includes(e.code)?'NEEDS_LOGIN':'FAILED';task.error=publicError(e);}
      this.save(b);
    }
    const payment=b.tasks.filter(t=>t.state==='READY').reduce((sum,t)=>sum+BigInt(t.paymentWei),0n);
    b.plannedValueWei=String(payment);
    if(payment>BigInt(maxTotal)){
      b.error={code:'BATCH_BUDGET_EXCEEDED',message:'Combined prepared payments exceed the total native payment cap'};
      for(const t of b.tasks)if(t.state==='READY'){t.state='NEEDS_REVIEW';t.error=b.error;}
    }
    for(const task of b.tasks)if(task.state!=='READY'&&task.operationId){
      const engine=this.accounts.get(task.accountId).engine,op=engine.store.get(task.operationId);
      if(!op.submission&&op.state==='AWAITING_USER')engine.cancel({id:op.id});
    }
    b.planComplete=true;
    b.definition={id:b.id,accountIds:b.accountIds,action:b.action,limits:b.limits,items:b.tasks.map(t=>({eligible:t.state==='READY',fixed:fixedItem(t,b.action)}))};
    b.planToken=digest(b.definition);
    this.save(b);return this.result(b);
  }
  refresh(b) {
    let changed=false;
    for(const t of b.tasks){
      if(!['RUNNING','PENDING'].includes(t.state))continue;
      const runtime=this.accounts.get(t.accountId);
      const op=t.operationId?runtime.store.get(t.operationId):runtime.store.byKey(t.idempotencyKey);
      if(op){
        t.operationId=op.id;t.result=runtime.engine.view(op);
        t.state=op.state==='CONFIRMED'||op.state==='SIGNED'?'SUCCEEDED':pending.has(op.state)?'PENDING':op.state==='RESULT_MISMATCH'?'NEEDS_REVIEW':
          ['FAILED','REJECTED'].includes(op.state)?'FAILED':op.state==='CANCELLED'?'SKIPPED':this.active.has(b.id+':'+t.accountId)?'RUNNING':'QUEUED';
        changed=true;
      } else if(!this.active.has(b.id+':'+t.accountId)){t.state='QUEUED';changed=true;}
    }
    if(changed)this.save(b);return b;
  }
  status({id:batchId}){return this.result(this.refresh(this.get(batchId)));}
  list(){return this.rows().map(b=>this.result(this.refresh(b)));}
  run({id:batchId,approved,planToken}) {
    const b=this.get(batchId);
    check(b.planComplete,'BATCH_PLAN_INCOMPLETE','Planning was interrupted; create a new plan with a new idempotencyKey');
    check(approved===true&&planToken===b.planToken,'CONFIRMATION_REQUIRED','Approve the specific batch planToken');
    this.verifyPlan(b);
    check(!b.error,'BATCH_BUDGET_EXCEEDED','Create a new plan within the total payment cap');
    if(!b.approved){
      b.approved=true;b.approvedAt=Date.now();b.paused=false;
      for(const t of b.tasks)if(t.state==='READY'){t.state='QUEUED';t.authorized=true;}
      this.save(b);
    }
    this.pump();return this.status({id:batchId});
  }
  pause({id:batchId}){const b=this.get(batchId);check(b.planComplete,'BATCH_PLANNING','Wait for planning to finish');b.paused=true;this.save(b);return this.result(b);}
  resume({id:batchId}){const b=this.get(batchId);check(b.approved,'CONFIRMATION_REQUIRED','Approve the batch plan before resuming');this.verifyPlan(b);b.paused=false;delete b.pauseReason;for(const t of b.tasks)if(t.state==='NEEDS_LOGIN'&&t.authorized)t.state='QUEUED';this.save(b);this.pump();return this.result(b);}
  cancel({id:batchId}){
    const b=this.get(batchId);check(b.planComplete,'BATCH_PLANNING','Wait for planning to finish');b.paused=true;
    for(const t of b.tasks){
      if(['READY','QUEUED'].includes(t.state)){
        t.state='CANCELLED';
        if(t.operationId){const engine=this.accounts.get(t.accountId).engine,op=engine.store.get(t.operationId);if(!op.submission&&op.state==='AWAITING_USER')engine.cancel({id:op.id});}
      }
      if(t.state==='RUNNING')t.cancelRequested=true;
    }
    this.save(b);return this.result(b);
  }
  start(){for(const b of this.rows())this.refresh(b);this.pump();}
  pump() {
    if(this.stopping)return;
    while(this.active.size<this.concurrency){
      let selected;
      for(const b of this.rows()){
        if(!b.approved||b.paused)continue;
        const t=b.tasks.find(t=>t.state==='QUEUED'&&t.authorized&&!this.busyAccounts.has(t.accountId));
        if(t){selected={b,t};break;}
      }
      if(!selected)break;
      const {b,t}=selected,key=b.id+':'+t.accountId;
      this.busyAccounts.add(t.accountId);t.state='RUNNING';this.save(b);
      const task=Promise.resolve().then(()=>this.execute(b.id,t.accountId)).catch(error=>{
        const current=this.get(b.id),item=current.tasks.find(x=>x.accountId===t.accountId);item.state='NEEDS_REVIEW';item.error=publicError(error);this.save(current);
      }).finally(()=>{
        this.active.delete(key);this.busyAccounts.delete(t.accountId);this.pump();
      });this.active.set(key,task);
    }
  }
  async execute(batchId,accountId) {
    let b=this.get(batchId),task=b.tasks.find(t=>t.accountId===accountId);
    const runtime=this.accounts.get(accountId),engine=runtime.engine;
    try {
      this.verifyPlan(b);
      check(b.definition.items.some(i=>i.eligible&&i.fixed.accountId===accountId),'CONFIRMATION_REQUIRED','Account was not executable in the approved plan');
      const beforeSubmit=()=>{
        const current=this.get(batchId),item=current.tasks.find(t=>t.accountId===accountId);
        this.verifyPlan(current);
        check(!item.cancelRequested,'BATCH_CANCELLED','Batch item cancelled before submission');
        check(!current.paused,'BATCH_PAUSED','Batch paused before submission');
      };
      const result=await engine.mutex.run(async()=>{
        const ctx=await engine.context({external:b.action!=='sell'});
        check(ctx.address.toLowerCase()===task.walletAddress.toLowerCase()&&runtime.account.deviceProfileVersion===task.deviceProfileVersion,'ACCOUNT_WALLET_MISMATCH','Wallet or device profile differs from the approved batch plan');
        check(Date.now()<task.expiresAt,'PREVIEW_EXPIRED','Batch item expired; prepare a new plan');
        b=this.get(batchId);task=b.tasks.find(t=>t.accountId===accountId);
        if(!task.reserved){
          const reserved=BigInt(b.reservedValueWei)+BigInt(task.paymentWei);
          check(reserved<=BigInt(b.limits.maxTotalValueWei),'BATCH_BUDGET_EXCEEDED','Batch native payment budget exhausted');
          task.reserved=true;b.reservedValueWei=String(reserved);this.save(b);
        }
        if(b.action==='sell'){
          // Already hold the per-account mutex; use the inner market path rather than dispatching recursively.
          const {runAggregatedSell}=await import('./market-sell.mjs');
          return runAggregatedSell(engine,{...task.params,authorization:{approved:true}},{beforeSubmit});
        }
        return engine.confirmInner({id:task.operationId,approved:true,confirmationToken:task.confirmationToken},{beforeSubmit,batchId});
      });
      b=this.get(batchId);task=b.tasks.find(t=>t.accountId===accountId);task.result=result;
      if(result.id)task.operationId=result.id;
      task.state=result.state==='CONFIRMED'?'SUCCEEDED':result.state==='CANCELLED'?'SKIPPED':['FAILED','REJECTED'].includes(result.state)?'FAILED':pending.has(result.state)?'PENDING':'NEEDS_REVIEW';
    } catch(e){
      b=this.get(batchId);task=b.tasks.find(t=>t.accountId===accountId);task.error=publicError(e);
      task.state=e.code==='BATCH_PAUSED'?'QUEUED':e.code==='BATCH_CANCELLED'?'CANCELLED':e.code==='PREVIEW_EXPIRED'?'EXPIRED':['NOT_LOGGED_IN','SESSION_EXPIRED','WALLET_DISCONNECTED'].includes(e.code)?'NEEDS_LOGIN':'FAILED';
      // A persisted submission always wins over the transport error; it must be reconciled, never reissued.
      const op=task.operationId?runtime.store.get(task.operationId):runtime.store.byKey(task.idempotencyKey);
      if(op?.submission){task.operationId=op.id;task.result=engine.view(op);task.state=pending.has(op.state)?'PENDING':op.state==='CONFIRMED'?'SUCCEEDED':'NEEDS_REVIEW';}
    }
    this.save(b);
  }
  async close(){if(this.closed)return;this.stopping=true;await this.control.tail;await Promise.all([...this.active.values()]);this.db.close();this.closed=true;}
}
