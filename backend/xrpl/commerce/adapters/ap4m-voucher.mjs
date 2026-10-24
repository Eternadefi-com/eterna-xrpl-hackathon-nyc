// Adapter: AP4M-style voucher commerce, SIMULATED. Wraps unified/voucher-sim.mjs (Eterna's local model of Mastercard
// Agent Pay for Machines as publicly described). Not Mastercard; every object says so.
// Lifecycle: 402 challenge -> voucher signed only after governance PERMIT -> VOUCHER_VERIFIED by the seller ->
// REDEEMED (batched, REDEEMED_PENDING) -> SETTLED only with separate settlement evidence from a LIVE rail (today: the
// XLS-68/75 delegated Devnet Payment) -> VERIFIED -> UNLOCKED. A signed voucher is never settlement.
import { paymentRequired, verifyBatch, voucherHash, DOMAIN, TYPES, SIM, SCHEME, NETWORK } from '../../unified/voucher-sim.mjs';
import { evidence } from '../contract.mjs';

const b32 = (h) => (h.startsWith('0x') ? h : `0x${h}`).toLowerCase();
const adapter = {
  id: 'ap4m-voucher', rail: 'ap4m-voucher', assets: ['XRP'], networks: ['xrpl:2'], mode: 'SIMULATED',
  describe: () => ({
    can: ['Answer HTTP 402 with an x402 v2-shaped requirement (scheme eterna-voucher-sim)',
      'Have the agent sign cumulative EIP-712 vouchers, only after an Eterna governance PERMIT',
      'Have the seller verify signature, seller binding, cumulative amount, nonce, cap and expiry; reject replays',
      'Batch vouchers for deferred redemption and reconcile the batch against a real ledger settlement'],
    cannot: ['Connect to Mastercard: there is no AP4M sandbox access; the vouchers are simulated locally',
      'Settle by itself: settlement evidence must come from another rail', 'Use Mastercard\'s real EIP-712 domain or types (unknown; see MASTERCARD_REQUIREMENTS.md)',
      'Claim VERIFIED for the voucher part: it stays SIMULATED'],
    proofConditions: { status: 'SIMULATED', facts: [{ fact: 'batchValid', equals: true }, { fact: 'voucherInBatch', equals: true },
      { fact: 'settlementStatus', equals: 'VERIFIED' }, { fact: 'settlementCoversBatch', equals: true }] },
    lifecycle: ['AUTHORIZED', 'VOUCHER_VERIFIED', 'REDEEMED', 'SETTLED', 'VERIFIED', 'UNLOCKED'],
  }),
  challenge: ({ amount, payTo, resource, description }) => paymentRequired({ url: resource, description, priceDrops: amount, sellerId: payTo }),
  /** UNSIGNED EIP-712 voucher draft. ctx: { session: { terms }, previousCumulativeDrops }. The decision fixes the nonce. */
  prepare(decision, { session, previousCumulativeDrops = '0' } = {}) {
    const q = decision.request, t = session?.terms;
    if (!t || t.sessionId !== q.voucher?.sessionId || t.seller !== q.seller) throw Object.assign(new Error('SESSION_MISMATCH'), { code: 'SESSION_MISMATCH' });
    const message = { sessionId: t.sessionId, buyer: t.buyer, seller: q.seller, cumulativeDrops: (BigInt(previousCumulativeDrops) + BigInt(q.amount)).toString(),
      nonce: String(q.voucher.nonce), expiry: t.expiry, certificateDigest: t.certificateDigest };
    if (BigInt(message.cumulativeDrops) > BigInt(t.capDrops)) throw Object.assign(new Error('CAP_EXCEEDED'), { code: 'CAP_EXCEEDED' });
    return { kind: 'unsigned-voucher', ...SIM, scheme: SCHEME, network: NETWORK, typedData: { domain: DOMAIN, types: { Voucher: TYPES.Voucher }, primaryType: 'Voucher', message },
      digest: voucherHash(message), signWith: 'Eterna governed agent signer (outside the adapter)' };
  },
  /** ref: { batch, voucherDigest, buyer, certificateDigest, perVoucherDrops, capDrops, settlement: <evidence from a LIVE rail> } */
  async verify(ref) {
    const b = ref.batch, s = ref.settlement;
    const check = verifyBatch(b, { sellerId: b.seller, buyer: ref.buyer, certificateDigest: ref.certificateDigest, perVoucherDrops: ref.perVoucherDrops, capDrops: ref.capDrops });
    const i = b.vouchers.findIndex((v) => v.digest === ref.voucherDigest);
    const inc = i < 0 ? null : (BigInt(b.vouchers[i].message.cumulativeDrops) - BigInt(i ? b.vouchers[i - 1].message.cumulativeDrops : 0)).toString();
    const facts = { ...SIM, network: NETWORK, asset: 'XRP', destination: b.seller, amount: inc, payer: s?.facts?.payer ?? null, batchDigest: b.batchDigest,
      batchValid: check.ok, voucherSignaturesChecked: check.signaturesChecked, voucherInBatch: i >= 0, redeemedCumulativeDrops: b.redeemedCumulativeDrops,
      settlementAdapter: s?.adapter ?? null, settlementStatus: s?.status ?? 'PENDING', settlementMode: s?.mode ?? null,
      settlementCoversBatch: s?.mode === 'LIVE_CAPABLE' && s?.facts?.amount === b.redeemedCumulativeDrops && s?.facts?.destination === b.seller
        && (s?.facts?.memos ?? []).some((m) => m.type === 'eterna/ap4m-sim-voucher-batch' && m.data === b.batchDigest),
      ...(check.problems.length ? { problems: check.problems } : {}) };
    const status = check.ok && i >= 0 ? 'SIMULATED' : 'FAILED';
    return evidence(adapter, status, facts, s?.txHash ? { txHash: s.txHash, txUrl: s.txUrl } : {});
  },
};
export default adapter;
