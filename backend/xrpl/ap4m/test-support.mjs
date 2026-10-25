// TEST STUBS for ap4m/ (offline). Everything here is SYNTHETIC and named STUB_*: a stub Merchant, a stub of the kit's
// buyResource(), stub readers with synthetic receipts, fixed fake keys. None of it is the AP4M kit, the AP4M service or
// chain data, and no test that uses it supports a "real" claim. Real public chain data lives only in fixtures/public-tape.json.
import { createRequire } from 'node:module';
import { canonicalJson } from '../unified/common.mjs';
import { CONTRACTS, NETWORK } from './constants.mjs';
import { LEDGER, VAULT, ERC20, encodeHeader, decodeHeader, voucherTypedData, voucherDigest, deriveClaimId, resourceDigest, resourceBindingTypedData, channelCall } from './voucher.mjs';
import { READ } from './readers.mjs';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
export const STUB = Object.freeze({ synthetic: true, note: 'SYNTHETIC test stub: not the AP4M kit, not the AP4M service, not chain data' });
export const STUB_AGENT_KEY = `0x${'11'.repeat(32)}`;            // fixed fake EVM key (well-known test value; never funded)
export const STUB_OTHER_KEY = `0x${'22'.repeat(32)}`;
export const STUB_PAYOUT = ethers.getAddress(`0x${'5a'.repeat(20)}`);
export const STUB_CHANNEL = `0x${'c1'.repeat(32)}`;
export const STUB_RESOURCE_URL = 'http://127.0.0.1:4308/resource';
const H = (c) => `0x${c.repeat(64 / c.length)}`;
const RLUSD = ethers.getAddress(CONTRACTS.rlusdToken), LEDGER_ADDR = ethers.getAddress(CONTRACTS.paymentLedger), VAULT_ADDR = ethers.getAddress(CONTRACTS.pooledEscrowVault);

export const stubChannel = (o = {}) => ({ allocationId: H('a1'), merchantPspId: H('b1'), requestDigest: H('d1'), authorityAttestationId: H('e1'), merchantAttestationId: H('e2'),
  merchantId: H('f1'), latestVoucherDigest: H('00'), cap: ethers.parseUnits('2', 18), redeemed: 0n, agent: new ethers.Wallet(STUB_AGENT_KEY).address, allocationGeneration: 1n, status: 1,
  payout: STUB_PAYOUT, merchantGeneration: 1n, merchantPspSigner: '0xaE9b83F33d393671B9Cd39FbF6dd9D4830a3B4F9', merchantPspSignerGeneration: 1n, validAfter: 1, validBefore: 1794765600, ...o });
const encodeChannel = (c) => LEDGER.encodeFunctionResult('channels', [c.allocationId, c.merchantPspId, c.requestDigest, c.authorityAttestationId, c.merchantAttestationId, c.merchantId,
  c.latestVoucherDigest, c.cap, c.redeemed, c.agent, c.allocationGeneration, c.status, c.payout, c.merchantGeneration, c.merchantPspSigner, c.merchantPspSignerGeneration, c.validAfter, c.validBefore]);

/** STUB x402 Merchant (a fake fetch). It answers like the kit's createX402Merchant: 402 + PAYMENT-REQUIRED, then 200. */
export function STUB_merchant({ priceWei, channel = stubChannel(), resourceUrl = STUB_RESOURCE_URL, raisePriceOnRetryTo } = {}) {
  let calls = 0;
  const required = (amount) => ({ x402Version: 2, error: 'Payment required', resource: { url: resourceUrl, description: 'AP4M hackathon resource', mimeType: 'application/json' },
    accepts: [{ scheme: 'batch-settlement', network: NETWORK.caip2, amount: amount.toString(), asset: RLUSD, payTo: channel.payout, maxTimeoutSeconds: 300,
      extra: { bindingVersion: '1', ledger: LEDGER_ADDR, pricingMode: 'fixed', channelId: STUB_CHANNEL, acceptedCumulativeAmount: channel.redeemed.toString() } }] });
  const res = (status, body, headers = {}) => ({ status, headers: new Headers(headers), json: async () => body });
  const f = async (url, init = {}) => {
    calls++;
    const h = new Headers(init.headers);
    if (url !== resourceUrl) return res(404, { error: 'not_found' });
    if (!h.get('payment-signature')) return res(402, { x402Version: 2, error: 'payment_required' }, { 'PAYMENT-REQUIRED': encodeHeader(required(calls > 1 && raisePriceOnRetryTo ? raisePriceOnRetryTo : priceWei)) });
    return res(200, { resource: { report: 'stub resource' } }, { 'PAYMENT-RESPONSE': encodeHeader({ success: true, transaction: H('7e'), network: NETWORK.caip2 }) });
  };
  return Object.assign(f, { STUB, calls: () => calls, required });
}

/** STUB of the kit's buyResource(): same signing sequence as @ap4m/sdk buildX402PaymentPayload (voucher, then resource
 *  binding, through `wallet.signTypedData`) and the same maximumAmount check; no chain, no service. */
