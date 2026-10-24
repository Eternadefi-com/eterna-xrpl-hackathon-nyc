// Rose AGENT mission (XRPL Devnet only): certificate v2, recorded governance, ledger verification, receipt and evidence.
// The orchestration lives in run-agent-mission.mjs; this module has no submit path (verification is read-only).
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildMissionCertificate, approveCertificate, verifyCertificate, certificateDigest, createGovernance } from '../commerce/governance.mjs';
import { readTx, balanceDeltas, onAll, checks } from './verify.mjs';
import { verifySignatures } from './tx.mjs';
import { verifyBatch, SIM } from './voucher-sim.mjs';
import { DEVNET, MEMO, memoValues } from './common.mjs';
import * as x68 from '../xls68/xls68.mjs';

export const ROSE_APPROVAL_LABEL = 'Rose (fictional) — Devnet demo key held by the operator';
export const EVIDENCE_PATH = new URL('./evidence/evidence-rose-agent-mission.json', import.meta.url);
export const PRICES = Object.freeze({ report: '100000', premium: '250000' });
const copy = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

/** Mission certificate v2 for the agent mission. requester = the AI agent (account A + its simulator voucher key). */
export function agentCertificate({ missionId, agent, voucherKey, rose, seller, model, issuedAt, expiry }) {
  return buildMissionCertificate({ missionId, task: 'buy validated XRPL Devnet ledger reports',
    requester: { id: agent, kind: 'ai-agent', xrpl: agent, voucherKey: voucherKey.toLowerCase(), runtime: 'ollama', model },
    payer: { xrpl: rose, name: 'Rose (fictional persona)' }, sellers: [seller], rails: ['ap4m-voucher'], networks: ['xrpl:2'],
    limits: { XRP: { perTx: '100000', total: '300000' } }, maxTransactions: 3, issuedAt, expiry });
}
/** Rose's approval, signed with the Devnet demo key the operator holds. Labelled as such; never a human signature. */
export const approveAsRoseDemo = (cert, roseDemoKey) => ({ ...approveCertificate(cert, roseDemoKey), label: ROSE_APPROVAL_LABEL, humanSignature: false });

/** The commerce engine with every state-changing call recorded (op, time, args), so a resumed run can replay it exactly. */
export function recordedGovernance({ certificate, approval, adapters, ops = [] }) {
  let fixed = null;
  const g = createGovernance({ certificate, approval, adapters, now: () => fixed ?? Date.now() });
  const log = [];
  const run = (op, args, at = Date.now()) => { fixed = at; try { const r = g[op](...args); log.push({ op, at, args: copy(args) }); return r; } finally { fixed = null; } };
  for (const o of ops) run(o.op, o.args, o.at);
  return { ...g, authorize: (q) => run('authorize', [q]), advance: (id, to, ref = {}) => run('advance', [id, to, ref ?? {}]), fail: (id, why = '') => run('fail', [id, why]),
    unlock: (id, ev) => run('unlock', [id, ev]), ops: () => copy(log) };
}

// ---- verification (read-only, every reader) ------------------------------------------------------------------------------
const accountInfo = async (r, account) => (await r.request('account_info', { account, ledger_index: 'validated' }))?.account_data ?? null;
const TF_SPONSOR_CREATED_ACCOUNT = x68.FLAGS.Payment.tfSponsorCreatedAccount;

