import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAgentShift,AGENT_SHIFT } from '../src/project-preflight.mjs';
import { fixture } from './helpers.mjs';

// Use a reviewed-code fixture hash without replacing production deployment pins.
const CODE='0x60006000';
function setup() {
  const f=fixture();f.chain.config={chainId:56};f.reads=[];
  f.chain.rpc=async()=>{f.reads.push('code');return CODE;};
  f.chain.call=async(_,__,name)=>{f.reads.push(name);return[{totalMinted:4444n,MAX_SUPPLY:4444n,mintOpen:true,challengeSigner:AGENT_SHIFT.verifier}[name]];};
  return f;
}
test('supply exhaustion takes precedence over the open switch; live changes are reevaluated',()=>{
  const state={hash:AGENT_SHIFT.codeHash,minted:4444n,max:4444n,open:true,verifier:AGENT_SHIFT.verifier};
  const full=assessAgentShift(state);assert.equal(full.status,'SOLD_OUT');assert.equal(full.supply.remaining,'0');
  assert.equal(assessAgentShift({...state,minted:4443n}).status,'AVAILABLE');
  assert.equal(assessAgentShift({...state,minted:4443n,open:false}).status,'CLOSED');
  assert.throws(()=>assessAgentShift({...state,max:5000n}),{code:'PROJECT_STATE_INVALID'});
  assert.throws(()=>assessAgentShift({...state,minted:4445n}),{code:'PROJECT_STATE_INVALID'});
  assert.throws(()=>assessAgentShift({...state,verifier:'0x1111111111111111111111111111111111111111'}),{code:'PROJECT_VERIFIER_CHANGED'});
});
test('known project code change stops research without touching wallet or creating operations',async t=>{
  const f=setup();t.after(()=>f.store.close());
  const r=await f.engine.dispatch('project.preflight',{url:AGENT_SHIFT.origin+'/#genesis'});
  assert.equal(r.status,'NEEDS_REVIEW');assert.equal(r.error.code,'PROJECT_CODE_CHANGED');
  assert.equal(r.executionAttempted,false);assert.equal(f.wallet.calls.length,0);assert.equal(f.store.scan().length,0);
});
test('lookalike origin and unrelated site paths do not run a known adapter or make network requests',async t=>{
  const f=setup();t.after(()=>f.store.close());
  for(const url of ['https://agentshift.lol.evil.example/#genesis','https://agentshift.lol/#marketplace','https://agentshift.lol/another','https://agentshift.lol/?project=other']){
    assert.equal((await f.engine.dispatch('project.preflight',{url})).status,'UNADAPTED');
  }
  assert.equal(f.reads.length,0);assert.equal(f.wallet.calls.length,0);
});
test('unknown projects return matching saved research without trusting cached availability',async t=>{
  const f=setup();t.after(()=>f.store.close());
  f.store.project({name:'Example',sources:[{url:'https://example.com/mint'}],summary:'Previously sold out',unverified:['Live availability']});
  const r=await f.engine.dispatch('project.preflight',{url:'https://example.com/new-sale'});
  assert.equal(r.status,'UNADAPTED');assert.equal(r.priorResearch[0].name,'Example');assert.equal(r.priorResearch[0].untrusted,true);
  assert.equal((await f.engine.dispatch('project.preflight',{url:'https://example.com.evil.example'})).priorResearch.length,0);
});
test('project preflight blocks private URLs and wrong chain without wallet access',async t=>{
  const f=setup();t.after(()=>f.store.close());
  await assert.rejects(f.engine.dispatch('project.preflight',{url:'http://127.0.0.1'}),{code:'UNSAFE_URL'});
  f.chain.config.chainId=1;
  assert.equal((await f.engine.dispatch('project.preflight',{url:AGENT_SHIFT.origin})).error.code,'WRONG_CHAIN');assert.equal(f.reads.length,0);
});