export function STUB_kit({ ignoreMaximum = false } = {}) {   // ignoreMaximum: a misbehaving client, to test the signer alone
  let called = 0;
  async function buyResource({ wallet, resourceUrl, channelId, maximumAmount, requestFetch }) {
    called++;
    const first = await requestFetch(resourceUrl, { headers: { 'X-AP4M-CHANNEL-ID': channelId } });
    const pr = decodeHeader(first.headers.get('PAYMENT-REQUIRED'));
    const a = pr.accepts[0];
    if (!ignoreMaximum && BigInt(a.amount) > BigInt(maximumAmount)) throw new Error('Merchant challenge exceeds the configured purchase authority');
    const cumulativeAmount = BigInt(a.extra.acceptedCumulativeAmount) + BigInt(a.amount);
    const t = voucherTypedData({ channelId, cumulativeAmount });
    const agentSignature = await wallet.signTypedData(t.domain, t.types, { channelId, cumulativeAmount: cumulativeAmount.toString() });
    const vd = voucherDigest({ channelId, cumulativeAmount });
    const b = resourceBindingTypedData({ resourceDigest: resourceDigest(pr.resource), voucherDigest: vd });
    const resourceSignature = await wallet.signTypedData(b.domain, b.types, b.message);
    const second = await requestFetch(resourceUrl, { headers: { 'X-AP4M-CHANNEL-ID': channelId, 'PAYMENT-SIGNATURE': encodeHeader({ agentSignature, resourceSignature }) } });
    const body = await second.json();
    return { operation: 'stub', claimId: deriveClaimId({ channelId, previousCumulativeAmount: a.extra.acceptedCumulativeAmount, cumulativeAmount }), transactionHash: H('7e'), redemption: 'Confirmed', resource: body.resource, agentSignature, resourceSignature, STUB };
  }
  return { buyResource, context: { STUB }, called: () => called };
}

/** STUB reader answering eth_call channels() and synthetic receipts. `receipts[hash] = receipt`. */
export function STUB_reader(url, { channel = stubChannel(), receipts = {}, logs = [], head = 1000 } = {}) {
  return { url, label: `stub:${new URL(url).hostname}`, STUB, request: async (m, p = []) => {
    if (!READ.has(m)) throw new Error(`METHOD_REFUSED ${m}`);
    if (m === 'eth_chainId') return ethers.toQuantity(NETWORK.chainId);
    if (m === 'eth_blockNumber') return ethers.toQuantity(head);
    if (m === 'eth_call') { if (p[0].data !== channelCall(STUB_CHANNEL).data) throw new Error('unknown call'); return encodeChannel(channel); }
    if (m === 'eth_getTransactionReceipt') return receipts[p[0]] ?? null;
    if (m === 'eth_getLogs') return logs.filter((l) => l.address.toLowerCase() === p[0].address.toLowerCase() && p[0].topics.every((t, i) => t === l.topics[i]));
    throw new Error(`not stubbed ${m}`);
  } };
}
const log = (iface, address, name, args, tx, blockHash, logIndex = 0) => { const e = iface.encodeEventLog(name, args); return { address, topics: e.topics, data: e.data, logIndex: ethers.toQuantity(logIndex), transactionHash: tx, blockNumber: '0x10', blockHash }; };
/** SYNTHETIC receipts for one complete payment (redeem, payout, settlement) that the adapter's verify() will parse. */
export function STUB_settlement({ draft, amountWei = draft.amountWei, payout = draft.payTo, agent = draft.agent, blockHash = H('bb') }) {
  const redeem = H('7e'), payoutTx = H('9a'), settleTx = H('5e');
  const v = [draft.channelId, draft.claimId, draft.voucherDigest, H('a1'), agent, H('f1'), payout, '0x02b55B1AB212EcFeCe33826c3b5020E7381E7053', BigInt(draft.previousCumulativeAmount), BigInt(draft.cumulativeAmount), BigInt(amountWei)];
  const receipts = {
    [redeem]: { status: '0x1', blockNumber: '0x10', blockHash, logs: [log(LEDGER, LEDGER_ADDR, 'VoucherRedeemed', v, redeem, blockHash)] },
    [payoutTx]: { status: '0x1', blockNumber: '0x11', blockHash, logs: [log(ERC20, RLUSD, 'Transfer', [VAULT_ADDR, payout, BigInt(amountWei)], payoutTx, blockHash, 0),
      log(VAULT, VAULT_ADDR, 'ClaimPaid', [draft.claimId, H('9b'), draft.channelId, payout, BigInt(amountWei), BigInt(amountWei), 1792889513n], payoutTx, blockHash, 1)] },
    [settleTx]: { status: '0x1', blockNumber: '0x12', blockHash, logs: [log(LEDGER, LEDGER_ADDR, 'SettlementRecorded', [draft.claimId, draft.channelId, H('5d')], settleTx, blockHash)] },
  };
  return { redeem, payoutTx, settleTx, receipts, STUB };
}
/** STUB AP4M service client (record-redemption + settle) for settleAndVerify(). */
export const STUB_service = ({ payoutTx, settleTx }) => ({ STUB, recorded: [], async recordRedemption(tx) { this.recorded.push(tx); return { ok: true }; },
  async settle(channelId) { return { settlement_tx: settleTx, payout_tx: payoutTx, channel_id: channelId, receipt_url: null, STUB }; } });
export const canon = canonicalJson;