export async function verifyAgentMission(readers, m) {
  const { E, R, S, A } = m.accounts, cd = m.certificateDigest, c = m.certificate, out = {};
  const L = c.limits.XRP;

  // reused from the earlier Rose mission: A is still E's sponsored account
  out['xls68-sponsorship'] = await onAll(readers, async (r) => {
    const t = await readTx(r, m.prior.txs.agentCreate.hash), a = await accountInfo(r, A);
    return { ledger_hash: t.ledger_hash, ledger_index: t.ledger_index, facts: { agentSponsor: a?.Sponsor, agentBalanceDrops: a?.Balance, reusedFrom: 'rose-unified-commerce' }, ...checks([
      [t.validated && t.hashMatches && t.meta?.TransactionResult === 'tesSUCCESS', 'agent create not validated tesSUCCESS'],
      [t.tx.TransactionType === 'Payment' && t.tx.Account === E && t.tx.Destination === A && ((t.tx.Flags ?? 0) & TF_SPONSOR_CREATED_ACCOUNT) !== 0, 'agent create fields'],
      [a?.Sponsor === E, 'agent AccountRoot.Sponsor != Eterna (validated state)']]) };
  });
  // reused: Rose's Payment-only delegation to A still exists
  out['xls75-delegation'] = await onAll(readers, async (r) => {
    const t = await readTx(r, m.prior.txs.delegateSet.hash);
    const entry = (await r.request('ledger_entry', { delegate: { account: R, authorize: A }, ledger_index: 'validated' }))?.node;
    const ePerms = (entry?.Permissions ?? []).map((p) => p.Permission.PermissionValue);
    return { ledger_hash: t.ledger_hash, ledger_index: t.ledger_index, facts: { permissions: ePerms, delegateEntrySponsor: entry?.Sponsor, grantedUnderCertificate: m.prior.certificateDigest, reusedFrom: 'rose-unified-commerce' }, ...checks([
      [t.validated && t.hashMatches && t.meta?.TransactionResult === 'tesSUCCESS', 'DelegateSet not validated tesSUCCESS'],
      [t.tx.TransactionType === 'DelegateSet' && t.tx.Account === R && t.tx.Authorize === A, 'DelegateSet fields'],
      [entry?.LedgerEntryType === 'Delegate' && entry.Account === R && entry.Authorize === A && ePerms.length === 1 && ePerms[0] === 'Payment', 'Delegate entry (validated state) is not Payment-only R->A']]) };
  });
  // governance: v2 certificate + approval verify; the approval key is the key that controls R on-ledger; digest on-ledger
  out.governance = await onAll(readers, async (r) => {
    const d = await readTx(r, m.prior.txs.delegateSet.hash), s = await readTx(r, m.txs.settlement.hash);
    return { ledger_hash: s.ledger_hash, ledger_index: s.ledger_index, facts: { certificateType: c.type, certificateDigest: cd, approvalKey: m.approval.publicKey, onLedgerRoseKey: d.tx.SigningPubKey, approvalLabel: m.approval.label }, ...checks([
      [certificateDigest(c) === cd && verifyCertificate(c, m.approval), 'certificate digest / approval signature'],
      [m.approval.label === ROSE_APPROVAL_LABEL && m.approval.humanSignature === false, 'approval label'],
      [d.tx.SigningPubKey === m.approval.publicKey && d.tx.Account === R, 'approval key is not the key that signed for R on-ledger'],
      [memoValues(s.tx, MEMO.certificate).includes(cd), 'certificate digest not in the settlement memo']]) };
  });
  // settlement: one delegated, fee-only sponsored Payment R -> S for exactly the redeemed voucher total
  const batch = verifyBatch(m.sim.batch, { sellerId: S, buyer: c.requester.voucherKey, certificateDigest: cd, perVoucherDrops: L.perTx, capDrops: L.total });
  out.settlement = await onAll(readers, async (r) => {
    const t = await readTx(r, m.txs.settlement.hash), sig = verifySignatures(t.tx), d = balanceDeltas(t.meta);
    const fee = BigInt(t.tx.Fee), amt = BigInt(t.tx.Amount);
    return { ledger_hash: t.ledger_hash, ledger_index: t.ledger_index, facts: { amountDrops: t.tx.Amount, voucherTotalDrops: batch.totalDrops, delivered: t.meta?.delivered_amount ?? t.meta?.DeliveredAmount,
      delegate: t.tx.Delegate, sponsor: t.tx.Sponsor, sponsorFlags: t.tx.SponsorFlags, feeDrops: t.tx.Fee, balanceDeltas: d, voucherSignaturesChecked: batch.signaturesChecked }, ...checks([
      [t.validated && t.hashMatches, 'tx not validated / hash mismatch'], [t.meta?.TransactionResult === 'tesSUCCESS', `result ${t.meta?.TransactionResult}`],
      [t.tx.TransactionType === 'Payment' && t.tx.Account === R && t.tx.Delegate === A && t.tx.Destination === S, 'Account/Delegate/Destination'],
      [batch.ok, `voucher batch: ${batch.problems.join('; ')}`], [t.tx.Amount === batch.totalDrops && t.tx.Amount === m.sim.batch.redeemedCumulativeDrops, 'amount != voucher total'],
      [amt <= BigInt(L.total), 'amount over the certificate total'],
      [memoValues(t.tx, MEMO.voucherBatch).includes(m.sim.batch.batchDigest) && memoValues(t.tx, MEMO.certificate).includes(cd), 'memo digests'],
      [sig.signer, 'agent (Delegate) signature'], [t.tx.Sponsor === E && t.tx.SponsorFlags === 1 && sig.sponsor === true, 'fee sponsorship fields / Eterna SPN signature'],
      [d[E] === (-fee).toString(), 'Eterna did not pay exactly the fee'], [d[R] === (-amt).toString(), 'Rose balance change'], [d[S] === amt.toString(), 'seller balance change'],
      [d[A] === undefined, 'agent balance changed']]) };
  });
  // refusal: nothing signed for the refused requests; on-ledger, the only Rose payment carrying this certificate is the settlement
  const signedIds = new Set(m.sim.signerCalls.map((x) => x.requestId));
  out.refusal = await onAll(readers, async (r) => {
    const txs = (await r.request('account_tx', { account: R, ledger_index_min: -1, ledger_index_max: -1, limit: 200 }))?.transactions ?? [];
    const pays = txs.map((x) => ({ ...(x.tx_json ?? x.tx), hash: x.hash ?? (x.tx_json ?? x.tx)?.hash })).filter((t) => t?.TransactionType === 'Payment' && t.Account === R);
    const mine = pays.filter((t) => memoValues(t, MEMO.certificate).includes(cd));
    const refusedAmounts = new Set(m.sim.refusals.map((f) => f.amountDrops));
    return { ledger_hash: null, facts: { codes: m.sim.refusals.map((f) => f.code), paymentsCarryingThisCertificate: mine.length, paymentsForRefusedAmounts: mine.filter((t) => refusedAmounts.has(t.Amount ?? t.DeliverMax)).length }, ...checks([
      [m.sim.refusals.length > 0 && m.sim.refusals.every((f) => f.signed === false && !signedIds.has(f.requestId)), 'a refused request reached the signer'],
      [mine.length === 1 && mine[0].hash === m.txs.settlement.hash, 'payments under this certificate other than the settlement'],
      [mine.every((t) => !refusedAmounts.has(t.Amount ?? t.DeliverMax)), 'a payment for a refused amount']]) };
  });
  // reports: each delivered report's validated ledger hash re-read from every reader
  out.reports = await onAll(readers, async (r) => {
    const bad = [];
    for (const rep of m.sim.reports) { const l = await r.request('ledger', { ledger_index: rep.ledger_index }); if ((l?.ledger_hash ?? l?.ledger?.ledger_hash) !== rep.ledger_hash || l?.validated !== true) bad.push(rep.ledger_index); }
    return { ledger_hash: null, facts: { reportsChecked: m.sim.reports.length }, ...checks([[m.sim.reports.length > 0 && bad.length === 0, `report ledgers mismatch ${bad}`]]) };
  });
  return out;
}

