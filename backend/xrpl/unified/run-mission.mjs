// Rose unified-commerce mission on XRPL DEVNET ONLY. Resumable: every step records its result (and every signed blob
// BEFORE submission) in ~/eterna-private/unified-devnet/mission-state.json; a rerun skips validated steps and resubmits
// the same signed blob (same hash) if a step was interrupted. Any tec/tem/tef stops the run (no loop-spending).
// Usage (from backend/xrpl): node unified/run-mission.mjs
import { SNAPSHOT } from '../xls68/xls68.mjs';
import { DEVNET, digestOf, fail } from './common.mjs';
import { reader, assertDevnet, faucetFund, submitAndWait, waitValidated } from './rpc.mjs';
import { xrplKey, simulatorWallet, loadState, saveState } from './store.mjs';
import { buildCertificate, certificateDigest, roseApprove, verifyRoseApproval } from './governance.mjs';
import { buildAgentAccountCreate, buildSponsoredDelegateSet, buildDelegatedSettlement, buildAnchor, signSingle, cosign } from './tx.mjs';
import { createGovernedAgent, createSeller, startSellerServer, agentFetch, transition, STATUS, SIM } from './voucher-sim.mjs';
import { verifyMission, verifyAnchor, buildEvidence, writeEvidence } from './verify.mjs';

