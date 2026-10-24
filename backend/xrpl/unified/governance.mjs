// Governance: Eterna's mission certificate, Rose's approval signature over its digest, and the policy gate that every
// voucher must pass BEFORE it is signed. Offline; no network code.
import { createRequire } from 'node:module';
import { canonicalJson, sha256Hex, hexUtf8, fail } from './common.mjs';

const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const { isValidClassicAddress } = require('ripple-address-codec');

const drops = (v, n) => { if (typeof v !== 'string' || !/^[1-9]\d{0,16}$/.test(v)) throw fail('CERT_INVALID', `${n} must be positive drops`); return v; };
const addr = (a, n) => { if (!isValidClassicAddress(a)) throw fail('CERT_INVALID', `${n} must be a classic address`); return a; };
const iso = (t, n) => { if (typeof t !== 'string' || Number.isNaN(Date.parse(t))) throw fail('CERT_INVALID', `${n} must be ISO time`); return t; };

export const CERT_TYPE = 'eterna.mission-certificate.v1';
/** The mission certificate Eterna issues. All amounts are XRP drops strings; times ISO-8601 UTC. */
export function buildCertificate({ missionId, rose, agent, agentVoucherAddress, seller, sponsor, task, perVoucherDrops, capDrops, issuedAt, expiry }) {
  if (BigInt(drops(perVoucherDrops, 'perVoucherDrops')) > BigInt(drops(capDrops, 'capDrops'))) throw fail('CERT_INVALID', 'per-voucher limit exceeds cap');
  if (!/^0x[0-9a-fA-F]{40}$/.test(agentVoucherAddress ?? '')) throw fail('CERT_INVALID', 'agentVoucherAddress must be an EVM-style address');
  if (Date.parse(iso(expiry, 'expiry')) <= Date.parse(iso(issuedAt, 'issuedAt'))) throw fail('CERT_INVALID', 'expiry must follow issuedAt');
  return {
    type: CERT_TYPE, missionId, issuer: 'Eterna', network: 'XRPL Devnet', networkId: 2,
    principal: { name: 'Rose (fictional persona)', treasury: addr(rose, 'rose') },
    agent: { xrpl: addr(agent, 'agent'), voucherKey: agentVoucherAddress.toLowerCase() },
    task, approvedSellers: [addr(seller, 'seller')], sponsor: addr(sponsor, 'sponsor'),
    limits: { currency: 'XRP', perVoucherDrops, capDrops }, voucherScheme: 'eterna-voucher-sim', issuedAt, expiry,
  };
}
export const certificateDigest = (cert) => sha256Hex(canonicalJson(cert));

// The principal signs a domain-separated message (not a transaction): "ETERNA-MISSION-APPROVAL\0" || digest bytes.
// signDigest / verifyDigestApproval are generic (any certificate shape); commerce/governance.mjs reuses them.
const approvalMessage = (digest) => hexUtf8('ETERNA-MISSION-APPROVAL\0') + digest.toUpperCase();
export function signDigest(digest, key, expectedAddress) {
  const kp = typeof key === 'string' ? keypairs.deriveKeypair(key) : key;
  if (keypairs.deriveAddress(kp.publicKey) !== expectedAddress) throw fail('APPROVAL_SIGNER', 'key is not the certificate principal');
  return { certificateDigest: digest, signer: expectedAddress, publicKey: kp.publicKey, signature: keypairs.sign(approvalMessage(digest), kp.privateKey), scheme: 'xrpl-keypair/ETERNA-MISSION-APPROVAL' };
}
export function verifyDigestApproval(digest, approval, expectedAddress) {
  try {
    return approval?.certificateDigest === digest && keypairs.deriveAddress(approval.publicKey) === expectedAddress
      && approval.signer === expectedAddress && keypairs.verify(approvalMessage(digest), approval.signature, approval.publicKey);
  } catch { return false; }
}
export const roseApprove = (cert, roseKey) => signDigest(certificateDigest(cert), roseKey, cert.principal.treasury);
/** True only if the approval is by the certificate principal, over this exact certificate. */
export const verifyRoseApproval = (cert, approval) => { try { return verifyDigestApproval(certificateDigest(cert), approval, cert.principal.treasury); } catch { return false; } };

const refuse = (code, why) => { throw Object.assign(fail(code, why), { refusal: true }); };
/** Gate for opening a voucher session: approved principal, approved seller, cap and expiry inside the certificate. */
export function sessionPolicyCheck(cert, { approval, seller, voucherKey, capDrops, expiry, now = Date.now() }) {
  if (!verifyRoseApproval(cert, approval)) refuse('POLICY_NOT_APPROVED_BY_PRINCIPAL', 'certificate lacks a valid principal approval');
  if (now >= Date.parse(cert.expiry)) refuse('POLICY_CERT_EXPIRED', 'mission certificate expired');
  if (!cert.approvedSellers.includes(seller)) refuse('POLICY_SELLER_NOT_APPROVED', `seller ${seller} is not approved by the certificate`);
  if (String(voucherKey ?? '').toLowerCase() !== cert.agent.voucherKey) refuse('POLICY_AGENT_MISMATCH', 'voucher key is not the certified agent key');
  if (BigInt(capDrops) > BigInt(cert.limits.capDrops)) refuse('POLICY_CAP_EXCEEDED', `session cap ${capDrops} > certificate cap ${cert.limits.capDrops}`);
  if (expiry * 1000 > Date.parse(cert.expiry)) refuse('POLICY_VOUCHER_OUTLIVES_CERT', 'session expiry is after the certificate expiry');
  return { approved: true };
}

/** Eterna's policy gate. Throws { code } (a refusal) or returns the approved increment. Called before any voucher signature.
 *  req: { approval, seller, voucherKey, previousCumulativeDrops, cumulativeDrops, voucherExpiry, now(ms) } */
export function policyCheck(cert, req) {
  if (!verifyRoseApproval(cert, req.approval)) refuse('POLICY_NOT_APPROVED_BY_PRINCIPAL', 'certificate lacks a valid principal approval');
  const now = req.now ?? Date.now();
  if (now >= Date.parse(cert.expiry)) refuse('POLICY_CERT_EXPIRED', 'mission certificate expired');
  if (!cert.approvedSellers.includes(req.seller)) refuse('POLICY_SELLER_NOT_APPROVED', `seller ${req.seller} is not approved by the certificate`);
  if (String(req.voucherKey ?? '').toLowerCase() !== cert.agent.voucherKey) refuse('POLICY_AGENT_MISMATCH', 'voucher key is not the certified agent key');
  const prev = BigInt(req.previousCumulativeDrops ?? '0'), cum = BigInt(req.cumulativeDrops);
  const inc = cum - prev;
  if (inc <= 0n) refuse('POLICY_NOT_MONOTONIC', 'cumulative amount must increase');
  if (inc > BigInt(cert.limits.perVoucherDrops)) refuse('POLICY_PER_VOUCHER_EXCEEDED', `voucher increment ${inc} > per-voucher limit ${cert.limits.perVoucherDrops}`);
  if (cum > BigInt(cert.limits.capDrops)) refuse('POLICY_CAP_EXCEEDED', `cumulative ${cum} > cap ${cert.limits.capDrops}`);
  if (req.voucherExpiry !== undefined && req.voucherExpiry * 1000 > Date.parse(cert.expiry)) refuse('POLICY_VOUCHER_OUTLIVES_CERT', 'voucher expiry is after the certificate expiry');
  return { approved: true, incrementDrops: inc.toString() };
}
