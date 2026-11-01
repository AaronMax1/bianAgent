import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { check } from './util.mjs';

export const BSC = {
  chainId: 56,
  rpcUrls: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com'],
  router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  wrapped: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  routeSource: 'https://github.com/bnbxcs/TMTN/blob/4543ed433a06300259856d8ccea58a783d44e095/engine/live/dexDirect.js',
  confirmations: 3, quoteTtlMs: 120000, maxQuoteBlocks: 300
};
export function loadConfig() {
  const root = resolve(process.env.CODEX_WALLET_HOME || join(homedir(), '.local/share/codex-project-wallet'));
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const file = join(root, 'config.json');
  const custom = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  check(!custom.chainId || custom.chainId === 56, 'CHAIN_NOT_SUPPORTED', 'This release supports BSC chain 56');
  check(!custom.walletTransport||['cli','direct'].includes(custom.walletTransport),'INVALID_TRANSPORT','walletTransport must be cli or direct');
  return { ...BSC, ...custom, root, socket: join(root, 'service.sock'), dbPath: join(root, 'state.sqlite'),
    walletTransport: custom.walletTransport||'direct',
    bawBin: custom.bawBin || process.env.BAW_BIN || 'baw', proxy: custom.proxy ?? process.env.CODEX_WALLET_PROXY ?? '',
    cliTimeoutMs: 45000 };
}
