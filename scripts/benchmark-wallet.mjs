import { mkdirSync,writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { BawAdapter } from '../src/baw.mjs';
import { DirectBawAdapter } from '../src/baw-direct.mjs';
import { loadConfig } from '../src/config.mjs';
import { check,json,publicError } from '../src/util.mjs';

const config=loadConfig(),cli=new BawAdapter(config),direct=new DirectBawAdapter(config);
const report={startedAt:new Date().toISOString(),mode:'read-only',sequence:['cli','direct','direct','cli'],samples:[]};
try{
  // Establish the direct connection once; report cold start separately.
  let t=performance.now();check((await direct.status(true)).status==='CONNECTED','NOT_CONNECTED','Wallet must be connected');
  report.directColdStatusMs=Math.round(performance.now()-t);
  for(const mode of report.sequence) {
    const adapter=mode==='cli'?cli:direct;
    t=performance.now();const s=await adapter.status(true);const statusMs=performance.now()-t;
    check(s.status==='CONNECTED','NOT_CONNECTED','Wallet must remain connected');
    t=performance.now();const settings=await adapter.settings(true);const settingsMs=performance.now()-t;
    check(settings.devMode?.enabled,'DEV_MODE_REQUIRED','Developer Mode must remain active for comparison');
    report.samples.push({transport:mode,statusMs:Math.round(statusMs),settingsMs:Math.round(settingsMs),workflowMs:Math.round(statusMs+settingsMs)});
  }
  const avg=(mode,key)=>Math.round(report.samples.filter(s=>s.transport===mode).reduce((n,s)=>n+s[key],0)/2);
  report.averages={cli:{statusMs:avg('cli','statusMs'),settingsMs:avg('cli','settingsMs'),workflowMs:avg('cli','workflowMs')},direct:{statusMs:avg('direct','statusMs'),settingsMs:avg('direct','settingsMs'),workflowMs:avg('direct','workflowMs')}};
  report.workflowReductionPercent=Math.round((1-report.averages.direct.workflowMs/report.averages.cli.workflowMs)*100);
  report.directRequests=direct.api.timings;
  report.passed=true;
}catch(e){report.passed=false;report.error=publicError(e);process.exitCode=1;}
finally{await direct.close();}
report.completedAt=new Date().toISOString();
const output=fileURLToPath(new URL('../test-results/wallet-transport-benchmark.json',import.meta.url));
mkdirSync(fileURLToPath(new URL('../test-results/',import.meta.url)),{recursive:true});
writeFileSync(output,json(report)+'\n',{mode:0o600});
process.stdout.write(json(report)+'\n');
