// XLS-68 (Sponsored Fees and Reserves) transaction builder for XRPL Devnet. OFFLINE ONLY: this module builds, validates,
// encodes, signs and verifies; it has no network code and never submits. Field codes come from a read-only snapshot of
// Devnet's server_definitions (fixtures/devnet-server-definitions.json, rippled 3.4.1). Rules mirror rippled 3.4.1
// (Transactor.cpp preflight1Sponsor, SponsorshipSet.cpp, SponsorshipTransfer.cpp, Payment.cpp, Sign.cpp); see README.md.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const codec = require('ripple-binary-codec');
const keypairs = require('ripple-keypairs');
const { decodeAccountID, isValidClassicAddress } = require('ripple-address-codec');

const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

// ---- definitions --------------------------------------------------------------------------------------------------
export const SNAPSHOT_PATH = new URL('./fixtures/devnet-server-definitions.json', import.meta.url);
export const SNAPSHOT = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
/** Build codec definitions from a server_definitions result (live or snapshot). */
export const definitionsFrom = (serverDefinitions) => new codec.XrplDefinitions(serverDefinitions, codec.coreTypes);
export const DEVNET_DEFINITIONS = definitionsFrom(SNAPSHOT.definitions);

const TF = SNAPSHOT.definitions.TRANSACTION_FLAGS;
const LSF = SNAPSHOT.definitions.LEDGER_ENTRY_FLAGS;
export const FLAGS = Object.freeze({
  // server_definitions TRANSACTION_FLAGS / LEDGER_ENTRY_FLAGS (Devnet snapshot)
  SponsorshipSet: Object.freeze({ ...TF.SponsorshipSet }),
  SponsorshipTransfer: Object.freeze({ ...TF.SponsorshipTransfer }),
  Payment: Object.freeze({ ...TF.Payment }),
  Sponsorship: Object.freeze({ ...LSF.Sponsorship }),
  // SponsorFlags values are NOT exposed by server_definitions; from rippled 3.4.1 include/xrpl/protocol/TxFlags.h.
  SponsorFlags: Object.freeze({ spfSponsorFee: 0x1, spfSponsorReserve: 0x2 }),
});
const SPF = FLAGS.SponsorFlags;
const SPF_MASK = ~(SPF.spfSponsorFee | SPF.spfSponsorReserve) >>> 0;
const UNIVERSAL = Object.values(TF.universal).reduce((a, b) => (a | b) >>> 0, 0);

// rippled HashPrefix.h: makeHashPrefix(a,b,c) = a<<24 | b<<16 | c<<8.
const prefix = (s) => Buffer.from([...s].map((c) => c.charCodeAt(0)).concat(0)).toString('hex').toUpperCase();
export const HASH_PREFIX = Object.freeze({
  TxSign: prefix('STX'), TxMultiSign: prefix('SMT'), SponsorTxSign: prefix('SPN'), SponsorTxMultiSign: prefix('SPM'),
  TransactionId: prefix('TXN'),
});

// rippled 3.4.1 SponsorHelpers.cpp isReserveSponsorAllowed. Every non-pseudo tx type may use spfSponsorFee.
export const RESERVE_SPONSOR_ALLOWED = Object.freeze(new Set([
  'DelegateSet', 'DepositPreauth', 'Payment', 'SignerListSet', 'CheckCancel', 'CheckCash', 'CheckCreate', 'EscrowCancel',
  'EscrowCreate', 'EscrowFinish', 'PaymentChannelClaim', 'PaymentChannelCreate', 'PaymentChannelFund', 'Clawback',
  'MPTokenAuthorize', 'MPTokenIssuanceCreate', 'MPTokenIssuanceDestroy', 'MPTokenIssuanceSet', 'TrustSet',
  'CredentialAccept', 'CredentialCreate', 'CredentialDelete', 'AccountSet', 'SetRegularKey', 'SponsorshipTransfer',
]));
const PSEUDO = new Set(['EnableAmendment', 'SetFee', 'UNLModify']);

