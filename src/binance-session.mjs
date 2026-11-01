import { createDecipheriv,createCipheriv,pbkdf2,randomBytes,randomUUID,createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { networkInterfaces,userInfo,homedir } from 'node:os';
import { join,dirname,isAbsolute } from 'node:path';
import { readFileSync,realpathSync,existsSync,statSync,mkdirSync,writeFileSync,renameSync,chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { check,Mutex } from './util.mjs';

export const SUPPORTED_CLI={version:'1.12.0',sha256:'e63e2dff4a6d267d2375a0bbcdf518f10ddd04b0ffaff378c265a26f0961fe4f'};
export function deviceIdentity() {
  for(const list of Object.values(networkInterfaces()))for(const n of list||[])
    if(!n.internal&&n.family==='IPv4'&&n.mac!=='00:00:00:00:00:00')return n.mac;
  return userInfo().username;
}
export function findCliPackage(config={}) {
  let root=config.bawPackageRoot;
  if(!root) {
    const bin=config.bawBin||'baw';
    const path=isAbsolute(bin)?bin:(process.env.PATH||'').split(':').map(p=>join(p,bin)).find(existsSync);
    check(path,'CLI_NOT_FOUND','Install the compatible official baw CLI to provide its session storage');
    root=dirname(dirname(realpathSync(path)));
  }
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  check(pkg.name==='@binance/agentic-wallet'&&pkg.version===SUPPORTED_CLI.version,'CLI_COMPATIBILITY','Direct API adapter requires reviewed baw CLI '+SUPPORTED_CLI.version);
  const hash=createHash('sha256').update(readFileSync(join(root,'dist/index.js'))).digest('hex');
  check(hash===SUPPORTED_CLI.sha256,'CLI_COMPATIBILITY','Official CLI build changed; review API/session compatibility before using direct mode');
  return root;
}
const derive=promisify(pbkdf2);
export class BinanceSession {
  #clientId='';#sessionId='';#pending='';#invalid='';#key;#file={};#stamp='';#keytar;#initialized=false;#commits=new Mutex();
  constructor(config={},options={}) {
    options={...config.sessionOptions,...options};
    this.directory=options.directory||process.env.BINANCE_BAW_DIR||join(homedir(),'.baw');
    this.path=join(this.directory,'session.json');
    this.identity=options.identity||process.env.BINANCE_INSTANCE_ID||deviceIdentity();
    this.keyPath=options.keyPath;
    this.keychainService=options.keychainService||'baw';
    this.keychainAccount=options.keychainAccount||'agentSessionId';
    this.initialClientId=options.initialClientId;
    if('keytar'in options)this.#keytar=options.keytar;
    else { const root=findCliPackage(config);try{const req=createRequire(join(root,'package.json'));this.#keytar=req('@github/keytar');}catch{this.#keytar=null;} }
  }
  async initialize() {
    if(!this.#initialized) {
      this.#key=this.keyPath?readFileSync(this.keyPath):await derive(this.identity,'baw-agentic-wallet-v1:'+this.identity,100000,32,'sha256');
      check(this.#key.length===32,'INVALID_VAULT','Invalid session encryption key');
      this.#initialized=true;
    }
    this.reloadFile();
  }
  decrypt(value) {
    try {
      const b=Buffer.from(value,'base64');
      if(b.length<33)return'';
      const c=createDecipheriv('aes-256-gcm',this.#key,b.subarray(0,16));c.setAuthTag(b.subarray(-16));
      return Buffer.concat([c.update(b.subarray(16,-16)),c.final()]).toString('utf8');
    }catch{return'';}
  }
  encrypt(value) {
    const iv=randomBytes(16),c=createCipheriv('aes-256-gcm',this.#key,iv);
    return Buffer.concat([iv,c.update(value,'utf8'),c.final(),c.getAuthTag()]).toString('base64');
  }
  reloadFile() {
    let stamp='';
    if(existsSync(this.path)){const s=statSync(this.path);stamp=s.mtimeMs+':'+s.size;}
    if(stamp===this.#stamp&&this.#clientId)return;
    this.#stamp=stamp;
    this.#file=stamp?JSON.parse(readFileSync(this.path,'utf8')):{};
    const encoded=this.#file.clientId||'';
    const client=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(encoded)?encoded:this.decrypt(encoded);
    check(!encoded||client,'SESSION_READ_FAILED','Cannot decode this device’s baw client identity; use the original environment');
    if(this.#clientId&&client!==this.#clientId){this.#pending='';this.#sessionId='';this.#invalid='';}
    this.#clientId=client;
    this.#sessionId=this.#file.sessionId?this.decrypt(this.#file.sessionId):'';
  }
  async credentials() {
    await this.initialize();
    let session=this.#sessionId;
    if(this.#keytar) {
      try { session=(await this.#keytar.getPassword(this.keychainService,this.keychainAccount))||session; }
      catch { /* Official CLI falls back to its encrypted file when keychain is unavailable. */ }
    }
    session=this.#pending||session;
    if(session===this.#invalid)session='';
    check(!this.#clientId||/^[0-9a-f-]{36}$/i.test(this.#clientId),'SESSION_READ_FAILED','Invalid stored client identity');
    check(!session||/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(session),'SESSION_READ_FAILED','Invalid stored session cookie');
    return{clientId:this.#clientId,sessionId:session};
  }
  writeFile() {
    mkdirSync(this.directory,{recursive:true,mode:0o700});chmodSync(this.directory,0o700);
    const temp=this.path+'.'+randomUUID()+'.tmp';
    writeFileSync(temp,JSON.stringify(this.#file,null,2),{mode:0o600,flag:'wx'});renameSync(temp,this.path);chmodSync(this.path,0o600);
    const s=statSync(this.path);this.#stamp=s.mtimeMs+':'+s.size;
  }
  async beginLogin() {
    await this.initialize();
    if(!this.#clientId){
      const previous=await this.credentials();this.#invalid=previous.sessionId;
      this.#clientId=this.initialClientId||randomUUID();this.#file.clientId=this.encrypt(this.#clientId);this.writeFile();
    }
    return this.#clientId;
  }
  stageCookie(value) {
    check(typeof value==='string'&&/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(value),'SESSION_COOKIE_INVALID','Invalid session cookie from Binance');
    this.#pending=value;
  }
  commit() {
    return this.#commits.run(async()=>{
      if(!this.#pending)return;
      const pending=this.#pending;
      let saved=false;
      if(this.#keytar) {
        try { await this.#keytar.setPassword(this.keychainService,this.keychainAccount,pending);saved=true; }
        catch { /* Store with the CLI's authenticated encryption format. */ }
      }
      if(!saved){this.reloadFile();this.#file.sessionId=this.encrypt(pending);this.writeFile();}
      this.#sessionId=pending;
      // A newer response may have staged another cookie while keychain I/O was pending.
      if(this.#pending===pending)this.#pending='';
    });
  }
  async invalidate(expectedSession) {
    const expired=expectedSession??(await this.credentials()).sessionId;
    this.#invalid=expired;
    if(this.#pending===expired)this.#pending='';
  }
}
