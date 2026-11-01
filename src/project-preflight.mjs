import { performance } from 'node:perf_hooks';
import { Interface,keccak256 } from 'ethers';
import { projectUrl } from './projects.mjs';
import { check,sameAddress,publicError } from './util.mjs';

// Reviewed deployment facts are reusable. Availability is always read from the chain.
export const AGENT_SHIFT=Object.freeze({
  id:'agentshift-genesis',name:'Agent Shift Genesis',origin:'https://agentshift.lol',chainId:56,
  contract:'0x4c5F33653F447229E85e52A238Da826f1B3299fa',
  codeHash:'0xe9c618978e726ba7b7c1a0de2f7cba0aebdaf04a194d6ae32bc47b2ddda86d43',
  verifier:'0x26cDD4Dd417BB999e5a8fceDB053F13209d84f78',maxSupply:'4444',reviewedAt:'2026-10-30',
  source:'https://agentshift.lol/agent-guide.md'
});
const abi=new Interface([
  'function totalMinted() view returns(uint256)','function MAX_SUPPLY() view returns(uint256)',
  'function mintOpen() view returns(bool)','function challengeSigner() view returns(address)'
]);
export function assessAgentShift({hash,minted,max,open,verifier}) {
  check(hash===AGENT_SHIFT.codeHash,'PROJECT_CODE_CHANGED','Genesis runtime code changed; review the project before continuing');
  check(sameAddress(verifier,AGENT_SHIFT.verifier),'PROJECT_VERIFIER_CHANGED','Genesis verifier changed; review the project before continuing');
  check(typeof minted==='bigint'&&typeof max==='bigint'&&String(max)===AGENT_SHIFT.maxSupply&&minted>=0n&&minted<=max&&typeof open==='boolean','PROJECT_STATE_INVALID','Genesis supply or availability response is inconsistent');
  return {status:minted===max?'SOLD_OUT':open?'AVAILABLE':'CLOSED',supply:{minted:String(minted),max:String(max),remaining:String(max-minted),mintOpen:open}};
}
function priorResearch(store,url) {
  return store.projects().filter(p=>p.sources?.some(s=>{try{return new URL(s.url).origin===url.origin;}catch{return false;}}))
    .slice(0,2).map(p=>({id:p.id,name:p.name,summary:String(p.summary||'').slice(0,700),
      sources:p.sources.map(s=>({url:s.url})),unverified:p.unverified,updatedAt:p.updatedAt,untrusted:true}));
}
export async function projectPreflight({url,chain,store}) {
  const started=performance.now(),u=projectUrl(url),timings=[];
  async function stage(name,fn) {
    const t=performance.now();try{return await fn();}finally{timings.push({stage:name,ms:Math.round(performance.now()-t)});}
  }
  const report={url:u.href,mode:'read-only',observedAt:Date.now(),timings,executionAttempted:false};
  const finish=value=>({...report,...value,totalMs:Math.round(performance.now()-started)});
  if(u.origin!==AGENT_SHIFT.origin||u.pathname!=='/'||u.search||!['','#genesis'].includes(u.hash)) {
    return finish({status:'UNADAPTED',priorResearch:priorResearch(store,u),
      nextStep:'Check the requested action, chain, availability and price from official sources first. Reuse prior research as context; refresh live facts before preparing anything.'});
  }
  report.project=AGENT_SHIFT.name;report.adapter=AGENT_SHIFT.id;
  report.deployment={chainId:AGENT_SHIFT.chainId,contract:AGENT_SHIFT.contract,reviewedAt:AGENT_SHIFT.reviewedAt};
  report.sources=[{url:AGENT_SHIFT.source}];
  try {
    check(chain.config.chainId===AGENT_SHIFT.chainId,'WRONG_CHAIN','Project requires BSC chain 56');
    const block=await stage('chain.snapshot',()=>chain.snapshot());
    const results=await Promise.allSettled([
      stage('chain.codeHash',()=>chain.rpc('eth_getCode',[AGENT_SHIFT.contract,block.tag]).then(keccak256)),
      ...['totalMinted','MAX_SUPPLY','mintOpen','challengeSigner'].map(name=>stage('chain.'+name,()=>chain.call(AGENT_SHIFT.contract,abi,name,[],block.tag).then(r=>r[0])))
    ]);
    const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
    const [hash,minted,max,open,verifier]=results.map(r=>r.value);
    const {status,supply}=assessAgentShift({hash,minted,max,open,verifier});
    await stage('chain.canonicalBlock',()=>chain.verifySnapshot(block));
    report.block={number:block.number,hash:block.hash};report.deployment.codeHash=hash;
    report.supply=supply;
    return finish({status,adapterScope:'availability-only',
      nextStep:status==='SOLD_OUT'?'Stop: supply is exhausted. No wallet login, eligibility checks, signature, interview or mint is needed.':
        status==='CLOSED'?'Stop: mint is closed. No signature or transaction is needed.':
        'Check wallet eligibility, then review the project-specific login/interview adapter. Generic SignIn does not support this project’s SessionAuthorization or StartAuthorization.'});
  }catch(e){return finish({status:'NEEDS_REVIEW',error:publicError(e),nextStep:'Resolve this check before login, signing or preparing a transaction. Do not assume the previous availability result is current.'});}
}
