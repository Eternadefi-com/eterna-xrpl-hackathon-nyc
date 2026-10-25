// Adapter: the REAL Mastercard AP4M hackathon kit on XRPL EVM Testnet (eip155:1449000), behind Eterna's one governance
// engine. Same adapter contract as commerce/adapters/*.mjs (describe / challenge / prepare / verify), so the product UI
// does not change. What is whose:
//   - the kit's x402 Merchant issues the HTTP 402 challenge, redeems the voucher on the PaymentLedger and serves the resource;
//   - the AP4M service (Mastercard's hackathon deployment) opens Channels, pays RLUSD from the PooledEscrowVault and records
//     the settlement; its test PSPs attest the agent authority and the merchant (ids read from chain, never invented here);
//   - Eterna decides: PERMIT or REFUSE before any signature (governance.mjs), drafts the exact voucher (prepare), has the
//     owner-side signer sign only that voucher (owner-voucher-signer.mjs), and re-reads every on-chain fact (verify).
// Eterna's checks are Eterna's governance evidence. They are NOT Mastercard KYA, NOT PSP certification, NOT AP4M approval.
import { fail } from '../unified/common.mjs';
import { evidence } from '../commerce/contract.mjs';
import { evmDecimal, EVM_RLUSD } from '../commerce/governance.mjs';
import { CONTRACTS, NETWORK, CHANNEL_STATUS_OPEN, PSPS } from './constants.mjs';
import { ethers, readChallenge, voucherTypedData, voucherDigest, deriveClaimId, resourceDigest, resourceBindingTypedData, decodeChannel, channelCall,
  voucherRedeemedLogs, claimPaidLogs, settlementRecordedLogs, transferLogs, TOPICS, toEngineHash } from './voucher.mjs';

export const RAIL = 'ap4m-kit';
const refusal = (code, why) => Object.assign(fail(code, why), { code, refusal: true, signed: false });
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** Read a Channel's on-chain state through a read-only reader (eth_call channels(channelId)). */
export async function readChannel(reader, channelId) { return decodeChannel(await reader.request('eth_call', [channelCall(channelId), 'latest'])); }

