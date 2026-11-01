import { randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { readFileSync,writeFileSync,mkdirSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { check,json } from './util.mjs';
export class Vault {
  constructor(root) {
    this.root=root;
    if(!root){this.key=randomBytes(32);return;}
    mkdirSync(root,{recursive:true,mode:0o700});
    const path=join(root,'vault.key');
    try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    chmodSync(path,0o600);this.key=readFileSync(path);
    check(this.key.length===32,'INVALID_VAULT','Invalid local vault encryption key');
  }
  seal(value) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    const data=Buffer.concat([cipher.update(json(value),'utf8'),cipher.final()]);
    return{iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex')};
  }
  open(value) {
    const cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(value.iv,'hex'));cipher.setAuthTag(Buffer.from(value.tag,'hex'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data,'hex')),cipher.final()]).toString('utf8'));
  }
  exportSignature(op) {
    check(this.root,'VAULT_PATH_REQUIRED','A persistent runtime directory is required');
    check(op.state==='SIGNED'&&op.messageResult,'SIGNATURE_UNAVAILABLE','No verified signature for this operation');
    const dir=join(this.root,'exports');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
    const path=join(dir,op.id+'.json');
    writeFileSync(path,json(this.open(op.messageResult))+'\n',{mode:0o600});chmodSync(path,0o600);
    return{path,origin:op.payload.origin,expiresAt:op.messageExpiry,note:'Sensitive signature file: consume only in the authorized project adapter, do not print; delete after use'};
  }
}
