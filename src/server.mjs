import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync, chmodSync, openSync, writeFileSync, closeSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { Chain } from './chain.mjs';
import { AccountManager } from './accounts.mjs';
import { BatchRunner } from './batches.mjs';
import { dashboardSnapshot } from './dashboard.mjs';
import { json, publicError, fail,check } from './util.mjs';

export function nextRecovery(operations,schedule,now=Date.now()) {
  return operations.filter(x=>x.submission&&!['CONFIRMED','SIGNED','FAILED','REJECTED','RESULT_MISMATCH'].includes(x.state)&&(schedule.get(x.id)?.nextAt||0)<=now)
    .sort((a,b)=>Number(!!b.txHash)-Number(!!a.txHash))[0];
}
export async function startServer({config=loadConfig(),wallet,chain,store,walletFactory}={}) {
  const lock=config.root+'/service.lock';
  let fd;
  try { fd=openSync(lock,'wx',0o600); }
  catch(e) {
    if(e.code!=='EEXIST')throw e;
    const pid=Number(readFileSync(lock,'utf8'));
    try { process.kill(pid,0); fail('SERVICE_RUNNING','Service is already running'); }
    catch(error) { if(error.code!=='ESRCH')throw error; }
    unlinkSync(lock);fd=openSync(lock,'wx',0o600);
  }
  writeFileSync(fd,String(process.pid));closeSync(fd);
  if(existsSync(config.socket))unlinkSync(config.socket);
  let accounts,batches,server;
  try {
    chain ||=new Chain(config);
    accounts=new AccountManager({config,chain,wallet,store,walletFactory});
    for(const account of accounts.registry.accounts)accounts.get(account.id);
    batches=new BatchRunner({accounts,config});batches.start();
  } catch(error) {
    await batches?.close();await accounts?.close();await chain?.close?.();
    for(const p of [config.socket,lock])if(existsSync(p))unlinkSync(p);
    throw error;
  }
  const engine=accounts.get().engine;
  server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json; charset=utf-8');
    res.setHeader('cache-control','no-store');
    try {
      if(req.method==='GET'&&req.url==='/health'){res.end(json({ok:true,pid:process.pid,version:'0.3.0',multiAccount:true,batchConcurrency:batches.concurrency,walletTransport:engine.wallet.transport||'cli'}));return;}
      if(req.method!=='POST'||req.url!=='/call')fail('NOT_FOUND','Unknown endpoint');
      // No TCP listener: only this user's 0600 Unix socket is exposed.
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>256*1024)fail('REQUEST_TOO_LARGE','Request exceeds 256 KiB');chunks.push(chunk);}
      const {method,params={},accountId}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      check(typeof method==='string'&&params&&typeof params==='object'&&!Array.isArray(params),'INVALID_ARGUMENTS','Expected a method and object params');
      if(accountId!==undefined)check(!method.startsWith('batch.')&&method!=='batches'&&method!=='account.add'&&method!=='accounts','INVALID_ACCOUNT','This method uses its own account selection');
      let result;
      if(method==='dashboard.snapshot'){check(accountId===undefined,'INVALID_ACCOUNT','Dashboard includes all accounts');result=dashboardSnapshot(accounts);}
      else if(method==='batch.plan')result=await batches.plan(params);
      else if(method==='batches')result=batches.list();
      else if(['batch.run','batch.status','batch.pause','batch.resume','batch.cancel'].includes(method))result=batches[method.slice(6)](params);
      else result=await accounts.dispatch(method,params,accountId);
      res.end(json({success:true,data:result}));
    }catch(e){res.statusCode=e.code==='NOT_FOUND'?404:400;res.end(json({success:false,error:publicError(e)}));}
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.socket,resolve);});}
  catch(error){await batches.close();await accounts.close();await chain.close?.();for(const p of [config.socket,lock])if(existsSync(p))unlinkSync(p);throw error;}
  chmodSync(config.socket,0o600);
  let recovering=false,recoveryOffset=0;const recoverySchedule=new Map();
  const timer=setInterval(async()=>{
    if(recovering)return;recovering=true;
    try{
      const runtimes=[...accounts.runtimes.values()],selected=[];
      for(let i=0;i<runtimes.length;i++){
        const runtime=runtimes[(recoveryOffset+i)%runtimes.length];
        const schedule=recoverySchedule.get(runtime.account.id)||new Map();recoverySchedule.set(runtime.account.id,schedule);
        const op=nextRecovery(runtime.store.scan(),schedule);
        if(op)selected.push({runtime,schedule,op});
        if(selected.length>=batches.concurrency){recoveryOffset=(recoveryOffset+i+1)%runtimes.length;break;}
      }
      await Promise.allSettled(selected.map(async({runtime,schedule,op})=>{
        await runtime.engine.reconcile({id:op.id}).catch(()=>{});
        const unknown=runtime.store.get(op.id).state==='UNKNOWN_SUBMIT',attempt=unknown?(schedule.get(op.id)?.attempt||0)+1:0;
        schedule.set(op.id,{attempt,nextAt:Date.now()+(unknown?Math.min(60000,8000*2**Math.min(attempt,3)):8000)});
      }));
    }catch{/* A later recovery tick retries transient read/storage failures. */}finally{recovering=false;}
  },8000);
  timer.unref();
  let closing;
  const close=()=>closing||=(async()=>{
    clearInterval(timer);
    await new Promise(resolve=>server.close(resolve));
    // Ongoing verify/execute children are owned by this service; normal shutdown must
    // only occur after they finish. SIGKILL recovery is covered by durable intent.
    await batches.close();
    // Wait for any recovery callback still using a store before closing it.
    while(recovering)await new Promise(resolve=>setTimeout(resolve,10));
    await accounts.close();await chain.close?.();
    for(const p of [config.socket,lock])if(existsSync(p))unlinkSync(p);
  })();
  return {server,engine,accounts,batches,close,config};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  startServer().then(service=>{
    let stopping=false;
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;await service.close();process.exit(0);});
  }).catch(e=>{process.stderr.write(json(publicError(e))+'\n');process.exitCode=1;});
}
