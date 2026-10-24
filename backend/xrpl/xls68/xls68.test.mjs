import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { createRequire } from 'node:module';
import * as x from './xls68.mjs';

// Offline proofs only. Keys are derived here from fixed, obviously-fake entropy; they are not, and never were, real keys.
const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const codec = require('ripple-binary-codec');
const { decodeAccountID } = require('ripple-address-codec');
const key = (byte, algorithm) => {
  const seed = keypairs.generateSeed({ entropy: new Uint8Array(16).fill(byte), algorithm });
  const kp = keypairs.deriveKeypair(seed);
  return { seed, ...kp, address: keypairs.deriveAddress(kp.publicKey) };
};
const ETERNA = key(0xe7, 'ed25519');           // test sponsor
const ROSE = key(0x05, 'ed25519');             // test sponsee (Rose's agent)
const ETERNA_K1 = key(0xe8, 'ecdsa-secp256k1');
const ROSE_K1 = key(0x06, 'ecdsa-secp256k1');
const OTHER = key(0x99, 'ed25519');
const hexId = (a) => Buffer.from(decodeAccountID(a)).toString('hex').toUpperCase();
const body = (o = {}) => ({ Sequence: 7, Fee: '12', LastLedgerSequence: 6390000, ...o });

// ---- Devnet snapshot ----------------------------------------------------------------------------------------------
test('snapshot: Devnet rippled 3.4.1 with Sponsor and fixCleanup3_4_0 enabled', () => {
  const m = x.SNAPSHOT._meta;
  assert.equal(m.build_version, '3.4.1');
  assert.equal(m.network_id, 2);
  assert.deepEqual(m.amendments.Sponsor, { hash: 'BE1F90581635DBCEBFC4678C4B54FEDDC1A17B50FD02CFE765A4132A342126AC', enabled: true, supported: true });
  assert.equal(m.amendments.fixCleanup3_4_0.enabled, true); // => sponsor signs with the SPN prefix
  const d = x.SNAPSHOT.definitions;
  assert.equal(d.TRANSACTION_TYPES.SponsorshipSet, 91);
  assert.equal(d.TRANSACTION_TYPES.SponsorshipTransfer, 90);
  assert.equal(d.LEDGER_ENTRY_TYPES.Sponsorship, 0x90);
  assert.deepEqual(d.TRANSACTION_FORMATS.SponsorshipSet.map((f) => f.name), ['CounterpartySponsor', 'Sponsee', 'FeeAmountDelta', 'MaxFee', 'RemainingOwnerCountDelta']);
  assert.deepEqual(d.TRANSACTION_FORMATS.SponsorshipTransfer.map((f) => f.name), ['ObjectID', 'Sponsee']);
  assert.deepEqual(d.TRANSACTION_FORMATS.common.slice(-3).map((f) => f.name), ['Sponsor', 'SponsorFlags', 'SponsorSignature']);
});

// Field header per the XRPL binary format, computed from the snapshot (type code, nth) — not from the codec.
const header = (name) => {
  const d = x.SNAPSHOT.definitions;
  const [, f] = d.FIELDS.find(([n]) => n === name);
  const t = d.TYPES[f.type], n = f.nth, h = (v) => v.toString(16).padStart(2, '0');
  if (t < 16 && n < 16) return h((t << 4) | n).toUpperCase();
  if (t < 16) return (h(t << 4) + h(n)).toUpperCase();
  if (n < 16) return (h(n) + h(t)).toUpperCase();
  return ('00' + h(t) + h(n)).toUpperCase();
};

