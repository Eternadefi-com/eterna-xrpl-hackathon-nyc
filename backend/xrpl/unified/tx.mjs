// Transaction builders for the Rose mission (XRPL Devnet). OFFLINE: build, check, encode, sign; never submits.
// XLS-68 comes from ../xls68/xls68.mjs (snapshot definitions, SPN/STX prefixes, preflight). XLS-75 DelegateSet is a
// minimal port of buildNyDelegateSet from eterna-production backend/xrpl/lib/delegate-binding-resolver.mjs at commit
// 97b9193 (branch codex/ny-agent-orchestration-v1): Account=principal, Authorize=delegate, Permissions=[Payment] only,
// one certificate memo. The C56 proof plumbing of that builder is replaced by our mission certificate digest.
import { createRequire } from 'node:module';
import * as x68 from '../xls68/xls68.mjs';
import { fail, memo, MEMO } from './common.mjs';

const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const codec = require('ripple-binary-codec');
const { isValidClassicAddress } = require('ripple-address-codec');

// ripple-binary-codec 2.7.0 XrplDefinitionsBase calls associateTypes() before it builds delegatablePermissions, so a
// definitions object built from a server_definitions snapshot cannot encode PermissionValue. Re-associating once fills
// in only that missing association (idempotent for every other field).
if (!x68.DEVNET_DEFINITIONS.field.PermissionValue.associatedType) x68.DEVNET_DEFINITIONS.associateTypes(codec.coreTypes);

const SPF = x68.FLAGS.SponsorFlags;
export const PERMISSION_MAX = 10; // rippled 3.4.1 include/xrpl/protocol/Protocol.h kPermissionMaxSize
const hex64 = (d, n) => { if (!/^[0-9a-f]{64}$/.test(d ?? '')) throw fail('temMALFORMED', `${n} must be a lowercase sha256 hex digest`); return d; };
const addr = (a, n) => { if (!isValidClassicAddress(a)) throw fail('temMALFORMED', `${n} must be a classic address`); return a; };
const common = ({ sequence = 0, fee = '12', lastLedgerSequence }) => {
  const t = { Fee: String(fee), Sequence: sequence };
  if (lastLedgerSequence !== undefined) t.LastLedgerSequence = lastLedgerSequence;
  return t;
};

/** Local preflight for the delegation rules this mission relies on (rippled 3.4.1), on top of xls68.check. */
export function checkMission(tx) {
  if (tx.Delegate !== undefined) {
    addr(tx.Delegate, 'Delegate');
    if (tx.Delegate === tx.Account) throw fail('temBAD_SIGNER', 'Delegate equals Account (Transactor.cpp preflight1)');
    if (tx.SponsorFlags !== undefined && (tx.SponsorFlags & SPF.spfSponsorReserve)) throw fail('temINVALID', 'spfSponsorReserve with Delegate (Transactor.cpp checkSponsor)');
  }
  if (tx.TransactionType === 'DelegateSet') {
    addr(tx.Authorize, 'Authorize');
    if (tx.Account === tx.Authorize) throw fail('temMALFORMED', 'cannot authorize self (DelegateSet.cpp preflight)');
    const p = tx.Permissions;
    if (!Array.isArray(p)) throw fail('temMALFORMED', 'Permissions must be an array');
    if (p.length > PERMISSION_MAX) throw fail('temARRAY_TOO_LARGE', 'too many permissions');
    const vals = p.map((e) => e?.Permission?.PermissionValue);
    if (new Set(vals).size !== vals.length) throw fail('temMALFORMED', 'duplicate permission');
  }
  return x68.check(tx);
}

/** XLS-68 step: Eterna creates Rose's agent account with 1 drop; Eterna carries the account reserve. */
export const buildAgentAccountCreate = ({ eterna, agent, ...rest }) =>
  checkMission(x68.buildSponsoredAccountCreate({ sponsor: eterna, destination: agent, amountDrops: '1', ...rest }));

/** XLS-75 step: Rose grants the agent the Payment permission only. Eterna co-signs as fee + reserve sponsor (allowed:
 *  DelegateSet is on isReserveSponsorAllowed and carries no Delegate field). */
