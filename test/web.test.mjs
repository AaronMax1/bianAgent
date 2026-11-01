import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startWebServer } from '../src/web-server.mjs';

test('dashboard serves local UI, gates mutations by origin and CSRF, and never forwards arbitrary wallet calls',async t=>{
  const calls=[];
  const web=await startWebServer({port:0,health:async()=>({ok:true,version:'0.3.0'}),invoke:async(method,params,accountId)=>{
    calls.push({method,params,accountId});
    if(method==='account.connect'||method==='account.pairing')return {state:'VERIFYING',urlForWeb:'https://example.com/binance-pairing',pairingCode:'123456',expireAt:Date.now()+30000};
    return {method,accountId};
  }});t.after(()=>web.close());
  const html=await fetch(web.url);assert.equal(html.status,200);assert((await html.text()).includes('Wallet Studio'));
  assert(html.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const csrf=(await (await fetch(web.url+'/api/session')).json()).data.csrf;
  const post=(path,body={},headers={})=>fetch(web.url+path,{method:'POST',headers:{'content-type':'application/json','x-wallet-csrf':csrf,...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/accounts',{alias:'a'},{'x-wallet-csrf':''})).status,403);
  assert.equal((await post('/api/accounts',{alias:'a'},{origin:'https://attacker.example'})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{const req=request(web.url+'/api/overview',{headers:{host:'attacker.example'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(wrongHost,403);
  assert.equal((await fetch(web.url+'/api/session',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await post('/api/call',{method:'submit'})).status,404);
  assert.equal((await post('/api/accounts',{alias:'a',deviceProfile:{}})).status,400);
  const added=await post('/api/accounts',{alias:'a',displayName:'账户 A'});assert.equal(added.status,200);
  const pairing=(await (await post('/api/accounts/a/connect')).json()).data;
  assert(pairing.qrDataUrl.startsWith('data:image/png;base64,'));assert.equal(pairing.urlForWeb,undefined);
  assert.equal(calls.at(-1).accountId,'a');
  assert.equal(calls.at(-1).method,'account.connect');
  const status=(await (await fetch(web.url+'/api/accounts/a/status')).json()).data;
  assert.equal(status.method,undefined);
});
