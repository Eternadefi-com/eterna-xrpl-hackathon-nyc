// OWNER-SIDE SIGNER: the signing-key custody boundary for Products 2 (RLUSD) and 4 (WHAT IF?) on XRPL Mainnet.
//
// The agent's XRPL key is held on the OWNER's own device (~/eterna-private/<product>/agent.key, 0600), never by an
// Eterna service and never by the AI agent. The signer signs ONE delegated Payment (Account = Rose, Delegate = agent)
// and only when it is given an Eterna PERMIT: a governance decision signed by Eterna's governance key that binds the
// network, Account, Delegate, Destination, the exact Amount (XRP drops, or RLUSD issuer/currency/value), the order id,
// the quote id (if any), the certificate digest, a fee cap and an expiry. Any mismatch, expiry or replay -> refusal.
// So Eterna can only REFUSE (by not issuing a permit), never SEND: the governance key cannot move funds, and the owner's
// signer cannot be made to sign anything outside a permit. This module never submits. It lives outside commerce/ on
// purpose: commerce/ (Eterna's service code) keeps its no-signing guard (conformance.test.mjs).
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as x68 from '../xls68/xls68.mjs';
import { digestOf, hexUtf8, fail, memoValues } from '../unified/common.mjs';

const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const { isValidClassicAddress } = require('ripple-address-codec');

export const PERMIT_TYPE = 'eterna.signing-permit.v1';
const PERMIT_DOMAIN = 'ETERNA-SIGNING-PERMIT\0';
const TF_PARTIAL_PAYMENT = 0x00020000, TF_NO_RIPPLE_DIRECT = 0x00010000, TF_LIMIT_QUALITY = 0x00040000;
const NETWORK_IDS = { 'xrpl:0': 0, 'xrpl:1': 1, 'xrpl:2': 2 };
const refuse = (code, why) => { throw Object.assign(fail(code, why), { refusal: true }); };
const canonAmount = (a) => (typeof a === 'string' ? a : { currency: a?.currency, issuer: a?.issuer, value: a?.value });
const sameAmount = (a, b) => digestOf(canonAmount(a)) === digestOf(canonAmount(b));

// ---- the permit (Eterna governance side) -------------------------------------------------------------------------------
/** Permit body from a PERMIT decision. Every field the signer will enforce is here. */
export function buildPermit({ decision, network, account, delegate, destination, amount, orderId, quoteId, certificateDigest, expiresAt, maxFeeDrops = '5000', nonce }) {
  for (const [n, a] of [['account', account], ['delegate', delegate], ['destination', destination]]) if (!isValidClassicAddress(a ?? '')) throw fail('PERMIT_INVALID', n);
  if (!(network in NETWORK_IDS)) throw fail('PERMIT_INVALID', 'network');
  if (typeof amount === 'string' ? !/^[1-9]\d*$/.test(amount) : !(amount?.currency && amount?.issuer && /^\d+(\.\d+)?$/.test(amount?.value ?? ''))) throw fail('PERMIT_INVALID', 'amount');
  if (!/^[0-9a-f]{64}$/.test(certificateDigest ?? '') || !orderId || Number.isNaN(Date.parse(expiresAt))) throw fail('PERMIT_INVALID', 'certificateDigest / orderId / expiresAt');
  return { type: PERMIT_TYPE, network, account, delegate, destination, amount: canonAmount(amount), orderId, ...(quoteId ? { quoteId } : {}), certificateDigest,
    decisionId: decision?.decisionId ?? null, decisionDigest: decision?.decisionDigest ?? null, maxFeeDrops: String(maxFeeDrops), expiresAt, nonce: nonce ?? digestOf({ orderId, at: Date.now() }).slice(0, 32) };
}
export const permitDigest = (p) => { const { signature: _, ...body } = p ?? {}; return digestOf(body); };
const permitMessage = (digest) => hexUtf8(PERMIT_DOMAIN) + digest.toUpperCase();
/** Eterna governance signs the permit digest (domain-separated; not a transaction; cannot move funds). */
export function signPermit(body, governanceKey) {
  const kp = typeof governanceKey === 'string' ? keypairs.deriveKeypair(governanceKey) : governanceKey;
  const d = permitDigest(body);
  return { ...body, signature: { publicKey: kp.publicKey, signature: keypairs.sign(permitMessage(d), kp.privateKey), scheme: 'xrpl-keypair/ETERNA-SIGNING-PERMIT', digest: d } };
}
export function verifyPermitSignature(p, trustedPublicKey) {
  try { const d = permitDigest(p); return p.signature?.publicKey === trustedPublicKey && p.signature?.digest === d && keypairs.verify(permitMessage(d), p.signature.signature, trustedPublicKey); } catch { return false; }
}

// ---- the signer (owner device) ----------------------------------------------------------------------------------------------
/** Replay store: permit digests and nonces already used. File-backed (0600) on the owner device; in-memory for tests. */
export function fileReplayStore(path) {
  const load = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { used: [] });
  return { has: (k) => load().used.includes(k), add: (k) => { const s = load(); s.used.push(k); writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 1), { mode: 0o600 }); chmodSync(`${path}.tmp`, 0o600); renameSync(`${path}.tmp`, path); } };
}
export const memoryReplayStore = () => { const s = new Set(); return { has: (k) => s.has(k), add: (k) => s.add(k) }; };