// ---- small helpers ------------------------------------------------------------------------------------------------
const isAddr = (a) => typeof a === 'string' && isValidClassicAddress(a);
const needAddr = (a, name) => { if (!isAddr(a)) throw fail('temMALFORMED', `${name} must be a classic address`); return a; };
const drops = (v, name, { allowZero = false, allowNegative = false } = {}) => {
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) throw fail('temBAD_AMOUNT', `${name} must be an XRP drops string`);
  const n = BigInt(v);
  if (n === 0n && !allowZero) throw fail('temBAD_AMOUNT', `${name} must not be zero`);
  if (n < 0n && !allowNegative) throw fail('temBAD_AMOUNT', `${name} must not be negative`);
  return v;
};
const u32 = (v, name) => { if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw fail('temMALFORMED', `${name} must be a UInt32`); return v; };
const flagsOf = (tx) => (tx.Flags ?? 0) >>> 0;
const has = (tx, f) => tx[f] !== undefined;
const sha512Half = (hex) => createHash('sha512').update(Buffer.from(hex, 'hex')).digest().subarray(0, 32).toString('hex').toUpperCase();

const accountIdHex = (a) => Buffer.from(decodeAccountID(a)).toString('hex');
/** rippled Indexes.cpp indexHash: SHA512Half(uint16 namespace || parts...). */
export const indexHash = (namespaceChar, ...hexParts) => sha512Half(namespaceChar.charCodeAt(0).toString(16).padStart(4, '0') + hexParts.join(''));
/** Ledger key of the Sponsorship object: indexHash('>' 0x3E, sponsor AccountID, sponsee AccountID). */
export function sponsorshipKeylet(sponsor, sponsee) {
  needAddr(sponsor, 'sponsor'); needAddr(sponsee, 'sponsee');
  return indexHash('>', accountIdHex(sponsor), accountIdHex(sponsee));
}
/** Ledger key of a DepositPreauth object: indexHash('p', owner, authorized). */
export const depositPreauthKeylet = (owner, authorized) => indexHash('p', accountIdHex(needAddr(owner, 'owner')), accountIdHex(needAddr(authorized, 'authorized')));

/** Account reserve under Sponsor (AccountRootHelpers.cpp accountReserve/ownerCount/accountCountImpl), in drops. */
export function requiredReserveDrops(acct, { baseDrops, incDrops }) {
  const owner = BigInt(acct.OwnerCount ?? 0) - BigInt(acct.SponsoredOwnerCount ?? 0) + BigInt(acct.SponsoringOwnerCount ?? 0);
  const accounts = BigInt(acct.Sponsor ? 0 : 1) + BigInt(acct.SponsoringAccountCount ?? 0);
  return BigInt(baseDrops) * accounts + BigInt(incDrops) * owner;
}

/** Minimum fee in drops: base * (1 + |Signers| + |SponsorSignature.Signers|) (Transactor::calculateBaseFee). A
 *  single-signed SponsorSignature adds nothing. */
export const minimumFeeDrops = (tx, baseDrops) =>
  BigInt(baseDrops) * BigInt(1 + (tx.Signers?.length ?? 0) + (tx.SponsorSignature?.Signers?.length ?? 0));