export function buildSponsoredDelegateSet({ rose, agent, sponsor, certificateDigest, sponsorReserve = true, ...rest }) {
  const tx = { TransactionType: 'DelegateSet', Account: addr(rose, 'rose'), Authorize: addr(agent, 'agent'), ...common(rest),
    Permissions: [{ Permission: { PermissionValue: 'Payment' } }], Memos: [memo(MEMO.certificate, hex64(certificateDigest, 'certificateDigest'))] };
  return checkMission(x68.withSponsor(tx, { sponsor, fee: true, reserve: sponsorReserve }));
}

/** Settlement: ONE delegated Payment Rose -> seller, signed by the agent (Delegate), fee-only sponsored by Eterna
 *  (spfSponsorFee + Delegate is allowed; spfSponsorReserve + Delegate is temINVALID and is never built). */
export function buildDelegatedSettlement({ rose, agent, seller, sponsor, amountDrops, batchDigest, certificateDigest, ...rest }) {
  if (!/^[1-9]\d*$/.test(amountDrops ?? '')) throw fail('temBAD_AMOUNT', 'amountDrops');
  const tx = { TransactionType: 'Payment', Account: addr(rose, 'rose'), Delegate: addr(agent, 'agent'), Destination: addr(seller, 'seller'),
    Amount: amountDrops, ...common(rest),
    Memos: [memo(MEMO.voucherBatch, hex64(batchDigest, 'batchDigest')), memo(MEMO.certificate, hex64(certificateDigest, 'certificateDigest'))] };
  return checkMission(sponsor ? x68.withSponsor(tx, { sponsor, fee: true, reserve: false }) : tx);
}

/** Audit anchor: one AccountSet from Eterna carrying the receipt digest. */
export const buildAnchor = ({ eterna, receiptDigest, ...rest }) =>
  checkMission({ TransactionType: 'AccountSet', Account: addr(eterna, 'eterna'), ...common(rest), Memos: [memo(MEMO.auditReceipt, hex64(receiptDigest, 'receiptDigest'))] });

// ---- signing -------------------------------------------------------------------------------------------------------
const kp = (k) => (typeof k === 'string' ? keypairs.deriveKeypair(k) : k);
/** The account that must produce TxnSignature: the Delegate when present (Transactor::checkSign), else Account. */
export const signerOf = (tx) => tx.Delegate ?? tx.Account;
const finish = (tx) => ({ tx, tx_blob: x68.encode(tx), hash: x68.txHash(tx) });

/** Single-signed (no co-signer). */
export function signSingle(tx, key) {
  const k = kp(key);
  if (keypairs.deriveAddress(k.publicKey) !== signerOf(tx)) throw fail('tefBAD_AUTH', 'key is not the required signer');
  const body = checkMission({ ...tx, SigningPubKey: k.publicKey });
  return finish({ ...body, TxnSignature: keypairs.sign(x68.accountSigningData(body), k.privateKey) });
}
/** Co-signed: sponsor signs 'SPN\0'||body, then the signer (Account or Delegate) signs 'STX\0'||body. */
export function cosign(tx, { signerKey, sponsorKey }) {
  const s = kp(signerKey), p = kp(sponsorKey);
  if (keypairs.deriveAddress(s.publicKey) !== signerOf(tx)) throw fail('tefBAD_AUTH', 'signer key is not the Account/Delegate');
  if (keypairs.deriveAddress(p.publicKey) !== tx.Sponsor) throw fail('tefBAD_AUTH', 'sponsor key is not tx.Sponsor');
  const body = checkMission({ ...tx, SigningPubKey: s.publicKey });
  const withSponsor = { ...body, SponsorSignature: { SigningPubKey: p.publicKey, TxnSignature: keypairs.sign(x68.sponsorSigningData(body), p.privateKey) } };
  return finish({ ...withSponsor, TxnSignature: keypairs.sign(x68.accountSigningData(withSponsor), s.privateKey) });
}

const safe = (f) => { try { return f(); } catch { return false; } };
/** Re-verify signatures of a (decoded / ledger-returned) tx: signer = Delegate ?? Account; sponsor under SPN. */
export function verifySignatures(tx) {
  const signer = safe(() => keypairs.deriveAddress(tx.SigningPubKey) === signerOf(tx) && keypairs.verify(x68.accountSigningData(tx), tx.TxnSignature, tx.SigningPubKey));
  const sponsor = tx.SponsorSignature ? x68.verifySponsorSignature(tx) : null;
  return { signer, sponsor };
}
