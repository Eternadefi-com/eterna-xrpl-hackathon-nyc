// AP4M voucher math and event parsing, re-implemented from the kit's published definitions (constants.mjs) so that
// Eterna can check every field BEFORE the agent key signs, and re-derive every on-chain fact independently AFTER.
// Pure functions; no network, no keys. Tests check these against real public XRPL EVM Testnet data (fixtures/).
import { createRequire } from 'node:module';
import { fail } from '../unified/common.mjs';
import { CONTRACTS, NETWORK, LEDGER_ABI, VAULT_ABI, ERC20_ABI, VOUCHER_TYPES, RESOURCE_BINDING_TYPES, PAYMENT_CLAIM_ID_TYPE, voucherDomain, resourceBindingDomain } from './constants.mjs';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
export { ethers };
export const LEDGER = new ethers.Interface(LEDGER_ABI);
export const VAULT = new ethers.Interface(VAULT_ABI);
export const ERC20 = new ethers.Interface(ERC20_ABI);
const abi = ethers.AbiCoder.defaultAbiCoder();
const B32 = /^0x[0-9a-f]{64}$/;
export const isB32 = (v) => typeof v === 'string' && B32.test(v);
const uint = (v, n) => { const b = typeof v === 'bigint' ? v : /^\d+$/.test(String(v)) ? BigInt(v) : null; if (b === null || b < 0n) throw fail('VOUCHER_INVALID', `${n} must be a non-negative integer`); return b; };

/** The exact typed data the kit signs for a fixed-price voucher (cumulative, per Channel). */
export function voucherTypedData({ channelId, cumulativeAmount, ledger = CONTRACTS.paymentLedger, chainId = NETWORK.chainId }) {
  if (!isB32(channelId)) throw fail('VOUCHER_INVALID', 'channelId must be lowercase bytes32 hex');
  return { domain: voucherDomain(ethers.getAddress(ledger), BigInt(chainId)), types: { Voucher: VOUCHER_TYPES.Voucher.map((f) => ({ ...f })) }, primaryType: 'Voucher',
    message: { channelId, cumulativeAmount: uint(cumulativeAmount, 'cumulativeAmount') } };
}
export const voucherDigest = (v) => { const t = voucherTypedData(v); return ethers.TypedDataEncoder.hash(t.domain, t.types, t.message); };
/** claimId = keccak256(abi.encode(PaymentClaim typehash, chainId, ledger, channelId, previous, cumulative, voucherDigest)). */
export function deriveClaimId({ channelId, previousCumulativeAmount, cumulativeAmount, ledger = CONTRACTS.paymentLedger, chainId = NETWORK.chainId }) {
  const prev = uint(previousCumulativeAmount, 'previousCumulativeAmount'), cum = uint(cumulativeAmount, 'cumulativeAmount');
  if (cum <= prev) throw fail('VOUCHER_INVALID', 'cumulative amount must exceed the previous high-water mark');
  return ethers.keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'uint256', 'bytes32'],
    [ethers.id(PAYMENT_CLAIM_ID_TYPE), BigInt(chainId), ethers.getAddress(ledger), channelId, prev, cum, voucherDigest({ channelId, cumulativeAmount: cum, ledger, chainId })]));
}

