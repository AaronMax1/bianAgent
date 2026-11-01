import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { call, callSocket, ensureServer } from './client.mjs';
import { loadConfig } from './config.mjs';
import { check, json, publicError } from './util.mjs';

const staticFiles={
  '/':['../web/index.html','text/html; charset=utf-8'],
  '/app.js':['../web/app.js','text/javascript; charset=utf-8'],
  '/style.css':['../web/style.css','text/css; charset=utf-8']
};
const cleanPairing=async value=>({state:value.state||'NONE',expireAt:value.expireAt,pairingCode:value.pairingCode,
  ...(value.urlForWeb?{qrDataUrl:await QRCode.toDataURL(value.urlForWeb,{width:320,margin:2,errorCorrectionLevel:'M'})}:{}),
  ...(value.error?{error:{code:value.error.code,message:value.error.message}}:{})});
export async function startWebServer({config=loadConfig(),port=config.webPort??4173,invoke=(method,params,accountId)=>call(config,method,params,accountId),health=()=>callSocket(config,'/health')}={}) {
  const csrf=randomBytes(32).toString('hex');
  let origin;
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send=(status,data)=>{res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.end(json(data));};
    try{
      const actualPort=server.address().port;
      check([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(req.headers.host),'WEB_ORIGIN_DENIED','Use the local dashboard address');
      check(!req.headers.origin||[`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`].includes(req.headers.origin),'WEB_ORIGIN_DENIED','Cross-origin requests are blocked');
      check(!['cross-site'].includes(req.headers['sec-fetch-site']),'WEB_ORIGIN_DENIED','Cross-site requests are blocked');
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&staticFiles[url.pathname]){
        const [file,mime]=staticFiles[url.pathname];res.setHeader('content-type',mime);res.end(readFileSync(new URL(file,import.meta.url)));return;
      }
      if(req.method==='GET'&&url.pathname==='/api/health'){
        const backend=await health();send(200,{success:true,data:{app:'codex-wallet-web',pid:process.pid,backend}});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/session'){send(200,{success:true,data:{csrf}});return;}
      if(!['GET','POST','PATCH'].includes(req.method)){send(405,{success:false,error:{code:'METHOD_NOT_ALLOWED',message:'Method not allowed'}});return;}
      let body={};
      if(req.method!=='GET'){
        const supplied=Buffer.from(req.headers['x-wallet-csrf']||'');
        check(supplied.length===csrf.length&&timingSafeEqual(supplied,Buffer.from(csrf)),'WEB_CSRF_DENIED','Refresh the page and retry');
        check(String(req.headers['content-type']||'').split(';')[0]==='application/json','INVALID_ARGUMENTS','Expected JSON');
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;check(size<=8192,'REQUEST_TOO_LARGE','Request exceeds 8 KiB');chunks.push(chunk);}
        try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{check(false,'INVALID_ARGUMENTS','Invalid JSON');}
        check(body&&typeof body==='object'&&!Array.isArray(body),'INVALID_ARGUMENTS','Expected an object');
      }
      let result;
      if(req.method==='GET'&&url.pathname==='/api/overview')result=await invoke('dashboard.snapshot',{});
      else if(req.method==='POST'&&url.pathname==='/api/accounts'){
        check(Object.keys(body).every(k=>['alias','displayName','notes','expectedAddress'].includes(k)),'INVALID_ARGUMENTS','Unexpected account field');
        result=await invoke('account.add',body);
      }else{
        const match=/^\/api\/accounts\/([^/]+)(?:\/(status|connect|pairing))?$/.exec(url.pathname);
        check(match,'NOT_FOUND','Unknown endpoint');const accountId=decodeURIComponent(match[1]),action=match[2];
        check(accountId.length<=100,'INVALID_ACCOUNT','Invalid account');
        if(req.method==='PATCH'&&!action)result=await invoke('account.update',body,accountId);
        else if(req.method==='POST'&&action==='connect'){
          check(Object.keys(body).length===0,'INVALID_ARGUMENTS','Unexpected login fields');
          result=await cleanPairing(await invoke('account.connect',{},accountId));
        }else if(req.method==='GET'&&action==='pairing')result=await cleanPairing(await invoke('account.pairing',{},accountId));
        else if(req.method==='GET'&&action==='status'){
          const s=await invoke('account.status',{},accountId);
          result={walletStatus:s.walletStatus,address:s.address,observedAt:s.observedAt,
            sessionExpireTime:s.settings?.sessionExpireTime,quotaLeft:s.settings?.quotaLeft};
        }else check(false,'NOT_FOUND','Unknown endpoint');
      }
      send(200,{success:true,data:result});
    }catch(error){
      const status=error.code==='NOT_FOUND'?404:['WEB_ORIGIN_DENIED','WEB_CSRF_DENIED'].includes(error.code)?403:error.code==='REQUEST_TOO_LARGE'?413:400;
      send(status,{success:false,error:publicError(error)});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  return {server,url:origin,close:()=>new Promise(resolve=>server.close(resolve))};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const config=loadConfig(),lock=config.root+'/web.lock';let service,ownsLock=false;
  try{
    if(existsSync(lock)){
      const pid=Number(readFileSync(lock,'utf8'));let alive=false;
      try{process.kill(pid,0);alive=true;}catch(e){if(e.code!=='ESRCH')throw e;}
      check(!alive,'WEB_RUNNING','Dashboard is already running');unlinkSync(lock);
    }
    const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);ownsLock=true;
    await ensureServer(config);service=await startWebServer({config});
    const close=async()=>{await service.close();if(existsSync(lock))unlinkSync(lock);process.exit(0);};
    process.once('SIGTERM',close);process.once('SIGINT',close);
    process.stdout.write(json({url:service.url})+'\n');
  }catch(error){if(ownsLock&&existsSync(lock))unlinkSync(lock);process.stderr.write(json(publicError(error))+'\n');process.exitCode=1;}
}
