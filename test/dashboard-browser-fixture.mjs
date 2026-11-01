import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { startWebServer } from '../src/web-server.mjs';
import { call } from '../src/client.mjs';
import { BSC } from '../src/config.mjs';
import { FakeWallet,FakeChain,A,B,C } from './helpers.mjs';
const root=mkdtempSync(join(tmpdir(),'wallet-studio-browser-'));
const config={...BSC,root,socket:join(root,'s.sock'),dbPath:join(root,'state.sqlite'),walletTransport:'direct'};
class LoginWallet extends FakeWallet {
  async connect(){
    if(this.connected)return {state:'CONNECTED'};
    this.pairing={state:'VERIFYING',urlForWeb:'https://example.com/fixture-binance-login',pairingCode:'abc123',expireAt:Date.now()+30000};
    this.verifyTask=new Promise(resolve=>setTimeout(()=>{this.connected=true;this.pairing.state='CONNECTED';resolve();},5000));
    return this.pairing;
  }
}
const backend=await startServer({config,chain:new FakeChain(),wallet:new LoginWallet(),walletFactory:(_config,a)=>{const w=new LoginWallet();w.address=a.alias==='account2'?B:C;w.connected=a.alias==='account2';return w;}});
const second=backend.accounts.add({alias:'account2'});
backend.accounts.bind(backend.accounts.resolve('default'),{address:A});backend.accounts.bind(backend.accounts.resolve('account2'),{address:B});
for(const [alias,id,wallet] of [['default','first',A],['account2','second',B]]){
 const runtime=backend.accounts.get(alias);
 runtime.store.save({id,idempotencyKey:'fixture-'+id,label:'Ptah IAO claim',kind:'contract',state:'CONFIRMED',wallet,createdAt:Date.now()-2000,txHash:'0x'+'a'.repeat(64),decoded:{method:'claimAirdrop()'},payload:{to:'0xa2556377118dD333F9f09600DE0bBCf54Cbc69A0'},businessResult:{verified:true,event:'AirdropClaimed',values:{amount:'11250000000000000000000'}}});
}
const web=await startWebServer({config,port:0,invoke:(method,params,accountId)=>call(config,method,params,accountId)});
console.log(JSON.stringify({url:web.url}));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await web.close();await backend.close();rmSync(root,{recursive:true,force:true});process.exit(0);});