// ---- local preflight (mirrors rippled 3.4.1; returns the tx or throws { code }) ----------------------------------------
export function checkSponsorFields(tx) {
  if (!tx || typeof tx !== 'object' || typeof tx.TransactionType !== 'string') throw fail('temMALFORMED', 'not a transaction');
  needAddr(tx.Account, 'Account');
  const hasS = has(tx, 'Sponsor'), hasF = has(tx, 'SponsorFlags'), hasSig = has(tx, 'SponsorSignature');
  if ((hasS || hasF || hasSig) && PSEUDO.has(tx.TransactionType)) throw fail('temINVALID_FLAG', 'pseudo-transactions cannot be sponsored');
  if (hasS !== hasF) throw fail('temINVALID_FLAG', 'Sponsor and SponsorFlags must appear together');
  if (hasSig && !(hasS && hasF)) throw fail('temMALFORMED', 'SponsorSignature without Sponsor/SponsorFlags');
  if (hasF) {
    const f = tx.SponsorFlags;
    if (!Number.isInteger(f) || f < 0 || f > 0xffffffff || (f & SPF_MASK) !== 0 || f === 0) throw fail('temINVALID_FLAG', 'SponsorFlags must be a non-zero combination of spfSponsorFee|spfSponsorReserve');
    if ((f & SPF.spfSponsorReserve) && !RESERVE_SPONSOR_ALLOWED.has(tx.TransactionType)) throw fail('temINVALID_FLAG', `spfSponsorReserve not allowed on ${tx.TransactionType}`);
    if ((f & SPF.spfSponsorReserve) && has(tx, 'Delegate')) throw fail('temINVALID', 'reserve sponsorship cannot be combined with Delegate');
  }
  if (hasS) { needAddr(tx.Sponsor, 'Sponsor'); if (tx.Sponsor === tx.Account) throw fail('temMALFORMED', 'Sponsor cannot equal Account'); }
  if (hasSig) {
    const s = tx.SponsorSignature;
    if (!s || typeof s !== 'object') throw fail('temMALFORMED', 'SponsorSignature must be an object');
    if (s.Signers !== undefined && (s.TxnSignature !== undefined || (s.SigningPubKey ?? '') !== '')) throw fail('temBAD_SIGNATURE', 'cannot both single- and multi-sign SponsorSignature');
  }
  return tx;
}

export function checkSponsorshipSet(tx) {
  checkSponsorFields(tx);
  const f = flagsOf(tx), S = FLAGS.SponsorshipSet;
  if ((f & ~(UNIVERSAL | Object.values(S).reduce((a, b) => a | b, 0))) >>> 0) throw fail('temINVALID_FLAG', 'unknown SponsorshipSet flag');
  if ((f & S.tfSponsorshipSetRequireSignForFee) && (f & S.tfSponsorshipClearRequireSignForFee)) throw fail('temINVALID_FLAG', 'set and clear RequireSignForFee');
  if ((f & S.tfSponsorshipSetRequireSignForReserve) && (f & S.tfSponsorshipClearRequireSignForReserve)) throw fail('temINVALID_FLAG', 'set and clear RequireSignForReserve');
  const hasCp = has(tx, 'CounterpartySponsor'), hasSe = has(tx, 'Sponsee');
  if (hasCp === hasSe) throw fail('temMALFORMED', 'exactly one of CounterpartySponsor / Sponsee');
  const sponsor = hasCp ? needAddr(tx.CounterpartySponsor, 'CounterpartySponsor') : tx.Account;
  const sponsee = hasSe ? needAddr(tx.Sponsee, 'Sponsee') : tx.Account;
  if (sponsor === sponsee) throw fail('temMALFORMED', 'sponsor equals sponsee');
  if (has(tx, 'SponsorFlags') && (tx.SponsorFlags & SPF.spfSponsorReserve)) throw fail('temINVALID_FLAG', 'SponsorshipSet reserve cannot be sponsored');
  if (f & S.tfDeleteObject) {
    const modify = S.tfSponsorshipSetRequireSignForFee | S.tfSponsorshipSetRequireSignForReserve | S.tfSponsorshipClearRequireSignForFee | S.tfSponsorshipClearRequireSignForReserve;
    if (f & modify) throw fail('temINVALID_FLAG', 'delete cannot change require-sign flags');
    if (has(tx, 'FeeAmountDelta') || has(tx, 'RemainingOwnerCountDelta') || has(tx, 'MaxFee')) throw fail('temMALFORMED', 'delete cannot carry budget fields');
    return tx;
  }
  if (tx.Account !== sponsor) throw fail('temMALFORMED', 'only the sponsor may create or update a Sponsorship');
  if (has(tx, 'FeeAmountDelta')) drops(tx.FeeAmountDelta, 'FeeAmountDelta', { allowNegative: true });
  if (has(tx, 'MaxFee')) drops(tx.MaxFee, 'MaxFee', { allowZero: true });
  if (has(tx, 'RemainingOwnerCountDelta')) {
    const d = tx.RemainingOwnerCountDelta;
    if (!Number.isInteger(d) || d < -0x80000000 || d > 0x7fffffff) throw fail('temMALFORMED', 'RemainingOwnerCountDelta must be an Int32');
    if (d === 0) throw fail('temINVALID', 'RemainingOwnerCountDelta must not be zero');
  }
  if (!has(tx, 'FeeAmountDelta') && !has(tx, 'RemainingOwnerCountDelta') && !has(tx, 'MaxFee') && (f & ~UNIVERSAL) === 0) throw fail('temREDUNDANT', 'nothing to change');
  return tx;
}

