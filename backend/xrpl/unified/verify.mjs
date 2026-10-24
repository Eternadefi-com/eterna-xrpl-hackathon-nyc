// Independent verification: re-read every mission transaction and ledger object from each Devnet reader, decode the
// signed binary ourselves, re-check signatures and every field, and only mark a component VERIFIED when all readers
// prove it. Read-only (no submit). CLI: `node unified/verify.mjs` re-verifies the saved mission state and rewrites the
// evidence file.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as x68 from '../xls68/xls68.mjs';
import { verifySignatures } from './tx.mjs';
import { verifyBatch, SIM } from './voucher-sim.mjs';
import { verifyRoseApproval, certificateDigest } from './governance.mjs';
import { DEVNET, MEMO, memoValues, digestOf } from './common.mjs';

const require = createRequire(import.meta.url);
const codec = require('ripple-binary-codec');

export const EVIDENCE_PATH = new URL('./evidence/evidence-rose-unified-commerce.json', import.meta.url);
const TF_SPONSOR_CREATED_ACCOUNT = x68.FLAGS.Payment.tfSponsorCreatedAccount;

/** Fetch a tx in binary from one reader and decode it locally. */
export async function readTx(r, hash) {
  const res = await r.request('tx', { transaction: hash, binary: true });
  if (!res || res.error) return { reader: r.url, error: res?.error ?? 'no result' };
  const blob = res.tx_blob ?? res.tx;
  const tx = x68.decode(blob), meta = codec.decode(res.meta_blob ?? res.meta, x68.DEVNET_DEFINITIONS);
  const ledger = await r.request('ledger', { ledger_index: res.ledger_index });
  return { reader: r.url, tx, meta, validated: res.validated === true, ledger_index: res.ledger_index, ledger_hash: ledger?.ledger?.ledger_hash ?? ledger?.ledger_hash, hashMatches: x68.txHash(tx) === hash };
}
export const balanceDeltas = (meta) => {
  const out = {};
  for (const n of meta.AffectedNodes ?? []) {
    const node = n.ModifiedNode ?? n.CreatedNode ?? n.DeletedNode;
    if (node?.LedgerEntryType !== 'AccountRoot') continue;
    const fin = node.FinalFields ?? node.NewFields, prev = node.PreviousFields;
    if (fin?.Balance === undefined) continue;
    out[fin.Account] = (BigInt(fin.Balance) - BigInt(prev?.Balance ?? (n.CreatedNode ? '0' : fin.Balance))).toString();
  }
  return out;
};
const accountInfo = async (r, account) => (await r.request('account_info', { account, ledger_index: 'validated' }))?.account_data ?? null;

/** Run a check function against every reader; the component is proved only if every reader passes, and readers agree. */
export async function onAll(readers, fn) {
  const per = [];
  for (const r of readers) { try { per.push({ reader: r.url, ...(await fn(r)) }); } catch (e) { per.push({ reader: r.url, ok: false, problems: [e.message] }); } }
  const agree = per.every((p) => p.ledger_hash === per[0].ledger_hash);
  return { ok: per.every((p) => p.ok) && agree, per, agree };
}
export const checks = (list) => { const problems = list.filter(([ok]) => !ok).map(([, why]) => why); return { ok: problems.length === 0, problems }; };

