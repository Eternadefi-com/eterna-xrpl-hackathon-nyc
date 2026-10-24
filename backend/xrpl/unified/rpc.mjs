// XRPL Devnet network access. DEVNET ONLY: every URL must be on the host allow-list below, every reader must report
// network_id 2 before it is used, and `submit` / the faucet exist only for Devnet. There is no Mainnet path.
import { createRequire } from 'node:module';
import { DEVNET, fail } from './common.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws'); // already a dependency of xrpl.js; no new package

export const DEVNET_HOSTS = Object.freeze(new Set(['s.devnet.rippletest.net', 'devnet.honeycluster.io', 'clio.devnet.rippletest.net', 'faucet.devnet.rippletest.net']));
export const READ_METHODS = Object.freeze(new Set(['server_info', 'server_definitions', 'feature', 'fee', 'account_info', 'account_objects', 'account_tx', 'ledger', 'ledger_entry', 'tx']));
const assertDevnetUrl = (u) => { const h = new URL(u).hostname; if (!DEVNET_HOSTS.has(h)) throw fail('NOT_DEVNET', `host ${h} is not an allow-listed Devnet host`); return u; };

/** JSON-RPC (https) or WebSocket (wss) reader. Read-only unless allowSubmit (Devnet primary only). */
export function reader(url, { allowSubmit = false, timeoutMs = 20000 } = {}) {
  assertDevnetUrl(url);
  const ws = url.startsWith('wss://');
  let sock, ready, nextId = 1; const pending = new Map();
  const open = () => ready ??= new Promise((res, rej) => {
    sock = new WebSocket(url);
    sock.on('open', res); sock.on('error', rej);
    sock.on('message', (m) => { const j = JSON.parse(m); const p = pending.get(j.id); if (p) { pending.delete(j.id); p(j); } });
  });
  async function request(method, params = {}) {
    if (!READ_METHODS.has(method) && !(allowSubmit && method === 'submit')) throw fail('METHOD_REFUSED', `${method} is not allowed on ${url}`);
    const ctl = AbortSignal.timeout(timeoutMs);
    if (!ws) {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params: [params] }), signal: ctl });
      return (await r.json()).result;
    }
    await open();
    const id = nextId++;
    const j = await new Promise((res, rej) => { pending.set(id, res); ctl.addEventListener('abort', () => rej(fail('TIMEOUT', `${method} on ${url}`))); sock.send(JSON.stringify({ id, command: method, ...params })); });
    return j.result ?? { error: j.error, error_message: j.error_message, ...j };
  }
  const close = () => { try { sock?.close(); } catch {} };
  return { url, request, close, allowSubmit };
}

/** Confirm a reader is a live Devnet server (network_id 2). Returns its identity for the evidence. */
export async function assertDevnet(r) {
  const info = (await r.request('server_info'))?.info;
  if (info?.network_id !== DEVNET.networkId) throw fail('NOT_DEVNET', `${r.url} reports network_id ${info?.network_id}`);
  return { url: r.url, build_version: info.build_version, hostid: info.hostid, complete_ledgers: info.complete_ledgers, validated: info.validated_ledger?.seq };
}

/** Fund an address we hold the key for from the Devnet faucet (the seed never leaves this machine). */
export async function faucetFund(address) {
  const r = await fetch(assertDevnetUrl(DEVNET.faucet), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ destination: address }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw fail('FAUCET', `HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return { address: j.account?.address ?? j.account?.classicAddress ?? address, amount: j.amount, hash: j.transactionHash ?? j.hash };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Submit a signed blob to the Devnet primary and wait for validation. Stops on any tec/tem/tef (never re-spends). */
export async function submitAndWait(primary, { tx_blob, hash, lastLedgerSequence }) {
  if (!primary.allowSubmit) throw fail('METHOD_REFUSED', 'reader is read-only');
  await assertDevnet(primary);
  const s = await primary.request('submit', { tx_blob });
  const er = s?.engine_result;
  if (!er) throw fail('SUBMIT', JSON.stringify(s).slice(0, 300));
  if (s.tx_json?.hash && s.tx_json.hash !== hash) throw fail('HASH_MISMATCH', `${s.tx_json.hash} != ${hash}`);
  if (!['tesSUCCESS', 'terQUEUED'].includes(er) && !er.startsWith('ter') && er !== 'tefPAST_SEQ') throw fail(er, `submit rejected: ${s.engine_result_message}`);
  return waitValidated(primary, hash, lastLedgerSequence);
}
export async function waitValidated(r, hash, lastLedgerSequence, { maxMs = 90000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const t = await r.request('tx', { transaction: hash });
    if (t?.validated) return t;
    if (lastLedgerSequence) {
      const seq = (await r.request('ledger', { ledger_index: 'validated' }))?.ledger_index;
      if (Number(seq) > lastLedgerSequence) throw fail('EXPIRED', `${hash} not validated by LastLedgerSequence ${lastLedgerSequence}`);
    }
    if (Date.now() - t0 > maxMs) throw fail('TIMEOUT', `${hash} not validated`);
    await sleep(2000);
  }
}