export function checkSponsorshipTransfer(tx) {
  checkSponsorFields(tx);
  const f = flagsOf(tx), T = FLAGS.SponsorshipTransfer;
  const mode = [T.tfSponsorshipEnd, T.tfSponsorshipCreate, T.tfSponsorshipReassign].filter((b) => f & b);
  if (mode.length !== 1) throw fail('temINVALID_FLAG', 'exactly one of tfSponsorshipEnd/Create/Reassign');
  if ((f & ~(UNIVERSAL | T.tfSponsorshipEnd | T.tfSponsorshipCreate | T.tfSponsorshipReassign)) >>> 0) throw fail('temINVALID_FLAG', 'unknown SponsorshipTransfer flag');
  if (has(tx, 'ObjectID') && !/^[0-9A-F]{64}$/i.test(tx.ObjectID)) throw fail('temMALFORMED', 'ObjectID must be Hash256 hex');
  if (f & T.tfSponsorshipEnd) {
    if (has(tx, 'Sponsor')) throw fail('temMALFORMED', 'End path excludes Sponsor');
    if (has(tx, 'Sponsee') && needAddr(tx.Sponsee, 'Sponsee') === tx.Account) throw fail('temMALFORMED', 'Sponsee equals Account');
    return tx;
  }
  if (!has(tx, 'Sponsor')) throw fail('temMALFORMED', 'Create/Reassign need Sponsor');
  if (!(tx.SponsorFlags & SPF.spfSponsorReserve)) throw fail('temINVALID_FLAG', 'Create/Reassign need spfSponsorReserve');
  if (has(tx, 'Sponsee')) throw fail('temMALFORMED', 'Create/Reassign exclude Sponsee');
  if (!has(tx, 'ObjectID') && !has(tx, 'SponsorSignature')) throw fail('temMALFORMED', 'account-level Create/Reassign require SponsorSignature');
  return tx;
}

export function checkSponsoredAccountCreate(tx) {
  checkSponsorFields(tx);
  const f = flagsOf(tx), P = FLAGS.Payment;
  if (!(f & P.tfSponsorCreatedAccount)) return tx;
  if (f & (P.tfNoRippleDirect | P.tfPartialPayment | P.tfLimitQuality)) throw fail('temINVALID_FLAG', 'tfSponsorCreatedAccount excludes path flags');
  if (has(tx, 'SendMax') || has(tx, 'Paths')) throw fail('temINVALID', 'tfSponsorCreatedAccount excludes SendMax/Paths');
  drops(tx.Amount, 'Amount');
  needAddr(tx.Destination, 'Destination');
  return tx;
}

/** Dispatch the local preflight by type. */
export function check(tx) {
  if (tx?.TransactionType === 'SponsorshipSet') return checkSponsorshipSet(tx);
  if (tx?.TransactionType === 'SponsorshipTransfer') return checkSponsorshipTransfer(tx);
  if (tx?.TransactionType === 'Payment') return checkSponsoredAccountCreate(tx);
  return checkSponsorFields(tx);
}

// ---- builders (unsigned; Sequence / Fee / LastLedgerSequence come from the caller's autofill) -------------------------
const common = ({ account, sequence, fee = '12', lastLedgerSequence, memos }) => {
  const tx = { Account: needAddr(account, 'account'), Fee: drops(String(fee), 'Fee', { allowZero: true }), Sequence: u32(sequence ?? 0, 'sequence') };
  if (lastLedgerSequence !== undefined) tx.LastLedgerSequence = u32(lastLedgerSequence, 'lastLedgerSequence');
  if (memos) tx.Memos = memos;
  return tx;
};
const sponsorFlagsFor = ({ fee = true, reserve = false }) => (fee ? SPF.spfSponsorFee : 0) | (reserve ? SPF.spfSponsorReserve : 0);