const PRIMARY = DEVNET.rpc, INDEPENDENT = ['wss://devnet.honeycluster.io/', 'https://clio.devnet.rippletest.net:51234'];
const REPORT_PRICE = '100000';      // 0.1 XRP per report = the per-voucher limit
const REPORTS_TO_BUY = 3;
const log = (...a) => console.log('[mission]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const m = loadState();
const save = () => saveState(m);
const primary = reader(PRIMARY, { allowSubmit: true });

// ---- 0. readers, definitions, amendments (read-only) -----------------------------------------------------------
const readers = [primary];
m.readers = [await assertDevnet(primary)];
for (const u of INDEPENDENT) {
  const r = reader(u);
  try { const id = await assertDevnet(r); if (id.hostid !== m.readers[0].hostid) { readers.push(r); m.readers.push(id); break; } } catch (e) { log(`independent reader ${u} unavailable: ${e.message}`); r.close(); }
}
log(`${readers.length} reader(s):`, m.readers.map((r) => `${r.url} (${r.hostid})`).join(', '));
const defs = await primary.request('server_definitions');
if (defs.hash !== SNAPSHOT._meta.definitions_hash) throw fail('DEFINITIONS_CHANGED', `Devnet definitions ${defs.hash} != snapshot; refresh xls68/fixtures first`);
for (const name of ['Sponsor', 'PermissionDelegationV1_1', 'fixCleanup3_4_0']) {
  const f = (await primary.request('feature', { feature: SNAPSHOT._meta.amendments[name].hash }))?.[SNAPSHOT._meta.amendments[name].hash];
  if (f?.enabled !== true) throw fail('AMENDMENT_DISABLED', name);
}

// ---- keys and funding ---------------------------------------------------------------------------------------------
const K = { E: xrplKey('eterna'), R: xrplKey('rose'), S: xrplKey('seller'), A: xrplKey('agent'), rogue: xrplKey('rogue-seller') };
const wallet = simulatorWallet();
m.accounts = { E: K.E.address, R: K.R.address, S: K.S.address, A: K.A.address, rogue: K.rogue.address };
m.txs ??= {}; save();
const info = async (a) => (await primary.request('account_info', { account: a, ledger_index: 'validated' }))?.account_data ?? null;
for (const role of ['E', 'R', 'S']) {
  if (await info(K[role].address)) continue;
  log(`funding ${role} ${K[role].address} from the Devnet faucet`);
  await faucetFund(K[role].address);
  for (let i = 0; i < 30 && !(await info(K[role].address)); i++) await sleep(2000);
  if (!(await info(K[role].address))) throw fail('FAUCET', `${role} not funded`);
}

// ---- 1. governance --------------------------------------------------------------------------------------------------
if (!m.certificate) {
  const now = new Date();
  m.certificate = buildCertificate({ missionId: `rose-unified-${now.toISOString().slice(0, 10)}`, rose: K.R.address, agent: K.A.address, agentVoucherAddress: wallet.address,
    seller: K.S.address, sponsor: K.E.address, task: 'buy validated XRPL ledger reports', perVoucherDrops: REPORT_PRICE, capDrops: '500000',
    issuedAt: now.toISOString(), expiry: new Date(now.getTime() + 24 * 3600e3).toISOString() });
  m.certificateDigest = certificateDigest(m.certificate);
  m.approval = roseApprove(m.certificate, K.R.seed);
  save();
}
if (!verifyRoseApproval(m.certificate, m.approval)) throw fail('APPROVAL', 'Rose approval does not verify');
log('certificate', m.certificateDigest);

// ---- tx step helper: sign once, persist the blob, then submit / resume ----------------------------------------------
async function step(name, build) {
  const saved = m.txs[name];
  if (saved?.validated) return saved;
  if (saved?.tx_blob) {
    const t = await primary.request('tx', { transaction: saved.hash });
    if (t?.validated) { Object.assign(saved, { validated: true, ledger: t.ledger_index, result: t.meta.TransactionResult }); save(); return saved; }
    const seq = (await primary.request('ledger', { ledger_index: 'validated' }))?.ledger_index;
    if (Number(seq) <= saved.lastLedgerSequence) { log(`${name}: resubmitting the same signed blob ${saved.hash}`); return finish(name, saved); }
    log(`${name}: previous blob expired unvalidated; re-signing`);
  }
  const seqNow = Number((await primary.request('ledger', { ledger_index: 'validated' })).ledger_index);
  const s = await build(seqNow + 20);
  m.txs[name] = { ...s.meta, hash: s.hash, tx_blob: s.tx_blob, lastLedgerSequence: seqNow + 20 }; save();
  return finish(name, m.txs[name]);
}
async function finish(name, saved) {
  const t = await submitAndWait(primary, { tx_blob: saved.tx_blob, hash: saved.hash, lastLedgerSequence: saved.lastLedgerSequence })
    .catch(async (e) => { if (e.code === 'tefPAST_SEQ' || e.code === 'tefALREADY') return waitValidated(primary, saved.hash, saved.lastLedgerSequence); throw e; });
  Object.assign(saved, { validated: true, ledger: t.ledger_index, result: t.meta?.TransactionResult }); save();
  if (saved.result !== 'tesSUCCESS') throw fail(saved.result, `${name} validated with ${saved.result}; stopping (diagnose before any retry)`);
  log(`${name} ${saved.hash} validated in ledger ${saved.ledger}`);
  return saved;
}
const seqOf = async (a) => (await info(a)).Sequence;

// ---- 2. XLS-68: Eterna creates the agent account (1 drop, sponsored) ---------------------------------------------------
await step('agentCreate', async (lls) => ({ meta: {}, ...signSingle(buildAgentAccountCreate({ eterna: K.E.address, agent: K.A.address, sequence: await seqOf(K.E.address), lastLedgerSequence: lls }), K.E.seed) }));

// ---- 3. XLS-75: Rose delegates Payment to the agent; Eterna co-signs as fee + reserve sponsor --------------------------
await step('delegateSet', async (lls) => ({ meta: { sponsorFlags: 3 }, ...cosign(buildSponsoredDelegateSet({ rose: K.R.address, agent: K.A.address, sponsor: K.E.address,
  certificateDigest: m.certificateDigest, sequence: await seqOf(K.R.address), lastLedgerSequence: lls }), { signerKey: K.R.seed, sponsorKey: K.E.seed }) }));

// ---- 4. voucher simulator: buy reports through the local x402-style seller ----------------------------------------------
if (!m.sim) {
  const agent = createGovernedAgent({ wallet, cert: m.certificate, approval: m.approval, certificateDigest: m.certificateDigest });
  const seller = createSeller({ sellerId: K.S.address }), rogue = createSeller({ sellerId: K.rogue.address });
  let lastLedger = 0;
  const produce = async (voucher) => {
    let l;
    for (let i = 0; i < 10; i++) { l = await primary.request('ledger', { ledger_index: 'validated' }); if (Number(l.ledger_index) > lastLedger) break; await sleep(1500); }
    lastLedger = Number(l.ledger_index);
    const L = l.ledger;
    const body = { kind: 'xrpl-devnet-validated-ledger-report', network: 'XRPL Devnet', source: PRIMARY, ledger_index: Number(l.ledger_index), ledger_hash: l.ledger_hash,
      parent_hash: L.parent_hash, account_hash: L.account_hash, transaction_hash: L.transaction_hash, close_time_iso: L.close_time_iso, total_coins: L.total_coins,
      validated: l.validated === true, soldBy: K.S.address, deliveredUnder: { voucherDigest: voucher.digest, cumulativeDrops: voucher.message.cumulativeDrops } };
    return { ...body, reportDigest: digestOf(body) };
  };
  const shop = await startSellerServer({ seller, routes: {
    '/report': { priceDrops: REPORT_PRICE, description: 'Validated XRPL Devnet ledger report', produce },
    '/premium-report': { priceDrops: '200000', description: 'Premium report (over the per-voucher limit)', produce } } });
  const rogueShop = await startSellerServer({ seller: rogue, routes: { '/report': { priceDrops: '50000', description: 'Unapproved seller', produce } } });
  const reports = [], probes = [];
  try {
    for (let i = 0; i < REPORTS_TO_BUY; i++) {
      const r = await agentFetch(`${shop.url}/report`, agent);
      if (r.status !== 200) throw fail('PURCHASE', JSON.stringify(r));
      reports.push(r.report); log(`report ${i + 1}: ledger ${r.report.ledger_index}, voucher cumulative ${r.voucher.message.cumulativeDrops}`);
    }
    // refusals: Eterna's gate stops these before any signature exists
    for (const u of [`${shop.url}/premium-report`, `${rogueShop.url}/report`]) {
      const r = await agentFetch(u, agent);
      if (r.status !== 'REFUSED') throw fail('POLICY', `expected refusal for ${u}, got ${r.status}`);
      log(`refused: ${r.refusal.code}`);
    }
    // seller-side probe: replaying the last voucher is rejected by the seller
    const last = agent.vouchers.at(-1), sess = agent.sessions.get(K.S.address).session;
    const replay = seller.verify({ session: sess, voucher: last }, REPORT_PRICE);
    probes.push({ probe: 'replay-last-voucher', ok: replay.ok, code: replay.code });
    if (replay.ok) throw fail('REPLAY', 'seller accepted a replayed voucher');
  } finally { await shop.close(); await rogueShop.close(); }
  const batch = seller.redeem(agent.sessions.get(K.S.address).session.terms.sessionId);
  m.sim = { ...SIM, reports, refusals: agent.refusals, agentVouchers: agent.vouchers, sellerVouchers: [...seller.sessions.values()][0].accepted, probes, batch, budget: agent.budget() };
  m.unlocked = false; save();
  log(`batch ${batch.batchDigest}: ${batch.voucherCount} vouchers, ${batch.redeemedCumulativeDrops} drops`);
}

// ---- 5. settlement: ONE delegated Payment R -> S signed by A, fee-only sponsored by E ------------------------------------
await step('settlement', async (lls) => ({ meta: { feeSponsored: true }, ...cosign(buildDelegatedSettlement({ rose: K.R.address, agent: K.A.address, seller: K.S.address, sponsor: K.E.address,
  amountDrops: m.sim.batch.redeemedCumulativeDrops, batchDigest: m.sim.batch.batchDigest, certificateDigest: m.certificateDigest, sequence: await seqOf(K.R.address), lastLedgerSequence: lls }),
  { signerKey: K.A.seed, sponsorKey: K.E.seed }) }));

// ---- 6. independent verification, then unlock ------------------------------------------------------------------------
const v = await verifyMission(readers, m);
for (const [k, r] of Object.entries(v)) log('verify', k.padEnd(18), r.ok ? 'VERIFIED' : `FAILED ${JSON.stringify(r.per.map((p) => p.problems))}`);
const allOk = Object.values(v).every((r) => r.ok);
if (allOk && !m.unlocked) {
  m.unlocked = true;
  const at = new Date().toISOString();
  for (const x of m.sim.sellerVouchers) if (x.status === STATUS.REDEEMED_PENDING) transition(x, STATUS.SETTLED, at, `settled by ${m.txs.settlement.hash}`);
  save();
}
writeEvidence(buildEvidence(m, v));
if (!allOk) { log('verification failed; reports stay locked, no receipt anchored'); process.exit(1); }

// ---- 7. linked audit receipt, anchored by one AccountSet memo from Eterna ------------------------------------------------
if (!m.receipt) {
  const facts = Object.fromEntries(Object.entries(v).map(([k, r]) => [k, { ok: r.ok, readers: r.per.map((p) => ({ reader: p.reader, ok: p.ok, ledger_hash: p.ledger_hash ?? null })), facts: JSON.parse(JSON.stringify(r.per[0]?.facts ?? {}, (_, x) => (typeof x === 'bigint' ? String(x) : x))) }]));
  const body = { type: 'eterna.audit-receipt.v1', scenario: 'rose-unified-commerce', network: 'XRPL Devnet', certificate: m.certificate, certificateDigest: m.certificateDigest, approval: m.approval,
    transactions: Object.fromEntries(['agentCreate', 'delegateSet', 'settlement'].map((k) => [k, { hash: m.txs[k].hash, ledger: m.txs[k].ledger }])),
    voucherBatch: { digest: m.sim.batch.batchDigest, voucherDigests: m.sim.batch.vouchers.map((x) => x.digest), redeemedCumulativeDrops: m.sim.batch.redeemedCumulativeDrops, ...SIM },
    reportDigests: m.sim.reports.map((r) => r.reportDigest), refusals: m.sim.refusals, sellerProbes: m.sim.probes, verification: facts, readers: m.readers.map((r) => r.url), unlocked: m.unlocked };
  m.receipt = { body: JSON.parse(JSON.stringify(body, (k, x) => (typeof x === 'number' && !Number.isSafeInteger(x) ? String(x) : x))), digest: null };
  m.receipt.digest = digestOf(m.receipt.body); save();
}
log('receipt', m.receipt.digest);
await step('anchor', async (lls) => ({ meta: {}, ...signSingle(buildAnchor({ eterna: K.E.address, receiptDigest: m.receipt.digest, sequence: await seqOf(K.E.address), lastLedgerSequence: lls }), K.E.seed) }));
v.anchor = await verifyAnchor(readers, m);
log('verify anchor', v.anchor.ok ? 'VERIFIED' : JSON.stringify(v.anchor.per.map((p) => p.problems)));
log('evidence', writeEvidence(buildEvidence(m, v)));
readers.forEach((r) => r.close());