const adapter = {
  id: 'ap4m-kit', rail: RAIL, assets: [EVM_RLUSD.asset], networks: [NETWORK.caip2], mode: 'LIVE_CAPABLE',
  describe: () => ({
    can: ['Take the HTTP 402 challenge from the AP4M kit\'s own x402 Merchant (scheme batch-settlement, fixed price, RLUSD on XRPL EVM Testnet)',
      'Draft the exact AP4M EIP-712 voucher (cumulative, per Channel) only after an Eterna governance PERMIT; refuse over-cap before any signature',
      'Have the owner-side signer sign that voucher and its x402 resource binding, and nothing else, inside the kit\'s own buyResource()',
      'Verify VoucherRedeemed (PaymentLedger), ClaimPaid and the RLUSD transfer (PooledEscrowVault), and SettlementRecorded from two independent readers'],
    cannot: ['Open a Channel, deposit, redeem or settle by itself: those are the AP4M service, the kit Merchant and the owner (approval-gated)',
      'Attest identities: PSP attestations are the AP4M service\'s test PSPs; Eterna checks are governance evidence, not KYA or PSP certification',
      'Run on Mainnet: XRPL EVM Testnet (chain 1449000) only, as the hackathon kit requires',
      'Hold the agent key: it stays on the owner\'s Mac (ap4m/owner-voucher-signer.mjs)'],
    proofConditions: { status: 'VERIFIED', facts: [{ fact: 'voucherRedeemed', equals: true }, { fact: 'claimBindsVoucher', equals: true },
      { fact: 'claimPaid', equals: true }, { fact: 'payoutTransferMatches', equals: true }, { fact: 'settlementRecorded', equals: true },
      { fact: 'readersAgreeing', min: 2 }, { fact: 'blockHashesAgree', equals: true }] },
    lifecycle: ['AUTHORIZED', 'VOUCHER_VERIFIED', 'REDEEMED', 'SETTLED', 'VERIFIED', 'UNLOCKED'],
  }),

  /** GET the kit Merchant's resource for a Channel and return its 402 challenge. offer: { resourceUrl, channelId, fetch? } */
  async challenge({ resourceUrl, channelId, fetch: f = fetch }) {
    const r = await f(resourceUrl, { headers: { 'X-AP4M-CHANNEL-ID': channelId }, redirect: 'error' });
    if (r.status !== 402) throw fail('X402_NOT_REQUIRED', `merchant answered HTTP ${r.status}, not 402`);
    const header = r.headers.get('PAYMENT-REQUIRED') ?? '';
    const c = readChallenge(header);
    if (c.channelId !== channelId || c.resource?.url !== resourceUrl) throw fail('X402_INVALID', 'challenge is for another channel or resource');
    return { status: 402, header, ...c };
  },

  /** The governance request for a challenge (amount as an exact RLUSD decimal; seller = the merchant payout address). */
  toRequest(c, { requestId, requester, payer, agent }) {
    return { requestId, requester, payer, agent: ethers.getAddress(agent), rail: RAIL, network: c.network, asset: EVM_RLUSD.asset, amount: evmDecimal(c.amountWei),
      seller: c.payTo, resource: c.resource?.url, voucher: { sessionId: c.channelId, nonce: (c.previousCumulativeAmount + c.amountWei).toString() } };
  },

  /** UNSIGNED voucher draft for an AUTHORIZED decision. ctx: { challenge, channel (on-chain, readChannel), nowSeconds }.
   *  Throws a refusal (signed: false) on any mismatch or if the Channel's on-chain cap would be exceeded. */
  prepare(decision, { challenge: c, channel: ch, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
    const q = decision?.request;
    if (!c || !ch) throw refusal('CONTEXT_MISSING', 'need the merchant challenge and the on-chain channel');
    const amountWei = c.amountWei, units = BigInt(decision.units);
    const bad = [];
    if (units !== amountWei) bad.push(`challenge amount ${amountWei} != authorized ${units}`);
    if (q.seller !== c.payTo) bad.push('payTo is not the authorized seller');
    if (q.voucher?.sessionId !== c.channelId) bad.push('channel is not the authorized one');
    if (c.network !== NETWORK.caip2 || c.ledger !== ethers.getAddress(CONTRACTS.paymentLedger) || c.asset !== ethers.getAddress(CONTRACTS.rlusdToken)) bad.push('network/ledger/asset is not the AP4M hackathon deployment');
    if (bad.length) throw refusal('CHALLENGE_DECISION_MISMATCH', bad.join('; '));
    if (ch.status !== CHANNEL_STATUS_OPEN) throw refusal('CHANNEL_NOT_OPEN', `channel status ${ch.status}`);
    if (ch.agent !== q.agent) throw refusal('AGENT_MISMATCH', 'on-chain channel agent is not the certified agent wallet');
    if (ch.payout !== c.payTo) throw refusal('PAYOUT_MISMATCH', 'challenge payTo differs from the channel payout bound on-chain');
    if (ch.redeemed !== c.previousCumulativeAmount) throw refusal('STALE_CHALLENGE', `channel redeemed ${ch.redeemed} != challenge ${c.previousCumulativeAmount}`);
    if (nowSeconds < ch.validAfter || nowSeconds >= ch.validBefore - 5) throw refusal('CHANNEL_WINDOW_CLOSED', 'outside the channel validity window');
    const cumulativeAmount = ch.redeemed + amountWei;
    if (cumulativeAmount > ch.cap) throw refusal('CAP_EXCEEDED', `cumulative ${evmDecimal(cumulativeAmount)} RLUSD > channel cap ${evmDecimal(ch.cap)} RLUSD (on-chain Authorized Spend Limit)`);
    const typedData = voucherTypedData({ channelId: c.channelId, cumulativeAmount });
    const vd = voucherDigest({ channelId: c.channelId, cumulativeAmount });
    const rd = c.resource ? resourceDigest(c.resource) : null;
    return { kind: 'ap4m-unsigned-voucher', decisionId: decision.decisionId, network: NETWORK.caip2, agent: q.agent, payTo: c.payTo, channelId: c.channelId,
      previousCumulativeAmount: ch.redeemed.toString(), amountWei: amountWei.toString(), cumulativeAmount: cumulativeAmount.toString(), typedData,
      voucherDigest: vd, claimId: deriveClaimId({ channelId: c.channelId, previousCumulativeAmount: ch.redeemed, cumulativeAmount }),
      resource: c.resource ?? null, resourceDigest: rd, resourceBinding: rd ? resourceBindingTypedData({ resourceDigest: rd, voucherDigest: vd }) : null,
      ap4mAttestations: { source: 'PaymentLedger.channels() on chain; issued by the AP4M service test PSPs, not by Eterna', authorityAttestationId: ch.authorityAttestationId,
        merchantAttestationId: ch.merchantAttestationId, merchantPspId: ch.merchantPspId, merchantPspSigner: ch.merchantPspSigner,
        merchantPspSignerIsServicePsp: PSPS.some((p) => p.signer.toLowerCase() === ch.merchantPspSigner.toLowerCase()) },
      signWith: 'ap4m/owner-voucher-signer.mjs on the owner device, armed with an Eterna permit for exactly this voucher' };
  },

  /** Re-read the payment on chain. ref: { claimId, channelId, redemptionTx, payoutTx?, settlementTx?, expected: draft-like
   *  { voucherDigest, previousCumulativeAmount, cumulativeAmount, amountWei, payTo, agent }, principal (the certificate payer) }. */
  async verify(ref, readers = []) {
    const e = ref.expected, per = [];
    for (const r of readers) {
      const p = { url: r.url, label: r.label, ok: false, problems: [], blocks: {} };
      try {
        if (BigInt(await r.request('eth_chainId')) !== NETWORK.chainId) throw new Error('wrong chain');
        const rr = await r.request('eth_getTransactionReceipt', [ref.redemptionTx]);
        if (!rr || BigInt(rr.status) !== 1n) throw new Error('redemption tx missing or reverted');
        const vr = voucherRedeemedLogs(rr.logs).filter((x) => x.claimId === ref.claimId);
        p.voucherRedeemed = vr.length === 1;
        const v = vr[0];
        if (v) {
          p.claimBindsVoucher = v.channelId === ref.channelId && v.voucherDigest === e.voucherDigest && v.voucherDigest === voucherDigest({ channelId: v.channelId, cumulativeAmount: v.cumulativeAmount })
            && v.claimId === deriveClaimId({ channelId: v.channelId, previousCumulativeAmount: v.previousCumulativeAmount, cumulativeAmount: v.cumulativeAmount })
            && v.previousCumulativeAmount.toString() === e.previousCumulativeAmount && v.cumulativeAmount.toString() === e.cumulativeAmount && v.amount.toString() === e.amountWei
            && v.payout === e.payTo && v.agent === e.agent;
          p.onChain = { agent: v.agent, payout: v.payout, merchantId: v.merchantId, submitter: v.submitter, amountWei: v.amount.toString() };
        }
        p.blocks.redemption = rr.blockHash;
        const find = async (address, topic) => { const head = BigInt(await r.request('eth_blockNumber')), end = BigInt(rr.blockNumber) + 2000n;
          return (await r.request('eth_getLogs', [{ address, topics: [topic, ref.claimId], fromBlock: rr.blockNumber, toBlock: hex(end < head ? end : head) }]))[0]?.transactionHash ?? null; };
        const payoutTx = ref.payoutTx ?? await find(CONTRACTS.pooledEscrowVault, TOPICS.ClaimPaid);
        const settlementTx = ref.settlementTx ?? await find(CONTRACTS.paymentLedger, TOPICS.SettlementRecorded);
        p.payoutTx = payoutTx; p.settlementTx = settlementTx;
        if (payoutTx) {
          const pr = await r.request('eth_getTransactionReceipt', [payoutTx]);
          const cp = BigInt(pr?.status ?? 0) === 1n ? claimPaidLogs(pr.logs).filter((x) => x.claimId === ref.claimId) : [];
          p.claimPaid = cp.length === 1 && cp[0].channelId === ref.channelId && cp[0].amount.toString() === e.amountWei && cp[0].payout === e.payTo;
          p.payoutTransferMatches = transferLogs(pr?.logs).some((t) => t.from === ethers.getAddress(CONTRACTS.pooledEscrowVault) && t.to === e.payTo && t.value.toString() === e.amountWei);
          p.blocks.payout = pr?.blockHash ?? null;
        }
        if (settlementTx) {
          const sr = await r.request('eth_getTransactionReceipt', [settlementTx]);
          const s = BigInt(sr?.status ?? 0) === 1n ? settlementRecordedLogs(sr.logs).filter((x) => x.claimId === ref.claimId && x.channelId === ref.channelId) : [];
          p.settlementRecorded = s.length === 1; p.settlementDigest = s[0]?.settlementDigest ?? null;
          p.blocks.settlement = sr?.blockHash ?? null;
        }
        for (const k of ['voucherRedeemed', 'claimBindsVoucher', 'claimPaid', 'payoutTransferMatches', 'settlementRecorded']) if (p[k] !== true) p.problems.push(`${k} not confirmed`);
        p.ok = p.problems.length === 0;
      } catch (x) { p.problems.push(x.message); }
      per.push(p);
    }
    const all = (k) => per.length > 0 && per.every((p) => p[k] === true);
    const first = per[0] ?? {};
    const blockHashesAgree = per.length > 0 && per.every((p) => ['redemption', 'payout', 'settlement'].every((b) => p.blocks[b] && p.blocks[b] === first.blocks?.[b]));
    const agentIsCertified = all('claimBindsVoucher') && per.every((p) => p.onChain?.agent === e.agent);
    const settledSomewhere = per.some((p) => p.settlementRecorded || p.claimPaid);
    const facts = {
      network: NETWORK.caip2, asset: EVM_RLUSD.asset, destination: e.payTo, amount: evmDecimal(e.amountWei), amountWei: e.amountWei,
      payer: agentIsCertified ? ref.principal ?? null : null, agent: e.agent, channelId: ref.channelId, claimId: ref.claimId, voucherDigest: e.voucherDigest,
      voucherRedeemed: all('voucherRedeemed'), claimBindsVoucher: all('claimBindsVoucher'), claimPaid: all('claimPaid'), payoutTransferMatches: all('payoutTransferMatches'),
      settlementRecorded: all('settlementRecorded'), readersAgreeing: per.filter((p) => p.ok).length, readersAsked: per.length, blockHashesAgree,
      settlementDigest: first.settlementDigest ?? null, redemptionTx: ref.redemptionTx, payoutTx: first.payoutTx ?? null, settlementTx: first.settlementTx ?? null,
      ledger: CONTRACTS.paymentLedger, vault: CONTRACTS.pooledEscrowVault, token: CONTRACTS.rlusdToken,
      explorer: { redemption: `${NETWORK.explorerUrl}/tx/${ref.redemptionTx}`, ...(first.payoutTx ? { payout: `${NETWORK.explorerUrl}/tx/${first.payoutTx}` } : {}), ...(first.settlementTx ? { settlement: `${NETWORK.explorerUrl}/tx/${first.settlementTx}` } : {}) },
      readers: per.map((p) => ({ url: p.url, label: p.label, ok: p.ok, problems: p.problems })),
      label: 'XRPL EVM Testnet; AP4M hackathon deployment; read by Eterna from public chain data',
    };
    const anyMismatch = per.some((p) => p.claimBindsVoucher === false || p.claimPaid === false || p.payoutTransferMatches === false);
    const status = per.length && per.every((p) => p.ok) && per.length >= 2 && blockHashesAgree ? 'VERIFIED' : anyMismatch ? 'FAILED' : settledSomewhere || per.some((p) => p.voucherRedeemed) ? 'PENDING' : 'FAILED';
    if (status === 'FAILED') facts.problems = per.flatMap((p) => p.problems.map((x) => `${p.label}: ${x}`));
    return evidence(adapter, status, facts, first.payoutTx ? { txHash: toEngineHash(first.payoutTx), txUrl: `${NETWORK.explorerUrl}/tx/${first.payoutTx}` } : {});
  },
};
export default adapter;
