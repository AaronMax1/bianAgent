import { mkdirSync,writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { call } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { check,json } from '../src/util.mjs';
// Explicitly read/preview only. This script never invokes confirm or sign-message execute.
const config=loadConfig();const report={startedAt:new Date().toISOString(),mode:'mainnet-read-and-preview-only',checks:[]};
async function run(name,method,params,verify){
  const t=performance.now();const result=await call(config,method,params);verify?.(result);
  report.checks.push({name,passed:true,ms:Math.round(performance.now()-t)});return result;
}
try{
  const status=await run('connected wallet','status',{},r=>check(r.walletStatus==='CONNECTED','NOT_CONNECTED','Connect wallet before live smoke'));
  report.wallet=status.address;report.chainId=status.chainId;report.walletTransport=status.walletTransport;
  await run('reuse active session','connect',{},r=>check(r.reused,'LOGIN_NOT_REUSED','Existing session should be reused'));
  const usdt='0x55d398326f99059fF775485246999027B3197955';
  const inspect=await run('BSC contract metadata','inspect',{contract:usdt},r=>check(r.hasCode&&r.metadata.decimals===18,'INSPECT_FAILED','Unexpected USDT deployment metadata'));
  report.block=inspect.block.number;
  const quote=await run('self-route native-to-USDT quote','quote',{tokenIn:'native',tokenOut:usdt,amount:'0.0001',slippageBps:100},r=>check(BigInt(r.minOutRaw)>0n,'QUOTE_FAILED','No minimum output'));
  report.quote={router:quote.router,path:quote.path,amountInRaw:quote.amountInRaw,expectedOutRaw:quote.expectedOutRaw,minOutRaw:quote.minOutRaw};
  const swap=await run('self-route swap calldata through Binance preview','prepare',{kind:'swap',idempotencyKey:'smoke-swap-'+randomUUID(),label:'Smoke swap preview only, never execute',tokenIn:'native',tokenOut:usdt,amount:'0.0001',slippageBps:100},r=>check(r.state==='AWAITING_USER'&&r.decoded.recipient===status.address&&!r.submission,'SWAP_PREVIEW_FAILED','Expected an unsubmitted self-route swap preview'));
  report.swapPreview={operationId:swap.id,state:swap.state,hasSimulation:!!swap.preview.simulationResult,minOutRaw:swap.quote.minOutRaw};
  await run('cancel unsubmitted swap preview','cancel',{id:swap.id},r=>check(r.state==='CANCELLED','CANCEL_FAILED','Swap preview should cancel locally'));
  const preview=await run('real Binance contract preview','prepare',{kind:'contract',idempotencyKey:'smoke-'+randomUUID(),label:'Read-only smoke: preview USDT zero-value approval, never execute',to:usdt,abi:['function approve(address spender,uint256 value) returns(bool)'],method:'approve',args:[config.router,'0'],value:'0'},r=>check(r.state==='AWAITING_USER'&&!r.submission,'PREVIEW_FAILED','Expected unsubmitted preview'));
  report.preview={operationId:preview.id,state:preview.state,hasParsedTx:!!preview.preview.parsedTx,hasSimulation:!!preview.preview.simulationResult,requireConfirmation:preview.preview.requireConfirmation};
  await run('cancel unsubmitted smoke preview','cancel',{id:preview.id},r=>check(r.state==='CANCELLED','CANCEL_FAILED','Preview should cancel locally'));
  await run('project research import','project.import',{name:'PancakeSwap V2 smoke research',sources:[{url:config.routeSource}],contracts:[config.router],summary:'Codex verified a deployed BSC V2 route and read-only quote. No real trade was executed.',unverified:['Project audit and current fees are outside this smoke check']});
  const metrics=await call(config,'metrics');report.walletTimings=metrics.timings;report.httpTimings=metrics.httpTimings;
  report.passed=true;report.completedAt=new Date().toISOString();
}catch(e){report.passed=false;report.error={code:e.code,message:e.message,details:e.details};process.exitCode=1;}
const output=fileURLToPath(new URL('../test-results/live-smoke.json',import.meta.url));
mkdirSync(fileURLToPath(new URL('../test-results/',import.meta.url)),{recursive:true});
writeFileSync(output,json(report)+'\n',{mode:0o600});
process.stdout.write(json({...report,report:output})+'\n');
