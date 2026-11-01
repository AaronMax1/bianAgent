import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, ContractFactory, Wallet } from 'ethers';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { Chain } from '../src/chain.mjs';
import { BSC } from '../src/config.mjs';

export const A='0x1111111111111111111111111111111111111111';
export const B='0x2222222222222222222222222222222222222222';
export const C='0x3333333333333333333333333333333333333333';
export class FakeWallet {
  constructor(signer=null) { this.signer=signer;this.address=A;this.connected=true;this.devMode=true;this.previews=new Map();this.calls=[];this.expire=Date.now()+3600000;this.signerWallet=Wallet.createRandom(); }
  async status(){this.calls.push('status');return{status:this.connected?'CONNECTED':'UNCONNECTED'};}
  async context(){this.calls.push('context');if(!this.connected)throw Object.assign(new Error('disconnected'),{code:'WALLET_DISCONNECTED'});if(!this.devMode)throw Object.assign(new Error('dev off'),{code:'DEV_MODE_REQUIRED'});return{address:this.address,chainId:56,settings:{signInMaxTime:new Date(this.expire).toISOString(),sessionExpireTime:new Date(this.expire).toISOString(),devMode:{enabled:true,expiresAt:Date.now()/1000+3600}}};}
  async lock(){return{status:this.locked?'LOCKED':'UNLOCKED'};}
  async preview(tx){this.calls.push('preview');if(this.previewError)throw new Error('simulation failed');if(this.signer)await this.signer.call({to:tx.to,value:BigInt(tx.value),data:tx.data});
    const requestId=String(this.previews.size+1);this.previews.set(requestId,tx);
    return{requestId,expiresAt:Date.now()+60000,...(tx.gasLimit===undefined?{}:{gasLimit:tx.gasLimit}),parsedTx:{to:tx.to,from:tx.from,value:tx.value,data:tx.data},simulationResult:{simulationCode:'000000000',allowanceChanges:[],authorityChanges:[],balanceChanges:[]},risks:{riskDetails:[]},requireConfirmation:!!this.pending};}
  async execute(requestId){this.calls.push('execute');if(this.errorBefore)throw new Error('timeout before known response');if(this.pending)return{status:'PENDING_CONFIRMATION',orderId:'app-1'};
    let txHash='0x'+'ab'.repeat(32);
    if(this.signer){const tx=this.previews.get(requestId);const result=await this.signer.sendTransaction({to:tx.to,value:BigInt(tx.value),data:tx.data,...(tx.gasLimit===undefined?{}:{gasLimit:tx.gasLimit})});txHash=result.hash;await result.wait();this.lastHash=txHash;}
    if(this.errorAfter)throw new Error('timeout after broadcast');return{status:'BROADCASTED',orderId:'order-1',txHash};}
  async history(){return{transactions:this.lastHash?[{txHash:this.lastHash,txTime:new Date().toISOString()}]:[]};}
  async connect(){return{state:'CONNECTED',reused:true};}
  async previewMessage(wrapper){const requestId=String(this.previews.size+1);this.previews.set(requestId,wrapper);return{requestId,expiresAt:Date.now()+60000,parsedMessage:{messageType:'SignTypedData',message:wrapper.params[1]},risks:{riskDetails:[]}};}
  async executeMessage(requestId){this.calls.push('executeMessage');const typed=JSON.parse(this.previews.get(requestId).params[1]);return{status:'COMPLETED',orderId:'signature-1',signature:await this.signerWallet.signTypedData(typed.domain,typed.types,typed.message)};}
}
export class FakeChain {
  constructor(){this.block={tag:'0x64',number:100,hash:'0x'+'11'.repeat(32),timestamp:Math.floor(Date.now()/1000)};this.calls=[];}
  async snapshot(){return this.block;}
  async verifySnapshot(){if(this.reorg)throw Object.assign(new Error('reorg'),{code:'CHAIN_REORG'});}
  async rpc(method){this.calls.push(method);if(method==='eth_getCode')return'0x60006000';if(method==='eth_getTransactionByHash')return null;if(method==='eth_getTransactionCount')return'0x0';return null;}
  async close(){}
}
export function fixture(){
  const store=new Store(':memory:');const wallet=new FakeWallet();const chain=new FakeChain();const config={...BSC};
  return{store,wallet,chain,config,engine:new Engine({store,wallet,chain,config})};
}
export function mintRequest(key='test-mint-1',to=B){return{kind:'contract',idempotencyKey:key,to,abi:['function mint(uint256 quantity)'],method:'mint',args:['1'],value:'0',expected:{kind:'event',abi:['event Minted(address indexed receiver,uint256 quantity)'],event:'Minted',args:{receiver:A,quantity:'1'}}};}
export async function anvilFixture(){
  const source=new URL('./fixture.sol',import.meta.url);
  const compiled=JSON.parse(execFileSync('solc',['--combined-json','abi,bin',fileURLToPath(source)],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const dir=mkdtempSync(join(tmpdir(),'cw-'));
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const child=spawn(process.env.ANVIL_BIN||'anvil',['--port',String(port),'--host','127.0.0.1','--chain-id','56','--silent'],{stdio:'ignore'});
  const url='http://127.0.0.1:'+port;const provider=new JsonRpcProvider(url,56,{staticNetwork:true});provider.pollingInterval=50;
  for(let i=0;i<60;i++){try{await provider.getBlockNumber();break;}catch{await new Promise(r=>setTimeout(r,50));}}
  const signer=await provider.getSigner(0);
  async function deploy(name){const key=Object.keys(compiled.contracts).find(k=>k.endsWith(':'+name));const c=compiled.contracts[key];const contract=await new ContractFactory(JSON.parse(c.abi),c.bin,signer).deploy();await contract.waitForDeployment();return contract;}
  const token=await deploy('TestToken'),token2=await deploy('TestToken'),router=await deploy('TestRouter'),project=await deploy('TestProject');
  const config={...BSC,root:dir,socket:join(dir,'s.sock'),dbPath:join(dir,'state.sqlite'),rpcUrls:[url],router:await router.getAddress(),wrapped:C,confirmations:1,quoteTtlMs:60000};
  const chain=new Chain(config),wallet=new FakeWallet(signer);wallet.address=await signer.getAddress();
  const store=new Store(config.dbPath);const engine=new Engine({store,wallet,chain,config});
  return{dir,url,provider,signer,token,token2,router,project,config,chain,wallet,store,engine,async close(){store.close();await chain.close();provider.destroy();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true});}};
}
