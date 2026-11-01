import { Agent,Client,ProxyAgent,fetch } from 'undici';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BinanceSession,SUPPORTED_CLI } from './binance-session.mjs';
import { realDeviceProfile,deviceHeaders } from './device-profile.mjs';
import { check,fail } from './util.mjs';

const prefix='/bapi/defi/v1/public/wallet-direct/agent-wallet';
const dex='/bapi/defi/v1/public/wallet-direct/web-dex/agent';
// Override only CONNECT's destination when the local proxy's DNS is incorrect.
// The HTTPS URL, Host, TLS SNI and certificate verification remain www.binance.com.
export function binanceProxyClient(connectAddress,ClientType=Client) {
  check(isIP(connectAddress)===4,'INVALID_BINANCE_CONNECT_ADDRESS','binanceConnectAddress must be an IPv4 address');
  return (url,options)=>{
    const client=new ClientType(url,options),connect=client.connect.bind(client);
    client.connect=(params,callback)=>connect({...params,path:params.path==='www.binance.com:443'?connectAddress+':443':params.path},callback);
    return client;
  };
}
export const ENDPOINTS={
  query:{path:prefix+'/login/query',method:'GET',read:true},
  login:{path:prefix+'/login',method:'POST',auth:false},
  loginConfirm:{path:prefix+'/login/confirm',method:'POST',auth:false},
  settings:{path:prefix+'/settings/query',method:'GET',read:true},
  limits:{path:prefix+'/trading-limit/query',method:'GET',read:true},
  wallets:{path:prefix+'/mpc-wallet/list',method:'POST',read:true},
  networks:{path:'/bapi/defi/v1/public/wallet-direct/mgmt/agent/networks/active',method:'GET',read:true},
  lock:{path:prefix+'/order/tx-lock-status',method:'POST',read:true},
  pending:{path:'/bapi/defi/v2/public/wallet-direct/agent/tx-history-pending',method:'GET',read:true},
  confirmed:{path:'/bapi/defi/v2/public/wallet-direct/agent/tx-history-confirm',method:'GET',read:true},
  preview:{path:prefix+'/contract-call/preview',method:'POST'},
  execute:{path:prefix+'/contract-call/execute',method:'POST'},
  messagePreview:{path:prefix+'/sign-message/preview',method:'POST'},
  messageExecute:{path:prefix+'/sign-message/execute',method:'POST'},
  messageResult:{path:prefix+'/sign-message/result',method:'POST',read:true},
  marketQuote:{path:dex+'/quote',method:'POST',read:true},
  marketPlace:{path:dex+'/place-order',method:'POST'},
  marketOrders:{path:dex+'/batch-query-market-orders',method:'POST',read:true},
  rwaTokens:{path:'/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/scaleui/list',method:'GET',read:true}
};
export class BinanceApi {
  #session;#fetch;#dispatcher;
  timings=[];
  constructor(config,options={}) {
    this.#session=options.session||new BinanceSession(config);
    this.deviceProfile=config.deviceProfile||realDeviceProfile();
    this.#fetch=options.fetch||fetch;
    check(!config.binanceConnectAddress||config.proxy,'PROXY_REQUIRED','binanceConnectAddress requires the configured HTTP proxy');
    this.#dispatcher=config.proxy?new ProxyAgent({uri:config.proxy,connections:4,...(config.binanceConnectAddress?{clientFactory:binanceProxyClient(config.binanceConnectAddress)}:{})}):new Agent({connections:4,keepAliveTimeout:30000});
    this.timeout=config.apiTimeoutMs||20000;
  }
  async hasSession(){const c=await this.#session.credentials();return!!(c.sessionId&&c.clientId);}
  async beginLogin(){return this.#session.beginLogin();}
  async commit(){return this.#session.commit();}
  async call(name,body) {
    const spec=ENDPOINTS[name];check(spec,'ENDPOINT_NOT_ALLOWED','Unknown Binance API operation');
    for(let attempt=0;;attempt++){
      try{return await this.request(name,spec,body);}
      catch(e) {
        if(!spec.read||attempt>=1||!['NETWORK_ERROR','REQUEST_TIMEOUT','SERVICE_UNAVAILABLE'].includes(e.code))throw e;
        await new Promise(r=>setTimeout(r,Math.min(e.retryAfterMs||250,3000)));
      }
    }
  }
  async request(name,spec,body) {
    const c=await this.#session.credentials();
    if(spec.auth!==false)check(c.clientId&&c.sessionId,'NOT_LOGGED_IN','Binance wallet session is unavailable; connect in the Binance App');
    check(c.clientId,'NOT_LOGGED_IN','Binance client identity is unavailable; start pairing');
    const headers={
      'content-type':'application/json',agentClientId:c.clientId,...deviceHeaders(this.deviceProfile),
      'bnc-uuid':c.clientId,'x-trace-id':randomBytes(16).toString('hex'),
      version_code:SUPPORTED_CLI.version,clientVersion:SUPPORTED_CLI.version,
      agentClientType:'AGENT_CLI',agentClientVersion:SUPPORTED_CLI.version
    };
    if(c.sessionId)headers.Cookie='agentSessionId='+c.sessionId;
    let url='https://www.binance.com'+spec.path;
    if(spec.method==='GET'&&body){const query=new URLSearchParams(Object.entries(body).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>[k,String(v)]));if(query.size)url+='?'+query;}
    const started=performance.now();
    try{
      const response=await this.#fetch(url,{method:spec.method,headers,body:spec.method==='POST'&&body!==undefined?JSON.stringify(body):undefined,
        dispatcher:this.#dispatcher,redirect:'error',signal:AbortSignal.timeout(this.timeout)});
      if(!response.ok) {
        await response.body?.cancel();
        const status=response.status;
        const code=[401,403].includes(status)?'UNAUTHORIZED':[429,503].includes(status)?'SERVICE_UNAVAILABLE':[408,504].includes(status)?'REQUEST_TIMEOUT':'NETWORK_ERROR';
        const error=Object.assign(new Error('HTTP Status Code '+status),{code,details:{httpStatus:status},retryAfterMs:Number(response.headers.get('retry-after'))*1000});throw error;
      }
      const text=await response.text();check(text.length<=4*1024*1024,'API_RESPONSE_TOO_LARGE','Binance response exceeded size limit');
      let result;try{result=JSON.parse(text);}catch{fail('API_BAD_RESPONSE','Binance returned invalid JSON');}
      check(result&&typeof result==='object','API_BAD_RESPONSE','Binance returned an invalid response envelope');
      if(result.code!=='000000') {
        const apiCode=String(result.code);
        if(apiCode==='100001005')await this.#session.invalidate(c.sessionId);
        const submissionEvidence=!!(result.data?.txHash||result.data?.orderTxId||result.data?.orderId||['BROADCASTED','PENDING_CONFIRMATION','PENDING','FINISHED'].includes(result.data?.status));
        fail(apiCode==='100001005'?'SESSION_EXPIRED':'BINANCE_API_ERROR',typeof result.message==='string'?result.message:'Binance API rejected request',{apiCode,operation:name,...(submissionEvidence?{submissionEvidence:true,...(result.data?.orderId?{orderId:String(result.data.orderId)}:{})}:{})});
      }
      const cookie=response.headers.get('set-cookie')?.match(/(?:^|[;,]\s*)agentSessionId=([^;,\s]+)/)?.[1];
      if(cookie){
        this.#session.stageCookie(cookie);
        if(spec.auth!==false&&(name!=='query'||(result.data?.connectionStatus==='CONNECTED'&&result.data?.walletCreateStatus==='CREATED')))await this.#session.commit();
      }
      return result.data;
    }catch(e) {
      if(e.code)throw e;
      if(e.name==='TimeoutError'||e.name==='AbortError')fail('REQUEST_TIMEOUT','Binance API request timed out; execution outcome may be unknown');
      fail('NETWORK_ERROR','Binance API network request failed');
    }finally{
      this.timings.push({operation:name,transport:'direct-http',ms:Math.round(performance.now()-started),at:Date.now()});
      if(this.timings.length>100)this.timings.shift();
    }
  }
  async close(){await this.#dispatcher.close();}
}
