// Adapter: XRP micropayments over an XRPL payment channel. The PROVEN path is the purchase worker + tools/paychan-demo on
// branch codex/ny-agent-orchestration-v1 (ny-combined-staging, HEAD 67a0014). This adapter does NOT execute: execution
// stays with that worker. Only pure pieces are ported:
//   - the 402 challenge body from tools/paychan-demo/src/seller-agent.mjs (commit f0c4e1c),
//   - the seller-side claim acceptance (ClaimAcceptor.accept, dropsToXrp) from tools/paychan-demo/src/claims.mjs (32fb894).
// verify() checks the worker's recorded execution (ownerView.execution: redeemTx, readers, deliveryDigest) and, given
// readers, re-reads the PaymentChannelClaim from each one (read-only).
import { createRequire } from 'node:module';
import { evidence, x402Challenge, agreement } from '../contract.mjs';
import { NETWORKS } from '../readers.mjs';

const require = createRequire(import.meta.url);
const { verifyPaymentChannelClaim } = require('xrpl');

// ---- ported from claims.mjs @ 32fb894 (unchanged logic) ------------------------------------------------------------
export const dropsToXrp = (drops) => {
  const b = BigInt(drops); const whole = b / 1000000n; const frac = (b % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};
/** Seller side: accept a claim and deliver only if it is worth more than what was already accepted. */
export class ClaimAcceptor {
  constructor({ sellerAccount, now = () => Math.floor(Date.now() / 1000), expiryMarginSec = 60 }) {
    Object.assign(this, { sellerAccount, now, expiryMarginSec }); this.accepted = new Map();
  }
  accept(claim, channel, priceDrops) {
    const fail = (c) => ({ ok: false, code: c });
    if (!channel.evidenceOk) return fail('UNKNOWN_EVIDENCE');
    if (channel.destination !== this.sellerAccount) return fail('NOT_MY_CHANNEL');
    if (claim.publicKey.toUpperCase() !== channel.publicKey.toUpperCase()) return fail('KEY_MISMATCH');
    if (this.now() >= channel.expiresUnix - this.expiryMarginSec) return fail('CHANNEL_EXPIRING');
    if (BigInt(claim.cumulativeDrops) > BigInt(channel.amountDrops)) return fail('EXCEEDS_CHANNEL_FUNDS');
    if (!verifyPaymentChannelClaim(claim.channelId, dropsToXrp(claim.cumulativeDrops), claim.signature, claim.publicKey)) return fail('BAD_SIGNATURE');
    const prev = BigInt(this.accepted.get(claim.channelId) ?? channel.balanceDrops ?? '0');
    if (BigInt(claim.cumulativeDrops) - prev < BigInt(priceDrops)) return fail('UNDERPAID');
    this.accepted.set(claim.channelId, claim.cumulativeDrops);
    return { ok: true, newlyPaidDrops: (BigInt(claim.cumulativeDrops) - prev).toString() };
  }
}

const HASH = /^[0-9A-F]{64}$/;
const adapter = {
  id: 'xrp-paychan', rail: 'xrp-paychan', assets: ['XRP'], networks: ['xrpl:0', 'xrpl:2'], mode: 'LIVE_CAPABLE',
  describe: () => ({
    can: ['Pay per call in XRP with cumulative signed payment-channel claims (no ledger tx per call)',
      'Let the seller verify each claim offline before serving', 'Redeem the best claim in one PaymentChannelClaim',
      'Show recorded Mainnet purchases re-read from two independent Mainnet readers'],
    cannot: ['Carry RLUSD or any token (XRP payment channels are XRP-only)', 'Execute from this adapter: the purchase worker executes',
      'Spend more than the channel was funded with', 'Treat a signed claim as payment before the redeem tx validates'],
    proofConditions: { status: 'VERIFIED', facts: [{ fact: 'validated', equals: true }, { fact: 'tesSUCCESS', equals: true }, { fact: 'channelMatches', equals: true },
      { fact: 'claimCovered', equals: true }, { fact: 'recordedDelivered', equals: true }, { fact: 'readersAgreeing', min: 2 }, { fact: 'ledgerHashesAgree', equals: true }] },
    lifecycle: ['AUTHORIZED', 'VOUCHER_VERIFIED', 'REDEEMED', 'SETTLED', 'VERIFIED', 'UNLOCKED'],
  }),
  /** The paychan-demo 402 body (ported), wrapped in the x402 v2 shape. */
  challenge: ({ amount, payTo, network = 'xrpl:0', resource, description }) => {
    const legacy = { payment: 'xrpl-payment-channel', destination: payTo, priceDrops: amount };
    return { ...x402Challenge({ scheme: 'xrpl-payment-channel', network, amount, asset: 'XRP', payTo, resource, description,
      extra: { claimHeader: 'eterna-channel-claim', cumulative: true, legacy } }), ...legacy };
  },
  /** Claim DRAFT (unsigned). ctx: { channel: { channelId, publicKey, amountDrops }, previousCumulativeDrops } */
  prepare(decision, { channel, previousCumulativeDrops = '0' } = {}) {
    if (!HASH.test(channel?.channelId ?? '')) throw Object.assign(new Error('CHANNEL_REQUIRED'), { code: 'CHANNEL_REQUIRED' });
    const cumulative = BigInt(previousCumulativeDrops) + BigInt(decision.request.amount);
    if (cumulative > BigInt(channel.amountDrops)) throw Object.assign(new Error('EXCEEDS_CHANNEL_FUNDS'), { code: 'EXCEEDS_CHANNEL_FUNDS' });
    return { kind: 'unsigned-claim', network: decision.request.network, channelId: channel.channelId, publicKey: channel.publicKey, cumulativeDrops: cumulative.toString(),
      amountXrp: dropsToXrp(cumulative.toString()), signWith: 'tools/paychan-demo/src/claim-signer.mjs (certificate-bound signer, outside the adapter)',
      header: 'eterna-channel-claim' };
  },
  /** ref: { network, seller, payer, channelId, execution: ownerView.execution } */
  async verify(ref, readers = []) {
    const x = ref.execution ?? {};
    const recorded = { recordedSettled: x.settlement === 'SETTLED', recordedDelivered: x.deliveryStatus === 'DELIVERED', recordedReaders: (x.readers ?? []).length,
      deliveryDigest: x.deliveryDigest ?? null, redeemLedger: x.redeemLedger ?? null };
    const base = { network: ref.network, asset: 'XRP', destination: ref.seller, amount: x.paidDrops ?? null, claimDrops: x.claimDrops ?? null, ...recorded };
    if (!HASH.test(x.redeemTx ?? '')) return evidence(adapter, 'FAILED', { ...base, problems: ['no redeem tx recorded'] });
    if (!readers.length) return evidence(adapter, 'PENDING', { ...base, reason: 'recorded evidence only; re-read required' }, { txHash: x.redeemTx });
    const per = [];
    for (const r of readers) {
      try {
        const t = await r.request('tx', { transaction: x.redeemTx });
        if (!t || t.error) { per.push({ reader: r.url, ok: false, pending: true, problems: [t?.error ?? 'no result'] }); continue; }
        const tx = t.tx_json ?? t, meta = t.meta ?? {};
        const ch = (meta.AffectedNodes ?? []).map((n) => n.ModifiedNode ?? n.DeletedNode).find((n) => n?.LedgerEntryType === 'PayChannel');
        const ledger = await r.request('ledger', { ledger_index: t.ledger_index });
        const facts = { validated: t.validated === true, tesSUCCESS: meta.TransactionResult === 'tesSUCCESS', result: meta.TransactionResult,
          channelMatches: tx.TransactionType === 'PaymentChannelClaim' && tx.Channel === ref.channelId && tx.Account === ref.seller && ch?.FinalFields?.Destination === ref.seller,
          claimCovered: BigInt(ch?.FinalFields?.Balance ?? 0) >= BigInt(x.claimDrops ?? 1n << 62n),
          payer: ch?.FinalFields?.Account ?? null, channelBalanceDrops: ch?.FinalFields?.Balance ?? null,
          paidThisTxDrops: ch ? (BigInt(ch.FinalFields.Balance) - BigInt(ch.PreviousFields?.Balance ?? ch.FinalFields.Balance)).toString() : null, feeDrops: tx.Fee };
        const problems = Object.entries({ validated: facts.validated, tesSUCCESS: facts.tesSUCCESS, channelMatches: facts.channelMatches, claimCovered: facts.claimCovered }).filter(([, v]) => !v).map(([k]) => k);
        if (ref.payer && facts.payer !== ref.payer) problems.push('channel owner is not the payer');
        per.push({ reader: r.url, ok: problems.length === 0, final: t.validated === true, ledgerHash: ledger?.ledger_hash ?? ledger?.ledger?.ledger_hash, ledger: t.ledger_index, facts, problems });
      } catch (e) { per.push({ reader: r.url, ok: false, pending: true, problems: [e.message] }); }
    }
    const ag = agreement(per), problems = [...new Set(per.flatMap((p) => p.problems))];
    const status = per.some((p) => p.final && !p.ok) ? 'FAILED' : per.every((p) => p.ok) && ag.ledgerHashesAgree ? 'VERIFIED' : 'PENDING';
    return evidence(adapter, status, { ...base, ...(per.find((p) => p.facts)?.facts ?? {}), ...ag, ...(problems.length ? { problems } : {}), readers: per.map((p) => ({ reader: p.reader, ok: p.ok, ledgerHash: p.ledgerHash ?? null })) },
      { txHash: x.redeemTx, ledger: per.find((p) => p.ledger)?.ledger, txUrl: NETWORKS[ref.network]?.explorer(x.redeemTx) });
  },
};
export default adapter;
