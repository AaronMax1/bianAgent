import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { openSync,closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check } from './util.mjs';

export async function ensureWebServer(config) {
  const port=config.webPort??4173;check(Number.isSafeInteger(port)&&port>=1024&&port<=65535,'INVALID_WEB_PORT','webPort must be 1024–65535');
  const url=`http://127.0.0.1:${port}`;
  const probe=()=>new Promise((resolve,reject)=>{
    const req=request(url+'/api/health',res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{const v=JSON.parse(body);check(v.data?.app==='codex-wallet-web','WEB_PORT_BUSY','Port belongs to another application');resolve(v.data);}catch(e){reject(e);}});});
    req.setTimeout(1500,()=>req.destroy(new Error('Dashboard health timed out')));req.on('error',reject);req.end();
  });
  try{return {url,...await probe()};}catch(e){if(e.code==='WEB_PORT_BUSY')throw e;}
  const log=openSync(config.root+'/web.log','a',0o600);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./web-server.mjs',import.meta.url))],{detached:true,stdio:['ignore',log,log],env:{...process.env,CODEX_WALLET_HOME:config.root}});
  child.unref();closeSync(log);
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,150));try{return {url,...await probe()};}catch(e){if(e.code==='WEB_PORT_BUSY')throw e;}}
  throw new Error('Dashboard did not start; inspect '+config.root+'/web.log');
}
