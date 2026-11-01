import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv,pbkdf2Sync,randomBytes } from 'node:crypto';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BinanceSession } from '../src/binance-session.mjs';
import { BinanceApi,ENDPOINTS,binanceProxyClient } from '../src/binance-api.mjs';
import { DirectBawAdapter,normalizeSettings } from '../src/baw-direct.mjs';
import { Engine } from '../src/engine.mjs';
import { fixture,anvilFixture,mintRequest,A } from './helpers.mjs';

const CLIENT='11111111-2222-3333-4444-555555555555',SESSION='unit-test-session-not-real';
test('Binance DNS workaround changes only the proxy CONNECT destination and preserves TLS options',()=>{
  const calls=[];
  class StubClient {constructor(url,options){calls.push({url,options});}connect(params){calls.push(params);return Promise.resolve();}}
  const client=binanceProxyClient('99.84.141.68',StubClient)('http://127.0.0.1:7890',{connect:'tls-fixture'});
  client.connect({path:'www.binance.com:443',headers:{host:'www.binance.com:443'},servername:'www.binance.com'});
  assert.equal(calls[1].path,'99.84.141.68:443');assert.equal(calls[1].headers.host,'www.binance.com:443');assert.equal(calls[1].servername,'www.binance.com');
  client.connect({path:'other.example:443'});assert.equal(calls[2].path,'other.example:443');
  assert.throws(()=>binanceProxyClient('https://wrong.example'),{code:'INVALID_BINANCE_CONNECT_ADDRESS'});
});
class Session {
  clientId=CLIENT;sessionId=SESSION;staged='';committed=0;invalidated=0;
  async credentials(){return{clientId:this.clientId,sessionId:this.staged||this.sessionId};}
  stageCookie(value){this.staged=value;}
  async beginLogin(){this.clientId||=CLIENT;}
  async commit(){this.committed++;if(this.staged)this.sessionId=this.staged;this.staged='';}
  async invalidate(){this.invalidated++;this.sessionId='';this.staged='';}
}
const response=(data,headers={})=>new Response(JSON.stringify({code:'000000',data}),{status:200,headers});
test('direct HTTP uses fixed endpoints and session headers, refuses redirects and never leaks credentials in timings',async t=>{
  const session=new Session(),requests=[];
  const api=new BinanceApi({}, {session,fetch:async(url,options)=>{requests.push({url,options});return response({connectionStatus:'CONNECTED',walletCreateStatus:'CREATED'});}});
  t.after(()=>api.close());await api.call('query');
  assert.equal(requests[0].url,'https://www.binance.com'+ENDPOINTS.query.path);
  assert.equal(requests[0].options.headers.Cookie,'agentSessionId='+SESSION);
  assert.equal(requests[0].options.headers.agentClientId,CLIENT);
  assert.equal(requests[0].options.redirect,'error');
  assert(!JSON.stringify(api).includes(SESSION));assert(!JSON.stringify(api.timings).includes(CLIENT));
  await assert.rejects(api.call('https://evil.example'),{code:'ENDPOINT_NOT_ALLOWED'});
});
test('successful session rotation is persisted; rejected response cannot replace the active session',async t=>{
  const session=new Session();let bad=false;
  const api=new BinanceApi({}, {session,fetch:async()=>bad?new Response(JSON.stringify({code:'351803',message:'High risk transaction'}),{headers:{'set-cookie':'agentSessionId=evil; Secure'}}):response({connectionStatus:'CONNECTED',walletCreateStatus:'CREATED'},{'set-cookie':'agentSessionId=rotated-session; HttpOnly; Secure'})});
  t.after(()=>api.close());await api.call('query');assert.equal(session.sessionId,'rotated-session');assert.equal(session.committed,1);
  bad=true;await assert.rejects(api.call('preview',{}),{code:'BINANCE_API_ERROR'});assert.equal(session.sessionId,'rotated-session');
});
test('direct API retries safe reads but execute, market placement and login-confirm are single-attempt',async t=>{
  const session=new Session();let calls=0;
  const api=new BinanceApi({}, {session,fetch:async()=>{calls++;if(calls%2)throw new TypeError('network fixture');return response({status:'UNLOCKED'});}});
  t.after(()=>api.close());assert.equal((await api.call('lock',{binanceChainId:'56'})).status,'UNLOCKED');assert.equal(calls,2);
  calls=0;await assert.rejects(api.call('execute',{requestId:'one'}),{code:'NETWORK_ERROR'});assert.equal(calls,1);
  calls=0;await assert.rejects(api.call('marketPlace',{binanceChainId:'56'}),{code:'NETWORK_ERROR'});assert.equal(calls,1);
  calls=0;await assert.rejects(api.call('loginConfirm',{qrCodeId:'q'}),{code:'NETWORK_ERROR'});assert.equal(calls,1);
});
test('session expiry, malformed responses and transport errors preserve outcomes and sanitize error details',async t=>{
  const session=new Session();let result=new Response(JSON.stringify({code:'100001005',message:'Session expired'}));
  const api=new BinanceApi({}, {session,fetch:async()=>result});t.after(()=>api.close());
  await assert.rejects(api.call('query'),{code:'SESSION_EXPIRED'});assert.equal(session.invalidated,1);
  session.sessionId=SESSION;result=new Response('<html>not JSON</html>');
  await assert.rejects(api.call('preview',{}),{code:'API_BAD_RESPONSE'});
});
test('simulation error with order or hash evidence remains ambiguous to the caller',async t=>{
  const api=new BinanceApi({}, {session:new Session(),fetch:async()=>new Response(JSON.stringify({code:'953401',message:'simulation error',data:{orderId:'already-created'}}))});
  t.after(()=>api.close());await assert.rejects(api.call('execute',{requestId:'preview'}),e=>e.code==='BINANCE_API_ERROR'&&e.details.submissionEvidence===true&&e.details.operation==='execute');
});
test('normalization preserves actual quota fields and both timestamp formats',()=>{
  const end=Date.now()+3600000;
  const d=normalizeSettings({autoLogout:'365d',dailyLimit:'100',devMode:{enabled:true,expiresAt:Math.floor(end/1000),dailyLimit:'10'},riskyTxnHandling:'NeedConfirmation'},
    {quotaUsed:'2.5',developerModeQuotaUsed:'1.25'}, {sessionExpireTime:end,signInMaxTime:end+1000000,inactiveSignOutTime:new Date(end).toISOString()});
  assert.equal(d.quotaLeft,97.5);assert.equal(d.developerModeQuotaUsed,1.25);assert.equal(d.devMode.enabled,true);assert(Date.parse(d.devMode.expiresAt)>Date.now());assert.equal(d.inactiveSignOutTime,new Date(end).toISOString());
});
test('direct adapter supports existing service methods without executing a CLI process',async()=>{
  const calls=[],api={
    hasSession:async()=>true,close:async()=>{},
    call:async(name,body)=>{calls.push({name,body});return{
      query:{connectionStatus:'CONNECTED',walletCreateStatus:'CREATED',sessionExpireTime:Date.now()+1000000},
      settings:{devMode:{enabled:true,expiresAt:Date.now()/1000+1000}},limits:{},
      wallets:[{subWalletList:[{addresses:[{binanceChainId:'56',address:A}]}]}],
      networks:[{binanceChainId:'56',simpleName:'BSC'}],lock:{status:'UNLOCKED'},
      preview:{requestId:'p',expiresAt:Date.now()+100000,parsedTx:{to:A}},execute:{status:'PENDING_CONFIRMATION',orderId:'o'},
      messagePreview:{requestId:'m'},messageExecute:{status:'PENDING_CONFIRMATION',orderId:'s'},messageResult:{status:'PENDING_CONFIRMATION'},
      pending:{list:[{txHash:'hash1',txTime:Date.now(),txHashList:[]}]},confirmed:{list:[]}
    }[name];}};
  const wallet=new DirectBawAdapter({chainId:56,bawBin:'/must-not-execute'}, {api});
  assert.equal((await wallet.context({external:true,fresh:true})).address,A);
  await wallet.preview({chainId:56,from:A,to:A,value:'0',data:'0x'});
  assert.deepEqual(calls.find(x=>x.name==='preview').body,{binanceChainId:'56',from:A,to:A,value:'0',inputData:'0x'});
  await wallet.preview({chainId:56,from:A,to:A,value:'0',data:'0x',gasLimit:800000});
  assert.equal(calls.filter(x=>x.name==='preview').at(-1).body.gasLimit,800000);
  assert.equal((await wallet.execute('p')).orderId,'o');
  assert.equal((await wallet.history(Date.now()-1000)).transactions[0].txHash,'hash1');
  await wallet.previewMessage({method:'eth_signTypedData_v4',params:[]});await wallet.executeMessage('m');await wallet.messageResult('s');
  assert(calls.find(x=>x.name==='messageResult').body.orderId==='s');
});
test('direct login preserves official pairing link and waits for actual connected wallet before committing',async()=>{
  let connected=false,begun=0,committed=0;
  const api={hasSession:async()=>connected,beginLogin:async()=>begun++,commit:async()=>committed++,close:async()=>{},
    call:async(name)=>{if(name==='login')return{connectionStatus:'UNCONNECTED',qrInfo:{qrCodeUrl:'https://example.com/?a=1%2B2',qrCodeId:'q',expireAt:Date.now()+10000}};
      if(name==='loginConfirm'){connected=true;return{connectionStatus:'CONNECTED'};}
      return{connectionStatus:'CONNECTED',walletCreateStatus:'CREATED'};}};
  const wallet=new DirectBawAdapter({chainId:56},{api});const a=await wallet.connect();
  assert.equal(a.urlForWeb,'https://example.com/?a=1%2B2');assert.match(a.pairingCode,/^[a-f0-9]{6}$/);await wallet.verifyTask;
  assert.equal(begun,1);assert.equal(committed,1);assert.equal(wallet.pairing.state,'CONNECTED');
  assert.equal((await wallet.connect()).reused,true);
});
test('explicit fresh status bypasses the short query cache after the wallet disconnects',async()=>{
  let connected=true,queries=0;
  const api={hasSession:async()=>true,call:async()=>{queries++;return{connectionStatus:connected?'CONNECTED':'UNCONNECTED',walletCreateStatus:'CREATED'};}};
  const wallet=new DirectBawAdapter({chainId:56},{api});
  assert.equal((await wallet.status(true)).status,'CONNECTED');connected=false;
  assert.equal((await wallet.status(true)).status,'UNCONNECTED');assert.equal(queries,2);
});
test('direct execute timeout reaches durable UNKNOWN_SUBMIT, never falls back to CLI or retries',async t=>{
  const f=fixture();t.after(()=>f.store.close());let submits=0;
  const session=new Session(),api=new BinanceApi({}, {session,fetch:async()=>{submits++;throw new TypeError('failed after bytes sent');}});
  t.after(()=>api.close());f.wallet.execute=requestId=>api.call('execute',{requestId});
  const op=await f.engine.prepare(mintRequest());const req={id:op.id,approved:true,confirmationToken:op.confirmationToken};
  assert.equal((await f.engine.confirm(req)).state,'UNKNOWN_SUBMIT');await f.engine.confirm(req);assert.equal(submits,1);
});
test('encrypted CLI session compatibility, fallback persistence, keychain rotation and identity mismatch',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cw-session-')),identity='unit-test-device-not-real';
  const key=pbkdf2Sync(identity,'baw-agentic-wallet-v1:'+identity,100000,32,'sha256');
  const encode=s=>{const iv=randomBytes(16),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(s),c.final(),c.getAuthTag()]).toString('base64');};
  const path=join(root,'session.json');
  writeFileSync(path,JSON.stringify({clientId:encode(CLIENT),sessionId:encode(SESSION)}),{mode:0o600});
  try{
    const session=new BinanceSession({}, {directory:root,identity,keytar:null});
    assert.deepEqual(await session.credentials(),{clientId:CLIENT,sessionId:SESSION});
    session.stageCookie('new-test-cookie');await session.commit();
    const second=new BinanceSession({}, {directory:root,identity,keytar:null});
    assert.equal((await second.credentials()).sessionId,'new-test-cookie');assert.equal(statSync(path).mode&0o777,0o600);
    assert(!readFileSync(path,'utf8').includes('new-test-cookie'));
    let stored='keychain-test-cookie';const keytar={getPassword:async()=>stored,setPassword:async(_,__,v)=>{stored=v;}};
    const third=new BinanceSession({}, {directory:root,identity,keytar});
    assert.equal((await third.credentials()).sessionId,stored);third.stageCookie('rotated-keychain-cookie');await third.commit();assert.equal(stored,'rotated-keychain-cookie');
    const wrong=new BinanceSession({}, {directory:root,identity:'another-device',keytar:null});
    await assert.rejects(wrong.credentials(),{code:'SESSION_READ_FAILED'});
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('concurrent cookie rotations serialize keychain writes and preserve the newest staged session',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cw-session-'));
  let stored=SESSION,releaseFirst,firstStarted;
  const gate=new Promise(r=>releaseFirst=r),started=new Promise(r=>firstStarted=r),writes=[];
  const keytar={getPassword:async()=>stored,setPassword:async(_,__,value)=>{
    writes.push(value);if(writes.length===1){firstStarted();await gate;}stored=value;
  }};
  writeFileSync(join(root,'session.json'),JSON.stringify({clientId:CLIENT}),{mode:0o600});
  try{
    const session=new BinanceSession({}, {directory:root,identity:'test-device',keytar});await session.credentials();
    session.stageCookie('first-test-cookie');const first=session.commit();await started;
    session.stageCookie('second-test-cookie');const second=session.commit();
    await session.invalidate('expired-earlier-cookie');
    assert.equal((await session.credentials()).sessionId,'second-test-cookie');assert.equal(writes.length,1);
    releaseFirst();await Promise.all([first,second]);
    assert.deepEqual(writes,['first-test-cookie','second-test-cookie']);
    assert.equal(stored,'second-test-cookie');assert.equal((await session.credentials()).sessionId,stored);
  }finally{releaseFirst();rmSync(root,{recursive:true,force:true});}
});
test('direct HTTP adapter end-to-end: local-chain preview, single submission and verified mint receipt',async t=>{
  const f=await anvilFixture(),requests=[],expiry=Date.now()+3600000;
  const api=new BinanceApi({}, {session:new Session(),fetch:async(url,options)=>{
    const name=Object.keys(ENDPOINTS).find(k=>new URL(url).pathname===ENDPOINTS[k].path);
    const body=options.body?JSON.parse(options.body):undefined;requests.push({name,body});
    if(name==='query')return response({connectionStatus:'CONNECTED',walletCreateStatus:'CREATED',sessionExpireTime:expiry,signInMaxTime:expiry});
    if(name==='settings')return response({devMode:{enabled:true,expiresAt:expiry}});
    if(name==='limits')return response({});
    if(name==='wallets')return response([{subWalletList:[{addresses:[{binanceChainId:'56',address:f.wallet.address}]}]}]);
    if(name==='networks')return response([{binanceChainId:'56',simpleName:'BSC'}]);
    if(name==='lock')return response({status:'UNLOCKED'});
    if(name==='preview')return response(await f.wallet.preview({chainId:56,from:body.from,to:body.to,value:body.value,data:body.inputData}));
    if(name==='execute')return response(await f.wallet.execute(body.requestId));
    throw new Error('Unexpected API operation: '+name);
  }});
  t.after(async()=>{await api.close();await f.close();});
  const wallet=new DirectBawAdapter({...f.config,bawBin:'/must-not-execute'}, {api});
  const engine=new Engine({...f,wallet});
  const request=mintRequest('direct-local-mint',await f.project.getAddress());request.expected.args.receiver=f.wallet.address;
  assert.equal(await f.project.minted(),0n);
  const op=await engine.submit({request,authorization:{approved:true,maxValueWei:'0'}});assert.equal(op.state,'BROADCASTED');
  const result=await engine.reconcile({id:op.id});assert.equal(result.state,'CONFIRMED');assert.equal(result.businessResult.verified,true);
  assert.equal(await f.project.minted(),1n);assert.equal(requests.filter(r=>r.name==='execute').length,1);
  assert.equal(requests.filter(r=>r.name==='query').length,1);
  assert.deepEqual(requests.find(r=>r.name==='execute').body,{requestId:f.store.get(op.id).requestId});
});
