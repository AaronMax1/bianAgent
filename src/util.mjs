import { createHash, randomUUID } from 'node:crypto';
import { getAddress } from 'ethers';

export function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }
export function check(ok, code, message) { if (!ok) fail(code, message); }
export function address(a) { try { return getAddress(a); } catch { fail('INVALID_ADDRESS', 'Invalid EVM address'); } }
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function uint(n, positive = false) {
  check(typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n), 'INVALID_AMOUNT', 'Amounts must be integer decimal strings');
  check(BigInt(n) < 2n ** 256n && (!positive || BigInt(n) > 0n), 'INVALID_AMOUNT', 'Amount outside uint256 range');
  return n;
}
export function hex(s) { check(typeof s === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(s), 'INVALID_HEX', 'Expected even-length hex data'); return s.toLowerCase(); }
export function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(typeof v === 'bigint' ? v.toString() : v);
}
export const digest = v => createHash('sha256').update(stable(v)).digest('hex');
export const id = () => randomUUID();
export function epochMs(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const n = Number(value); return n < 1e11 ? n * 1000 : n;
  }
  return typeof value === 'string' ? Date.parse(value) : NaN;
}
export const json = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);
const secret = /^(signature|signatureRecovery|privateKey|seed|mnemonic|password|token|accessToken|sessionToken|clientId|authorization|apiKey|rawData|messageWrapper)$/i;
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, secret.test(k) ? '[REDACTED]' : redact(val)]));
  return v;
}
export function publicError(e) { return redact({ code: e.code || 'INTERNAL_ERROR', message: e.message, details: e.details }); }
export class Mutex {
  tail = Promise.resolve();
  run(fn) { const next = this.tail.then(fn, fn); this.tail = next.catch(() => {}); return next; }
}
export class Cache {
  values = new Map(); inFlight = new Map();
  async get(key, ttl, fn, fresh = false) {
    const c = this.values.get(key);
    if (!fresh && c && c.until > Date.now()) return structuredClone(c.value);
    if (this.inFlight.has(key)) return structuredClone(await this.inFlight.get(key));
    const p = Promise.resolve().then(fn).then(value => { this.values.set(key, { value, until: Date.now() + ttl }); return value; });
    this.inFlight.set(key, p);
    try { return structuredClone(await p); } finally { this.inFlight.delete(key); }
  }
  clear() { this.values.clear(); }
}
