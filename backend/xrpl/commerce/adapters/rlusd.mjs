// Adapter: RLUSD (Ripple USD) by a DIRECT issued-currency Payment, never a payment channel (XRP channels carry no tokens).
// Reuses lib/xrpl-asset-identity.mjs (identity, exactAmount, buildDirectPayment, issuedPaymentPreflight, verifyDelivered;
// commits dac1f07 / 60cb291) and the Testnet profile of lib/ny-testnet-profile.mjs + scripts/ny-testnet-rlusd-rehearsal.mjs
// (dc92f4a: issuer-flag bits, two independent Testnet readers). No RLUSD exists on Devnet.
// Status: PENDING until a real Testnet run is approved. Everything here is read-only or unsigned.
import { assetIdentity, registeredAssetIdentity, exactAmount, buildDirectPayment, issuedPaymentPreflight, verifyDelivered } from '../../lib/xrpl-asset-identity.mjs';
import { assertDelegationCompatible } from '../delegation.mjs';
import { evidence, x402Challenge, agreement } from '../contract.mjs';
import { NETWORKS } from '../readers.mjs';

// Issuer AccountRoot flags (same bits as scripts/ny-testnet-rlusd-rehearsal.mjs FLAGS).
const LSF = { requireAuth: 0x00040000, globalFreeze: 0x00400000, defaultRipple: 0x00800000, clawback: 0x80000000 };
const has = (flags, bit) => ((Number(flags ?? 0) >>> 0) & bit) !== 0;
const identityFor = (network) => registeredAssetIdentity(network, 'RLUSD');

/** Read-only preflight on one reader: issuer flags known, payer holds enough, destination trust line exists with room. */
export async function preflight(reader, { network, payer, destination, amount }) {
  const identity = identityFor(network), amt = exactAmount(identity, amount);
  const issuer = (await reader.request('account_info', { account: identity.issuer, ledger_index: 'validated' }))?.account_data;
  const lines = async (account) => (await reader.request('account_lines', { account, peer: identity.issuer, ledger_index: 'validated' }))?.lines ?? null;
  const [payerLines, recipientLines] = [await lines(payer), await lines(destination)];
  const issuerFlags = issuer ? { requireAuthorization: has(issuer.Flags, LSF.requireAuth), globalFreeze: has(issuer.Flags, LSF.globalFreeze),
    defaultRipple: has(issuer.Flags, LSF.defaultRipple), clawback: has(issuer.Flags, LSF.clawback), transferRate: issuer.TransferRate ?? null } : null;
  const checks = { issuerFound: !!issuer, issuerFlagsKnown: !!issuerFlags, noTransferFee: !!issuer && [undefined, 0, 1000000000].includes(issuer.TransferRate) };
  try {
    if (!issuer) throw Object.assign(new Error('PREFLIGHT_ISSUER_NOT_FOUND'), { code: 'PREFLIGHT_ISSUER_NOT_FOUND' });
    issuedPaymentPreflight({ identity, amount: amt, payerLines, recipientLines, issuerFlags });
    return { ok: true, reader: reader.url, issuerFlags, checks };
  } catch (e) { return { ok: false, code: e.code, reader: reader.url, issuerFlags, checks }; }
}

