import { fetch, ProxyAgent } from 'undici';
import { Interface, formatUnits, parseUnits, keccak256, getBytes } from 'ethers';
import { check, fail, address, sameAddress, uint, hex, id } from './util.mjs';
import { SELL_SLIPPAGE_BPS } from './trade-policy.mjs';

export const tokenAbi = new Interface([
  'function decimals() view returns(uint8)', 'function symbol() view returns(string)',
  'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)'
]);
export const routerAbi = new Interface([
  'function getAmountsOut(uint256,address[]) view returns(uint256[])',
  'function swapExactETHForTokens(uint256,address[],address,uint256) payable returns(uint256[])',
  'function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns(uint256[])',
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns(uint256[])'
]);
const READ_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_getTransactionReceipt', 'eth_getTransactionByHash']);
export class Chain {
  constructor(config) {
    this.config = config;
    const proxy = config.rpcProxy ?? config.proxy;
    this.dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    this.seq = 0; this.verified = new Map();
  }
  async request(url, method, params) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method, params }), dispatcher: this.dispatcher, signal: AbortSignal.timeout(12000) });
    check(res.ok, 'RPC_HTTP_ERROR', 'RPC HTTP ' + res.status);
    const d = await res.json();
    if (d.error) fail('RPC_CALL_ERROR', d.error.message);
    check('result' in d, 'RPC_INVALID', 'RPC response missing result'); return d.result;
  }
  async rpc(method, params = []) {
    check(READ_METHODS.has(method), 'RPC_WRITE_FORBIDDEN', 'Only read-only RPC methods are allowed');
    let last;
    for (const url of this.config.rpcUrls) {
      try {
        if (method !== 'eth_chainId' && (this.verified.get(url) || 0) < Date.now()) {
          check(Number(BigInt(await this.request(url, 'eth_chainId', []))) === this.config.chainId, 'WRONG_CHAIN', 'RPC is on a different chain');
          this.verified.set(url, Date.now() + 60000);
        }
        const result = await this.request(url, method, params);
        if (method === 'eth_chainId') check(Number(BigInt(result)) === this.config.chainId, 'WRONG_CHAIN', 'RPC is on a different chain');
        return result;
      } catch (e) { if (['RPC_CALL_ERROR', 'WRONG_CHAIN'].includes(e.code)) throw e; last = e; }
    }
    throw last || new Error('No RPC configured');
  }
  async snapshot() {
    const b = await this.rpc('eth_getBlockByNumber', ['latest', false]);
    check(b?.hash && Number(BigInt(b.timestamp)) * 1000 > Date.now() - 60000, 'STALE_CHAIN', 'RPC head is stale');
    return { number: Number(BigInt(b.number)), tag: b.number, hash: b.hash, timestamp: Number(BigInt(b.timestamp)), observedAt: Date.now() };
  }
  async verifySnapshot(b) {
    const current = await this.rpc('eth_getBlockByNumber', [b.tag, false]);
    check(current?.hash === b.hash, 'CHAIN_REORG', 'Snapshot block changed; prepare again');
  }
  async call(to, abi, method, args, block = 'latest', from) {
    const data = abi.encodeFunctionData(method, args);
    return abi.decodeFunctionResult(method, await this.rpc('eth_call', [{ to: address(to), data, ...(from ? { from } : {}) }, block]));
  }
  async inspect(contract) {
    contract = address(contract); const b = await this.snapshot();
    const code = await this.rpc('eth_getCode', [contract, b.tag]);
    const metadata = {};
    const results = await Promise.allSettled(['decimals', 'symbol'].map(k => this.call(contract, tokenAbi, k, [], b.tag)));
    if (results[0].status === 'fulfilled') metadata.decimals = Number(results[0].value[0]);
    if (results[1].status === 'fulfilled') metadata.symbol = String(results[1].value[0]).slice(0, 80);
    await this.verifySnapshot(b);
    return { chainId: this.config.chainId, contract, hasCode: code !== '0x', codeHash: keccak256(code), metadata, block: b, source: this.config.rpcUrls[0] };
  }
  async quote(input, wallet) {
    const nativeIn = input.tokenIn === 'native', nativeOut = input.tokenOut === 'native';
    const tokenIn = nativeIn ? this.config.wrapped : address(input.tokenIn);
    const tokenOut = nativeOut ? this.config.wrapped : address(input.tokenOut);
    check(!sameAddress(tokenIn, tokenOut), 'INVALID_PAIR', 'Input and output tokens must differ');
    const slippageBps = input.slippageBps ?? (nativeOut||input.side==='sell'?SELL_SLIPPAGE_BPS:100);
    check(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 5000, 'INVALID_SLIPPAGE', 'slippageBps must be an integer from 0 to 5000');
    const b = await this.snapshot();
    const [inDecimals, outDecimals] = await Promise.all([
      nativeIn ? 18 : this.call(tokenIn, tokenAbi, 'decimals', [], b.tag).then(x => Number(x[0])),
      nativeOut ? 18 : this.call(tokenOut, tokenAbi, 'decimals', [], b.tag).then(x => Number(x[0]))
    ]);
    let amountIn;
    check((input.amountRaw!==undefined)!==(input.amount!==undefined),'INVALID_AMOUNT','Provide exactly one of amount or amountRaw');
    try {
      if(input.amountRaw!==undefined)amountIn=BigInt(uint(input.amountRaw,true));
      else { check(typeof input.amount==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(input.amount),'INVALID_AMOUNT','Human amounts must be decimal strings');amountIn=parseUnits(input.amount,inDecimals); }
    }
    catch { fail('INVALID_AMOUNT', 'Amount exceeds precision or is invalid'); }
    uint(amountIn.toString(), true);
    const paths = [[tokenIn, tokenOut]];
    if (![tokenIn, tokenOut].some(x => sameAddress(x, this.config.wrapped))) paths.push([tokenIn, this.config.wrapped, tokenOut]);
    const routes = await Promise.allSettled(paths.map(async path => {
      const amounts = (await this.call(this.config.router, routerAbi, 'getAmountsOut', [amountIn, path], b.tag))[0];
      return { path, out: BigInt(amounts[amounts.length - 1]) };
    }));
    const good = routes.filter(x => x.status === 'fulfilled' && x.value.out > 0n).map(x => x.value).sort((a,b) => a.out > b.out ? -1 : a.out < b.out ? 1 : 0);
    check(good.length, 'NO_ROUTE', 'No quote among supported PancakeSwap V2 paths');
    const best = good[0];
    const minOut = best.out * BigInt(10000 - slippageBps) / 10000n;
    check(minOut > 0n, 'DUST_OUTPUT', 'Minimum output rounds to zero');
    await this.verifySnapshot(b);
    return { id: id(), wallet: address(wallet), chainId: this.config.chainId, router: this.config.router, nativeIn, nativeOut,
      tokenIn, tokenOut, amountInRaw: amountIn.toString(), expectedOutRaw: best.out.toString(), minOutRaw: minOut.toString(),
      expectedOut: formatUnits(best.out, outDecimals), inDecimals, outDecimals, path: best.path, slippageBps,
      block: b, expiresAt: Date.now() + this.config.quoteTtlMs, feeDetail: 'Pool fee included in quote; gas and token transfer taxes not included', source: this.config.routeSource };
  }
  buildSwap(q, wallet) {
    check(sameAddress(q.wallet, wallet), 'WALLET_CHANGED', 'Quote belongs to a different wallet');
    const deadline = Math.floor(Date.now() / 1000) + 180;
    const name = q.nativeIn ? 'swapExactETHForTokens' : q.nativeOut ? 'swapExactTokensForETH' : 'swapExactTokensForTokens';
    const args = q.nativeIn ? [q.minOutRaw, q.path, wallet, deadline] : [q.amountInRaw, q.minOutRaw, q.path, wallet, deadline];
    const data = routerAbi.encodeFunctionData(name, args);
    const decoded = routerAbi.parseTransaction({ data, value: q.nativeIn ? q.amountInRaw : '0' });
    check(decoded.name === name && sameAddress(decoded.args[decoded.args.length - 2], wallet), 'PAYLOAD_MISMATCH', 'Swap recipient mismatch');
    return { chainId: this.config.chainId, from: address(wallet), to: address(q.router), value: q.nativeIn ? q.amountInRaw : '0', data, deadline };
  }
  async balances(q, wallet) {
    const [native, balance, allowance] = await Promise.all([
      this.rpc('eth_getBalance', [wallet, 'latest']),
      q.nativeIn ? Promise.resolve([q.amountInRaw]) : this.call(q.tokenIn, tokenAbi, 'balanceOf', [wallet]),
      q.nativeIn ? Promise.resolve([q.amountInRaw]) : this.call(q.tokenIn, tokenAbi, 'allowance', [wallet, q.router])
    ]);
    const spendable = q.nativeIn ? BigInt(native) : BigInt(balance[0]);
    check(spendable >= BigInt(q.amountInRaw), 'INSUFFICIENT_BALANCE', 'Insufficient input token balance');
    check(BigInt(native) > (q.nativeIn ? BigInt(q.amountInRaw) : 0n), 'INSUFFICIENT_GAS', 'Native coin balance must also cover network gas');
    return { allowance: allowance[0].toString(), balance: spendable.toString() };
  }
  async close() { await this.dispatcher?.close(); }
}
