// Rose AGENT mission on XRPL DEVNET ONLY: a real local LLM (Ollama, tool calling) is the decision-maker; Eterna's
// governance and signer stay in this operator process; the agent runs in a key-less child process (agent-process.mjs).
//   0 readers + definitions + amendments   1 reuse E/R/S/A + the R->A Payment delegation   2 certificate v2 + approval
//   3 the agent mission (transcript)   4 redeem   5 ONE delegated fee-sponsored Payment R->S   6 verify from two readers,
//   then unlock   7 audit receipt (with the transcript sha256) anchored by an AccountSet memo from E
// Resumable: state in ~/eterna-private/unified-devnet/agent-mission-state.json; every signed blob is saved before submit.
// Usage (from backend/xrpl): node unified/run-agent-mission.mjs [--model qwen3:30b-a3b]
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT } from '../xls68/xls68.mjs';
import { DEVNET, digestOf, fail } from './common.mjs';
import { reader, assertDevnet, faucetFund, submitAndWait, waitValidated } from './rpc.mjs';
import { xrplKey, simulatorWallet, DIR } from './store.mjs';
import { buildDelegatedSettlement, buildAnchor, signSingle, cosign } from './tx.mjs';
import { createSeller, startSellerServer, transition, STATUS, SIM } from './voucher-sim.mjs';
import { verifyAnchor } from './verify.mjs';
import { readDelegationGrant } from '../commerce/delegation.mjs';
import { certificateDigest, STATES } from '../commerce/governance.mjs';
import ap4m from '../commerce/adapters/ap4m-voucher.mjs';
import xls68 from '../commerce/adapters/xls68-sponsored.mjs';
import { createVoucherSigner, createToolHost, runAgent, instructionFor, agentDecisions, transcriptBytes, sha256 } from './agent-tools.mjs';
import { agentCertificate, approveAsRoseDemo, recordedGovernance, verifyAgentMission, buildAgentReceiptBody, buildAgentEvidence, writeAgentEvidence, PRICES } from './agent-mission.mjs';