// ---- receipt and evidence (pure) -----------------------------------------------------------------------------------------
const flat = (v) => Object.fromEntries(Object.entries(v).map(([k, r]) => [k, { ok: r.ok, readers: r.per.map((p) => ({ reader: p.reader, ok: p.ok, ledger_hash: p.ledger_hash ?? null })), facts: copy(r.per[0]?.facts ?? {}) }]));
/** The linked audit receipt body. It carries the sha256 of the agent transcript file. */
export function buildAgentReceiptBody(m, v) {
  return copy({ type: 'eterna.audit-receipt.v2', scenario: 'rose-agent-mission', network: 'XRPL Devnet', certificate: m.certificate, certificateDigest: m.certificateDigest, approval: m.approval,
    agent: { runtime: 'ollama', model: m.model.name, modelDigest: m.model.digest, transcriptSha256: m.agent.transcriptSha256, transcriptFile: m.agent.transcriptFile, toolCalls: m.agent.toolCalls },
    governance: { decisions: m.unlocks.map((u) => ({ decisionId: u.decisionId, receiptDigest: u.receiptDigest, unlocked: u.unlocked })), refusals: m.sim.refusals.map((f) => ({ requestId: f.requestId, code: f.code, receiptDigest: f.receiptDigest, signed: false })) },
    signerCalls: m.sim.signerCalls,
    transactions: { agentCreate: { hash: m.prior.txs.agentCreate.hash, reused: true }, delegateSet: { hash: m.prior.txs.delegateSet.hash, reused: true }, settlement: { hash: m.txs.settlement.hash, ledger: m.txs.settlement.ledger } },
    voucherBatch: { digest: m.sim.batch.batchDigest, voucherDigests: m.sim.batch.vouchers.map((x) => x.digest), redeemedCumulativeDrops: m.sim.batch.redeemedCumulativeDrops, ...SIM },
    reportDigests: m.sim.reports.map((r) => r.reportDigest), verification: flat(v), readers: m.readers.map((r) => r.url), unlocked: m.unlocked === true });
}

