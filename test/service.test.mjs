import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,statSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer,nextRecovery } from '../src/server.mjs';
import { callSocket } from '../src/client.mjs';
import { BawAdapter } from '../src/baw.mjs';
import { BSC } from '../src/config.mjs';
import { FakeWallet,FakeChain,mintRequest,A } from './helpers.mjs';
test('old unknown submission cannot starve a newer broadcast and respects recovery backoff',()=>{
  const unknown={id:'old',submission:{},state:'UNKNOWN_SUBMIT'},sent={id:'new',submission:{},state:'BROADCASTED',txHash:'hash'};
  const schedule=new Map();assert.equal(nextRecovery([unknown,sent],schedule).id,'new');
  schedule.set('old',{nextAt:200});assert.equal(nextRecovery([unknown],schedule,100),undefined);
  assert.equal(nextRecovery([unknown],schedule,201).id,'old');
});
test('Unix socket API runs the full Codex prepare-confirm-recover interface and persists events',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'cw-svc-'));
  const config={...BSC,root:dir,socket:join(dir,'service.sock'),dbPath:join(dir,'state.sqlite')};
  const wallet=new FakeWallet(),chain=new FakeChain();
  const svc=await startServer({config,wallet,chain});t.after(async()=>{await svc.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal(statSync(config.socket).mode&0o777,0o600);assert.equal(statSync(config.dbPath).mode&0o777,0o600);
  const health=await callSocket(config,'/health');assert.equal(health.ok,true);
  const invoke=(method,params)=>callSocket(config,'/call',{method,params});
  const status=await invoke('status');assert.equal(status.data.walletStatus,'CONNECTED');
  const prepared=await invoke('prepare',mintRequest());assert.equal(prepared.data.state,'AWAITING_USER');
  const op=prepared.data;const request={id:op.id,approved:true,confirmationToken:op.confirmationToken};
  const sent=await invoke('confirm',request);assert.equal(sent.data.state,'BROADCASTED');
  await invoke('confirm',request);assert.equal(wallet.calls.filter(x=>x==='execute').length,1);
  const history=await invoke('events',{});assert(history.data.some(e=>e.state==='EXECUTE_INTENT_SAVED'));
  const unknown=await invoke('shell',{command:'echo unsafe'});assert.equal(unknown.success,false);
});
test('pairing deduplicates concurrent connect and keeps verify alive until terminal status',async()=>{
  const wallet=new BawAdapter({chainId:56});let connected=false,signin=0,finish;const done=new Promise(r=>finish=r);
  wallet.run=async args=>{
    if(args[0]==='wallet')return{status:connected?'CONNECTED':'UNCONNECTED'};
    if(args[1]==='signin'){signin++;await new Promise(r=>setTimeout(r,5));return{urlForWeb:'https://example.com/?exact=a%2Bb',pairingCode:'001234',qrCodeId:'q-1',expireAt:Date.now()+300000};}
    await done;connected=true;return{status:'SUCCESS'};
  };
  const [a,b]=await Promise.all([wallet.connect(),wallet.connect()]);
  assert.equal(signin,1);assert.equal(a.pairingCode,'001234');assert.equal(a.urlForWeb,'https://example.com/?exact=a%2Bb');assert.equal(b.state,'VERIFYING');
  finish();await wallet.verifyTask;assert.equal(wallet.pairing.state,'CONNECTED');
  assert.equal((await wallet.connect()).reused,true);
});
