// OWNER-SIDE AP4M VOUCHER SIGNER: the custody boundary for the agent's EVM key (0x8559...7e36, key at
// ~/eterna-private/mastercard-evm/evm.key, 0600, owner's Mac only). Same pattern as owner-signer/owner-signer.mjs:
// Eterna's governance key signs a PERMIT that binds one exact voucher; this signer signs that voucher and nothing else.
// Eterna can therefore only REFUSE (no permit -> no signature); it can never make the agent key pay.
//
// The object it returns is shaped like the ethers Wallet the AP4M kit expects (`address`, `signTypedData`), so it is passed
// straight into the kit's own `buyResource({ wallet })`: the REAL kit builds the x402 payload, our signer decides whether
// each typed-data signature may happen. It signs exactly two things per permit, both checked field by field:
//   1. Voucher(channelId, cumulativeAmount) in domain "AP4M Payment Ledger" v1 / chain 1449000 / the PaymentLedger;
//   2. X402ResourceBinding(resourceDigest, voucherDigest) in domain "AP4M x402 Resource Binding", for that same voucher.
// Everything else is refused: other types, other domains, a raised amount, another channel, a second use of a permit,
// raw messages (sign-in needs an explicit owner `armSignIn`), and transactions (no sendTransaction at all).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { digestOf, fail } from '../unified/common.mjs';
import { signPermit, verifyPermitSignature, permitDigest, memoryReplayStore, fileReplayStore } from '../owner-signer/owner-signer.mjs';
import { CONTRACTS, NETWORK, VOUCHER_DOMAIN_NAME, VOUCHER_DOMAIN_VERSION, RESOURCE_BINDING_DOMAIN_NAME, RESOURCE_BINDING_DOMAIN_VERSION } from './constants.mjs';
import { voucherDigest, isB32 } from './voucher.mjs';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
export { fileReplayStore, memoryReplayStore };
export const PERMIT_TYPE = 'eterna.ap4m-voucher-permit.v1';
const refuse = (code, why) => { throw Object.assign(fail(code, why), { refusal: true, signed: false }); };

// ---- the permit (Eterna governance side; offline) ---------------------------------------------------------------------
/** Permit from a PERMIT decision and the adapter's unsigned draft. Every field the signer enforces is here. */
export function buildVoucherPermit({ decision, draft, certificateDigest, expiresAt, nonce }) {
  const m = draft?.typedData?.message;
  if (draft?.kind !== 'ap4m-unsigned-voucher' || !m) throw fail('PERMIT_INVALID', 'need an ap4m unsigned voucher draft');
  if (!/^[0-9a-f]{64}$/.test(certificateDigest ?? '') || Number.isNaN(Date.parse(expiresAt))) throw fail('PERMIT_INVALID', 'certificateDigest / expiresAt');
  if (decision?.state !== 'AUTHORIZED' || decision.decisionId !== draft.decisionId) throw fail('PERMIT_INVALID', 'draft does not belong to an AUTHORIZED decision');
  return { type: PERMIT_TYPE, network: NETWORK.caip2, chainId: NETWORK.chainId.toString(), ledger: draft.typedData.domain.verifyingContract, agent: draft.agent,
    channelId: m.channelId, previousCumulativeAmount: draft.previousCumulativeAmount, cumulativeAmount: m.cumulativeAmount.toString(), amountWei: draft.amountWei,
    payTo: draft.payTo, resourceUrl: draft.resource?.url ?? null, resourceDigest: draft.resourceDigest ?? null, voucherDigest: draft.voucherDigest, claimId: draft.claimId,
    decisionId: decision.decisionId, decisionDigest: decision.decisionDigest, certificateDigest, expiresAt, nonce: nonce ?? digestOf({ d: decision.decisionId, at: Date.now() }).slice(0, 32) };
}
export { signPermit, verifyPermitSignature, permitDigest };

// ---- the signer (owner device) ---------------------------------------------------------------------------------------
/**
 * createOwnerVoucherSigner({ privateKey | wallet, trustedGovernanceKey, ledger, chainId, replay, now })
 * Returns { address, arm(permit), armSignIn(), signTypedData, signMessage, log() }. The key stays in this closure.
 */