// ---- x402 (the kit's canonical-base64 headers and its resource binding) ----------------------------------------------
/** The kit's canonical JSON: keys sorted recursively, JSON.stringify(_, null, 2) plus a trailing newline. */
export function kitCanonicalJson(v) {
  const norm = (x) => (x === null || typeof x !== 'object' ? x : Array.isArray(x) ? x.map(norm) : Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])])));
  return `${JSON.stringify(norm(v), null, 2)}\n`;
}
// The kit's x402 module hashes the resource with its own COMPACT canonical JSON (x402.js canonicalJson), not the
// pretty-printed retained-JSON form above; the digest must match the kit byte for byte or the binding is refused.
export const compactCanonicalJson = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(compactCanonicalJson).join(',')}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${compactCanonicalJson(v[k])}`).join(',')}}`);
export const resourceDigest = (resource) => ethers.keccak256(ethers.toUtf8Bytes(compactCanonicalJson(Object.fromEntries(['description', 'mimeType', 'url'].filter((k) => resource?.[k] !== undefined).map((k) => [k, resource[k]])))));
export function resourceBindingTypedData({ resourceDigest: rd, voucherDigest: vd, ledger = CONTRACTS.paymentLedger, chainId = NETWORK.chainId }) {
  if (!isB32(rd) || !isB32(vd)) throw fail('VOUCHER_INVALID', 'resource binding digests must be bytes32');
  return { domain: resourceBindingDomain(ethers.getAddress(ledger), BigInt(chainId)), types: { X402ResourceBinding: RESOURCE_BINDING_TYPES.X402ResourceBinding.map((f) => ({ ...f })) }, primaryType: 'X402ResourceBinding', message: { resourceDigest: rd, voucherDigest: vd } };
}
export const encodeHeader = (v) => Buffer.from(kitCanonicalJson(v), 'utf8').toString('base64');
export function decodeHeader(h) {
  if (typeof h !== 'string' || !h || h.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(h) || Buffer.from(h, 'base64').toString('base64') !== h) throw fail('X402_INVALID', 'header must be canonical base64');
  try { return JSON.parse(Buffer.from(h, 'base64').toString('utf8')); } catch { throw fail('X402_INVALID', 'header is not JSON'); }
}
/** Read a kit Merchant's PAYMENT-REQUIRED challenge into the fields Eterna governs. Shape checks only; no trust. */
export function readChallenge(paymentRequired) {
  const pr = typeof paymentRequired === 'string' ? decodeHeader(paymentRequired) : paymentRequired;
  const a = pr?.accepts?.[0];
  if (pr?.x402Version !== 2 || pr.accepts.length !== 1 || !a) throw fail('X402_INVALID', 'need an x402 v2 requirement with exactly one accepts[] entry');
  const bad = [];
  if (a.scheme !== 'batch-settlement') bad.push(`scheme ${a.scheme}`);
  if (a.network !== NETWORK.caip2) bad.push(`network ${a.network}`);
  if (!/^[1-9]\d*$/.test(a.amount ?? '')) bad.push('amount');
  if (!ethers.isAddress(a.asset ?? '') || !ethers.isAddress(a.payTo ?? '')) bad.push('asset/payTo');
  if (a.extra?.pricingMode !== 'fixed' || a.extra?.bindingVersion !== '1') bad.push('pricingMode/bindingVersion');
  if (!isB32(a.extra?.channelId) || !/^\d+$/.test(a.extra?.acceptedCumulativeAmount ?? '') || !ethers.isAddress(a.extra?.ledger ?? '')) bad.push('extra.channelId/acceptedCumulativeAmount/ledger');
  if (bad.length) throw fail('X402_INVALID', bad.join('; '));
  return { resource: pr.resource, scheme: a.scheme, network: a.network, amountWei: BigInt(a.amount), asset: ethers.getAddress(a.asset), payTo: ethers.getAddress(a.payTo),
    ledger: ethers.getAddress(a.extra.ledger), channelId: a.extra.channelId, previousCumulativeAmount: BigInt(a.extra.acceptedCumulativeAmount), maxTimeoutSeconds: a.maxTimeoutSeconds, raw: pr };
}

// ---- on-chain reads (decoders for eth_call / receipts) -------------------------------------------------------------------
export const channelCall = (channelId) => ({ to: CONTRACTS.paymentLedger, data: LEDGER.encodeFunctionData('channels', [channelId]) });
export function decodeChannel(hex) {
  const r = LEDGER.decodeFunctionResult('channels', hex);
  return { allocationId: r.allocationId, merchantPspId: r.merchantPspId, requestDigest: r.requestDigest, authorityAttestationId: r.authorityAttestationId,
    merchantAttestationId: r.merchantAttestationId, merchantId: r.merchantId, latestVoucherDigest: r.latestVoucherDigest, cap: r.cap, redeemed: r.redeemed,
    agent: ethers.getAddress(r.agent), allocationGeneration: r.allocationGeneration, status: Number(r.status), payout: ethers.getAddress(r.payout),
    merchantGeneration: r.merchantGeneration, merchantPspSigner: ethers.getAddress(r.merchantPspSigner), merchantPspSignerGeneration: r.merchantPspSignerGeneration,
    validAfter: Number(r.validAfter), validBefore: Number(r.validBefore) };
}
const parseFrom = (iface, address, name, logs) => (logs ?? []).filter((l) => l.address?.toLowerCase() === address.toLowerCase()).flatMap((l) => {
  try { const e = iface.parseLog({ topics: l.topics, data: l.data }); return e?.name === name ? [{ ...e.args.toObject(), logIndex: Number(l.logIndex), transactionHash: l.transactionHash, blockNumber: Number(l.blockNumber), blockHash: l.blockHash }] : []; } catch { return []; }
});
export const voucherRedeemedLogs = (logs, ledger = CONTRACTS.paymentLedger) => parseFrom(LEDGER, ledger, 'VoucherRedeemed', logs);
export const settlementRecordedLogs = (logs, ledger = CONTRACTS.paymentLedger) => parseFrom(LEDGER, ledger, 'SettlementRecorded', logs);
export const claimPaidLogs = (logs, vault = CONTRACTS.pooledEscrowVault) => parseFrom(VAULT, vault, 'ClaimPaid', logs);
export const channelOpenedLogs = (logs, ledger = CONTRACTS.paymentLedger) => parseFrom(LEDGER, ledger, 'ChannelOpened', logs);
export const transferLogs = (logs, token = CONTRACTS.rlusdToken) => parseFrom(ERC20, token, 'Transfer', logs);
export const TOPICS = Object.freeze({ VoucherRedeemed: LEDGER.getEvent('VoucherRedeemed').topicHash, SettlementRecorded: LEDGER.getEvent('SettlementRecorded').topicHash,
  ClaimPaid: VAULT.getEvent('ClaimPaid').topicHash, ChannelOpened: LEDGER.getEvent('ChannelOpened').topicHash });
/** Eterna's governance engine stores ledger refs as 64 upper-case hex chars; EVM hashes are 0x-prefixed lower-case. */
export const toEngineHash = (h) => (typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) ? h.slice(2).toUpperCase() : null);
export const fromEngineHash = (h) => `0x${h.toLowerCase()}`;
