import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AccountManager,DEFAULT_ACCOUNT } from '../src/accounts.mjs';
import { BinanceSession } from '../src/binance-session.mjs';
import { BinanceApi,ENDPOINTS } from '../src/binance-api.mjs';
import { DirectBawAdapter } from '../src/baw-direct.mjs';
import { BSC } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { callSocket,call } from '../src/client.mjs';
import { createServer } from 'node:http';
import { FakeWallet,FakeChain,mintRequest,A,B,C } from './helpers.mjs';
import { deviceHeaders } from '../src/device-profile.mjs';

export function accountFixture(){
  const root=mkdtempSync(join(tmpdir(),'cw-accounts-'));
  const config={...BSC,root,dbPath:join(root,'state.sqlite'),socket:join(root,'s.sock'),walletTransport:'direct'};
  const chain=new FakeChain(),wallet=new FakeWallet();
  const walletFactory=(_config,account)=>{const w=new FakeWallet();w.address=account.alias==='b'?B:C;return w;};
  const accounts=new AccountManager({config,chain,wallet,walletFactory});
  return {root,config,chain,wallet,walletFactory,accounts,async close(){await accounts.close();rmSync(root,{recursive:true,force:true});}};
}
test('account device profiles are distinct, stable across restart and validated',async()=>{
  const f=accountFixture();
  try{
    const a=f.accounts.add({alias:'a'}),b=f.accounts.add({alias:'b'});
    for(const field of ['mac','hostname','release'])assert.notEqual(a.deviceProfile[field],b.deviceProfile[field]);
    assert.equal(parseInt(a.deviceProfile.mac.slice(0,2),16)&3,2);
    assert.throws(()=>f.accounts.add({alias:'../escape'}),{code:'INVALID_ALIAS'});
    assert.throws(()=>f.accounts.add({alias:'a'}),{code:'ACCOUNT_EXISTS'});
    assert.throws(()=>f.accounts.add({alias:'duplicate',deviceProfile:a.deviceProfile}),{code:'DEVICE_PROFILE_CONFLICT'});
    assert.equal(statSync(join(f.root,'accounts.json')).mode&0o777,0o600);
    await f.accounts.close();
    const second=new AccountManager({config:f.config,chain:f.chain,wallet:new FakeWallet(),walletFactory:f.walletFactory});
    f.accounts=second;
    assert.deepEqual(second.public(second.resolve('a')),a);
    assert.equal(second.resolve('default').id,DEFAULT_ACCOUNT);
  }finally{await f.accounts.close();rmSync(f.root,{recursive:true,force:true});}
});
test('new account sessions isolate keychain rotation, encrypted fallback and client identities',async()=>{
  const f=accountFixture();
  try{
    f.accounts.add({alias:'a'});f.accounts.add({alias:'b'});
    const stored=new Map([['baw:agentSessionId','legacy-fixture-cookie']]);
    const keytar={getPassword:async(s,a)=>stored.get(s+':'+a),setPassword:async(s,a,v)=>stored.set(s+':'+a,v)};
    const ca=f.accounts.get('a').config,cb=f.accounts.get('b').config;
    const a=new BinanceSession(ca,{keytar}),b=new BinanceSession(cb,{keytar});
    await Promise.all([a.beginLogin(),b.beginLogin()]);
    assert.equal((await a.credentials()).sessionId,'');assert.equal((await b.credentials()).sessionId,'');
    a.stageCookie('fixture-cookie-a');b.stageCookie('fixture-cookie-b');await Promise.all([a.commit(),b.commit()]);
    assert.notEqual((await a.credentials()).clientId,(await b.credentials()).clientId);
    a.stageCookie('fixture-cookie-a-rotated');await a.commit();await a.invalidate('fixture-cookie-a-rotated');
    assert.equal((await a.credentials()).sessionId,'');assert.equal((await b.credentials()).sessionId,'fixture-cookie-b');
    assert.equal(stored.get('baw:agentSessionId'),'legacy-fixture-cookie');
    const fallback=new BinanceSession(cb,{keytar:null});await fallback.beginLogin();fallback.stageCookie('fixture-fallback-cookie');await fallback.commit();
    const restored=new BinanceSession(cb,{keytar:null});assert.equal((await restored.credentials()).sessionId,'fixture-fallback-cookie');
    assert(!readFileSync(join(cb.root,'session.json'),'utf8').includes('fixture-fallback-cookie'));
    assert.equal(statSync(join(cb.root,'session.json')).mode&0o777,0o600);
  }finally{await f.close();}
});
test('all HTTP calls use the selected device profile and stable client headers; signin OS agrees',async t=>{
  const f=accountFixture();t.after(()=>f.close());
  f.accounts.add({alias:'a'});f.accounts.add({alias:'b'});
  const requests=[];
  for(const alias of ['a','b']){
    const config=f.accounts.get(alias).config,session=new BinanceSession(config,{keytar:null});
    await session.beginLogin();session.stageCookie('fixture-'+alias);await session.commit();
    const api=new BinanceApi(config,{session,fetch:async(url,options)=>{
      const endpoint=Object.keys(ENDPOINTS).find(k=>ENDPOINTS[k].path===new URL(url).pathname);
      requests.push({alias,endpoint,headers:options.headers,body:options.body?JSON.parse(options.body):undefined});
      return new Response(JSON.stringify({code:'000000',data:endpoint==='login'?{connectionStatus:'UNCONNECTED',qrInfo:{qrCodeUrl:'https://example.com',qrCodeId:'q',expireAt:Date.now()+10000}}:{status:'UNLOCKED'}}));
    }});t.after(()=>api.close());
    for(const endpoint of ['query','preview','execute'])await api.call(endpoint,endpoint==='query'?undefined:{});
    const wallet=new DirectBawAdapter(config,{api:{hasSession:async()=>false,beginLogin:()=>api.beginLogin(),call:(...args)=>api.call(...args)}});
    const login=await wallet.run(['auth','signin']);assert.equal(login.qrCodeId,'q');
    const group=requests.filter(r=>r.alias===alias);
    for(const r of group){
      for(const [k,v] of Object.entries(deviceHeaders(config.deviceProfile)))assert.equal(r.headers[k],v);
      assert.equal(r.headers.agentClientId,r.headers['bnc-uuid']);
    }
    assert.equal(group.find(r=>r.endpoint==='login').body.os,config.deviceProfile.osName);
  }
  for(const field of ['agentClientMac','device_name','system_version','agentClientId'])assert.notEqual(requests[0].headers[field],requests.find(r=>r.alias==='b').headers[field]);
});
test('per-account idempotency and blockers are isolated; wrong account cannot confirm or export',async()=>{
  const f=accountFixture();
  try{
    f.accounts.add({alias:'b'});const a=f.accounts.get(),b=f.accounts.get('b');
    const first=await f.accounts.dispatch('prepare',mintRequest('same-per-account-key'));
    const second=await f.accounts.dispatch('prepare',mintRequest('same-per-account-key'),'b');
    assert.notEqual(first.id,second.id);assert.equal(first.wallet,A);assert.equal(second.wallet,B);
    await assert.rejects(f.accounts.dispatch('confirm',{id:first.id,approved:true,confirmationToken:first.confirmationToken},'b'),{code:'NOT_FOUND'});
    await assert.rejects(f.accounts.dispatch('signature.export',{id:first.id},'b'),{code:'NOT_FOUND'});
    a.wallet.pending=true;
    const resultA=await f.accounts.dispatch('confirm',{id:first.id,approved:true,confirmationToken:first.confirmationToken});
    assert.equal(resultA.state,'PENDING_APP');
    const resultB=await f.accounts.dispatch('confirm',{id:second.id,approved:true,confirmationToken:second.confirmationToken},'b');
    assert.equal(resultB.state,'BROADCASTED');
    await f.accounts.dispatch('confirm',{id:second.id,approved:true,confirmationToken:second.confirmationToken},'b');
    assert.equal(b.wallet.calls.filter(c=>c==='execute').length,1);
    assert.equal(b.store.get(second.id).accountId,second.accountId);
  }finally{await f.close();}
});
test('account binding refuses duplicate wallets and unexpected or changed addresses before preview',async()=>{
  const f=accountFixture();
  try{
    await f.accounts.dispatch('status');
    f.accounts.add({alias:'b',expectedAddress:B});const b=f.accounts.get('b');
    b.wallet.address=C;
    await assert.rejects(f.accounts.dispatch('prepare',mintRequest(),'b'),{code:'ACCOUNT_WALLET_MISMATCH'});
    b.wallet.address=B;await f.accounts.dispatch('status',{},'b');
    b.wallet.address=C;
    await assert.rejects(f.accounts.dispatch('status',{},'b'),{code:'ACCOUNT_WALLET_MISMATCH'});
    f.accounts.add({alias:'duplicate'});f.accounts.get('duplicate').wallet.address=A;
    await assert.rejects(f.accounts.dispatch('status',{},'duplicate'),{code:'DUPLICATE_WALLET'});
    assert(!b.wallet.calls.includes('preview'));
  }finally{await f.close();}
});
test('concurrent account pairing stays separate and repeated connect shares only its own task',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cw-pair-accounts-'));
  const config={...BSC,root,dbPath:join(root,'state.sqlite')},records=new Map();
  const accounts=new AccountManager({config,chain:new FakeChain(),wallet:new FakeWallet(),walletFactory:(config,a)=>{
    const record={connected:false,starts:0,commits:0};records.set(a.alias,record);
    const api={hasSession:async()=>record.connected,beginLogin:async()=>{},commit:async()=>record.commits++,close:async()=>{},call:async(name)=>{
      if(name==='login'){record.starts++;await new Promise(r=>setTimeout(r,5));return{connectionStatus:'UNCONNECTED',qrInfo:{qrCodeUrl:'https://example.com/'+a.alias,qrCodeId:'q-'+a.alias,expireAt:Date.now()+10000}};}
      if(name==='loginConfirm'){record.connected=true;return{connectionStatus:'CONNECTED'};}
      if(name==='query')return{connectionStatus:'CONNECTED',walletCreateStatus:'CREATED',signInMaxTime:Date.now()+3600000};
      if(name==='settings')return{};if(name==='limits')return{};
      if(name==='wallets')return[{subWalletList:[{addresses:[{binanceChainId:'56',address:a.alias==='b'?B:C}]}]}];
      if(name==='networks')return[{binanceChainId:'56',simpleName:'BSC'}];
      throw new Error('Unexpected pairing endpoint');
    }};return new DirectBawAdapter(config,{api});
  }});
  try{
    accounts.add({alias:'b'});accounts.add({alias:'c'});
    const [b,c,again]=await Promise.all([accounts.dispatch('account.connect',{},'b'),accounts.dispatch('account.connect',{},'c'),accounts.dispatch('account.connect',{},'b')]);
    assert.equal(b.urlForWeb,'https://example.com/b');assert.equal(c.urlForWeb,'https://example.com/c');assert.equal(again.accountId,b.accountId);
    await Promise.all([accounts.get('b').wallet.verifyTask,accounts.get('c').wallet.verifyTask]);
    assert.equal(records.get('b').starts,1);assert.equal(records.get('c').starts,1);
    assert.equal(records.get('b').commits,1);assert.equal(records.get('c').commits,1);
    assert.equal(accounts.resolve('b').walletAddress,B);assert.equal(accounts.resolve('c').walletAddress,C);
  }finally{await accounts.close();rmSync(root,{recursive:true,force:true});}
});
test('socket dispatch accepts explicit account selection and preserves the old default interface',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cw-account-socket-'));
  const config={...BSC,root,socket:join(root,'s.sock'),dbPath:join(root,'state.sqlite')};
  const svc=await startServer({config,chain:new FakeChain(),wallet:new FakeWallet(),walletFactory:()=>{const w=new FakeWallet();w.address=B;return w;}});
  try{
    const invoke=(method,params={},accountId)=>callSocket(config,'/call',{method,params,accountId});
    assert.equal((await invoke('status')).data.address,A);
    const added=await invoke('account.add',{alias:'b'});assert.equal(added.success,true);
    const status=await invoke('status',{},'b');assert.equal(status.data.address,B);assert.equal(status.data.accountId,added.data.accountId);
    const unknown=await invoke('prepare',mintRequest(),'absent');assert.equal(unknown.error.code,'ACCOUNT_NOT_FOUND');
    assert.equal((await invoke('accounts')).data.length,2);
    assert.equal((await callSocket(config,'/health')).version,'0.3.0');
  }finally{await svc.close();rmSync(root,{recursive:true,force:true});}
});
test('CLI selects a single account or an explicit batch, with JSON stdin and positional account aliases',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cw-account-cli-'));
  const config={...BSC,root,socket:join(root,'service.sock'),dbPath:join(root,'state.sqlite')};
  const svc=await startServer({config,chain:new FakeChain(),wallet:new FakeWallet(),walletFactory:()=>{const w=new FakeWallet();w.address=B;return w;}});
  const cli=(args,body)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),...args],{env:{...process.env,CODEX_WALLET_HOME:root},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);child.on('error',reject);
    child.on('close',code=>{try{resolve({code,...JSON.parse(stdout)});}catch{reject(new Error(stderr||stdout));}});child.stdin.end(body?JSON.stringify(body):'');
  });
  try{
    assert.equal((await cli(['account.add','b'])).success,true);
    assert.equal((await cli(['account.status','b'])).data.address,B);
    assert.equal((await cli(['status','--account','b'])).data.address,B);
    assert.equal((await cli(['status'])).data.address,A);
    const request={idempotencyKey:'cli-batch-selection',action:'submit',params:{request:mintRequest()},limits:{maxValueWeiPerAccount:'0',maxTotalValueWei:'0'}};
    const plan=await cli(['batch.plan','--accounts','b','--stdin'],request);assert.equal(plan.success,true);assert.equal(plan.data.tasks.length,1);
    assert.equal(plan.data.tasks[0].walletAddress,B);
    const sent=await cli(['batch.run','--stdin'],{id:plan.data.id,planToken:plan.data.planToken,approved:true});assert.equal(sent.success,true);
    while(svc.batches.active.size)await Promise.all([...svc.batches.active.values()]);
    assert.equal(svc.accounts.get('b').wallet.calls.filter(c=>c==='execute').length,1);assert(!svc.accounts.get().wallet.calls.includes('execute'));
    const invalid=await cli(['submit','--account','b','--accounts','default','--stdin'],{});assert.equal(invalid.success,false);
    assert.equal(invalid.error.code,'INVALID_ARGUMENTS');
  }finally{await svc.close();rmSync(root,{recursive:true,force:true});}
});
test('new client refuses to send account-selected requests to an old daemon',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cw-old-daemon-')),socket=join(root,'s.sock');let calls=0;
  const server=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/health')res.end(JSON.stringify({ok:true,version:'0.2.0'}));else{calls++;res.end(JSON.stringify({success:true,data:{state:'BROADCASTED'}}));}});
  await new Promise(r=>server.listen(socket,r));
  try{
    await assert.rejects(call({root,socket},'submit',{},'b'),{code:'SERVICE_UPGRADE_REQUIRED'});
    assert.equal(calls,0);
  }finally{await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
});
