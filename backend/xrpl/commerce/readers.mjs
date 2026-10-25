// READ-ONLY XRPL readers for adapter verification, on any network. There is no submit, sign or faucet path in this
// module: only the methods in READ_METHODS can be sent, and each reader must report the expected network id.
// (unified/rpc.mjs stays the only module with a Devnet submit path.) Also: recording and replay readers, so the
// tests verify against real ledger responses captured read-only, with no network access.
import { createRequire } from 'node:module';
import { fail, canonicalJson } from '../unified/common.mjs';
import { READ_METHODS } from '../unified/rpc.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const READ = new Set([...READ_METHODS, 'account_lines', 'amm_info', 'book_offers']); // reads only; no submit/sign method can be added here

export const NETWORKS = Object.freeze({
  'xrpl:0': { label: 'XRPL Mainnet', id: 0, explorer: (h) => `https://livenet.xrpl.org/transactions/${h}`, hosts: ['s1.ripple.com', 's2.ripple.com', 'xrplcluster.com'] },
  'xrpl:1': { label: 'XRPL Testnet', id: 1, explorer: (h) => `https://testnet.xrpl.org/transactions/${h}`, hosts: ['s.altnet.rippletest.net', 'testnet.xrpl-labs.com'] },
  'xrpl:2': { label: 'XRPL Devnet', id: 2, explorer: (h) => `https://devnet.xrpl.org/transactions/${h}`, hosts: ['s.devnet.rippletest.net', 'devnet.honeycluster.io'] },
});
export const DEFAULT_READERS = Object.freeze({
  'xrpl:0': ['https://s1.ripple.com:51234', 'https://xrplcluster.com'],
  'xrpl:1': ['https://s.altnet.rippletest.net:51234', 'wss://testnet.xrpl-labs.com/'],
  'xrpl:2': ['https://s.devnet.rippletest.net:51234', 'wss://devnet.honeycluster.io/'],
});
const net = (n) => NETWORKS[n] ?? fail('NETWORK_UNSUPPORTED', n);

// Quicknode (sponsor endpoint): its URL embeds an API token, so it comes only from the environment (loaded from the
// operator's private file by mainnet/quicknode-env.mjs — never from the repo). Only that exact host is admitted, only
// for Mainnet, and it must still report network id 0 like any reader.
export function quicknodeUrl() {
  const u = process.env.QUICKNODE_XRPL_MAINNET_URL ?? null;
  return u && /^https:\/\/[a-z0-9.-]+\.quiknode\.pro\//.test(u) ? u : null;
}
export const readerLabel = (url) => (/\.quiknode\.pro$/.test(new URL(url).hostname) ? 'Quicknode' : new URL(url).hostname);   // never show the token
/** Mainnet verification readers: the two default independent nodes, plus Quicknode as a third when configured (added, never substituted). */
export const mainnetReaders = () => [...DEFAULT_READERS['xrpl:0'], ...(quicknodeUrl() ? [quicknodeUrl()] : [])];

export function readOnlyReader(url, network, { timeoutMs = 20000 } = {}) {
  const host = new URL(url).hostname;
  const qn = network === 'xrpl:0' && quicknodeUrl() && new URL(quicknodeUrl()).hostname === host;
  if (!net(network).hosts.includes(host) && !qn) throw fail('READER_HOST_REFUSED', `${host} is not a known ${network} host`);
  const ws = url.startsWith('wss://');
  let sock, ready, id = 1; const pending = new Map();
  const open = () => ready ??= new Promise((res, rej) => {
    sock = new WebSocket(url); sock.on('open', res); sock.on('error', rej);
    sock.on('message', (m) => { const j = JSON.parse(m); pending.get(j.id)?.(j); pending.delete(j.id); });
  });
  async function request(method, params = {}) {
    if (!READ.has(method)) throw fail('METHOD_REFUSED', `${method} is not a read method`);
    const signal = AbortSignal.timeout(timeoutMs);
    if (!ws) return (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }), signal })).json()).result;
    await open();
    const n = id++;
    const j = await new Promise((res, rej) => { pending.set(n, res); signal.addEventListener('abort', () => rej(fail('TIMEOUT', method))); sock.send(JSON.stringify({ id: n, command: method, ...params })); });
    return j.result ?? { error: j.error };
  }
  return { url, network, request, close: () => { try { sock?.close(); } catch {} } };
}
/** Confirm the reader is on the expected network (Mainnet servers may omit network_id: treated as 0). */
export async function assertNetwork(r) {
  const i = (await r.request('server_info'))?.info;
  if ((i?.network_id ?? 0) !== net(r.network).id) throw fail('NETWORK_MISMATCH', `${r.url} reports ${i?.network_id}`);
  return { url: r.url, hostid: i.hostid ?? null, build_version: i.build_version };
}

const key = (method, params) => `${method} ${canonicalJson(params)}`;
/** Wrap a reader so every response is captured (read-only) into `tape`. */
export const recording = (r, tape = {}) => ({ ...r, tape, request: async (m, p = {}) => { const res = await r.request(m, p); (tape[r.url] ??= {})[key(m, p)] = res; return res; } });
/** A reader that answers only from a recorded tape. Unknown requests fail; `override` lets tests inject bad evidence. */
export const replayReader = (url, network, tape, override = (m, p, res) => res) => ({ url, network, close() {},
  request: async (m, p = {}) => { const res = tape[url]?.[key(m, p)]; if (res === undefined) throw fail('NOT_RECORDED', key(m, p)); return override(m, p, structuredClone(res)); } });