/** Attach a sponsor to any transaction. fee/reserve choose spfSponsorFee / spfSponsorReserve. */
export function withSponsor(tx, { sponsor, fee = true, reserve = false }) {
  const out = { ...tx, Sponsor: needAddr(sponsor, 'sponsor'), SponsorFlags: sponsorFlagsFor({ fee, reserve }) };
  return check(out);
}

/** Eterna creates Rose's agent account with ~0 XRP; Eterna (tx.Account) carries the 1-account reserve. */
export function buildSponsoredAccountCreate({ sponsor, destination, amountDrops = '1', ...rest }) {
  return check({ TransactionType: 'Payment', ...common({ account: sponsor, ...rest }), Destination: needAddr(destination, 'destination'),
    Amount: drops(String(amountDrops), 'amountDrops'), Flags: FLAGS.Payment.tfSponsorCreatedAccount });
}

/** Rose's agent pre-authorises Eterna (creates a DepositPreauth object). With reserve=true, Eterna carries its reserve. */
export function buildSponsoredDepositPreauth({ account, authorize, sponsor, fee = true, reserve = true, ...rest }) {
  return withSponsor({ TransactionType: 'DepositPreauth', ...common({ account, ...rest }), Authorize: needAddr(authorize, 'authorize') }, { sponsor, fee, reserve });
}

/** A sponsored AccountSet (no object created: only fee sponsorship is observable). */
export function buildSponsoredAccountSet({ account, sponsor, fields = {}, ...rest }) {
  return withSponsor({ TransactionType: 'AccountSet', ...common({ account, ...rest }), ...fields }, { sponsor, fee: true });
}

/** Sponsor pre-funds a sponsee: creates/updates the Sponsorship object (sponsor = tx.Account). */
export function buildSponsorshipSet({ sponsor, sponsee, feeAmountDelta, maxFee, remainingOwnerCountDelta, requireSignForFee, requireSignForReserve, ...rest }) {
  const S = FLAGS.SponsorshipSet;
  let Flags = 0;
  if (requireSignForFee === true) Flags |= S.tfSponsorshipSetRequireSignForFee;
  if (requireSignForFee === false) Flags |= S.tfSponsorshipClearRequireSignForFee;
  if (requireSignForReserve === true) Flags |= S.tfSponsorshipSetRequireSignForReserve;
  if (requireSignForReserve === false) Flags |= S.tfSponsorshipClearRequireSignForReserve;
  const tx = { TransactionType: 'SponsorshipSet', ...common({ account: sponsor, ...rest }), Sponsee: needAddr(sponsee, 'sponsee'), Flags };
  if (feeAmountDelta !== undefined) tx.FeeAmountDelta = String(feeAmountDelta);
  if (maxFee !== undefined) tx.MaxFee = String(maxFee);
  if (remainingOwnerCountDelta !== undefined) tx.RemainingOwnerCountDelta = remainingOwnerCountDelta;
  return checkSponsorshipSet(tx);
}

/** Delete a Sponsorship (either party). Remaining FeeAmount returns to the sponsor. */
export function buildSponsorshipDelete({ account, sponsee, counterpartySponsor, ...rest }) {
  const tx = { TransactionType: 'SponsorshipSet', ...common({ account, ...rest }), Flags: FLAGS.SponsorshipSet.tfDeleteObject };
  if (sponsee !== undefined) tx.Sponsee = sponsee;
  if (counterpartySponsor !== undefined) tx.CounterpartySponsor = counterpartySponsor;
  return checkSponsorshipSet(tx);
}

