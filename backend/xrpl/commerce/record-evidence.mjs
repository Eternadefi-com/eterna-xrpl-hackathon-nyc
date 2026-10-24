// READ-ONLY evidence capture. Re-reads the real executions each LIVE_CAPABLE adapter claims, from two readers per network,
// records every response to fixtures/readonly-tape.json (so tests replay real ledger data offline), and writes the
// adapter evidence to evidence/. No submit, no signing, no faucet: commerce/readers.mjs has no such path.
// Usage (from backend/xrpl): node commerce/record-evidence.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readOnlyReader, assertNetwork, recording, DEFAULT_READERS } from './readers.mjs';
import paychan from './adapters/xrp-paychan.mjs';
import sponsored from './adapters/xls68-sponsored.mjs';
import { preflight } from './adapters/rlusd.mjs';
import ap4m from './adapters/ap4m-voucher.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const out = (n, o) => { mkdirSync(new URL('./evidence/', import.meta.url), { recursive: true }); writeFileSync(new URL(`./evidence/${n}`, import.meta.url), JSON.stringify(o, null, 2) + '\n'); };
const tape = {};
const readersFor = async (network) => {
  const rs = [];
  for (const u of DEFAULT_READERS[network]) { const r = readOnlyReader(u, network); try { rs.push({ ...(await assertNetwork(r)), reader: recording(r, tape) }); } catch (e) { console.error(`${u}: ${e.message}`); r.close(); } }
  return rs;
};
const at = new Date().toISOString();

// Mainnet: the purchase worker's recorded paychan execution
const mp = fx('mainnet-paychan-purchase.json');
const main = await readersFor('xrpl:0');
const ev1 = await paychan.verify({ network: 'xrpl:0', seller: mp.seller, payer: mp.payer, channelId: mp.channelId, execution: mp.execution }, main.map((r) => r.reader));
out('xrp-paychan.mainnet.json', { capturedAt: at, readers: main.map(({ reader, ...i }) => i), ref: mp.purchaseId, evidence: ev1 });
console.log('xrp-paychan', ev1.status, ev1.txHash);

// Devnet: the unified mission's sponsored txs
const dm = fx('devnet-unified-mission.json');
const dev = await readersFor('xrpl:2');
const ev2 = await sponsored.verify({ txHash: dm.txs.settlement, expected: { sponsor: dm.accounts.E, sponsorFlags: 1 } }, dev.map((r) => r.reader));
const ev3 = await sponsored.verify({ txHash: dm.txs.delegateSet, expected: { sponsor: dm.accounts.E, sponsorFlags: 3 } }, dev.map((r) => r.reader));
const ev4 = await sponsored.verify({ txHash: dm.txs.agentCreate }, dev.map((r) => r.reader));
const ev5 = await ap4m.verify({ batch: dm.batch, voucherDigest: dm.batch.vouchers[0].digest, buyer: dm.certificate.agent.voucherKey, certificateDigest: dm.certificateDigest,
  perVoucherDrops: dm.certificate.limits.perVoucherDrops, capDrops: dm.certificate.limits.capDrops, settlement: ev2 });
out('xls68-sponsored.devnet.json', { capturedAt: at, readers: dev.map(({ reader, ...i }) => i), settlement: ev2, delegateSet: ev3, agentCreate: ev4 });
out('ap4m-voucher.devnet.json', { capturedAt: at, voucher: dm.batch.vouchers[0].digest, evidence: ev5 });
console.log('xls68-sponsored settlement', ev2.status, 'delegateSet', ev3.status, 'agentCreate', ev4.status, '| ap4m', ev5.status, ev5.facts.settlementCoversBatch);

// Testnet: RLUSD issuer state (read-only); no payer / seller accounts exist yet, so the trust-line preflight is PENDING
const test = await readersFor('xrpl:1');
const pf = [];
for (const r of test) pf.push(await preflight(r.reader, { network: 'xrpl:1', payer: dm.accounts.R, destination: dm.accounts.S, amount: '1' }));
out('rlusd.testnet-preflight.json', { capturedAt: at, readers: test.map(({ reader, ...i }) => i), note: 'Devnet mission addresses do not exist on Testnet: the trust-line checks are expected to fail until Testnet accounts are approved.', preflight: pf });
console.log('rlusd preflight', pf.map((p) => `${p.reader}: ${p.ok ? 'ok' : p.code} issuerFlags=${JSON.stringify(p.issuerFlags)}`).join(' | '));

writeFileSync(new URL('./fixtures/readonly-tape.json', import.meta.url), JSON.stringify({ capturedAt: at, note: 'Read-only RPC responses (Mainnet, Devnet, Testnet). Nothing was submitted or signed.', tape }, null, 1) + '\n');
for (const r of [...main, ...dev, ...test]) r.reader.close();