test('encoded field codes match the Devnet snapshot (and the codec default definitions cannot encode them)', () => {
  const expected = { Sponsor: '801B', SponsorFlags: '204A', SponsorSignature: 'E026', Sponsee: '801F', CounterpartySponsor: '801E',
    FeeAmountDelta: '6022', MaxFee: '6021', RemainingOwnerCountDelta: 'A2', ObjectID: '5029', TransactionType: '12' };
  for (const [n, h] of Object.entries(expected)) assert.equal(header(n), h, n);
  for (const n of ['SigningPubKey', 'TxnSignature', 'Signers', 'SponsorSignature']) assert.equal(x.SNAPSHOT.definitions.FIELDS.find(([k]) => k === n)[1].isSigningField, n === 'SigningPubKey', n);

  const set = x.encode(x.buildSponsorshipSet({ sponsor: ETERNA.address, sponsee: ROSE.address, feeAmountDelta: '1000000', maxFee: '1000', remainingOwnerCountDelta: -5, ...body() }));
  assert.ok(set.startsWith('12005B'), 'TransactionType SponsorshipSet = 0x005B');
  assert.ok(set.includes(header('FeeAmountDelta') + '40000000000F4240'));
  assert.ok(set.includes(header('MaxFee') + '40000000000003E8'));
  assert.ok(set.includes(header('Sponsee') + '14' + hexId(ROSE.address)));
  assert.ok(set.endsWith(header('RemainingOwnerCountDelta') + 'FFFFFFFB'), 'Int32 two\'s complement');

  const signed = x.cosign(x.buildSponsoredDepositPreauth({ account: ROSE.address, authorize: ETERNA.address, sponsor: ETERNA.address, ...body() }), { accountKey: ROSE.seed, sponsorKey: ETERNA.seed });
  assert.ok(signed.tx_blob.includes(header('Sponsor') + '14' + hexId(ETERNA.address)));
  assert.ok(signed.tx_blob.includes(header('SponsorFlags') + '00000003'));
  assert.ok(signed.tx_blob.includes(header('SponsorSignature') + '7321' + signed.tx.SponsorSignature.SigningPubKey));
  const xfer = x.encode({ ...x.buildSponsorshipTransfer({ account: ROSE.address, mode: 'end', objectId: 'AB'.repeat(32), ...body() }), SigningPubKey: '' });
  assert.ok(xfer.startsWith('12005A') && xfer.includes(header('ObjectID') + 'AB'.repeat(32)));

  assert.throws(() => codec.encode({ TransactionType: 'SponsorshipSet', Account: ETERNA.address, Sponsee: ROSE.address, Fee: '12', Sequence: 1 }));
});

test('flag values: server_definitions snapshot and rippled TxFlags.h', () => {
  assert.deepEqual(x.FLAGS.SponsorshipSet, { tfSponsorshipSetRequireSignForFee: 0x10000, tfSponsorshipClearRequireSignForFee: 0x20000,
    tfSponsorshipSetRequireSignForReserve: 0x40000, tfSponsorshipClearRequireSignForReserve: 0x80000, tfDeleteObject: 0x100000 });
  assert.deepEqual(x.FLAGS.SponsorshipTransfer, { tfSponsorshipEnd: 0x10000, tfSponsorshipCreate: 0x20000, tfSponsorshipReassign: 0x40000 });
  assert.equal(x.FLAGS.Payment.tfSponsorCreatedAccount, 0x80000);
  assert.deepEqual(x.FLAGS.Sponsorship, { lsfSponsorshipRequireSignForFee: 0x10000, lsfSponsorshipRequireSignForReserve: 0x20000 });
  assert.deepEqual(x.FLAGS.SponsorFlags, { spfSponsorFee: 1, spfSponsorReserve: 2 });
  assert.deepEqual(x.HASH_PREFIX, { TxSign: '53545800', TxMultiSign: '534D5400', SponsorTxSign: '53504E00', SponsorTxMultiSign: '53504D00', TransactionId: '54584E00' });
  assert.equal(x.buildSponsorshipSet({ sponsor: ETERNA.address, sponsee: ROSE.address, maxFee: '10', requireSignForFee: true, requireSignForReserve: false, ...body() }).Flags, 0x10000 | 0x80000);
  assert.equal(x.buildSponsorshipDelete({ account: ROSE.address, counterpartySponsor: ETERNA.address, ...body() }).Flags, 0x100000);
  for (const [mode, f] of [['end', 0x10000], ['create', 0x20000], ['reassign', 0x40000]]) assert.equal(x.buildSponsorshipTransfer({ account: ROSE.address, mode, sponsor: ETERNA.address, objectId: '00'.repeat(32), ...body() }).Flags, f);
});

// ---- round trip ---------------------------------------------------------------------------------------------------
test('encode/decode round-trip for every builder (unsigned and signed)', () => {
  const plan = x.demoPlan({ eterna: ETERNA.address, roseAgent: ROSE.address });
  const txs = [...plan.map((p) => ({ ...p.tx, ...body() })),
    x.buildSponsorshipDelete({ account: ETERNA.address, sponsee: ROSE.address, ...body() }),
    x.buildSponsorshipTransfer({ account: ROSE.address, mode: 'reassign', objectId: 'CD'.repeat(32), sponsor: OTHER.address, ...body() }),
    x.buildSponsorshipTransfer({ account: ETERNA.address, mode: 'end', sponsee: ROSE.address, ...body() })];
  for (const tx of txs) {
    const unsigned = { ...tx, SigningPubKey: '' };
    assert.deepEqual(x.decode(x.encode(unsigned)), unsigned, tx.TransactionType);
  }
  const s = x.cosign({ ...plan[1].tx, ...body() }, { accountKey: ROSE.seed, sponsorKey: ETERNA.seed });
  assert.deepEqual(x.decode(s.tx_blob), s.tx);
  assert.match(s.hash, /^[0-9A-F]{64}$/);
});

