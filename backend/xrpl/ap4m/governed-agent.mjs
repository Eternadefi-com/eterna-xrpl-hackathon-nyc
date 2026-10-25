// The governed AP4M purchase: the agent meets an HTTP 402 from the kit's x402 Merchant and decides to pay, but the agent
// key signs only after Eterna PERMITs the exact voucher. Order of operations (nothing is signed before step 4):
//   1. adapter.challenge()   GET /resource -> 402 PAYMENT-REQUIRED (the kit Merchant's own challenge)
//   2. readChannel()         the Channel on chain: agent, payout, cap (Authorized Spend Limit), redeemed, window, PSP ids
//   3. gov.authorize()       PERMIT | REFUSE (over-cap, wrong seller, wrong agent wallet, expired, replay ...) -> refusal receipt
//      adapter.prepare()     exact unsigned voucher; refuses (and releases the budget) if the on-chain cap would be exceeded
//   4. permit                Eterna governance signs a permit for exactly that voucher; the owner-side signer is armed with it
//   5. kit.buyResource()     the REAL kit signs through our signer, the Merchant redeems on chain, the resource is returned
// settleAndVerify() then reports the redemption, waits for the AP4M service's settlement, re-reads the chain from two
// readers and unlocks only on the adapter's proof conditions. The kit, signer and service client are injected, so the
// offline tests run the same code with clearly named STUBS (test-support.mjs) and make no "real" claim.
import { digestOf } from '../unified/common.mjs';
import adapter, { readChannel } from './adapter.mjs';
import { buildVoucherPermit, signPermit } from './owner-voucher-signer.mjs';
import { toEngineHash } from './voucher.mjs';

export async function governedPurchase({ gov, signer, issuePermit, kit, readers, resourceUrl, channelId, requester, payer, requestId, operation, stateDirectory, provider, fetch: f = fetch, now = () => Date.now(), permitTtlSeconds = 120 }) {
  const trace = [];
  const step = (name, detail) => trace.push({ step: name, at: new Date(now()).toISOString(), ...detail });
  const c = await adapter.challenge({ resourceUrl, channelId, fetch: f });
  step('402_CHALLENGE', { amountWei: c.amountWei.toString(), payTo: c.payTo, channelId: c.channelId, scheme: c.scheme });
  const channel = await readChannel(readers[0], channelId);
  step('CHANNEL_READ', { cap: channel.cap.toString(), redeemed: channel.redeemed.toString(), agent: channel.agent, payout: channel.payout, status: channel.status });
  const request = adapter.toRequest(c, { requestId, requester, payer, agent: signer.address });
  const a = gov.authorize(request);
  if (a.outcome === 'REFUSE') {
    step('REFUSED', { code: a.code, by: 'Eterna governance (before signing)' });
    return { outcome: 'REFUSED', code: a.code, refusal: a.refusal, receipt: gov.receipt(a.refusal), signed: false, signerLog: signer.log(), trace };
  }
  const d = a.decision;
  let draft;
  try { draft = gov.route(d, { challenge: c, channel, nowSeconds: Math.floor(now() / 1000) }); }
  catch (e) {
    if (!e.refusal) throw e;
    gov.fail(d, `${e.code}: refused before signing`);
    step('REFUSED', { code: e.code, by: 'Eterna adapter (before signing)', reason: e.message });
    return { outcome: 'REFUSED', code: e.code, reason: e.message, decision: d, receipt: gov.receipt(d.decisionId), signed: false, signerLog: signer.log(), trace };
  }
  step('PERMIT', { decisionId: d.decisionId, voucherDigest: draft.voucherDigest, cumulativeAmount: draft.cumulativeAmount });
  const permit = issuePermit(buildVoucherPermit({ decision: d, draft, certificateDigest: d.certificateDigest, expiresAt: new Date(now() + permitTtlSeconds * 1000).toISOString() }));
  signer.arm(permit);
  let purchase;
  try {
    purchase = await kit.buyResource({ context: kit.context, provider, wallet: signer, stateDirectory, resourceUrl, channelId, maximumAmount: draft.amountWei, operation: operation ?? `eterna-${d.decisionId.slice(4, 20)}`, requestFetch: f });
  } catch (e) {
    const signedVoucher = signer.log().some((x) => x.kind === 'Voucher' && x.voucherDigest === draft.voucherDigest);
    if (signedVoucher) {
      // A signed voucher may still be redeemed by the Merchant: keep the budget RESERVED and resume with the same operation
      // (the kit retains the signed payment and never pays twice). Never release budget for a voucher that exists.
      step('PURCHASE_UNRESOLVED', { code: e.code ?? null, reason: e.message });
      return { outcome: 'UNRESOLVED', code: e.code ?? 'KIT_ERROR', reason: e.message, decision: d, draft, signed: true, signerLog: signer.log(), trace };
    }
    gov.fail(d, `kit purchase failed before signing: ${e.code ?? ''} ${e.message}`.trim());
    step('PURCHASE_FAILED', { code: e.code ?? null, reason: e.message, signed: false });
    return { outcome: e.refusal ? 'REFUSED' : 'FAILED', code: e.code ?? 'KIT_ERROR', reason: e.message, decision: d, draft, receipt: gov.receipt(d.decisionId), signed: false, signerLog: signer.log(), trace };
  }
  gov.advance(d, 'VOUCHER_VERIFIED', { note: 'the kit Merchant accepted the signed voucher' });
  gov.advance(d, 'REDEEMED', { note: `redeemVoucher tx ${purchase.transactionHash}` });
  step('REDEEMED', { claimId: purchase.claimId, redemptionTx: purchase.transactionHash });
  return { outcome: 'PAID', decision: d, draft, permitDigest: digestOf((({ signature, ...b }) => b)(permit)), purchase, resource: purchase.resource, signerLog: signer.log(), trace };
}

/** After PAID: report the redemption, wait for the service's settlement, verify from >= 2 readers, unlock. */
export async function settleAndVerify({ gov, paid, service, readers, principal }) {
  const { decision: d, draft, purchase } = paid;
  await service.recordRedemption(purchase.transactionHash);
  const s = await service.settle(draft.channelId);
  const payoutTx = s.payout_tx, settlementTx = s.settlement_tx;
  gov.advance(d, 'SETTLED', { txHash: toEngineHash(payoutTx), note: `AP4M payout ${payoutTx}; SettlementRecorded ${settlementTx}` });
  const ev = await adapter.verify({ claimId: purchase.claimId, channelId: draft.channelId, redemptionTx: purchase.transactionHash, payoutTx, settlementTx, principal,
    expected: { voucherDigest: draft.voucherDigest, previousCumulativeAmount: draft.previousCumulativeAmount, cumulativeAmount: draft.cumulativeAmount, amountWei: draft.amountWei, payTo: draft.payTo, agent: draft.agent } }, readers);
  const unlock = gov.unlock(d, ev);
  return { evidence: ev, unlock, receipt: gov.receipt(d.decisionId), ap4mReceiptUrl: s.receipt_url ?? null };
}

/** Permit issuer for Eterna's governance key (xrpl keypair; signs a permit digest, which cannot move funds). */
export const permitIssuer = (governanceKey) => (body) => signPermit(body, governanceKey);