/** Verify the on-ledger part of the mission. `m` = saved mission state. Returns component results keyed by component. */
export async function verifyMission(readers, m) {
  const { E, R, S, A } = m.accounts, cd = m.certificateDigest, out = {};
  const certOk = certificateDigest(m.certificate) === cd && verifyRoseApproval(m.certificate, m.approval);

  // XLS-68: sponsored account creation
  out['xls68-sponsorship'] = await onAll(readers, async (r) => {
    const t = await readTx(r, m.txs.agentCreate.hash);
    const created = (t.meta?.AffectedNodes ?? []).find((n) => n.CreatedNode?.LedgerEntryType === 'AccountRoot' && n.CreatedNode.NewFields?.Account === A)?.CreatedNode?.NewFields;
    const a = await accountInfo(r, A), e = await accountInfo(r, E);
    return { ledger_hash: t.ledger_hash, ledger_index: t.ledger_index, facts: { createdAccountSponsor: created?.Sponsor, agentSponsor: a?.Sponsor, agentBalanceDrops: a?.Balance,
      eternaSponsoringAccountCount: e?.SponsoringAccountCount ?? 0, eternaSponsoringOwnerCount: e?.SponsoringOwnerCount ?? 0 }, ...checks([
      [t.validated && t.hashMatches, 'tx not validated / hash mismatch'], [t.meta?.TransactionResult === 'tesSUCCESS', `result ${t.meta?.TransactionResult}`],
      [t.tx.TransactionType === 'Payment' && t.tx.Account === E && t.tx.Destination === A && t.tx.Amount === '1', 'tx fields'],
      [((t.tx.Flags ?? 0) & TF_SPONSOR_CREATED_ACCOUNT) !== 0, 'tfSponsorCreatedAccount not set'], [verifySignatures(t.tx).signer, 'Eterna signature'],
      [created?.Sponsor === E, 'created AccountRoot.Sponsor != Eterna'], [a?.Sponsor === E, 'agent AccountRoot.Sponsor != Eterna (validated state)'],
      [(e?.SponsoringAccountCount ?? 0) >= 1, 'Eterna SponsoringAccountCount < 1']]) };
  });

  // XLS-75: delegation (DelegateSet co-signed by Eterna as fee + reserve sponsor)
  out['xls75-delegation'] = await onAll(readers, async (r) => {
    const t = await readTx(r, m.txs.delegateSet.hash), sig = verifySignatures(t.tx);
    const entry = (await r.request('ledger_entry', { delegate: { account: R, authorize: A }, ledger_index: 'validated' }))?.node;
    const rose = await accountInfo(r, R), e = await accountInfo(r, E);
    const perms = (t.tx.Permissions ?? []).map((p) => p.Permission.PermissionValue), ePerms = (entry?.Permissions ?? []).map((p) => p.Permission.PermissionValue);
    return { ledger_hash: t.ledger_hash, ledger_index: t.ledger_index, facts: { permissions: perms, sponsorFlags: t.tx.SponsorFlags, delegateEntrySponsor: entry?.Sponsor,
      roseOwnerCount: rose?.OwnerCount, roseSponsoredOwnerCount: rose?.SponsoredOwnerCount ?? 0, eternaSponsoringOwnerCount: e?.SponsoringOwnerCount ?? 0,
      feePaidBy: Object.entries(balanceDeltas(t.meta)).filter(([, d]) => d.startsWith('-')).map(([k]) => k) }, ...checks([
      [t.validated && t.hashMatches, 'tx not validated / hash mismatch'], [t.meta?.TransactionResult === 'tesSUCCESS', `result ${t.meta?.TransactionResult}`],
      [t.tx.TransactionType === 'DelegateSet' && t.tx.Account === R && t.tx.Authorize === A, 'tx fields'],
      [perms.length === 1 && perms[0] === 'Payment', 'permissions not Payment-only'], [memoValues(t.tx, MEMO.certificate).includes(cd), 'certificate memo'],
      [t.tx.Sponsor === E && t.tx.SponsorFlags === m.txs.delegateSet.sponsorFlags, 'sponsor fields'], [sig.signer && sig.sponsor === true, 'signatures (Rose STX / Eterna SPN)'],
      [entry?.LedgerEntryType === 'Delegate' && entry.Account === R && entry.Authorize === A && ePerms.length === 1 && ePerms[0] === 'Payment', 'Delegate ledger entry'],
      [!(m.txs.delegateSet.sponsorFlags & 2) || entry?.Sponsor === E, 'Delegate entry Sponsor != Eterna']]) };
  });

  // governance: Rose's approval is by the key that controls R on the ledger, over the digest that the ledger carries
  out.governance = await onAll(readers, async (r) => {
    const t = await readTx(r, m.txs.delegateSet.hash);
    return { ledger_hash: t.ledger_hash, ledger_index: t.ledger_index, facts: { certificateDigest: cd, approvalKey: m.approval.publicKey, onLedgerRoseKey: t.tx.SigningPubKey }, ...checks([
      [certOk, 'certificate digest / Rose approval signature'], [t.tx.SigningPubKey === m.approval.publicKey && t.tx.Account === R, 'approval key is not the key Rose used on-ledger'],
      [memoValues(t.tx, MEMO.certificate).includes(cd), 'certificate digest not on ledger']]) };
  });

  // settlement: one delegated, fee-sponsored Payment for exactly the redeemed voucher total
  const batch = verifyBatch(m.sim.batch, { sellerId: S, buyer: m.certificate.agent.voucherKey, certificateDigest: cd, perVoucherDrops: m.certificate.limits.perVoucherDrops, capDrops: m.certificate.limits.capDrops });
  out.settlement = await onAll(readers, async (r) => {
    const t = await readTx(r, m.txs.settlement.hash), sig = verifySignatures(t.tx), d = balanceDeltas(t.meta);
    const fee = BigInt(t.tx.Fee), amt = BigInt(t.tx.Amount);
    return { ledger_hash: t.ledger_hash, ledger_index: t.ledger_index, facts: { amountDrops: t.tx.Amount, voucherTotalDrops: batch.totalDrops, delivered: t.meta?.delivered_amount ?? t.meta?.DeliveredAmount,
      sponsorFlags: t.tx.SponsorFlags, feeDrops: t.tx.Fee, balanceDeltas: d, voucherSignaturesChecked: batch.signaturesChecked }, ...checks([
      [t.validated && t.hashMatches, 'tx not validated / hash mismatch'], [t.meta?.TransactionResult === 'tesSUCCESS', `result ${t.meta?.TransactionResult}`],
      [t.tx.TransactionType === 'Payment' && t.tx.Account === R && t.tx.Delegate === A && t.tx.Destination === S, 'Account/Delegate/Destination'],
      [batch.ok, `voucher batch: ${batch.problems.join('; ')}`], [t.tx.Amount === batch.totalDrops && t.tx.Amount === m.sim.batch.redeemedCumulativeDrops, 'amount != voucher total'],
      [amt <= BigInt(m.certificate.limits.capDrops), 'amount over cap'],
      [memoValues(t.tx, MEMO.voucherBatch).includes(m.sim.batch.batchDigest) && memoValues(t.tx, MEMO.certificate).includes(cd), 'memo digests'],
      [sig.signer, 'agent (Delegate) signature'],
      ...(m.txs.settlement.feeSponsored ? [[t.tx.Sponsor === E && t.tx.SponsorFlags === 1 && sig.sponsor === true, 'fee sponsorship fields / Eterna SPN signature'],
        [d[E] === (-fee).toString(), 'Eterna did not pay exactly the fee']] : []),
      [d[R] === (m.txs.settlement.feeSponsored ? -amt : -(amt + fee)).toString(), 'Rose balance change'], [d[S] === amt.toString(), 'seller balance change'],
      [d[A] === undefined, 'agent balance changed']]) };
  });

  // refusal: the ledger shows Rose's only delegated payment went to the approved seller; nothing to the refused seller
  out.refusal = await onAll(readers, async (r) => {
    const txs = (await r.request('account_tx', { account: R, ledger_index_min: -1, ledger_index_max: -1, limit: 200 }))?.transactions ?? [];
    const pays = txs.map((x) => x.tx_json ?? x.tx).filter((t) => t?.TransactionType === 'Payment' && t.Account === R);
    const delegated = pays.filter((t) => t.Delegate), rogue = m.accounts.rogue;
    return { ledger_hash: null, facts: { refusals: m.sim.refusals.map((f) => f.code), rosePayments: pays.length, delegatedPayments: delegated.length, paymentsToRefusedSeller: pays.filter((t) => t.Destination === rogue).length }, ...checks([
      [m.sim.refusals.length > 0 && m.sim.refusals.every((f) => f.signed === false), 'no refusal recorded'],
      [delegated.length === 1 && delegated[0].Destination === S, 'delegated payments other than the settlement'],
      [pays.every((t) => t.Destination !== rogue), 'payment to refused seller']]) };
  });

  // reports: each delivered report's validated ledger hash is re-read from every reader
  out.reports = await onAll(readers, async (r) => {
    const bad = [];
    for (const rep of m.sim.reports) { const l = await r.request('ledger', { ledger_index: rep.ledger_index }); if ((l?.ledger_hash ?? l?.ledger?.ledger_hash) !== rep.ledger_hash || l?.validated !== true) bad.push(rep.ledger_index); }
    return { ledger_hash: null, facts: { reportsChecked: m.sim.reports.length }, ...checks([[bad.length === 0, `report ledgers mismatch ${bad}`]]) };
  });
  return out;
}