// ---- signatures ---------------------------------------------------------------------------------------------------
for (const [label, acct, spon] of [['ed25519', ROSE, ETERNA], ['secp256k1', ROSE_K1, ETERNA_K1]]) {
  test(`co-signed DepositPreauth (${label}): account and sponsor signatures verify; role prefixes are not interchangeable`, () => {
    const tx = x.buildSponsoredDepositPreauth({ account: acct.address, authorize: spon.address, sponsor: spon.address, ...body() });
    const { tx: signed } = x.cosign(tx, { accountKey: acct.seed, sponsorKey: spon.seed });
    assert.equal(x.verifyAccountSignature(signed), true);
    assert.equal(x.verifySponsorSignature(signed), true);
    // Both cover the same body; only the prefix differs (STX vs SPN).
    assert.equal(x.accountSigningData(signed).slice(8), x.sponsorSigningData(signed).slice(8));
    // The account's signature cannot be replayed as the sponsor's (and vice versa).
    assert.equal(keypairs.verify(x.accountSigningData(signed), signed.SponsorSignature.TxnSignature, spon.publicKey), false);
    assert.equal(keypairs.verify(x.sponsorSigningData(signed), signed.TxnSignature, acct.publicKey), false);
    // Any change to a signed field (Fee the sponsor pays, SponsorFlags, Sequence, the account key) breaks both.
    for (const t of [{ Fee: '13' }, { SponsorFlags: 1 }, { Sequence: 8 }, { SigningPubKey: OTHER.publicKey }]) {
      const bad = { ...signed, ...t };
      assert.equal(x.verifyAccountSignature(bad), false, JSON.stringify(t));
      assert.equal(x.verifySponsorSignature(bad), false, JSON.stringify(t));
    }
    // SponsorSignature is not a signing field: the account signature does not depend on it.
    assert.equal(x.verifyAccountSignature({ ...signed, SponsorSignature: { SigningPubKey: OTHER.publicKey, TxnSignature: '00' } }), true);
    assert.equal(x.verifySponsorSignature({ ...signed, SponsorSignature: { ...signed.SponsorSignature, SigningPubKey: OTHER.publicKey } }), false);
  });
}

test('ed25519 sponsor signature also verifies with node:crypto (independent of ripple-keypairs)', () => {
  const { tx } = x.cosign(x.buildSponsoredAccountSet({ account: ROSE.address, sponsor: ETERNA.address, ...body() }), { accountKey: ROSE.seed, sponsorKey: ETERNA.seed });
  const pub = (hex) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex.slice(2), 'hex').toString('base64url') }, format: 'jwk' });
  const ok = (data, sig, pk) => edVerify(null, Buffer.from(data, 'hex'), pub(pk), Buffer.from(sig, 'hex'));
  assert.equal(ok('53504E00' + codec.encodeForSigning(tx, x.DEVNET_DEFINITIONS).slice(8), tx.SponsorSignature.TxnSignature, ETERNA.publicKey), true);
  assert.equal(ok(codec.encodeForSigning(tx, x.DEVNET_DEFINITIONS), tx.TxnSignature, ROSE.publicKey), true);
});

test('signing guards: account key must be set first; keys must match Account / Sponsor', () => {
  const tx = x.buildSponsoredAccountSet({ account: ROSE.address, sponsor: ETERNA.address, ...body() });
  assert.throws(() => x.signAsSponsor(tx, ETERNA.seed), /SigningPubKey before any signature/);
  const withKey = { ...tx, SigningPubKey: ROSE.publicKey };
  assert.throws(() => x.signAsSponsor(withKey, OTHER.seed), { code: 'tefBAD_AUTH' });
  assert.throws(() => x.signAsAccount(withKey, OTHER.seed), { code: 'tefBAD_AUTH' });
  assert.throws(() => x.signAsSponsor({ ...x.buildSponsoredAccountCreate({ sponsor: ETERNA.address, destination: ROSE.address, ...body() }), SigningPubKey: ETERNA.publicKey }, ETERNA.seed), /no Sponsor/);
  assert.equal(x.verifySponsorSignature(withKey), false);
});