const first = (v) => v?.per?.find((p) => p.ledger_index)?.ledger_index;
const status = (v) => (v?.ok ? 'VERIFIED' : v ? 'FAILED' : 'PENDING');
const txc = (hash) => (hash ? { txHash: hash, txUrl: DEVNET.explorerTx(hash) } : {});
const problems = (v) => [...new Set((v?.per ?? []).flatMap((p) => p.problems ?? []))];
const led = (v) => (first(v) ? { ledger: first(v) } : {});

/** Evidence in the shape of evidence-rose-unified-commerce.json, plus `agent` and the premium-bundle `refusal`. */
export function buildAgentEvidence(m, v = {}) {
  const c = m.certificate, a = m.accounts, sim = m.sim ?? {};
  const f = (k) => ({ ...(v[k]?.per?.[0]?.facts ?? {}), readersAgreeing: v[k]?.per?.filter((p) => p.ok).length ?? 0, ...(problems(v[k]).length ? { problems: problems(v[k]) } : {}) });
  const refusal = sim.refusals?.[0];
  const components = [
    { key: 'governance', label: 'Mission certificate v2 approved for Rose', status: status(v.governance), ...led(v.governance),
      detail: `Eterna issued certificate v2 (requester: the AI agent; payer: Rose). Approval: "${ROSE_APPROVAL_LABEL}". It is the key that signs for Rose's account on Devnet; it is not a human signature. The certificate digest is in the settlement memo.`,
      facts: { ...f('governance'), task: c?.task, approvedSeller: a?.S, limits: c?.limits, maxTransactions: c?.maxTransactions } },
    { key: 'xls68-sponsorship', label: 'XLS-68: the agent account is sponsored by Eterna (reused)', status: status(v['xls68-sponsorship']), ...txc(m.prior?.txs?.agentCreate?.hash), ...led(v['xls68-sponsorship']),
      detail: 'The agent account A was created by Eterna as a sponsored account in the earlier Rose mission; re-verified now from every reader.', facts: f('xls68-sponsorship') },
    { key: 'xls75-delegation', label: 'XLS-75: Rose delegates Payment to the agent (reused)', status: status(v['xls75-delegation']), ...txc(m.prior?.txs?.delegateSet?.hash), ...led(v['xls75-delegation']),
      detail: 'The Payment-only delegation R->A from the earlier Rose mission still exists on the validated ledger.', facts: f('xls75-delegation') },
    { key: 'agent-decisions', label: `AI agent decisions (${m.model?.name} on local Ollama)`, status: 'RECORDED',
      detail: 'A local LLM chose every tool call. This is a transcript recorded by Eterna\'s tool host, not ledger proof; its sha256 is in the anchored audit receipt.',
      facts: { runtime: 'ollama', model: m.model?.name, modelDigest: m.model?.digest, transcriptFile: m.agent?.transcriptFile, transcriptSha256: m.agent?.transcriptSha256, toolCalls: m.agent?.toolCalls, decisions: m.agent?.decisions } },
    { key: 'voucher-sim', label: 'AP4M voucher model (simulated)', status: 'SIMULATED',
      detail: `Local x402-style seller; Eterna's signer issued ${sim.batch?.voucherCount ?? 0} cumulative EIP-712 voucher(s) from Eterna's local simulator after governance PERMIT. Not Mastercard.`,
      facts: { ...SIM, scheme: 'eterna-voucher-sim', vouchers: (sim.sellerVouchers ?? []).map((x) => ({ digest: x.digest, cumulativeDrops: x.message.cumulativeDrops, nonce: x.message.nonce, status: x.status })),
        batchDigest: sim.batch?.batchDigest, redeemedCumulativeDrops: sim.batch?.redeemedCumulativeDrops, reportLedgersRecheckedOnAllReaders: v.reports?.ok === true } },
    { key: 'settlement', label: 'Simulated AP4M redemption settled by Eterna on XRPL Devnet', status: status(v.settlement), ...txc(m.txs?.settlement?.hash), ...led(v.settlement),
      detail: 'One delegated Payment Rose -> seller for the redeemed voucher total, signed by the agent account A (Delegate) in the operator process, fee paid by Eterna (SponsorFlags 1). Not a Mastercard settlement.', facts: f('settlement') },
    { key: 'refusal', label: `Premium ledger bundle refused before signing (${refusal?.code ?? 'none'})`, status: refusal ? 'RECORDED' : 'PENDING',
      detail: 'Eterna governance refused the premium bundle before anything was signed; the refusal is Eterna\'s record. The ledger check shows no Rose payment under this certificate other than the settlement.',
      facts: { code: refusal?.code, reason: refusal?.reason, item: refusal?.item, amountDrops: refusal?.amountDrops, perTxDrops: c?.limits?.XRP?.perTx, signed: false, receiptDigest: refusal?.receiptDigest,
        signerCallsForRefusedRequests: (sim.signerCalls ?? []).filter((x) => (sim.refusals ?? []).some((r) => r.requestId === x.requestId)).length,
        ledgerCheck: { status: status(v.refusal), ...f('refusal') } } },
    { key: 'audit-receipt', label: 'Linked audit receipt (with the agent transcript hash) anchored on Devnet', status: status(v.anchor), ...txc(m.txs?.anchor?.hash), ...led(v.anchor),
      detail: 'sha256 over the certificate, approval, governance decisions and refusals, the agent transcript hash, the tx hashes, voucher and report digests and the verification facts; anchored by one AccountSet memo from Eterna.',
      facts: { digest: m.receipt?.digest, transcriptSha256: m.receipt?.body?.agent?.transcriptSha256, readersAgreeing: v.anchor?.per?.filter((p) => p.ok).length ?? 0 } },
    { key: 'mastercard-network', label: 'Mastercard Agent Pay for Machines network', status: 'PENDING', detail: 'No Mastercard AP4M sandbox access; vouchers are simulated locally.', facts: { connected: false } },
  ];
  return {
    scenario: 'rose-agent-mission', network: 'XRPL Devnet', generatedAt: new Date().toISOString(), readers: m.readers?.map((r) => r.url) ?? [],
    mission: { certificateType: c?.type, certificateDigest: m.certificateDigest, agent: a?.A, rose: a?.R, seller: a?.S, sponsor: a?.E, perTxDrops: c?.limits?.XRP?.perTx, totalDrops: c?.limits?.XRP?.total, maxTransactions: c?.maxTransactions, expiry: c?.expiry, approvalLabel: m.approval?.label },
    agent: { runtime: 'ollama', model: m.model?.name, modelDigest: m.model?.digest, transcriptSha256: m.agent?.transcriptSha256, transcriptFile: m.agent?.transcriptFile, toolCalls: m.agent?.toolCalls, decisions: m.agent?.decisions, summary: m.agent?.finish?.summary ?? null },
    components, unlocked: m.unlocked === true, reports: m.unlocked === true ? sim.reports ?? [] : [],
    auditReceipt: { digest: m.receipt?.digest ?? null, transcriptSha256: m.receipt?.body?.agent?.transcriptSha256 ?? null, anchorTx: m.txs?.anchor?.hash ?? null, anchorUrl: m.txs?.anchor?.hash ? DEVNET.explorerTx(m.txs.anchor.hash) : null },
  };
}
export function writeAgentEvidence(ev, path = EVIDENCE_PATH) {
  mkdirSync(new URL('./', path), { recursive: true });
  writeFileSync(path, JSON.stringify(ev, null, 2) + '\n');
  return path.pathname ?? String(path);
}
