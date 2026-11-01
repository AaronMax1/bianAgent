import { createECDH } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { BawAdapter } from './baw.mjs';
import { BinanceApi } from './binance-api.mjs';
import { Cache,check,fail,epochMs,address } from './util.mjs';
import { realDeviceProfile } from './device-profile.mjs';

const iso=value=>{const n=epochMs(value);return Number.isFinite(n)?new Date(n).toISOString():null;};
const num=value=>Number.parseFloat(value)||0;
export function normalizeSettings(settings,limits,query) {
  const quotaUsed=num(limits.quotaUsed),dailyLimit=num(settings.dailyLimit);
  const predictionUsed=num(limits.predictionQuotaUsed),predictionLimit=num(settings.predictionDailyLimit);
  const defiUsed=num(limits.defiQuotaUsed),defiLimit=num(settings.defiDailyLimit);
  const x402Used=num(limits.x402QuotaUsed),x402Limit=num(settings.x402DailyLimit);
  return{
    maxSigninDuration:settings.autoLogout,dailyLimit,abnormalTxnHandling:settings.riskyTxnHandling,
    inactiveSignoutDuration:settings.inactiveSignoutDuration,tradeAllTokens:settings.tradeAllTokens,
    predictionEnabled:settings.predictionEnabled,predictionDailyLimit:predictionLimit,predictionQuotaUsed:predictionUsed,predictionQuotaLeft:predictionLimit-predictionUsed,predictionQuotaDate:limits.predictionDate,
    defiDailyLimit:defiLimit,defiQuotaUsed:defiUsed,defiQuotaLeft:defiLimit-defiUsed,defiQuotaDate:limits.defiDate,
    x402DailyLimit:x402Limit,x402QuotaUsed:x402Used,x402QuotaLeft:x402Limit-x402Used,x402QuotaDate:limits.x402Date,
    developerModeQuotaUsed:limits.developerModeQuotaUsed==null?null:num(limits.developerModeQuotaUsed),developerModeQuotaDate:limits.developerModeDate??null,
    quotaUsed,quotaLeft:dailyLimit-quotaUsed,quotaDate:limits.date,
    devMode:settings.devMode?{enabled:settings.devMode.enabled??false,expiresAt:iso(settings.devMode.expiresAt),dailyLimit:num(settings.devMode.dailyLimit),balanceExceeded:settings.devMode.balanceExceeded??false}:null,
    sessionExpireTime:iso(query.sessionExpireTime),signInMaxTime:iso(query.signInMaxTime),inactiveSignOutTime:iso(query.inactiveSignOutTime)
  };
}
function arg(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
export class DirectBawAdapter extends BawAdapter {
  queryCache=new Cache();
  marketCache=new Cache();
  constructor(config,options={}) {
    super(config);this.api=options.api||new BinanceApi(config,options);this.transport='direct-http';
    this.deviceProfile=config.deviceProfile||this.api.deviceProfile||realDeviceProfile();
  }
  status(fresh=false){if(fresh)this.queryCache.clear();return super.status(fresh);}
  query(){return this.queryCache.get('query',500,()=>this.api.call('query'));}
  async run(args) {
    const started=performance.now();
    try{return await this.directRun(args);}
    finally{
      this.timings.push({command:args.slice(0,2).join(' '),transport:'direct-http',ms:Math.round(performance.now()-started),at:Date.now()});
      if(this.timings.length>100)this.timings.shift();
    }
  }
  async directRun(args) {
    const [group,command]=args;
    if(group==='market-order') {
      if(command==='list') {
        const result=await this.api.call('marketOrders',{orderId:arg(args,'--orderId'),page:1,pageSize:1});
        return {total:result.total,list:(result.rows||[]).map(r=>{
          let refund;try{const raw=JSON.parse(r.extend||'{}').refund;if(Array.isArray(raw))refund=raw.filter(x=>x&&typeof x.amount==='string'&&/^\d+(?:\.\d+)?$/.test(x.amount)&&Number(x.amount)>0&&typeof x.symbol==='string');}catch{}
          return {orderId:String(r.orderId||r.id||''),chain:r.walletChainId||r.fromTokenChainId,fromToken:r.fromTokenAddress,toToken:r.toTokenAddress,fromTokenQty:r.fromTokenQty,toTokenActualQty:r.toTokenActualQty,status:r.status,txHash:r.orderTxId,errorCode:r.errorCode||r.code,message:r.message,...(refund?.length?{refund}:{})};
        })};
      }
      check(['quote','swap'].includes(command),'DIRECT_COMMAND_NOT_SUPPORTED','Unsupported market operation');
      const binanceChainId=arg(args,'--binanceChainId'),fromToken=address(arg(args,'--fromToken')),toToken=address(arg(args,'--toToken')),amount=arg(args,'--fromTokenQty'),slippage=arg(args,'--slippage');
      check(typeof amount==='string'&&/^\d+(?:\.\d+)?$/.test(amount)&&Number(amount)>0,'INVALID_AMOUNT','Invalid market amount');
      const fraction=slippage==='auto'||slippage===undefined?'auto':String(Number(slippage)/100);
      check(fraction==='auto'||Number.isFinite(Number(fraction))&&Number(fraction)>=0&&Number(fraction)<=1,'INVALID_SLIPPAGE','Invalid market slippage');
      const registry=await this.marketCache.get('rwa',300000,()=>this.api.call('rwaTokens'));
      check(!(registry||[]).some(t=>String(t.chainId)===String(binanceChainId)&&[fromToken,toToken].some(a=>String(t.contractAddress).toLowerCase()===a.toLowerCase())),'RWA_NOT_SUPPORTED','Tokenized securities require share/multiplier conversion; this direct market adapter handles ordinary crypto tokens only');
      const body={binanceChainId,fromToken,toToken,amount,slippage:fraction};
      if(command==='quote')return this.api.call('marketQuote',body);
      const mev=arg(args,'--mev')!=='false',gasLevel=arg(args,'--gasLevel')||'MEDIUM';
      check(['LOW','MEDIUM','HIGH'].includes(gasLevel),'INVALID_GAS_LEVEL','Invalid market gas level');
      const result=await this.api.call('marketPlace',{...body,mev,gasLevel});
      if(result.code&&result.code!=='000000') {
        const submissionEvidence=!!(result.orderId||result.txHash||result.orderTxId||['BROADCASTED','PENDING_CONFIRMATION','PENDING','FINISHED'].includes(result.status));
        fail('BINANCE_API_ERROR',result.message||'Order rejected',{apiCode:String(result.code),operation:'marketPlace',...(submissionEvidence?{submissionEvidence:true}:{}),...(result.orderId?{orderId:String(result.orderId)}:{})});
      }
      return {orderId:result.orderId,clientOrderId:result.clientOrderId};
    }
    if(group==='wallet') {
      if(command==='status') {
        if(!await this.api.hasSession())return{status:'UNCONNECTED'};
        try {const q=await this.query();return{status:q.connectionStatus!=='CONNECTED'?'UNCONNECTED':q.walletCreateStatus==='CREATED'?'CONNECTED':'CREATING'};}
        catch(e){if(['SESSION_EXPIRED','NOT_LOGGED_IN'].includes(e.code)){this.cache.clear();this.queryCache.clear();return{status:'UNCONNECTED'};}throw e;}
      }
      if(command==='settings') {
        const [s,l,q]=await Promise.all([this.api.call('settings'),this.api.call('limits'),this.query()]);
        return normalizeSettings(s,l,q);
      }
      if(command==='address') {
        const [wallets,networks]=await Promise.all([this.api.call('wallets'),this.api.call('networks')]);
        const names=new Map((networks||[]).map(x=>[String(x.binanceChainId),x.simpleName]));
        const addresses=(wallets?.[0]?.subWalletList||[]).flatMap(w=>(w.addresses||[]).map(a=>({binanceChainId:String(a.binanceChainId),chainName:names.get(String(a.binanceChainId))||String(a.binanceChainId),address:/^0x[a-f0-9]{40}$/i.test(a.address)?address(a.address.toLowerCase()):a.address})));
        return{addresses};
      }
      if(command==='chains') {
        const networks=await this.api.call('networks');
        return{chains:(networks||[]).map(n=>({binanceChainId:n.binanceChainId,chainName:n.simpleName}))};
      }
      if(command==='tx-lock')return this.api.call('lock',{binanceChainId:arg(args,'--binanceChainId')});
      if(command==='tx-history') {
        const params={hideRisk:true,hideLowValue:true,binanceChainIds:arg(args,'--binanceChainId'),startTime:Number(arg(args,'--startTime')),size:Number(arg(args,'--size')||100)};
        const [p,c]=await Promise.all([this.api.call('pending',params),this.api.call('confirmed',params)]);
        const transactions=[...(p.list||[]),...(c.list||[])].map(t=>({
          txHash:t.txHash,binanceChainId:t.binanceChainId,txTime:iso(t.txTime),status:t.status,
          txHashList:(t.txHashList||[]).map(h=>({txHash:h.txHash,binanceChainId:h.binanceChainId,status:h.status}))
        }));
        return{transactions,hasMore:!!(p.nextToken||c.nextToken),nextCursor:null};
      }
    }
    if(group==='auth') {
      if(command==='signin') {
        if(await this.api.hasSession()) {
          try {const q=await this.query();if(q.connectionStatus==='CONNECTED'&&q.walletCreateStatus==='CREATED')return{status:'ALREADY_CONNECTED'};}
          catch(e){if(!['SESSION_EXPIRED','NOT_LOGGED_IN'].includes(e.code))throw e;}
        }
        await this.api.beginLogin();
        const key=createECDH('secp256k1');key.generateKeys();const publicKey=key.getPublicKey('hex','compressed').slice(2);
        const result=await this.api.call('login',{isFirstLogin:true,os:this.deviceProfile.osName,publicKeyHex:publicKey});
        check(result.connectionStatus==='UNCONNECTED'&&result.qrInfo,'PAIRING_INVALID','Binance returned no new pairing information');
        return{urlForWeb:result.qrInfo.qrCodeUrl,qrCodeId:result.qrInfo.qrCodeId,expireAt:result.qrInfo.expireAt,pairingCode:publicKey.slice(0,3)+publicKey.slice(-3)};
      }
      if(command==='verify') {
        const deadline=Math.min(this.pairing?.expireAt||Date.now()+300000,Date.now()+300000);
        let confirmed=false;
        while(Date.now()<deadline) {
          if(!confirmed) {const result=await this.api.call('loginConfirm',{qrCodeId:arg(args,'--qrCodeId')});confirmed=result.connectionStatus==='CONNECTED';}
          if(confirmed) {
            const q=await this.api.call('query');
            check(q.connectionStatus!=='UNCONNECTED','SESSION_EXPIRED','Binance authorization expired during wallet creation');
            if(q.connectionStatus==='CONNECTED'&&q.walletCreateStatus==='CREATED'){
              await this.api.commit();this.queryCache.clear();this.cache.clear();return{status:'SUCCESS'};
            }
          }
          await new Promise(r=>setTimeout(r,2000));
        }
        fail('AUTH_REJECTED','QR code does not exist or expired, please try a new code or restart the log in process.');
      }
    }
    if(group==='contract-call') {
      if(command==='preview')return this.api.call('preview',{binanceChainId:arg(args,'--binanceChainId'),from:arg(args,'--from'),to:arg(args,'--to'),value:arg(args,'--value'),inputData:arg(args,'--inputData'),...(arg(args,'--gasLimit')===undefined?{}:{gasLimit:Number(arg(args,'--gasLimit'))})});
      if(command==='execute')return this.api.call('execute',{requestId:arg(args,'--requestId')});
    }
    if(group==='sign-message') {
      if(command==='preview')return this.api.call('messagePreview',{binanceChainId:arg(args,'--binanceChainId'),message:arg(args,'--message'),signType:arg(args,'--signType')});
      if(command==='execute')return this.api.call('messageExecute',{requestId:arg(args,'--requestId')});
      if(command==='result')return this.api.call('messageResult',{orderId:arg(args,'--order-id')});
    }
    fail('DIRECT_COMMAND_NOT_SUPPORTED','This command is not implemented in the reviewed direct API adapter');
  }
  async close(){await this.api.close();}
}