// ---- malformed inputs ---------------------------------------------------------------------------------------------
test('rejects malformed sponsorship inputs with the rippled 3.4.1 result codes', () => {
  const E = ETERNA.address, R = ROSE.address;
  const base = { TransactionType: 'AccountSet', Account: R, ...body() };
  const cases = [
    [{ ...base, Sponsor: E }, 'temINVALID_FLAG'],                                    // Sponsor without SponsorFlags
    [{ ...base, SponsorFlags: 1 }, 'temINVALID_FLAG'],                               // SponsorFlags without Sponsor
    [{ ...base, SponsorSignature: {} }, 'temMALFORMED'],                             // signature without sponsor
    [{ ...base, Sponsor: E, SponsorFlags: 0 }, 'temINVALID_FLAG'],
    [{ ...base, Sponsor: E, SponsorFlags: 4 }, 'temINVALID_FLAG'],
    [{ ...base, Sponsor: R, SponsorFlags: 1 }, 'temMALFORMED'],                      // self-sponsorship
    [{ ...base, Sponsor: 'rNotAnAddress', SponsorFlags: 1 }, 'temMALFORMED'],
    [{ ...base, TransactionType: 'OfferCreate', Sponsor: E, SponsorFlags: 2 }, 'temINVALID_FLAG'], // reserve not allow-listed
    [{ ...base, Sponsor: E, SponsorFlags: 2, Delegate: E }, 'temINVALID'],
    [{ ...base, Sponsor: E, SponsorFlags: 1, SponsorSignature: { SigningPubKey: ETERNA.publicKey, TxnSignature: '00', Signers: [] } }, 'temBAD_SIGNATURE'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, CounterpartySponsor: OTHER.address, MaxFee: '1', ...body() }, 'temMALFORMED'],
    [{ TransactionType: 'SponsorshipSet', Account: E, MaxFee: '1', ...body() }, 'temMALFORMED'],
    [{ TransactionType: 'SponsorshipSet', Account: R, CounterpartySponsor: E, MaxFee: '1', ...body() }, 'temMALFORMED'], // sponsee may only delete
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: E, MaxFee: '1', ...body() }, 'temMALFORMED'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, FeeAmountDelta: '0', ...body() }, 'temBAD_AMOUNT'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, FeeAmountDelta: { currency: 'USD', issuer: E, value: '1' }, ...body() }, 'temBAD_AMOUNT'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, MaxFee: '-1', ...body() }, 'temBAD_AMOUNT'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, RemainingOwnerCountDelta: 0, ...body() }, 'temINVALID'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, ...body() }, 'temREDUNDANT'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, Flags: 0x30000, ...body() }, 'temINVALID_FLAG'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, Flags: 0xc0000, ...body() }, 'temINVALID_FLAG'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, Flags: 0x100000 | 0x10000, ...body() }, 'temINVALID_FLAG'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, Flags: 0x100000, MaxFee: '1', ...body() }, 'temMALFORMED'],
    [{ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, MaxFee: '1', Sponsor: OTHER.address, SponsorFlags: 2, ...body() }, 'temINVALID_FLAG'],
    [{ TransactionType: 'SponsorshipTransfer', Account: R, Flags: 0x30000, ...body() }, 'temINVALID_FLAG'],
    [{ TransactionType: 'SponsorshipTransfer', Account: R, Flags: 0, ...body() }, 'temINVALID_FLAG'],
    [{ TransactionType: 'SponsorshipTransfer', Account: R, Flags: 0x10000, Sponsor: E, SponsorFlags: 2, ...body() }, 'temMALFORMED'],
    [{ TransactionType: 'SponsorshipTransfer', Account: E, Flags: 0x10000, Sponsee: E, ...body() }, 'temMALFORMED'],
    [{ TransactionType: 'SponsorshipTransfer', Account: R, Flags: 0x20000, ObjectID: '00'.repeat(32), ...body() }, 'temMALFORMED'],
    [{ TransactionType: 'SponsorshipTransfer', Account: R, Flags: 0x20000, ObjectID: '00'.repeat(32), Sponsor: E, SponsorFlags: 1, ...body() }, 'temINVALID_FLAG'],
    [{ TransactionType: 'SponsorshipTransfer', Account: R, Flags: 0x20000, Sponsor: E, SponsorFlags: 2, ...body() }, 'temMALFORMED'], // account-level needs co-sign
    [{ TransactionType: 'Payment', Account: E, Destination: R, Amount: '1', Flags: 0x80000 | 0x20000, ...body() }, 'temINVALID_FLAG'],
    [{ TransactionType: 'Payment', Account: E, Destination: R, Amount: '1', SendMax: '2', Flags: 0x80000, ...body() }, 'temINVALID'],
    [{ TransactionType: 'Payment', Account: E, Destination: R, Amount: { currency: 'USD', issuer: E, value: '1' }, Flags: 0x80000, ...body() }, 'temBAD_AMOUNT'],
    [{ TransactionType: 'EnableAmendment', Account: E, Sponsor: R, SponsorFlags: 1, ...body() }, 'temINVALID_FLAG'],
  ];
  for (const [tx, code] of cases) assert.throws(() => x.check(tx), { code }, JSON.stringify(tx));
  // and builders refuse bad arguments
  assert.throws(() => x.buildSponsorshipTransfer({ account: R, mode: 'steal' }), { code: 'temINVALID_FLAG' });
  assert.throws(() => x.buildSponsoredAccountCreate({ sponsor: E, destination: R, amountDrops: '0' }), { code: 'temBAD_AMOUNT' });
  assert.throws(() => x.buildSponsoredDepositPreauth({ account: R, authorize: E, sponsor: R }), { code: 'temMALFORMED' });
  // valid edge cases still pass
  x.check({ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, FeeAmountDelta: '-5', ...body() });
  x.check({ TransactionType: 'SponsorshipSet', Account: R, CounterpartySponsor: E, Flags: 0x100000, ...body() });
  x.check({ TransactionType: 'SponsorshipSet', Account: E, Sponsee: R, Flags: 0x10000, ...body() });
  x.check({ TransactionType: 'OfferCreate', Account: R, Sponsor: E, SponsorFlags: 1, ...body() });
});