export function createOwnerVoucherSigner({ privateKey, wallet: injected, trustedGovernanceKey, ledger = CONTRACTS.paymentLedger, chainId = NETWORK.chainId, replay = memoryReplayStore(), now = () => Date.now() }) {
  const wallet = injected ?? new ethers.Wallet(privateKey);
  const address = wallet.address;
  const L = ethers.getAddress(ledger), C = BigInt(chainId);
  let armed = null, signIn = false;
  const log = [];
  const sameDomain = (d, name, version) => d && d.name === name && d.version === version && BigInt(d.chainId) === C && ethers.getAddress(d.verifyingContract ?? '0x0000000000000000000000000000000000000000') === L
    && Object.keys(d).every((k) => ['name', 'version', 'chainId', 'verifyingContract'].includes(k));
  const sameTypes = (types, name, fields) => { const k = Object.keys(types ?? {}).filter((x) => x !== 'EIP712Domain'); return k.length === 1 && k[0] === name && JSON.stringify(types[name].map((f) => [f.name, f.type])) === JSON.stringify(fields); };

  /** Load one permit. Verified here (signature, expiry, replay, agent, network, ledger) and again at each signature. */
  function arm(permit) {
    if (!permit) refuse('NO_PERMIT', 'no Eterna permit: nothing is signed');
    if (permit.type !== PERMIT_TYPE) refuse('PERMIT_INVALID', 'type');
    if (!verifyPermitSignature(permit, trustedGovernanceKey)) refuse('PERMIT_SIGNATURE_INVALID', 'permit is not signed by the trusted Eterna governance key (or was altered)');
    if (now() >= Date.parse(permit.expiresAt)) refuse('PERMIT_EXPIRED', `permit expired at ${permit.expiresAt}`);
    const pd = permitDigest(permit);
    if (replay.has(pd) || replay.has(`nonce:${permit.nonce}`) || replay.has(`voucher:${permit.voucherDigest}`)) refuse('PERMIT_REPLAYED', 'permit, nonce or voucher already signed');
    if (permit.network !== NETWORK.caip2 || BigInt(permit.chainId) !== C) refuse('NETWORK_MISMATCH', `permit for ${permit.network}`);
    if (ethers.getAddress(permit.ledger) !== L) refuse('LEDGER_MISMATCH', 'permit names another PaymentLedger');
    if (ethers.getAddress(permit.agent) !== address) refuse('AGENT_MISMATCH', 'permit is for another agent wallet');
    if (!isB32(permit.channelId) || voucherDigest({ channelId: permit.channelId, cumulativeAmount: permit.cumulativeAmount, ledger: L, chainId: C }) !== permit.voucherDigest) refuse('PERMIT_INVALID', 'voucherDigest does not match channelId/cumulativeAmount');
    if (BigInt(permit.cumulativeAmount) - BigInt(permit.previousCumulativeAmount) !== BigInt(permit.amountWei)) refuse('PERMIT_INVALID', 'cumulative - previous != amount');
    armed = { permit, pd, voucherSigned: false, bindingSigned: false };
    return { armed: true, permitDigest: pd, voucherDigest: permit.voucherDigest };
  }
  const finish = () => { if (armed?.voucherSigned && armed?.bindingSigned) { replay.add(armed.pd); replay.add(`nonce:${armed.permit.nonce}`); replay.add(`voucher:${armed.permit.voucherDigest}`); armed = null; } };

  async function signTypedData(domain, types, value) {
    if (!armed) refuse('NO_PERMIT', 'no armed Eterna permit: nothing is signed');
    const p = armed.permit;
    if (now() >= Date.parse(p.expiresAt)) { armed = null; refuse('PERMIT_EXPIRED', `permit expired at ${p.expiresAt}`); }
    if (sameDomain(domain, VOUCHER_DOMAIN_NAME, VOUCHER_DOMAIN_VERSION) && sameTypes(types, 'Voucher', [['channelId', 'bytes32'], ['cumulativeAmount', 'uint256']])) {
      if (armed.voucherSigned) refuse('PERMIT_REPLAYED', 'this permit already signed its voucher');
      const bad = [];
      if (String(value?.channelId).toLowerCase() !== p.channelId) bad.push('channelId');
      if (BigInt(value?.cumulativeAmount ?? -1) !== BigInt(p.cumulativeAmount)) bad.push(`cumulativeAmount ${value?.cumulativeAmount} != permitted ${p.cumulativeAmount}`);
      if (Object.keys(value ?? {}).some((k) => !['channelId', 'cumulativeAmount'].includes(k))) bad.push('extra fields');
      if (bad.length) { armed = null; refuse('VOUCHER_PERMIT_MISMATCH', bad.join('; ')); }
      const sig = await wallet.signTypedData(domain, types, value);
      armed.voucherSigned = true; log.push({ kind: 'Voucher', permitDigest: armed.pd, voucherDigest: p.voucherDigest, at: new Date(now()).toISOString() }); finish();
      return sig;
    }
    if (sameDomain(domain, RESOURCE_BINDING_DOMAIN_NAME, RESOURCE_BINDING_DOMAIN_VERSION) && sameTypes(types, 'X402ResourceBinding', [['resourceDigest', 'bytes32'], ['voucherDigest', 'bytes32']])) {
      if (!armed.voucherSigned) refuse('ORDER_INVALID', 'resource binding before its voucher');
      const bad = [];
      if (value?.voucherDigest !== p.voucherDigest) bad.push('voucherDigest');
      if (p.resourceDigest && value?.resourceDigest !== p.resourceDigest) bad.push('resourceDigest');
      if (bad.length) { armed = null; refuse('BINDING_PERMIT_MISMATCH', bad.join('; ')); }
      const pd = armed.pd;
      const sig = await wallet.signTypedData(domain, types, value);
      armed.bindingSigned = true; log.push({ kind: 'X402ResourceBinding', permitDigest: pd, voucherDigest: p.voucherDigest, at: new Date(now()).toISOString() }); finish();
      return sig;
    }
    armed = null;
    refuse('TYPED_DATA_REFUSED', `only the permitted AP4M Voucher and its x402 resource binding are signed (got ${Object.keys(types ?? {}).join(',')} / ${domain?.name})`);
  }
  /** Sign-in to the AP4M service is a personal_sign of the service's challenge. Off-chain, but only after the owner arms it. */
  function armSignIn() { signIn = true; return { armed: 'sign-in (one message)' }; }
  async function signMessage(message) {
    if (!signIn) refuse('SIGN_IN_NOT_ARMED', 'raw messages are refused unless the owner armed one sign-in');
    if (typeof message !== 'string' || /^0x/.test(message) || message.length > 2000) refuse('SIGN_IN_REFUSED', 'only a text sign-in challenge is signed');
    signIn = false; log.push({ kind: 'sign-in', at: new Date(now()).toISOString() });
    return wallet.signMessage(message);
  }
  const sendTransaction = () => refuse('TX_REFUSED', 'the governed voucher signer never sends transactions');
  return Object.freeze({ address, arm, armSignIn, signTypedData, signMessage, sendTransaction, getAddress: async () => address, connect() { return this; }, log: () => log.map((x) => ({ ...x })) });
}

/** Load the agent key from the owner's private directory (file must be 0600; the key is never printed or returned). */
export function loadOwnerAgentKey(path) {
  if (!existsSync(path)) throw fail('NO_KEY', `${path} missing`);
  if ((statSync(path).mode & 0o077) !== 0) throw fail('KEY_PERMISSIONS', `${path} must be 0600`);
  const raw = readFileSync(path, 'utf8').trim();
  const pk = raw.startsWith('{') ? JSON.parse(raw).privateKey : raw;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk ?? '')) throw fail('KEY_FORMAT', 'expected a 32-byte hex private key');
  const w = new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
  return { address: w.address, wallet: () => w };
}
