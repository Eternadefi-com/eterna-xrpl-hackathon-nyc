import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetIdentityError, assetIdentity, buildDirectPayment, exactAmount, issuedPaymentPreflight, ledgerAmount, verifyDelivered } from './xrpl-asset-identity.mjs';

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', TEST_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV';
const CUR = '524C555344000000000000000000000000000000';
const PAYER = 'rfUqWXpvN9BD2gtfTRH2RbXgKqHkmodkcj', SELLER = 'rJGrs4xAvEG4nuNDJL2dTyQMckaFRpFFFV', DELEGATE = 'rw8ASvHhKmeKowH58wEMzyoK63wR5YE6f5';
const code = (fn, expected) => assert.throws(fn, e => e instanceof AssetIdentityError && e.code === expected, expected);
const rlusd = assetIdentity({ network: 'xrpl:0', asset: 'RLUSD', issuer: ISSUER, currency: CUR });
const xrp = assetIdentity({ network: 'xrpl:0', asset: 'XRP' });

test('identity: XRP and authentic RLUSD are explicit, network-bound, and never substitutable', () => {
  assert.equal(rlusd.official, true); assert.equal(rlusd.issuer, ISSUER);
  code(() => assetIdentity({ network: 'xrpl:0', asset: 'RLUSD' }), 'ASSET_ISSUER_MISMATCH');                          // bare label
  code(() => assetIdentity({ network: 'xrpl:0', asset: 'RLUSD', issuer: TEST_ISSUER, currency: CUR }), 'ASSET_ISSUER_MISMATCH'); // Testnet issuer on Mainnet
  code(() => assetIdentity({ network: 'xrpl:0', asset: 'RLUSD', issuer: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', currency: CUR }), 'ASSET_ISSUER_MISMATCH');
  code(() => assetIdentity({ network: 'xrpl:0', asset: 'RLUSD', issuer: ISSUER, currency: 'USD' }), 'ASSET_CURRENCY_MISMATCH');
  code(() => assetIdentity({ network: 'xrpl:2', asset: 'RLUSD', issuer: ISSUER, currency: CUR }), 'ASSET_NOT_SUPPORTED_ON_NETWORK'); // no official RLUSD on Devnet
  code(() => assetIdentity({ network: 'xrpl:0', asset: 'XRP', issuer: ISSUER }), 'ASSET_NATIVE_HAS_NO_ISSUER');
  code(() => assetIdentity({ network: 'xrpl:9', asset: 'XRP' }), 'ASSET_NETWORK_UNSUPPORTED');
  const testnet = assetIdentity({ network: 'xrpl:1', asset: 'RLUSD', issuer: TEST_ISSUER, currency: CUR });
  assert.equal(testnet.official, false); assert.equal(testnet.testAsset, true, 'a test asset is never labelled official');
});

test('amounts: exact decimal, no floats; XRP in drops; RLUSD within token precision', () => {
  assert.deepEqual(exactAmount(xrp, '1'), { kind: 'native', drops: '1000000' });
  assert.deepEqual(exactAmount(xrp, '0.000001'), { kind: 'native', drops: '1' });
  code(() => exactAmount(xrp, '0.0000001'), 'AMOUNT_XRP_PRECISION');
  assert.deepEqual(exactAmount(rlusd, '1.50'), { kind: 'issued', value: '1.5' });
  assert.deepEqual(exactAmount(rlusd, '0.1'), { kind: 'issued', value: '0.1' });
  assert.equal(exactAmount(rlusd, '123456789012345').value, '123456789012345');
  code(() => exactAmount(rlusd, '1234567890123456'), 'AMOUNT_TOKEN_PRECISION');
  for (const bad of ['0', '0.00', '-1', '1,5', '', '1e', 'abc', ' 1']) assert.throws(() => exactAmount(rlusd, bad), AssetIdentityError, bad);
  assert.deepEqual(ledgerAmount(rlusd, exactAmount(rlusd, '2')), { currency: CUR, issuer: ISSUER, value: '2' });
  assert.equal(ledgerAmount(xrp, exactAmount(xrp, '2')), '2000000');
});

test('direct payment: exact Amount, delegate, no paths/SendMax/partial flag, no NetworkID; never to the issuer', () => {
  const tx = buildDirectPayment({ identity: rlusd, amount: exactAmount(rlusd, '1'), account: PAYER, destination: SELLER, delegate: DELEGATE });
  assert.deepEqual(tx, { TransactionType: 'Payment', Account: PAYER, Destination: SELLER, Amount: { currency: CUR, issuer: ISSUER, value: '1' }, Flags: 0, Delegate: DELEGATE });
  assert.equal('NetworkID' in tx || 'SendMax' in tx || 'Paths' in tx, false);
  code(() => buildDirectPayment({ identity: rlusd, amount: exactAmount(rlusd, '1'), account: PAYER, destination: ISSUER }), 'PAYMENT_TO_ISSUER_REFUSED');
  code(() => buildDirectPayment({ identity: xrp, amount: exactAmount(xrp, '1'), account: PAYER, destination: PAYER }), 'PAYMENT_SELF');
  code(() => buildDirectPayment({ identity: xrp, amount: exactAmount(xrp, '1'), account: PAYER, destination: SELLER, delegate: PAYER }), 'PAYMENT_DELEGATE_INVALID');
});

test('settlement evidence: delivered exactly the authorized asset, amount and destination; partial payments refused', () => {
  const amount = exactAmount(rlusd, '1');
  const tx = { TransactionType: 'Payment', Destination: SELLER, Flags: 0, Amount: { currency: CUR, issuer: ISSUER, value: '1' } };
  const meta = { TransactionResult: 'tesSUCCESS', delivered_amount: { currency: CUR, issuer: ISSUER, value: '1.0' } };
  assert.equal(verifyDelivered({ identity: rlusd, amount, destination: SELLER, tx, meta }), true);
  code(() => verifyDelivered({ identity: rlusd, amount, destination: SELLER, tx, meta: { ...meta, TransactionResult: 'tecPATH_PARTIAL' } }), 'DELIVERY_NOT_SUCCESS');
  code(() => verifyDelivered({ identity: rlusd, amount, destination: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', tx, meta }), 'DELIVERY_DESTINATION_MISMATCH');
  code(() => verifyDelivered({ identity: rlusd, amount, destination: SELLER, tx: { ...tx, Flags: 0x00020000 }, meta }), 'DELIVERY_PARTIAL_PAYMENT_REFUSED');
  code(() => verifyDelivered({ identity: rlusd, amount, destination: SELLER, tx: { ...tx, SendMax: '2000000' }, meta }), 'DELIVERY_NOT_DIRECT');
  code(() => verifyDelivered({ identity: rlusd, amount, destination: SELLER, tx, meta: { ...meta, delivered_amount: { currency: CUR, issuer: ISSUER, value: '0.99' } } }), 'DELIVERY_DELIVERED_AMOUNT_MISMATCH');
  code(() => verifyDelivered({ identity: rlusd, amount, destination: SELLER, tx, meta: { ...meta, delivered_amount: { currency: CUR, issuer: TEST_ISSUER, value: '1' } } }), 'DELIVERY_DELIVERED_AMOUNT_MISMATCH');
  // XRP delivered where RLUSD was authorized (asset substitution) is not delivery.
  code(() => verifyDelivered({ identity: rlusd, amount, destination: SELLER, tx: { ...tx, Amount: '1000000' }, meta: { ...meta, delivered_amount: '1000000' } }), 'DELIVERY_AMOUNT_FIELD_MISMATCH');
  code(() => verifyDelivered({ identity: xrp, amount: exactAmount(xrp, '1'), destination: SELLER, tx, meta }), 'DELIVERY_AMOUNT_FIELD_MISMATCH');
});

test('issued preflight: trust lines, freeze, authorization, balance and limit headroom', () => {
  const amount = exactAmount(rlusd, '5');
  const line = (o = {}) => ({ account: ISSUER, currency: CUR, balance: '10', limit: '100', ...o });
  const ok = { identity: rlusd, amount, payerLines: [line()], recipientLines: [line({ balance: '0' })], issuerFlags: { requireAuthorization: false } };
  assert.deepEqual(issuedPaymentPreflight(ok), { ok: true });
  code(() => issuedPaymentPreflight({ ...ok, recipientLines: [] }), 'PREFLIGHT_RECIPIENT_TRUST_LINE_MISSING');
  code(() => issuedPaymentPreflight({ ...ok, recipientLines: [line({ account: TEST_ISSUER })] }), 'PREFLIGHT_RECIPIENT_TRUST_LINE_MISSING');
  code(() => issuedPaymentPreflight({ ...ok, payerLines: [] }), 'PREFLIGHT_PAYER_TRUST_LINE_MISSING');
  code(() => issuedPaymentPreflight({ ...ok, payerLines: [line({ balance: '4.99' })] }), 'PREFLIGHT_PAYER_INSUFFICIENT_BALANCE');
  code(() => issuedPaymentPreflight({ ...ok, recipientLines: [line({ balance: '96', limit: '100' })] }), 'PREFLIGHT_RECIPIENT_LIMIT_TOO_LOW');
  code(() => issuedPaymentPreflight({ ...ok, recipientLines: [line({ balance: '0', freeze_peer: true })] }), 'PREFLIGHT_TRUST_LINE_FROZEN');
  code(() => issuedPaymentPreflight({ ...ok, issuerFlags: { globalFreeze: true } }), 'PREFLIGHT_ISSUER_GLOBAL_FREEZE');
  code(() => issuedPaymentPreflight({ ...ok, issuerFlags: { requireAuthorization: true } }), 'PREFLIGHT_RECIPIENT_NOT_AUTHORIZED');
  assert.deepEqual(issuedPaymentPreflight({ identity: xrp, amount: exactAmount(xrp, '1') }), { ok: true });
});
