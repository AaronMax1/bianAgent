import { Interface,parseUnits,formatUnits,formatEther,ZeroAddress } from 'ethers';
import { check,address } from './util.mjs';

export const BNAGENT=Object.freeze({
  origin:'https://bnagent.onrender.com',chainId:56,
  mint:'0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0',
  token:'0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB',
  codeHash:'0x218f0b5649192cfc3e5b23c19781bc6316872fea6cb6826030978c04bfcb7fca'
});
const abi=new Interface([
  'function walletStatus(address) view returns(bool,uint256,uint256,uint256,bool)',
  'function paused() view returns(bool)','function mintableNow() view returns(uint256)',
  'function costOf(uint256) view returns(uint256)','function bnbQuote(uint256) view returns(uint256)'
]);
export async function bnagentMintRequest({chain,wallet,input}) {
  const u=new URL(input.url);
  check(u.origin===BNAGENT.origin&&u.pathname==='/'&&!u.search&&!u.hash,'PROJECT_NOT_SUPPORTED','Only the reviewed BNAGENT mint origin is supported');
  check(chain.config.chainId===56,'WRONG_CHAIN','BNAGENT requires BSC 56');
  const requested=input.shares==='max'?10:Number(input.shares);
  check(Number.isSafeInteger(requested)&&requested>=1&&requested<=10,'INVALID_SHARES','shares must be max or an integer from 1 to 10');
  const [status,paused,supply]=await Promise.all([
    chain.call(BNAGENT.mint,abi,'walletStatus',[address(wallet)]),
    chain.call(BNAGENT.mint,abi,'paused',[]),chain.call(BNAGENT.mint,abi,'mintableNow',[])
  ]);
  const available=status[3]>status[2]?status[3]-status[2]:0n;
  const shares=[BigInt(requested),available,supply[0]].reduce((a,b)=>a<b?a:b);
  const state={eligible:status[0],paused:paused[0],minted:String(status[2]),quota:String(status[3]),remaining:String(available),observedAt:Date.now()};
  if(!status[0]||paused[0]||shares===0n)return {status:!status[0]?'INELIGIBLE':paused[0]?'CLOSED':available===0n?'QUOTA_EXHAUSTED':'SOLD_OUT',...state};
  check(input.shares==='max'||shares===BigInt(requested),'INSUFFICIENT_QUOTA','Requested quantity exceeds remaining quota or supply');
  const [cost,quote]=await Promise.all([chain.call(BNAGENT.mint,abi,'costOf',[shares]),chain.call(BNAGENT.mint,abi,'bnbQuote',[shares])]);
  check(cost[0]>0n&&quote[0]>0n,'INVALID_QUOTE','Project returned an empty price');
  const value=quote[0]*102n/100n;
  return {status:'AVAILABLE',...state,shares:Number(shares),costUsdt:formatUnits(cost[0],18),costUsdtRaw:String(cost[0]),quoteBnb:formatEther(quote[0]),maxBnb:formatEther(value),
    priceLimitScope:'maxCostUsdt checks the current table price; maxValueWei caps the actual BNB payment. BNB/USD and the tier may move before inclusion.',
    request:{kind:'contract',idempotencyKey:input.idempotencyKey,label:'BNAGENT '+shares+' shares',to:BNAGENT.mint,expectedCodeHash:BNAGENT.codeHash,
      abi:['function mintWithBnb(uint256 shares,address referrer,uint256 maxCost) payable'],method:'mintWithBnb',args:[String(shares),ZeroAddress,String(value)],value:String(value),
      ...(input.gasLimit===undefined?{}:{gasLimit:input.gasLimit}),
      expected:{kind:'event',address:BNAGENT.token,abi:['event Transfer(address indexed from,address indexed to,uint256 value)'],event:'Transfer',args:{to:wallet}}}};
}
export function checkBnagentPrice(quote,maxCostUsdt) {
  check(typeof maxCostUsdt==='string'&&/^\d+(?:\.\d{1,18})?$/.test(maxCostUsdt),'PRICE_LIMIT_REQUIRED','Specify maxCostUsdt as a decimal string');
  check(BigInt(quote.costUsdtRaw)<=parseUnits(maxCostUsdt,18),'PRICE_LIMIT','Current table price exceeds the user limit');
}
