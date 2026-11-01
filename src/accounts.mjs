import { existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { Vault } from './vault.mjs';
import { BawAdapter } from './baw.mjs';
import { DirectBawAdapter } from './baw-direct.mjs';
import { realDeviceProfile,newDeviceProfile } from './device-profile.mjs';
import { check,address,sameAddress,json } from './util.mjs';

export const DEFAULT_ACCOUNT='legacy-default';
export class AccountManager {
  runtimes=new Map();
  constructor({config,chain,wallet,store,walletFactory}={}) {
    Object.assign(this,{config,chain,walletFactory});
    mkdirSync(config.root,{recursive:true,mode:0o700});
    this.path=join(config.root,'accounts.json');
    this.registry=existsSync(this.path)?JSON.parse(readFileSync(this.path,'utf8')):{version:1,installationId:randomUUID(),accounts:[{
      id:DEFAULT_ACCOUNT,alias:'default',legacy:true,deviceProfile:realDeviceProfile(),deviceProfileVersion:1,createdAt:Date.now()
    }]};
    check(this.registry.version===1&&Array.isArray(this.registry.accounts)&&this.registry.accounts.some(a=>a.id===DEFAULT_ACCOUNT),'INVALID_ACCOUNTS','Invalid account registry');
    this.persist();
    const runtime=this.open(this.resolve(DEFAULT_ACCOUNT),{wallet,store});
    const prev=runtime.store.kv('walletContext');
    if(prev?.address&&!this.resolve(DEFAULT_ACCOUNT).walletAddress)this.bind(this.resolve(DEFAULT_ACCOUNT),prev);
  }
  persist() {
    const temp=this.path+'.'+randomUUID()+'.tmp';
    writeFileSync(temp,json(this.registry)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,this.path);chmodSync(this.path,0o600);
  }
  resolve(selector=DEFAULT_ACCOUNT) {
    check(typeof selector==='string'&&selector.length>0,'INVALID_ACCOUNT','Provide an account ID or alias');
    const account=this.registry.accounts.find(a=>a.id===selector||a.alias===selector);
    check(account,'ACCOUNT_NOT_FOUND','Account not found');return account;
  }
  public(account) {
    return {accountId:account.id,alias:account.alias,legacy:!!account.legacy,walletAddress:account.walletAddress,expectedAddress:account.expectedAddress,
      deviceProfile:account.deviceProfile,deviceProfileVersion:account.deviceProfileVersion,createdAt:account.createdAt,lastConnectedAt:account.lastConnectedAt,
      ...(account.displayName!==undefined?{displayName:account.displayName}:{}),...(account.notes!==undefined?{notes:account.notes}:{}),...(account.archived!==undefined?{archived:account.archived}:{})};
  }
  list(){return this.registry.accounts.map(a=>this.public(a));}
  metadata(input) {
    const result={};
    for(const [key,max] of [['displayName',60],['notes',500]])if(input[key]!==undefined){
      check(typeof input[key]==='string'&&input[key].length<=max,'INVALID_ACCOUNT_METADATA',key+' is too long');
      result[key]=input[key].trim();
    }
    if(input.archived!==undefined){check(typeof input.archived==='boolean','INVALID_ACCOUNT_METADATA','archived must be a boolean');result.archived=input.archived;}
    return result;
  }
  update(selector,input) {
    check(Object.keys(input).every(k=>['displayName','notes','archived'].includes(k)),'INVALID_ACCOUNT_METADATA','Only displayName, notes and archived can be updated');
    const account=this.resolve(selector);Object.assign(account,this.metadata(input));this.persist();return this.public(account);
  }
  add({alias,expectedAddress,deviceProfile,displayName,notes}={}) {
    const metadata=this.metadata({displayName,notes});
    check(this.config.walletTransport!=='cli','MULTI_ACCOUNT_DIRECT_REQUIRED','New accounts require direct wallet transport');
    check(typeof alias==='string'&&alias!=='all'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(alias),'INVALID_ALIAS','Use an account alias of 1–48 letters, digits, underscores or hyphens; all is reserved');
    check(!this.registry.accounts.some(a=>a.id===alias||a.alias===alias),'ACCOUNT_EXISTS','Account alias already exists');
    const account={id:'account-'+randomUUID(),alias,...metadata,deviceProfile:newDeviceProfile(this.registry.accounts.map(a=>a.deviceProfile),deviceProfile),deviceProfileVersion:1,createdAt:Date.now()};
    if(expectedAddress){account.expectedAddress=address(expectedAddress);check(!this.registry.accounts.some(a=>sameAddress(a.walletAddress,expectedAddress)||sameAddress(a.expectedAddress,expectedAddress)),'DUPLICATE_WALLET','Wallet is already assigned to another account');}
    const root=join(this.config.root,'accounts',account.id);mkdirSync(root,{recursive:true,mode:0o700});new Vault(root);
    this.registry.accounts.push(account);this.persist();return this.public(account);
  }
  bind(account,ctx) {
    const wallet=address(ctx.address);
    check(!account.expectedAddress||sameAddress(account.expectedAddress,wallet),'ACCOUNT_WALLET_MISMATCH','Connected wallet differs from the expected account wallet');
    check(!account.walletAddress||sameAddress(account.walletAddress,wallet),'ACCOUNT_WALLET_MISMATCH','Account wallet changed; original operations remain bound to the original wallet');
    check(!this.registry.accounts.some(a=>a.id!==account.id&&sameAddress(a.walletAddress,wallet)),'DUPLICATE_WALLET','This wallet is already bound to another account');
    if(!account.walletAddress){account.walletAddress=wallet;account.lastConnectedAt=Date.now();this.persist();}
  }
  open(account,injected={}) {
    if(this.runtimes.has(account.id))return this.runtimes.get(account.id);
    const root=account.legacy?this.config.root:join(this.config.root,'accounts',account.id);
    mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
    const config={...this.config,root,dbPath:account.legacy?this.config.dbPath:join(root,'state.sqlite'),accountId:account.id,
      deviceProfile:account.deviceProfile,deviceProfileVersion:account.deviceProfileVersion};
    if(!account.legacy){
      new Vault(root);
      config.walletTransport='direct';config.sessionOptions={directory:root,keyPath:join(root,'vault.key'),initialClientId:account.id.slice('account-'.length),
        keychainService:'codex-project-wallet',keychainAccount:this.registry.installationId+':'+account.id};
    }
    const wallet=injected.wallet||this.walletFactory?.(config,account)||(config.walletTransport==='cli'?new BawAdapter(config):new DirectBawAdapter(config));
    const store=injected.store||new Store(config.dbPath,{accountId:account.id,deviceProfileVersion:account.deviceProfileVersion});
    store.scope={accountId:account.id,deviceProfileVersion:account.deviceProfileVersion};
    const engine=new Engine({store,wallet,chain:this.chain,config});engine.observeContext=ctx=>this.bind(account,ctx);
    const runtime={account,config,store,wallet,engine};this.runtimes.set(account.id,runtime);return runtime;
  }
  get(selector){return this.open(this.resolve(selector));}
  annotate(value,account) {
    if(Array.isArray(value))return value.map(x=>this.annotate(x,account));
    if(value&&typeof value==='object')return {...value,accountId:account.id,...(account.walletAddress?{walletAddress:account.walletAddress}:{})};
    return value;
  }
  async dispatch(method,params={},selector) {
    check(params.accountId===undefined&&params.accountIds===undefined,'INVALID_ACCOUNT_SELECTION','Use the top-level accountId or CLI --account; multi-account selection belongs in batch.plan');
    check(params.batchId===undefined&&params.request?.batchId===undefined,'BATCH_EXECUTION_REQUIRED','Batch IDs are assigned internally by batch.plan');
    if(method==='account.add')return this.add(params);
    if(method==='accounts')return this.list();
    if(method==='account.update')return this.update(selector,params);
    if(method==='account.info')return this.public(this.resolve(selector));
    const runtime=this.get(selector);
    const actual=method==='account.connect'?'connect':method==='account.status'?'status':method==='account.pairing'?'pairing':method;
    const value=await runtime.engine.dispatch(actual,params);
    if(actual==='connect') {
      const bind=async()=>{if((await runtime.wallet.status(true)).status==='CONNECTED')runtime.engine.bindContext(await runtime.wallet.context({fresh:true}));};
      if(value.state==='CONNECTED')await bind();
      else if(runtime.wallet.verifyTask)runtime.wallet.verifyTask=runtime.wallet.verifyTask.then(bind).catch(error=>{
        if(runtime.wallet.pairing){runtime.wallet.pairing.state='FAILED';runtime.wallet.pairing.error={code:error.code||'PAIRING_FAILED',message:error.message};}
      });
    }
    return this.annotate(value,runtime.account);
  }
  async close(){if(this.closed)return;this.closed=true;
    await Promise.all([...this.runtimes.values()].map(async r=>{
      await r.wallet.verifyTask;await r.engine.mutex.tail;r.store.close();await r.wallet.close?.();
    }));
  }
}