/** Verify the audit anchor AccountSet. */
export async function verifyAnchor(readers, m) {
  return onAll(readers, async (r) => {
    const t = await readTx(r, m.txs.anchor.hash);
    return { ledger_hash: t.ledger_hash, ledger_index: t.ledger_index, ...checks([
      [t.validated && t.hashMatches && t.meta?.TransactionResult === 'tesSUCCESS', 'anchor not validated tesSUCCESS'],
      [t.tx.TransactionType === 'AccountSet' && t.tx.Account === m.accounts.E && verifySignatures(t.tx).signer, 'anchor fields / signature'],
      [digestOf(m.receipt.body) === m.receipt.digest && memoValues(t.tx, MEMO.auditReceipt).includes(m.receipt.digest), 'receipt digest']]) };
  });
}

// ---- evidence -------------------------------------------------------------------------------------------------------
const first = (v) => v?.per?.find((p) => p.ledger_index)?.ledger_index;
const status = (v) => (v?.ok ? 'VERIFIED' : v ? 'FAILED' : 'PENDING');
const txc = (hash) => (hash ? { txHash: hash, txUrl: DEVNET.explorerTx(hash) } : {});
const problems = (v) => [...new Set((v?.per ?? []).flatMap((p) => p.problems ?? []))];

export function buildEvidence(m, v = {}) {
  const c = m.certificate, a = m.accounts, f = (k) => ({ ...(v[k]?.per?.[0]?.facts ?? {}), readersAgreeing: v[k]?.per?.filter((p) => p.ok).length ?? 0, ...(problems(v[k]).length ? { problems: problems(v[k]) } : {}) });
  const sim = m.sim ?? {}, settled = m.txs?.settlement;
  const components = [
    { key: 'governance', label: 'Mission certificate approved by Rose', status: status(v.governance), ...(first(v.governance) ? { ledger: first(v.governance) } : {}),
      detail: 'Eterna issued the mission certificate; Rose signed its digest with the key that controls her treasury, and the digest is carried on-ledger.', facts: { ...f('governance'), task: c?.task, approvedSeller: a?.S } },
    { key: 'xls68-sponsorship', label: 'XLS-68: Eterna creates and sponsors the agent account', status: status(v['xls68-sponsorship']), ...txc(m.txs?.agentCreate?.hash), ...(first(v['xls68-sponsorship']) ? { ledger: first(v['xls68-sponsorship']) } : {}),
      detail: 'Eterna created the agent account with a 1-drop sponsored-account Payment and carries its reserve.', facts: f('xls68-sponsorship') },
    { key: 'xls75-delegation', label: 'XLS-75: Rose delegates Payment to the agent', status: status(v['xls75-delegation']), ...txc(m.txs?.delegateSet?.hash), ...(first(v['xls75-delegation']) ? { ledger: first(v['xls75-delegation']) } : {}),
      detail: 'Rose granted the agent the Payment permission only; Eterna co-signed as fee and reserve sponsor of the Delegate entry.', facts: f('xls75-delegation') },
    { key: 'voucher-sim', label: 'AP4M voucher model (simulated)', status: 'SIMULATED',
      detail: `Local x402-style seller; the agent bought ${sim.reports?.length ?? 0} reports with cumulative EIP-712 vouchers from Eterna's local simulator, not Mastercard.`,
      facts: { ...SIM, scheme: 'eterna-voucher-sim', vouchers: (sim.sellerVouchers ?? []).map((x) => ({ digest: x.digest, cumulativeDrops: x.message.cumulativeDrops, nonce: x.message.nonce, status: x.status })),
        batchDigest: sim.batch?.batchDigest, redeemedCumulativeDrops: sim.batch?.redeemedCumulativeDrops, sellerRejections: (sim.probes ?? []).map((p) => p.code),
        reportLedgersRecheckedOnAllReaders: v.reports?.ok === true } },
    { key: 'settlement', label: 'Simulated AP4M redemption settled by Eterna on XRPL Devnet', status: status(v.settlement), ...txc(settled?.hash), ...(first(v.settlement) ? { ledger: first(v.settlement) } : {}),
      detail: `One delegated Payment from Rose to the seller for the redeemed voucher total, signed by the agent${settled?.feeSponsored ? ', fee paid by Eterna' : ''}. Not a Mastercard settlement.`, facts: f('settlement') },
    { key: 'refusal', label: 'Out-of-policy purchases refused before signing', status: status(v.refusal),
      detail: 'Eterna refused an over-limit voucher and a non-approved seller before anything was signed; the ledger shows no payment outside the mission.',
      facts: { ...f('refusal'), refused: (sim.refusals ?? []).map((r) => ({ code: r.code, seller: r.request.seller, amountDrops: r.request.amountDrops })) } },
    { key: 'audit-receipt', label: 'Linked audit receipt anchored on Devnet', status: status(v.anchor), ...txc(m.txs?.anchor?.hash), ...(first(v.anchor) ? { ledger: first(v.anchor) } : {}),
      detail: 'sha256 over all mission evidence, anchored by one AccountSet memo from Eterna and re-read from the ledger.', facts: { digest: m.receipt?.digest, readersAgreeing: v.anchor?.per?.filter((p) => p.ok).length ?? 0 } },
    { key: 'mastercard-network', label: 'Mastercard Agent Pay for Machines network', status: 'PENDING', detail: 'No Mastercard AP4M sandbox access; vouchers are simulated locally.', facts: { connected: false } },
  ];
  return {
    scenario: 'rose-unified-commerce', network: 'XRPL Devnet', generatedAt: new Date().toISOString(), readers: m.readers?.map((r) => r.url) ?? [],
    mission: { certificateDigest: m.certificateDigest, agent: a?.A, rose: a?.R, seller: a?.S, sponsor: a?.E, capDrops: c?.limits.capDrops, perVoucherDrops: c?.limits.perVoucherDrops, expiry: c?.expiry },
    components, unlocked: m.unlocked === true, reports: m.unlocked === true ? sim.reports ?? [] : [],
    auditReceipt: { digest: m.receipt?.digest ?? null, anchorTx: m.txs?.anchor?.hash ?? null, anchorUrl: m.txs?.anchor?.hash ? DEVNET.explorerTx(m.txs.anchor.hash) : null },
  };
}
export function writeEvidence(ev) {
  mkdirSync(new URL('./evidence/', import.meta.url), { recursive: true });
  writeFileSync(EVIDENCE_PATH, JSON.stringify(ev, null, 2) + '\n');
  return EVIDENCE_PATH.pathname;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadState } = await import('./store.mjs');
  const { reader, assertDevnet } = await import('./rpc.mjs');
  const m = loadState();
  const readers = [];
  for (const u of m.readers.map((r) => r.url)) { const r = reader(u); try { await assertDevnet(r); readers.push(r); } catch (e) { console.error(`reader ${u} unavailable: ${e.message}`); } }
  const v = await verifyMission(readers, m);
  if (m.txs.anchor) v.anchor = await verifyAnchor(readers, m);
  for (const [k, r] of Object.entries(v)) console.log(k.padEnd(18), r.ok ? 'VERIFIED' : 'FAILED', r.ok ? '' : JSON.stringify(r.per.map((p) => p.problems)));
  console.log(writeEvidence(buildEvidence(m, v)));
  readers.forEach((r) => r.close());
}
