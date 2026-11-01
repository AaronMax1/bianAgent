import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { json, check } from './util.mjs';

export function callSocket(config,path,body,timeout=90000) {
  return new Promise((resolve,reject)=>{
    const req=request({socketPath:config.socket,path,method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{}},res=>{
      let s='';res.setEncoding('utf8');res.on('data',c=>{s+=c;});res.on('end',()=>{try{resolve(JSON.parse(s));}catch{reject(new Error('Invalid local service response'));}});
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('Local request timed out; check the same operation before retrying')));
    req.on('error',reject);if(body)req.write(json(body));req.end();
  });
}
export async function ensureServer(config) {
  try {const r=await callSocket(config,'/health');if(r.ok)return r;}catch{}
  const log=openSync(config.root+'/service.log','a',0o600);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{detached:true,stdio:['ignore',log,log],env:{...process.env,CODEX_WALLET_HOME:config.root}});
  child.unref();closeSync(log);
  for(let i=0;i<40;i++){
    await new Promise(r=>setTimeout(r,100));
    try {const r=await callSocket(config,'/health');if(r.ok)return r;}catch{}
  }
  throw new Error('Local service did not start; inspect '+config.root+'/service.log');
}
export async function call(config,method,params={},accountId) {
  if(accountId!==undefined)check(typeof accountId==='string'&&accountId.length>0,'INVALID_ACCOUNT','Provide a nonempty account ID or alias');
  const health=await ensureServer(config);
  if(accountId!==undefined||method==='accounts'||method.startsWith('account.')||method==='batches'||method.startsWith('batch.'))
    check(health.multiAccount===true,'SERVICE_UPGRADE_REQUIRED','Stop the old service before using account selection; it cannot route accounts safely');
  const r=await callSocket(config,'/call',{method,params,...(accountId!==undefined?{accountId}:{})});
  if(!r.success)throw Object.assign(new Error(r.error?.message||'Local service error'),r.error);
  return r.data;
}
