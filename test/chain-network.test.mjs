import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Chain } from '../src/chain.mjs';

test('RPC can connect directly while the wallet retains its proxy', async t => {
  const rpc = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x38' }));
  });
  let proxyRequests = 0;
  const proxy = createServer((_req, res) => {
    proxyRequests++;
    res.writeHead(403, { connection: 'close' });
    res.end();
  });
  proxy.on('connect', (_req, socket) => {
    proxyRequests++;
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await Promise.all([
    new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  ]);
  t.after(() => Promise.all([rpc, proxy].map(server => new Promise(resolve => server.close(resolve)))));
  const config = { chainId: 56, proxy: `http://127.0.0.1:${proxy.address().port}`,
    rpcUrls: [`http://127.0.0.1:${rpc.address().port}`] };
  const inherited = new Chain(config);
  const direct = new Chain({ ...config, rpcProxy: '' });
  t.after(async () => { await inherited.close(); await direct.close(); });
  await assert.rejects(inherited.rpc('eth_chainId'));
  assert.equal(proxyRequests, 1);
  assert.equal(await direct.rpc('eth_chainId'), '0x38');
  assert.equal(proxyRequests, 1);
  assert.equal(direct.config.proxy, config.proxy);
});
