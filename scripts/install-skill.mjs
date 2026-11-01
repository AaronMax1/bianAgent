import { homedir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync,mkdirSync,existsSync,writeFileSync,readFileSync } from 'node:fs';
import { check } from '../src/util.mjs';
const packageRoot=fileURLToPath(new URL('../',import.meta.url));
const destination=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'skills','codex-project-wallet');
if(existsSync(destination)) {
  const marker=join(destination,'installation.json');
  check(existsSync(marker)&&JSON.parse(readFileSync(marker,'utf8')).managedBy==='codex-project-wallet','SKILL_EXISTS','Existing skill is not managed by this installer');
}
mkdirSync(destination,{recursive:true});
cpSync(join(packageRoot,'skills/codex-project-wallet'),destination,{recursive:true});
writeFileSync(join(destination,'installation.json'),JSON.stringify({managedBy:'codex-project-wallet',packageRoot},null,2)+'\n',{mode:0o600});
const root=resolve(process.env.CODEX_WALLET_HOME||join(homedir(),'.local/share/codex-project-wallet'));
mkdirSync(root,{recursive:true,mode:0o700});
const configPath=join(root,'config.json');
if(!existsSync(configPath)) {
  const proxyIndex=process.argv.indexOf('--proxy');
  writeFileSync(configPath,JSON.stringify({proxy:proxyIndex>=0?process.argv[proxyIndex+1]:'',bawBin:process.env.BAW_BIN||'baw'},null,2)+'\n',{mode:0o600});
}
console.log(JSON.stringify({installed:destination,launcher:join(destination,'scripts/wallet.mjs'),runtime:root}));