const MODEL = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'qwen3:30b-a3b';
const OLLAMA = 'http://127.0.0.1:11434';
const PRIMARY = DEVNET.rpc, INDEPENDENT = ['wss://devnet.honeycluster.io/', 'https://clio.devnet.rippletest.net:51234'];
const STATE = join(DIR, 'agent-mission-state.json'), PRIOR = join(DIR, 'mission-state.json');
const log = (...a) => console.log('[agent-mission]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const m = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => { writeFileSync(`${STATE}.tmp`, JSON.stringify(m, null, 1), { mode: 0o600 }); chmodSync(`${STATE}.tmp`, 0o600); renameSync(`${STATE}.tmp`, STATE); };
const primary = reader(PRIMARY, { allowSubmit: true });

// ---- 0. readers, definitions, amendments ---------------------------------------------------------------------------------
const readers = [primary];
m.readers = [await assertDevnet(primary)];
for (const u of INDEPENDENT) {
  const r = reader(u);
  try { const id = await assertDevnet(r); if (id.hostid !== m.readers[0].hostid) { readers.push(r); m.readers.push(id); break; } } catch (e) { log(`independent reader ${u} unavailable: ${e.message}`); r.close(); }
}
if (readers.length < 2) throw fail('READERS', 'need two Devnet readers');
log(`${readers.length} readers:`, m.readers.map((r) => `${r.url} (${r.hostid})`).join(', '));
const defs = await primary.request('server_definitions');
if (defs.hash !== SNAPSHOT._meta.definitions_hash) throw fail('DEFINITIONS_CHANGED', `Devnet definitions ${defs.hash} != snapshot`);
for (const name of ['Sponsor', 'PermissionDelegationV1_1', 'fixCleanup3_4_0']) {
  const f = (await primary.request('feature', { feature: SNAPSHOT._meta.amendments[name].hash }))?.[SNAPSHOT._meta.amendments[name].hash];
  if (f?.enabled !== true) throw fail('AMENDMENT_DISABLED', name);
}

// ---- 1. reuse the existing Devnet accounts and delegation --------------------------------------------------------------------
const prior = JSON.parse(readFileSync(PRIOR, 'utf8'));
const K = { E: xrplKey('eterna'), R: xrplKey('rose'), S: xrplKey('seller'), A: xrplKey('agent') };
m.accounts = { E: K.E.address, R: K.R.address, S: K.S.address, A: K.A.address };
for (const k of ['E', 'R', 'S', 'A']) if (prior.accounts[k] !== m.accounts[k]) throw fail('ACCOUNTS', `${k} differs from the prior mission`);
m.prior = { scenario: 'rose-unified-commerce', certificateDigest: prior.certificateDigest, txs: { agentCreate: { hash: prior.txs.agentCreate.hash }, delegateSet: { hash: prior.txs.delegateSet.hash } } };
const info = async (a) => (await primary.request('account_info', { account: a, ledger_index: 'validated' }))?.account_data ?? null;
for (const role of ['E', 'R', 'S', 'A']) if (!(await info(K[role].address))) throw fail('ACCOUNT_MISSING', `${role} ${K[role].address} not on Devnet (reset?) - create new accounts with run-mission.mjs first`);
const grant = await readDelegationGrant(primary, { account: K.R.address, authorize: K.A.address });
if (!grant.exists || !grant.paymentOnly) throw fail('DELEGATION_MISSING', 'R->A Payment delegation not found');
const agentInfo = await info(K.A.address);
if (agentInfo.Sponsor !== K.E.address) throw fail('SPONSOR', 'A is not sponsored by E');
for (const role of ['E', 'R']) {
  if (BigInt((await info(K[role].address)).Balance) >= 20_000_000n) continue;
  log(`topping up ${role} from the Devnet faucet`); await faucetFund(K[role].address); await sleep(6000);
}
save();

// ---- 2. model, certificate v2, approval -----------------------------------------------------------------------------------
if (!m.model) {
  const tags = await (await fetch(`${OLLAMA}/api/tags`)).json(), version = await (await fetch(`${OLLAMA}/api/version`)).json();
  const t = tags.models.find((x) => x.name === MODEL);
  if (!t || !t.capabilities?.includes('tools')) throw fail('MODEL', `${MODEL} not available with tool support`);
  m.model = { name: t.name, digest: t.digest, details: t.details, capabilities: t.capabilities, ollamaVersion: version.version };
}
const wallet = simulatorWallet();
if (!m.certificate) {
  const now = new Date();
  m.missionId = `rose-agent-mission-${now.toISOString().slice(0, 10)}`;
  m.certificate = agentCertificate({ missionId: m.missionId, agent: K.A.address, voucherKey: wallet.address, rose: K.R.address, seller: K.S.address, model: m.model.name,
    issuedAt: now.toISOString(), expiry: new Date(now.getTime() + 4 * 3600e3).toISOString() });
  m.certificateDigest = certificateDigest(m.certificate);
  m.approval = approveAsRoseDemo(m.certificate, K.R.seed);
  m.govOps = []; save();
}
if (Date.now() >= Date.parse(m.certificate.expiry) && !m.txs?.settlement?.validated) throw fail('EXPIRED', 'certificate expired before settlement; move the state file aside to start over');
log('certificate v2', m.certificateDigest);
const gov = recordedGovernance({ certificate: m.certificate, approval: m.approval, adapters: [ap4m, xls68], ops: m.govOps });
const saveGov = () => { m.govOps = gov.ops(); save(); };

// ---- 3. the AI agent mission ---------------------------------------------------------------------------------------------
if (!m.agent) {
  const seller = createSeller({ sellerId: K.S.address });
  let lastLedger = 0;
  const ledgerHeader = async (after) => {
    let l;
    for (let i = 0; i < 10; i++) { l = await primary.request('ledger', { ledger_index: 'validated' }); if (Number(l.ledger_index) > after) break; await sleep(1500); }
    const L = l.ledger;
    return { ledger_index: Number(l.ledger_index), ledger_hash: l.ledger_hash, parent_hash: L.parent_hash, account_hash: L.account_hash, transaction_hash: L.transaction_hash, close_time_iso: L.close_time_iso, total_coins: L.total_coins, validated: l.validated === true };
  };
  const produce = async (voucher) => {
    const h = await ledgerHeader(lastLedger); lastLedger = h.ledger_index;
    const body = { kind: 'xrpl-devnet-validated-ledger-report', network: 'XRPL Devnet', source: PRIMARY, ...h, soldBy: K.S.address, deliveredUnder: { voucherDigest: voucher.digest, cumulativeDrops: voucher.message.cumulativeDrops } };
    return { ...body, reportDigest: digestOf(body) };
  };
  const produceBundle = async (voucher) => { const hs = []; for (let i = 0; i < 5; i++) hs.push(await ledgerHeader(hs.at(-1)?.ledger_index ?? lastLedger)); const body = { kind: 'xrpl-devnet-premium-ledger-bundle', ledgers: hs, deliveredUnder: { voucherDigest: voucher.digest } }; return { ...body, reportDigest: digestOf(body) }; };
  const items = [{ name: 'Validated ledger report', path: '/report', priceDrops: PRICES.report, description: 'The latest validated XRPL Devnet ledger header (index, hash, parent, state and tx tree hashes, close time).' },
    { name: 'Premium ledger bundle', path: '/premium-bundle', priceDrops: PRICES.premium, description: 'Five consecutive validated XRPL Devnet ledger headers.' }];
  let shopUrl;
  const shop = await startSellerServer({ seller, routes: {
    '/catalog': { free: true, produce: async () => ({ seller: 'Devnet ledger data vendor (local test seller)', payTo: K.S.address, network: 'XRPL Devnet', paymentScheme: 'x402-style 402, scheme eterna-voucher-sim (simulated)',
      items: items.map((i) => ({ name: i.name, url: `${shopUrl}${i.path}`, priceDrops: i.priceDrops, priceXRP: (Number(i.priceDrops) / 1e6).toString(), description: i.description })) }) },
    '/report': { priceDrops: PRICES.report, description: items[0].name, produce },
    '/premium-bundle': { priceDrops: PRICES.premium, description: items[1].name, produce: produceBundle } } });
  shopUrl = shop.url;
  const signer = createVoucherSigner({ wallet, governance: gov, certificate: m.certificate, certificateDigest: m.certificateDigest });
  const host = createToolHost({ governance: gov, signer, certificate: m.certificate, certificateDigest: m.certificateDigest, sellerOrigin: shop.url });
  log(`agent: ${m.model.name} (${m.model.digest.slice(0, 12)}), seller ${shop.url}`);
  let transcript;
  try {
    transcript = await runAgent({ toolHost: host, ollamaUrl: OLLAMA, model: m.model.name, modelInfo: m.model, user: instructionFor({ catalogUrl: `${shop.url}/catalog`, seller: K.S.address }),
      probePath: DIR, missionId: m.missionId, onEvent: (e) => {
        if (e.kind === 'tool_call') log(`  agent -> ${e.name} ${JSON.stringify(e.arguments).slice(0, 160)}`);
        if (e.kind === 'tool_result') log(`  tool  <- ${JSON.stringify(e.result).slice(0, 160)}`);
        if (e.kind === 'isolation_probe') log(`  isolation probe on the key directory: readable=${e.readable} (${e.code})`);
      } });
  } finally { await shop.close(); }
  const probe = transcript.events.find((e) => e.kind === 'isolation_probe');
  if (probe?.readable !== false) throw fail('ISOLATION', 'the agent process could list the key directory');
  probe.path = '~/eterna-private/unified-devnet';
  const st = host.state();
  // the agent's work is done: the seller batches the verified vouchers for redemption
  const sess = [...seller.sessions.values()][0];
  const batch = sess ? seller.redeem(sess.terms.sessionId) : null;
  for (const p of st.payments) gov.advance(p.decisionId, STATES.REDEEMED, { note: `in redemption batch ${batch.batchDigest}` });
  const date = new Date().toISOString().slice(0, 10);
  const file = `agent-transcript-${date}.json`, bytes = transcriptBytes(transcript);
  mkdirSync(new URL('./evidence/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`./evidence/${file}`, import.meta.url), bytes);
  m.agent = { transcriptFile: `unified/evidence/${file}`, transcriptSha256: sha256(bytes), toolCalls: transcript.toolCalls, decisions: agentDecisions(transcript), finish: transcript.finish, isolationProbe: { readable: probe.readable, code: probe.code } };
  m.sim = { ...SIM, reports: st.held.map((h) => h.report), payments: st.payments, refusals: st.refusals, signerCalls: signer.calls(), agentVouchers: st.vouchers,
    sellerVouchers: sess?.accepted ?? [], batch };
  m.unlocked = false; saveGov();
  log(`transcript ${m.agent.transcriptFile} sha256 ${m.agent.transcriptSha256}; ${m.agent.toolCalls} tool calls`);
  log(`purchases: ${st.payments.length}; refusals: ${st.refusals.map((r) => r.code).join(', ') || 'none'}`);
}
if (!m.sim.batch) { log('the agent bought nothing; nothing to settle'); writeAgentEvidence(buildAgentEvidence(m, {})); process.exit(1); }
if (!m.sim.refusals.some((r) => r.code === 'PER_TX_EXCEEDED')) log('WARNING: the agent did not request the premium bundle; no PER_TX_EXCEEDED refusal was produced');

// ---- 5. settlement: ONE delegated Payment R -> S signed by A, fee-only sponsored by E ----------------------------------------
m.txs ??= {};
async function step(name, build) { // same resumable step as run-mission.mjs
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
  if (saved.result !== 'tesSUCCESS') throw fail(saved.result, `${name} validated with ${saved.result}; stopping`);
  log(`${name} ${saved.hash} validated in ledger ${saved.ledger}`);
  return saved;
}
const seqOf = async (a) => (await info(a)).Sequence;
await step('settlement', async (lls) => ({ meta: { feeSponsored: true }, ...cosign(buildDelegatedSettlement({ rose: K.R.address, agent: K.A.address, seller: K.S.address, sponsor: K.E.address,
  amountDrops: m.sim.batch.redeemedCumulativeDrops, batchDigest: m.sim.batch.batchDigest, certificateDigest: m.certificateDigest, sequence: await seqOf(K.R.address), lastLedgerSequence: lls }),
  { signerKey: K.A.seed, sponsorKey: K.E.seed }) }));
for (const p of m.sim.payments) if (gov.decisions.get(p.decisionId).state === STATES.REDEEMED) gov.advance(p.decisionId, STATES.SETTLED, { txHash: m.txs.settlement.hash });
saveGov();

// ---- 6. verification from two readers, then the governance unlock --------------------------------------------------------------
const v = await verifyAgentMission(readers, m);
for (const [k, r] of Object.entries(v)) log('verify', k.padEnd(18), r.ok ? 'VERIFIED' : `FAILED ${JSON.stringify(r.per.map((p) => p.problems))}`);
const allOk = Object.values(v).every((r) => r.ok);
if (allOk && !m.unlocked) {
  const settlementEv = await xls68.verify({ txHash: m.txs.settlement.hash, expected: { sponsor: K.E.address, sponsorFlags: 1 } }, readers);
  m.unlocks = [];
  for (const p of m.sim.payments) {
    const ev = await ap4m.verify({ batch: m.sim.batch, voucherDigest: p.voucherDigest, buyer: m.certificate.requester.voucherKey, certificateDigest: m.certificateDigest,
      perVoucherDrops: m.certificate.limits.XRP.perTx, capDrops: m.certificate.limits.XRP.total, settlement: settlementEv });
    const u = gov.unlock(p.decisionId, ev);
    m.unlocks.push({ decisionId: p.decisionId, unlocked: u.unlocked === true, ...(u.unmet?.length ? { unmet: u.unmet } : {}), receiptDigest: gov.receipt(p.decisionId).digest, settlementEvidenceStatus: settlementEv.status });
  }
  m.unlocked = m.unlocks.length > 0 && m.unlocks.every((u) => u.unlocked);
  if (m.unlocked) { const at = new Date().toISOString(); for (const x of m.sim.sellerVouchers) if (x.status === STATUS.REDEEMED_PENDING) transition(x, STATUS.SETTLED, at, `settled by ${m.txs.settlement.hash}`); }
  saveGov();
}
writeAgentEvidence(buildAgentEvidence(m, v));
if (!allOk || !m.unlocked) { log('verification or unlock failed; reports stay locked, no receipt anchored', JSON.stringify(m.unlocks ?? [])); process.exit(1); }

// ---- 7. audit receipt with the transcript hash, anchored by one AccountSet memo from E ---------------------------------------
const tbytes = readFileSync(new URL(`../${m.agent.transcriptFile}`, import.meta.url));
if (sha256(tbytes) !== m.agent.transcriptSha256) throw fail('TRANSCRIPT_CHANGED', 'transcript file no longer matches its recorded sha256');
if (!m.receipt) { const body = buildAgentReceiptBody(m, v); m.receipt = { body, digest: digestOf(body) }; save(); }
log('receipt', m.receipt.digest);
await step('anchor', async (lls) => ({ meta: {}, ...signSingle(buildAnchor({ eterna: K.E.address, receiptDigest: m.receipt.digest, sequence: await seqOf(K.E.address), lastLedgerSequence: lls }), K.E.seed) }));
v.anchor = await verifyAnchor(readers, m);
log('verify anchor', v.anchor.ok ? 'VERIFIED' : JSON.stringify(v.anchor.per.map((p) => p.problems)));
log('evidence', writeAgentEvidence(buildAgentEvidence(m, v)));
readers.forEach((r) => r.close());
