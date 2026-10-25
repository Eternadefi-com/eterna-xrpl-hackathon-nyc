// READ-ONLY XRPL EVM Testnet readers for AP4M verification. Only the JSON-RPC methods in READ can be sent: there is no
// eth_sendRawTransaction / eth_sendTransaction / eth_sign path in this module. Hosts are allow-listed and every reader
// must report chain id 1449000. Two independent read paths: the public RPC node and the Blockscout explorer's own
// JSON-RPC facade (separate indexer). Recording / replay readers let the tests run offline on captured public data.
import { fail, canonicalJson } from '../unified/common.mjs';
import { NETWORK } from './constants.mjs';

export const READ = Object.freeze(new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getLogs', 'eth_call', 'eth_getCode', 'eth_getBalance', 'eth_getTransactionCount']));
export const HOSTS = Object.freeze({ 'rpc.testnet.xrplevm.org': 'xrplevm-rpc', 'explorer.testnet.xrplevm.org': 'blockscout' });
export const DEFAULT_READERS = Object.freeze([NETWORK.rpcUrl, NETWORK.explorerRpcUrl]);

export function evmReader(url, { timeoutMs = 20000 } = {}) {
  const host = new URL(url).hostname;
  if (!HOSTS[host]) throw fail('READER_HOST_REFUSED', `${host} is not an allow-listed XRPL EVM Testnet reader`);
  let id = 1;
  async function request(method, params = []) {
    if (!READ.has(method)) throw fail('METHOD_REFUSED', `${method} is not a read method`);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (j.error) throw fail('RPC_ERROR', `${host} ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  }
  return { url, label: HOSTS[host], request };
}
/** Refuse a reader that is not on chain 1449000. */
export async function assertChain(r) {
  const c = await r.request('eth_chainId');
  if (BigInt(c) !== NETWORK.chainId) throw fail('NETWORK_MISMATCH', `${r.url} reports chain ${c}`);
  return { url: r.url, label: r.label, chainId: Number(BigInt(c)) };
}
const key = (m, p) => `${m} ${canonicalJson(p)}`;
/** Wrap a reader so every response is captured into tape[url]. */
export const recording = (r, tape = {}) => ({ ...r, tape, request: async (m, p = []) => { const res = await r.request(m, p); (tape[r.url] ??= {})[key(m, p)] = res; return res; } });
/** Answer only from a tape. Unknown requests fail. `override(method, params, result)` lets tests inject bad evidence. */
export const replayReader = (url, tape, override = (m, p, res) => res) => ({ url, label: HOSTS[new URL(url).hostname] ?? 'replay',
  request: async (m, p = []) => { if (!READ.has(m)) throw fail('METHOD_REFUSED', m); const res = tape[url]?.[key(m, p)]; if (res === undefined) throw fail('NOT_RECORDED', key(m, p)); return override(m, p, structuredClone(res)); } });
