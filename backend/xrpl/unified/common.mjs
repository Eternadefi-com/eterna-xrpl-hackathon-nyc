// Shared helpers for the Rose unified-commerce mission (XRPL Devnet only). No network code here.
import { createHash } from 'node:crypto';

export const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/** Canonical JSON: object keys sorted recursively, no whitespace. Only strings, safe integers, booleans, null. */
export function canonicalJson(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw fail('CANON_NUMBER', 'only safe integers are canonical; use strings');
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  throw fail('CANON_TYPE', `cannot canonicalise ${typeof v}`);
}
export const sha256Hex = (data) => createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
export const digestOf = (obj) => sha256Hex(canonicalJson(obj));
export const hexUtf8 = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
export const utf8Hex = (h) => (typeof h === 'string' && /^([0-9A-Fa-f]{2})*$/.test(h) ? Buffer.from(h, 'hex').toString('utf8') : null);

// Memo types written on the ledger. MemoData is the lowercase hex digest, utf8-encoded.
export const MEMO = Object.freeze({
  certificate: 'eterna/mission-certificate', voucherBatch: 'eterna/ap4m-sim-voucher-batch', auditReceipt: 'eterna/audit-receipt',
});
export const memo = (type, data) => ({ Memo: { MemoType: hexUtf8(type), MemoData: hexUtf8(data) } });
/** Decode tx.Memos into [{type, data}]. */
export const readMemos = (tx) => (Array.isArray(tx?.Memos) ? tx.Memos : []).map((m) => ({ type: utf8Hex(m?.Memo?.MemoType), data: utf8Hex(m?.Memo?.MemoData) }));
export const memoValues = (tx, type) => readMemos(tx).filter((m) => m.type === type).map((m) => m.data);

export const DEVNET = Object.freeze({
  networkId: 2, label: 'XRPL Devnet',
  rpc: 'https://s.devnet.rippletest.net:51234',
  faucet: 'https://faucet.devnet.rippletest.net/accounts',
  explorerTx: (h) => `https://devnet.xrpl.org/transactions/${h}`,
});
