import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Cache, check, epochMs, publicError } from './util.mjs';

export class BawAdapter {
  cache = new Cache(); timings = []; pairing = null;
  constructor(config) { this.config = config; }
  async run(args, timeout = this.config.cliTimeoutMs || 45000) {
    const readonly=args[0]==='wallet';
    for(let attempt=0;;attempt++){
      try{return await this.runOnce(args,timeout);}
      catch(e){
        if(!readonly||attempt>=1||!['NETWORK_ERROR','CLI_TIMEOUT','CLI_BAD_RESPONSE'].includes(e.code))throw e;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }
  }
  async runOnce(args, timeout) {
    const start = performance.now();
    const env = { ...process.env };
    if (this.config.proxy) {
      env.CODEX_WALLET_PROXY = this.config.proxy;
      env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require=' + JSON.stringify(fileURLToPath(new URL('../scripts/proxy.cjs', import.meta.url)));
    }
    try {
      return await new Promise((resolve, reject) => {
        execFile(this.config.bawBin || 'baw', [...args, '--json'], { env, timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
          let parsed;
          try { parsed = JSON.parse(stdout.trim()); } catch {
            return reject(Object.assign(new Error(err?.killed ? 'Wallet CLI timed out; submission outcome may be unknown' : 'Wallet CLI did not return valid JSON'), { code: err?.killed ? 'CLI_TIMEOUT' : 'CLI_BAD_RESPONSE' }));
          }
          if (!parsed.success) return reject(Object.assign(new Error(parsed.error?.message || 'Wallet CLI error'), { code: parsed.error?.name || 'CLI_ERROR', details: { code: parsed.error?.code } }));
          if (err) return reject(Object.assign(new Error('Wallet CLI exited unexpectedly'), { code: 'CLI_EXIT_ERROR' }));
          resolve(parsed.data);
        });
      });
    } finally {
      this.timings.push({ command: args.slice(0, 2).join(' '), ms: Math.round(performance.now() - start), at: Date.now() });
      if (this.timings.length > 100) this.timings.shift();
    }
  }
  async status(fresh = false) { return this.cache.get('status', 5000, () => this.run(['wallet', 'status']), fresh); }
  async addresses(fresh = false) { return this.cache.get('addresses', 300000, () => this.run(['wallet', 'address']), fresh); }
  settings(fresh = true) { return this.cache.get('settings',30000,()=>this.run(['wallet','settings']),fresh); }
  chains() { return this.cache.get('chains', 60000, () => this.run(['wallet', 'chains'])); }
  lock() { return this.run(['wallet', 'tx-lock', '--binanceChainId', String(this.config.chainId)]); }
  history(start) { return this.run(['wallet', 'tx-history', '--binanceChainId', String(this.config.chainId), '--startTime', String(start), '--size', '100']); }
  async context({ external = false, fresh = false } = {}) {
    const status = await this.status(fresh);
    if(status.status!=='CONNECTED'){this.cache.clear();this.lastSessionKey=undefined;}
    check(status.status === 'CONNECTED', 'WALLET_DISCONNECTED', 'Binance wallet is not connected; use connect');
    const settings = await this.settings(external||fresh);
    for (const key of ['sessionExpireTime', 'inactiveSignOutTime']) {
      if (settings[key]) check(Date.parse(settings[key]) > Date.now(), 'SESSION_EXPIRED', 'Wallet session expired; reconnect in Binance App');
    }
    if (external) {
      check(settings.devMode?.enabled && epochMs(settings.devMode.expiresAt) > Date.now(), 'DEV_MODE_REQUIRED', 'Enable Developer Mode in Binance App: Agentic Wallet management → Settings → Developer Mode');
      check(!settings.devMode.balanceExceeded, 'DEV_MODE_BALANCE_EXCEEDED', 'Wallet balance exceeds Developer Mode limit');
    }
    const sessionKey=settings.signInMaxTime||null;
    const addresses = await this.addresses(this.lastSessionKey!==sessionKey);
    this.lastSessionKey=sessionKey;
    const entry = addresses.addresses?.find(x => String(x.binanceChainId) === String(this.config.chainId));
    check(entry?.address, 'ADDRESS_UNAVAILABLE', 'Connected wallet has no address on configured chain');
    return { address: entry.address, chainId: this.config.chainId, settings, observedAt: Date.now() };
  }
  async connect() {
    if ((await this.status(true)).status === 'CONNECTED') return { state: 'CONNECTED', reused: true };
    if (this.pairing && !['FAILED', 'EXPIRED', 'CONNECTED'].includes(this.pairing.state) && this.pairing.expireAt > Date.now()) return this.pairing;
    // Reserve before awaiting signin so concurrent callers share one task.
    if (this.signingIn) return this.signingIn;
    this.signingIn = this.startPairing();
    try { return await this.signingIn; } finally { this.signingIn = null; }
  }
  async startPairing() {
    const d = await this.run(['auth', 'signin']);
    if (d.status === 'ALREADY_CONNECTED') return { state: 'CONNECTED', reused: true };
    check(d.qrCodeId && d.urlForWeb && d.pairingCode, 'PAIRING_INVALID', 'Wallet returned incomplete pairing data');
    this.pairing = { state: 'VERIFYING', urlForWeb: d.urlForWeb, pairingCode: d.pairingCode, expireAt: Number(d.expireAt) };
    const task = this.pairing;
    this.verifyTask = this.run(['auth', 'verify', '--qrCodeId', d.qrCodeId], 330000).then(async () => {
      this.cache.clear();
      task.state = (await this.status(true)).status === 'CONNECTED' ? 'CONNECTED' : 'FAILED';
    }).catch(e => { task.state = Date.now() >= task.expireAt ? 'EXPIRED' : 'FAILED'; task.error = publicError(e); });
    return task;
  }
  preview(tx) { return this.run(['contract-call', 'preview', '--binanceChainId', String(tx.chainId), '--from', tx.from, '--to', tx.to, '--value', tx.value, '--inputData', tx.data,...(tx.gasLimit===undefined?[]:['--gasLimit',String(tx.gasLimit)])]); }
  execute(requestId) { return this.run(['contract-call', 'execute', '--requestId', requestId]); }
  marketArgs(command,p) {return ['market-order',command,'--binanceChainId',String(this.config.chainId),'--fromTokenQty',p.amount,'--fromToken',p.fromToken,'--toToken',p.toToken,'--slippage',String(p.slippageBps/100),...(command==='swap'?['--mev',String(p.mev??true),'--gasLevel',p.gasLevel||'MEDIUM']:[])];}
  marketQuote(p) {return this.run(this.marketArgs('quote',p));}
  marketSwap(p) {return this.run(this.marketArgs('swap',p));}
  marketOrders(orderId) {return this.run(['market-order','list','--orderId',String(orderId)]);}
  previewMessage(wrapper) { return this.run(['sign-message', 'preview', '--binanceChainId', String(this.config.chainId), '--signType', 'EIP712', '--message', JSON.stringify(wrapper)]); }
  executeMessage(requestId) { return this.run(['sign-message', 'execute', '--requestId', requestId]); }
  messageResult(orderId) { return this.run(['sign-message', 'result', '--order-id', orderId]); }
}