// ---- ledger math ----------------------------------------------------------------------------------------------------
test('Sponsorship keylet, reserve formula and fee formula', () => {
  const k = x.sponsorshipKeylet(ETERNA.address, ROSE.address);
  assert.match(k, /^[0-9A-F]{64}$/);
  assert.notEqual(k, x.sponsorshipKeylet(ROSE.address, ETERNA.address));
  // indexHash construction cross-checked against xrpl.js's own keylet hashes (AccountRoot 'a', SignerList 'S').
  const { hashes } = require('xrpl');
  assert.equal(x.indexHash('a', hexId(ROSE.address)), hashes.hashAccountRoot(ROSE.address));
  assert.equal(x.indexHash('S', hexId(ROSE.address), '00000000'), hashes.hashSignerListId(ROSE.address));
  assert.equal(k, x.indexHash('>', hexId(ETERNA.address), hexId(ROSE.address)));

  const fees = { baseDrops: 1_000_000, incDrops: 200_000 }; // Devnet snapshot: 1 XRP / 0.2 XRP
  assert.equal(x.requiredReserveDrops({ Sponsor: ETERNA.address, OwnerCount: 1, SponsoredOwnerCount: 1 }, fees), 0n);   // Rose after step 2
  assert.equal(x.requiredReserveDrops({ OwnerCount: 0, SponsoringAccountCount: 1, SponsoringOwnerCount: 1 }, fees), 2_200_000n); // Eterna
  assert.equal(x.requiredReserveDrops({ OwnerCount: 1, SponsoringAccountCount: 1, SponsoringOwnerCount: 1 }, fees), 2_400_000n); // + Sponsorship object
  assert.equal(x.minimumFeeDrops({}, 10), 10n);
  assert.equal(x.minimumFeeDrops({ SponsorSignature: { SigningPubKey: 'ED', TxnSignature: '00' } }, 10), 10n);
  assert.equal(x.minimumFeeDrops({ Signers: [{}, {}], SponsorSignature: { Signers: [{}, {}, {}] } }, 10), 60n);
});

test('demo plan: four unsigned templates that pass local preflight', () => {
  const plan = x.demoPlan({ eterna: ETERNA.address, roseAgent: ROSE.address });
  assert.deepEqual(plan.map((p) => p.tx.TransactionType), ['Payment', 'DepositPreauth', 'SponsorshipSet', 'AccountSet']);
  assert.equal(plan[0].tx.Flags, 0x80000);
  assert.equal(plan[1].tx.SponsorFlags, 3);
  assert.equal(plan[3].tx.SponsorFlags, 1);
  for (const p of plan) { assert.equal(p.tx.TxnSignature, undefined); assert.equal(p.tx.SponsorSignature, undefined); x.check(p.tx); }
});

test('the library has no network or submission code', () => {
  const src = readFileSync(new URL('./xls68.mjs', import.meta.url), 'utf8');
  for (const re of [/\bfetch\s*\(/, /WebSocket/, /new\s+Client\b/, /https?:\/\//, /\bsubmit\s*\(/, /require\(['"]xrpl['"]\)/, /from ['"]xrpl['"]/, /node:(http|https|net|tls|dgram)/]) assert.equal(re.test(src), false, re);
});