/** SponsorshipTransfer. mode: 'end' | 'create' | 'reassign'. objectId omitted = the account itself. */
export function buildSponsorshipTransfer({ account, mode, objectId, sponsor, sponsee, ...rest }) {
  const T = FLAGS.SponsorshipTransfer;
  const Flags = { end: T.tfSponsorshipEnd, create: T.tfSponsorshipCreate, reassign: T.tfSponsorshipReassign }[mode];
  if (!Flags) throw fail('temINVALID_FLAG', 'mode must be end | create | reassign');
  const tx = { TransactionType: 'SponsorshipTransfer', ...common({ account, ...rest }), Flags };
  if (objectId !== undefined) tx.ObjectID = objectId;
  if (sponsee !== undefined) tx.Sponsee = sponsee;
  if (mode !== 'end') { tx.Sponsor = needAddr(sponsor, 'sponsor'); tx.SponsorFlags = SPF.spfSponsorReserve; }
  return tx; // run checkSponsorshipTransfer after the sponsor signature is attached (account-level create/reassign need it)
}

// ---- encoding and signing -----------------------------------------------------------------------------------------
export const encode = (tx, defs = DEVNET_DEFINITIONS) => codec.encode(tx, defs);
export const decode = (hex, defs = DEVNET_DEFINITIONS) => codec.decode(hex, defs);
/** Fields covered by every signature: the tx minus non-signing fields (TxnSignature, Signers, SponsorSignature). */
export const signingBody = (tx, defs = DEVNET_DEFINITIONS) => codec.encodeForSigning(tx, defs).slice(HASH_PREFIX.TxSign.length);
/** Bytes the account (sponsee) signs: 'STX\0' || signing body. */
export const accountSigningData = (tx, defs) => HASH_PREFIX.TxSign + signingBody(tx, defs);
/** Bytes the sponsor signs (fixCleanup3_4_0 enabled on Devnet): 'SPN\0' || the same signing body. */
export const sponsorSigningData = (tx, defs) => HASH_PREFIX.SponsorTxSign + signingBody(tx, defs);
export const txHash = (tx, defs = DEVNET_DEFINITIONS) => sha512Half(HASH_PREFIX.TransactionId + encode(tx, defs));

const keyOf = (k) => (typeof k === 'string' ? keypairs.deriveKeypair(k) : k);
const freezeBody = (tx) => {
  if (typeof tx.SigningPubKey !== 'string' || tx.SigningPubKey === '') throw fail('temMALFORMED', 'set the account SigningPubKey before any signature: both signatures cover it');
};

/** Sponsor co-signature. tx.SigningPubKey (the account's key) must already be final. */
export function signAsSponsor(tx, sponsorKey, defs = DEVNET_DEFINITIONS) {
  check(tx); freezeBody(tx);
  if (!has(tx, 'Sponsor')) throw fail('temMALFORMED', 'no Sponsor to sign for');
  const { publicKey, privateKey } = keyOf(sponsorKey);
  if (keypairs.deriveAddress(publicKey) !== tx.Sponsor) throw fail('tefBAD_AUTH', 'sponsor key does not match tx.Sponsor (regular keys are not modelled locally)');
  const TxnSignature = keypairs.sign(sponsorSigningData(tx, defs), privateKey);
  return { ...tx, SponsorSignature: { SigningPubKey: publicKey, TxnSignature } };
}

/** The account's own signature (single-sign). */
export function signAsAccount(tx, accountKey, defs = DEVNET_DEFINITIONS) {
  check(tx); freezeBody(tx);
  const { publicKey, privateKey } = keyOf(accountKey);
  if (publicKey !== tx.SigningPubKey) throw fail('tefBAD_AUTH', 'account key does not match tx.SigningPubKey');
  if (keypairs.deriveAddress(publicKey) !== tx.Account) throw fail('tefBAD_AUTH', 'account key does not match tx.Account (regular keys are not modelled locally)');
  const out = { ...tx, TxnSignature: keypairs.sign(accountSigningData(tx, defs), privateKey) };
  return { tx: out, tx_blob: encode(out, defs), hash: txHash(out, defs) };
}