/**
 * createOwnerSigner({ network, agentKey, trustedGovernanceKey, account, definitions, replay, now })
 *  agentKey: the agent's seed (kept in this closure; never returned). account: Rose's address the delegation is from.
 *  sign(unsignedTx, permit) -> { tx, tx_blob, hash }   (Sequence, Fee and LastLedgerSequence must already be filled)
 */
export function createOwnerSigner({ network, agentKey, trustedGovernanceKey, account, definitions, replay = memoryReplayStore(), now = () => Date.now() }) {
  const kp = keypairs.deriveKeypair(agentKey);
  const agent = keypairs.deriveAddress(kp.publicKey);
  const log = [];
  function check(tx, permit) {
    if (!permit) refuse('NO_PERMIT', 'no Eterna permit: nothing is signed');
    if (permit.type !== PERMIT_TYPE) refuse('PERMIT_INVALID', 'type');
    if (!verifyPermitSignature(permit, trustedGovernanceKey)) refuse('PERMIT_SIGNATURE_INVALID', 'permit is not signed by the trusted Eterna governance key (or was altered)');
    if (now() >= Date.parse(permit.expiresAt)) refuse('PERMIT_EXPIRED', `permit expired at ${permit.expiresAt}`);
    const pd = permitDigest(permit);
    if (replay.has(pd) || replay.has(`nonce:${permit.nonce}`) || replay.has(`order:${permit.orderId}`)) refuse('PERMIT_REPLAYED', 'permit, nonce or order already signed');
    if (permit.network !== network) refuse('NETWORK_MISMATCH', `permit for ${permit.network}, signer is ${network}`);
    const bad = [];
    if (tx.TransactionType !== 'Payment') bad.push('TransactionType must be Payment');
    if (tx.Account !== permit.account || tx.Account !== account) bad.push('Account');
    if (tx.Delegate !== permit.delegate || tx.Delegate !== agent) bad.push('Delegate');
    if (tx.Destination !== permit.destination) bad.push('Destination');
    if (!sameAmount(tx.Amount, permit.amount)) bad.push('Amount');
    if (tx.DeliverMax !== undefined && !sameAmount(tx.DeliverMax, permit.amount)) bad.push('DeliverMax');
    if (tx.SendMax !== undefined || tx.Paths !== undefined || tx.DeliverMin !== undefined) bad.push('SendMax/Paths/DeliverMin not allowed');
    if (((tx.Flags ?? 0) & (TF_PARTIAL_PAYMENT | TF_LIMIT_QUALITY | TF_NO_RIPPLE_DIRECT)) !== 0) bad.push('partial-payment / quality flags not allowed');
    if (!/^\d+$/.test(tx.Fee ?? '') || BigInt(tx.Fee) > BigInt(permit.maxFeeDrops)) bad.push(`Fee above permit cap ${permit.maxFeeDrops}`);
    if (!Number.isSafeInteger(tx.Sequence) || !Number.isSafeInteger(tx.LastLedgerSequence)) bad.push('Sequence and LastLedgerSequence must be filled');
    if (network === 'xrpl:0' && (tx.Sponsor !== undefined || tx.SponsorFlags !== undefined || tx.SponsorSignature !== undefined)) bad.push('no sponsorship on Mainnet (Sponsor amendment not enabled)');
    if (NETWORK_IDS[network] <= 1024 && tx.NetworkID !== undefined) bad.push('NetworkID must be absent on this network');
    if (tx.TxnSignature !== undefined || tx.Signers !== undefined) bad.push('already signed');
    if (!memoValues(tx, 'eterna/order').includes(permit.orderId)) bad.push('order memo');
    if (!memoValues(tx, 'eterna/mission-certificate').includes(permit.certificateDigest)) bad.push('certificate memo');
    if (permit.quoteId && !memoValues(tx, 'eterna/quote').includes(permit.quoteId)) bad.push('quote memo');
    if (bad.length) refuse('TX_PERMIT_MISMATCH', bad.join('; '));
    return pd;
  }
  function sign(unsignedTx, permit) {
    const pd = check(unsignedTx, permit);
    const body = { ...unsignedTx, SigningPubKey: kp.publicKey };
    const tx = { ...body, TxnSignature: keypairs.sign(x68.accountSigningData(body, definitions), kp.privateKey) };
    const out = { tx, tx_blob: x68.encode(tx, definitions), hash: x68.txHash(tx, definitions) };
    replay.add(pd); replay.add(`nonce:${permit.nonce}`); replay.add(`order:${permit.orderId}`);
    log.push({ permitDigest: pd, orderId: permit.orderId, hash: out.hash, at: new Date(now()).toISOString() });
    return out;
  }
  return Object.freeze({ address: agent, network, sign, check: (tx, p) => { check(tx, p); return true; }, log: () => log.map((x) => ({ ...x })) });
}

// ---- key file on the owner device -----------------------------------------------------------------------------------------
/** Create (once) or load the agent key at <dir>/agent.key (dir 0700, file 0600). Returns the address and the seed loader. */
export function ownerAgentKey(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const p = join(dir, 'agent.key');
  if (!existsSync(p)) {
    const seed = keypairs.generateSeed({ algorithm: 'ed25519' });
    const address = keypairs.deriveAddress(keypairs.deriveKeypair(seed).publicKey);
    writeFileSync(p, JSON.stringify({ purpose: 'Eterna agent key for Rose\'s XLS-75 delegation; owner device only', algorithm: 'ed25519', address, seed }, null, 1), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(p, 0o600);
  const k = JSON.parse(readFileSync(p, 'utf8'));
  return { address: k.address, path: p, seed: () => k.seed };
}
