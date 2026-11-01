if (process.env.CODEX_WALLET_PROXY) {
  const { setGlobalDispatcher, ProxyAgent } = require('undici');
  setGlobalDispatcher(new ProxyAgent(process.env.CODEX_WALLET_PROXY));
}