const safeVerify = (data, sig, pub) => { try { return keypairs.verify(data, sig, pub); } catch { return false; } };
/** Account signature over 'STX\0' || body, by tx.SigningPubKey, which must belong to tx.Account (master key). */
export const verifyAccountSignature = (tx, defs = DEVNET_DEFINITIONS) =>
  typeof tx.TxnSignature === 'string' && typeof tx.SigningPubKey === 'string' && tx.SigningPubKey !== '' &&
  keypairs.deriveAddress(tx.SigningPubKey) === tx.Account && safeVerify(accountSigningData(tx, defs), tx.TxnSignature, tx.SigningPubKey);
/** Sponsor signature over 'SPN\0' || body, by SponsorSignature.SigningPubKey, which must belong to tx.Sponsor (master key). */
export const verifySponsorSignature = (tx, defs = DEVNET_DEFINITIONS) => {
  const s = tx.SponsorSignature;
  if (!s?.SigningPubKey || !s.TxnSignature) return false;
  return keypairs.deriveAddress(s.SigningPubKey) === tx.Sponsor && safeVerify(sponsorSigningData(tx, defs), s.TxnSignature, s.SigningPubKey);
};

/** Full co-signed flow for one transaction: set the account key, sponsor co-signs, account signs. Offline. */
export function cosign(tx, { accountKey, sponsorKey }, defs = DEVNET_DEFINITIONS) {
  const body = { ...tx, SigningPubKey: keyOf(accountKey).publicKey };
  const sponsored = signAsSponsor(body, sponsorKey, defs);
  return signAsAccount(sponsored, accountKey, defs);
}

// ---- the demo plan (unsigned templates; nothing here touches a network) ---------------------------------------------
/** Recommended Devnet sequence. Sequence/Fee/LastLedgerSequence are placeholders to autofill at submission time. */
export function demoPlan({ eterna, roseAgent }) {
  return [
    { step: 1, signers: ['eterna'], purpose: 'Create Rose agent account with 1 drop; Eterna carries the account reserve',
      evidence: ['AccountRoot(roseAgent).Sponsor == eterna', 'AccountRoot(roseAgent).Balance == "1"', 'AccountRoot(eterna).SponsoringAccountCount == 1'],
      tx: buildSponsoredAccountCreate({ sponsor: eterna, destination: roseAgent }) },
    { step: 2, signers: ['eterna (SponsorSignature, SPN prefix)', 'roseAgent (TxnSignature)'], purpose: 'Rose agent acts with zero spendable XRP: Eterna pays the fee and carries the new object reserve',
      evidence: ['validated tx has Sponsor == eterna, SponsorFlags == 3, SponsorSignature', `DepositPreauth ${depositPreauthKeylet(roseAgent, eterna)}.Sponsor == eterna`,
        'AccountRoot(roseAgent): OwnerCount 1, SponsoredOwnerCount 1, Balance still "1"', 'AccountRoot(eterna): SponsoringOwnerCount 1, Balance down by Fee'],
      tx: buildSponsoredDepositPreauth({ account: roseAgent, authorize: eterna, sponsor: eterna, fee: true, reserve: true }) },
    { step: 3, optional: true, signers: ['eterna'], purpose: 'Pre-funded budget: a Sponsorship ledger object Rose agent can draw on without Eterna co-signing',
      evidence: ['ledger_entry {sponsorship:{sponsor:eterna, sponsee:roseAgent}} exists', `index == ${sponsorshipKeylet(eterna, roseAgent)}`, 'FeeAmount / MaxFee / RemainingOwnerCount as set'],
      tx: buildSponsorshipSet({ sponsor: eterna, sponsee: roseAgent, feeAmountDelta: '100000', maxFee: '100', remainingOwnerCountDelta: 1 }) },
    { step: 4, optional: true, signers: ['roseAgent'], purpose: 'Rose agent spends from the pre-funded budget (no SponsorSignature)',
      evidence: ['validated tx has Sponsor, SponsorFlags 1, no SponsorSignature', 'Sponsorship.FeeAmount decreased by Fee'],
      tx: buildSponsoredAccountSet({ account: roseAgent, sponsor: eterna }) },
  ];
}