const adapter = {
  id: 'rlusd', rail: 'rlusd', assets: ['RLUSD'], networks: ['xrpl:0', 'xrpl:1'], mode: 'LIVE_CAPABLE',
  describe: () => ({
    can: ['Pay an exact RLUSD amount with a direct XRPL Payment (no partial-payment flag, no paths, no SendMax)',
      'Bind RLUSD to its issuer, currency code and network (Mainnet issuer rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De, Testnet rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV)',
      'Preflight read-only: issuer flags, payer balance, destination trust line and headroom',
      'Prove delivery from meta.delivered_amount on two readers, with the XRP fee reported separately',
      'Let an agent sign through an XLS-75 delegation'],
    cannot: ['Use a payment channel (XRP channels cannot carry tokens)', 'Run on Devnet (no RLUSD there)',
      'Accept a partial or short delivery', 'Run live until a Testnet run is approved (status PENDING)'],
    proofConditions: { status: 'VERIFIED', facts: [{ fact: 'validated', equals: true }, { fact: 'tesSUCCESS', equals: true }, { fact: 'deliveredExact', equals: true },
      { fact: 'readersAgreeing', min: 2 }, { fact: 'ledgerHashesAgree', equals: true }] },
    lifecycle: ['AUTHORIZED', 'SUBMITTED', 'SETTLED', 'VERIFIED', 'UNLOCKED'],
  }),
  challenge: ({ amount, payTo, network = 'xrpl:1', resource, description }) => {
    const id = identityFor(network); exactAmount(id, amount);
    return x402Challenge({ scheme: 'exact', network, amount, asset: { code: 'RLUSD', currency: id.currency, issuer: id.issuer }, payTo, resource, description,
      extra: { directPayment: true, partialPayment: false, note: 'Exact-amount direct Payment; delivered_amount must equal amount' } });
  },
  /** UNSIGNED exact-amount Payment. ctx: { delegate?, sequence, fee, lastLedgerSequence } */
  prepare(decision, { delegate, sequence = 0, fee = '12', lastLedgerSequence } = {}) {
    const q = decision.request, identity = assetIdentity({ network: q.network, asset: 'RLUSD', issuer: identityFor(q.network).issuer, currency: identityFor(q.network).currency });
    const tx = { ...buildDirectPayment({ identity, amount: exactAmount(identity, q.amount), account: q.payer, destination: q.seller, delegate }), Fee: fee, Sequence: sequence,
      ...(lastLedgerSequence ? { LastLedgerSequence: lastLedgerSequence } : {}) };
    if (delegate) assertDelegationCompatible(tx);
    return { kind: 'unsigned-tx', network: q.network, tx, preflightRequired: true, note: 'Unsigned. Run preflight() first; signing and submission are outside the adapter.' };
  },
  /** ref: { txHash, network, expected: { payer, destination, amount } } */
  async verify(ref, readers = []) {
    const identity = identityFor(ref.network), amount = exactAmount(identity, ref.expected.amount);
    if (!readers.length) return evidence(adapter, 'PENDING', { reason: 'no readers' }, { txHash: ref.txHash });
    const per = [];
    let shown = null;
    for (const r of readers) {
      try {
        const t = await r.request('tx', { transaction: ref.txHash });
        if (!t || t.error) { per.push({ reader: r.url, ok: false, pending: true, problems: [t?.error ?? 'no result'] }); continue; }
        const tx = t.tx_json ?? t, meta = t.meta ?? {}, d = meta.delivered_amount;
        const problems = [];
        try { verifyDelivered({ identity, amount, destination: ref.expected.destination, tx, meta }); } catch (e) { problems.push(e.code); }
        if (tx.Account !== ref.expected.payer) problems.push('PAYER_MISMATCH');
        if (t.validated !== true) problems.push('NOT_VALIDATED');
        const ledger = await r.request('ledger', { ledger_index: t.ledger_index });
        const facts = { network: ref.network, asset: 'RLUSD', issuer: identity.issuer, currency: identity.currency, payer: tx.Account, delegate: tx.Delegate ?? null,
          destination: tx.Destination, amount: typeof d === 'object' ? d.value : null, deliveredAmount: d ?? null, feeXrpDrops: tx.Fee,
          validated: t.validated === true, tesSUCCESS: meta.TransactionResult === 'tesSUCCESS', result: meta.TransactionResult, deliveredExact: problems.length === 0 };
        shown ??= facts;
        per.push({ reader: r.url, ok: problems.length === 0, final: t.validated === true, ledgerHash: ledger?.ledger_hash ?? ledger?.ledger?.ledger_hash, ledger: t.ledger_index, facts, problems });
      } catch (e) { per.push({ reader: r.url, ok: false, pending: true, problems: [e.message] }); }
    }
    const ag = agreement(per), problems = [...new Set(per.flatMap((p) => p.problems))];
    const status = per.some((p) => p.final && !p.ok) ? 'FAILED' : per.every((p) => p.ok) && ag.ledgerHashesAgree ? 'VERIFIED' : 'PENDING';
    return evidence(adapter, status, { ...(shown ?? {}), ...ag, ...(problems.length ? { problems } : {}), readers: per.map((p) => ({ reader: p.reader, ok: p.ok, ledgerHash: p.ledgerHash ?? null })) },
      { txHash: ref.txHash, ledger: per.find((p) => p.ledger)?.ledger, txUrl: NETWORKS[ref.network]?.explorer(ref.txHash) });
  },
};
export default adapter;
