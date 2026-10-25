// Quicknode as an ADDITIONAL independent reader: re-verify Eterna's recorded XRPL Mainnet transactions on every reader
// (s1.ripple.com, xrplcluster.com and Quicknode) and prove they all agree. Read-only: only read methods can be sent
// (commerce/readers.mjs), nothing is signed or submitted, and the Quicknode URL (it embeds a token) is never written —
// evidence labels it "Quicknode". CLI: node mainnet/quicknode-verify.mjs [--out <file>]
import './quicknode-env.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mainnetReaders, readOnlyReader, assertNetwork, readerLabel, quicknodeUrl } from '../commerce/readers.mjs';

const NET = 'xrpl:0';
const LIST = new URL('./recorded-mainnet-txs.json', import.meta.url);
const memoHex = (tx) => (tx.Memos ?? []).map((m) => String(m.Memo?.MemoData ?? '').toLowerCase());
// The fields every reader must report identically for a transaction to count as agreed.
const view = (t) => ({ type: t.TransactionType, account: t.Account, destination: t.Destination ?? null, channel: t.Channel ?? null,
  amount: t.Amount ?? null, balance: t.Balance ?? null, memos: memoHex(t), result: t.meta?.TransactionResult ?? null, delivered: t.meta?.delivered_amount ?? null });

async function readOne(r, item) {
  const t0 = Date.now();
  const res = await r.request('tx', { transaction: item.hash, binary: false });
  if (!res || res.error) return { ok: false, problems: [`tx: ${res?.error ?? 'no result'}`], ms: Date.now() - t0 };
  const tx = res.tx_json ? { ...res.tx_json, meta: res.meta } : res;
  const ledger = await r.request('ledger', { ledger_index: res.ledger_index });
  const ledgerHash = ledger?.ledger?.ledger_hash ?? ledger?.ledger_hash ?? null;
  const v = view(tx), problems = [];
  if (res.validated !== true) problems.push('not validated');
  if ((res.hash ?? tx.hash) !== item.hash) problems.push('hash mismatch');
  if (v.result !== 'tesSUCCESS') problems.push(`result ${v.result}`);
  if (!ledgerHash) problems.push('no ledger hash');
  if (item.memoDigest && !v.memos.some((m) => m.includes(item.memoDigest.toLowerCase()) || Buffer.from(m, 'hex').toString('utf8').includes(item.memoDigest))) problems.push('anchor memo does not contain the receipt digest');
  return { ok: problems.length === 0, problems, ledgerIndex: res.ledger_index, ledgerHash, view: v, ms: Date.now() - t0 };
}

export async function verifyAll({ urls = mainnetReaders(), list = JSON.parse(readFileSync(LIST, 'utf8')).txs } = {}) {
  const readers = urls.map((u) => readOnlyReader(u, NET));
  try {
    const servers = [];
    for (const r of readers) { const t0 = Date.now(); const s = await assertNetwork(r); servers.push({ reader: readerLabel(r.url), build: s.build_version, hostid: s.hostid, ms: Date.now() - t0 }); }
    const results = [];
    for (const item of list) {
      const per = [];
      for (const r of readers) { try { per.push({ reader: readerLabel(r.url), ...(await readOne(r, item)) }); } catch (e) { per.push({ reader: readerLabel(r.url), ok: false, problems: [e.message] }); } }
      const first = per[0];
      const agree = per.every((p) => p.ledgerHash && p.ledgerHash === first.ledgerHash && p.ledgerIndex === first.ledgerIndex && JSON.stringify(p.view) === JSON.stringify(first.view));
      results.push({ hash: item.hash, kind: item.kind, purchaseId: item.purchaseId, type: first.view?.type ?? null, expectedType: item.expectType,
        typeMatches: first.view?.type === item.expectType, ledgerIndex: first.ledgerIndex ?? null, ledgerHash: first.ledgerHash ?? null,
        verified: per.every((p) => p.ok) && agree, readersAgree: agree,
        per: per.map(({ reader, ok, problems, ms }) => ({ reader, ok, problems, ms })), explorer: `https://livenet.xrpl.org/transactions/${item.hash}` });
    }
    const qn = (p) => p.reader === 'Quicknode';
    const summary = { transactions: results.length, verifiedOnAllReaders: results.filter((x) => x.verified).length,
      quicknodeConfirmed: results.filter((x) => x.per.some((p) => qn(p) && p.ok)).length,
      readers: servers.map((s) => s.reader), byKind: results.reduce((a, x) => ((a[x.kind] ??= { total: 0, verified: 0 }).total++, x.verified && a[x.kind].verified++, a), {}),
      typeMismatches: results.filter((x) => !x.typeMatches).map((x) => ({ hash: x.hash, kind: x.kind, type: x.type, expected: x.expectedType })) };
    return { generatedAt: new Date().toISOString(), network: 'XRPL Mainnet', mode: 'read-only (tx, ledger, server_info only)', quicknodeIncluded: Boolean(quicknodeUrl()), servers, summary, results };
  } finally { readers.forEach((r) => r.close()); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : new URL('./evidence/quicknode-mainnet-verification.json', import.meta.url).pathname;
  const ev = await verifyAll();
  const text = JSON.stringify(ev, null, 1);
  if (quicknodeUrl() && text.includes(new URL(quicknodeUrl()).pathname.split('/').filter(Boolean)[0] ?? '\u0000')) throw new Error('refusing to write: Quicknode token would leak');
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, text + '\n');
  console.log(JSON.stringify({ out, quicknodeIncluded: ev.quicknodeIncluded, servers: ev.servers, summary: ev.summary }, null, 1));
}
