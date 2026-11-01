import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/accounts.mjs';
import { dashboardSnapshot } from '../src/dashboard.mjs';
import { BSC } from '../src/config.mjs';
import { FakeChain,FakeWallet,A,B } from './helpers.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'cw-dashboard-'));
  const config={...BSC,root,dbPath:join(root,'state.sqlite'),walletTransport:'direct'};
  const accounts=new AccountManager({config,chain:new FakeChain(),wallet:new FakeWallet(),walletFactory:()=>{const w=new FakeWallet();w.address=B;return w;}});
  t.after(async()=>{await accounts.close();rmSync(root,{recursive:true,force:true});});return accounts;
}
test('account metadata persists without changing aliases, sessions or device identities',async t=>{
  const accounts=fixture(t),added=accounts.add({alias:'second',displayName:'测试账户',notes:'独立管理'});
  const old=accounts.public(accounts.resolve('second'));
  const updated=accounts.update(added.accountId,{displayName:'新名称',notes:'新备注',archived:true});
  assert.equal(updated.alias,'second');assert.deepEqual(updated.deviceProfile,old.deviceProfile);
  assert.equal(accounts.get(added.accountId).config.accountId,added.accountId);
  assert.equal(accounts.resolve('second').displayName,'新名称');
  assert.throws(()=>accounts.update('second',{walletAddress:A}),{code:'INVALID_ACCOUNT_METADATA'});
  assert.throws(()=>accounts.add({alias:'bad',notes:'x'.repeat(501)}),{code:'INVALID_ACCOUNT_METADATA'});
  assert.equal(accounts.list().length,2);
  const restored=new AccountManager({config:accounts.config,chain:new FakeChain(),wallet:new FakeWallet()});
  try{assert.equal(restored.resolve('second').archived,true);assert.equal(restored.resolve('second').notes,'新备注');}
  finally{await restored.close();}
});
test('dashboard joins PoA and IAO across accounts, excludes previews from participation and never exports signing material',t=>{
  const accounts=fixture(t),second=accounts.add({alias:'second'});
  const write=(selector,id,state,to,extra={})=>accounts.get(selector).store.save({id,idempotencyKey:'key-'+id,label:'Ptah action',kind:'contract',wallet:selector?B:A,createdAt:Date.now(),state,
    payload:{to,data:'0x00'},requestId:'private-request',wrapper:{secret:'private-cookie'},messageResult:'private-signature',context:{secret:'private-context'},...extra});
  write(undefined,'card','CONFIRMED','0xD87ADb2E47979d6cb323896B1A9320E0dd132213',{businessResult:{verified:true,event:'Minted',values:{tokenId:'101',seed:'private-seed'}}});
  write(second.accountId,'airdrop','CONFIRMED','0xa2556377118dD333F9f09600DE0bBCf54Cbc69A0',{businessResult:{verified:true,event:'AirdropClaimed',values:{amount:'11250000000000000000000'}}});
  write(second.accountId,'preview','AWAITING_USER',B);
  const snapshot=dashboardSnapshot(accounts);
  assert.equal(snapshot.projects.length,1);assert.equal(snapshot.projects[0].key,'ptah');
  assert.equal(snapshot.projects[0].confirmedAccountIds.length,2);
  assert.equal(snapshot.accounts.find(a=>a.accountId===second.accountId).projectCount,1);
  assert.equal(snapshot.operations.find(o=>o.id==='airdrop').result.value,'11250.0');
  assert.equal(snapshot.totals.confirmed,2);assert.equal(snapshot.operations.length,3);
  assert(!JSON.stringify(snapshot).includes('private-'));
  for(let i=0;i<205;i++)write(undefined,'history-'+i,'CANCELLED',B);
  assert.equal(dashboardSnapshot(accounts).operations.length,208);
});
