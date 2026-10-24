import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as x68 from '../xls68/xls68.mjs';
import * as tx from './tx.mjs';
import * as gov from './governance.mjs';
import * as sim from './voucher-sim.mjs';
import { canonicalJson, memoValues, MEMO, digestOf } from './common.mjs';
import { reader } from './rpc.mjs';
import { buildEvidence } from './verify.mjs';

// Offline only. Keys come from fixed, obviously-fake entropy and were never used on any network.
const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const { Wallet } = require('ethers');
const key = (b) => { const seed = keypairs.generateSeed({ entropy: new Uint8Array(16).fill(b), algorithm: 'ed25519' }); const k = keypairs.deriveKeypair(seed); return { seed, ...k, address: keypairs.deriveAddress(k.publicKey) }; };
const E = key(0x11), R = key(0x22), S = key(0x33), A = key(0x44), X = key(0x55);
const W = new Wallet('0x' + '42'.repeat(32)), W2 = new Wallet('0x' + '43'.repeat(32));
const T0 = Date.parse('2026-10-24T20:00:00Z');
const cert = gov.buildCertificate({ missionId: 't', rose: R.address, agent: A.address, agentVoucherAddress: W.address, seller: S.address, sponsor: E.address,
  task: 'buy validated XRPL ledger reports', perVoucherDrops: '100000', capDrops: '500000', issuedAt: new Date(T0).toISOString(), expiry: new Date(T0 + 86400e3).toISOString() });
const CD = gov.certificateDigest(cert), approval = gov.roseApprove(cert, R.seed);
const D = 'ab'.repeat(32);

// ---- governance -----------------------------------------------------------------------------------------------------
test('certificate digest is sha256 over canonical JSON; Rose approval binds key and digest', () => {
  assert.equal(CD, require('node:crypto').createHash('sha256').update(canonicalJson(cert)).digest('hex'));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 'x' }] }), '{"a":[2,{"c":"x","d":3}],"b":1}');
  assert.ok(gov.verifyRoseApproval(cert, approval));
  assert.equal(gov.verifyRoseApproval({ ...cert, limits: { ...cert.limits, capDrops: '900000' } }, approval), false);
  assert.equal(gov.verifyRoseApproval(cert, { ...approval, publicKey: X.publicKey }), false);
  assert.throws(() => gov.roseApprove(cert, X.seed), /APPROVAL_SIGNER/);
  assert.throws(() => gov.buildCertificate({ ...cert, rose: R.address, agent: A.address, agentVoucherAddress: W.address, seller: S.address, sponsor: E.address, perVoucherDrops: '600000', capDrops: '500000', issuedAt: cert.issuedAt, expiry: cert.expiry }), /CERT_INVALID/);
});

test('policy gate: seller, per-voucher, cap, expiry, agent key, monotonic, approval', () => {
  const ok = { approval, seller: S.address, voucherKey: W.address, previousCumulativeDrops: '0', cumulativeDrops: '100000', now: T0 + 1 };
  assert.deepEqual(gov.policyCheck(cert, ok), { approved: true, incrementDrops: '100000' });
  const code = (o) => { try { gov.policyCheck(cert, { ...ok, ...o }); } catch (e) { assert.equal(e.refusal, true); return e.code; } return 'PASSED'; };
  assert.equal(code({ seller: X.address }), 'POLICY_SELLER_NOT_APPROVED');
  assert.equal(code({ cumulativeDrops: '100001' }), 'POLICY_PER_VOUCHER_EXCEEDED');
  assert.equal(code({ previousCumulativeDrops: '450000', cumulativeDrops: '550000' }), 'POLICY_CAP_EXCEEDED');
  assert.equal(code({ now: T0 + 86400e3 }), 'POLICY_CERT_EXPIRED');
  assert.equal(code({ voucherKey: W2.address }), 'POLICY_AGENT_MISMATCH');
  assert.equal(code({ previousCumulativeDrops: '100000', cumulativeDrops: '100000' }), 'POLICY_NOT_MONOTONIC');
  assert.equal(code({ approval: { ...approval, signature: approval.signature.replace(/^../, '00') } }), 'POLICY_NOT_APPROVED_BY_PRINCIPAL');
  assert.equal(code({ voucherExpiry: (T0 + 86400e3) / 1000 + 1 }), 'POLICY_VOUCHER_OUTLIVES_CERT');
});

// ---- voucher simulator ----------------------------------------------------------------------------------------------
const mkAgent = (o = {}) => sim.createGovernedAgent({ wallet: W, cert, approval, certificateDigest: CD, now: () => T0 + 1000, ...o });
const req = (amount = '100000', payTo = S.address) => ({ scheme: sim.SCHEME, network: sim.NETWORK, amount, payTo, asset: 'XRP' });

test('every simulator object is labelled simulated / not Mastercard; EIP-712 domain is the simulator', async () => {
  const a = mkAgent(); const { session, voucher } = await a.pay(req(), 'r');
  for (const o of [session, voucher]) { assert.equal(o.simulated, true); assert.equal(o.issuer, 'Eterna local simulator — not Mastercard'); }
  assert.deepEqual(sim.DOMAIN, { name: 'Eterna AP4M Simulator', version: '0', chainId: 0 });
  assert.equal(sim.recoverVoucherSigner(voucher), W.address.toLowerCase());
  assert.equal(voucher.message.certificateDigest, '0x' + CD);
  assert.equal(voucher.message.seller, S.address);
  assert.equal(voucher.status, 'ISSUED');
});

test('seller verifies cumulative vouchers; rejects replay, wrong signer, wrong seller, over cap, expired, wrong amount', async () => {
  let clock = T0 + 1000;
  const a = mkAgent({ now: () => clock }), seller = sim.createSeller({ sellerId: S.address, now: () => clock });
  const p1 = await a.pay(req(), 'r');
  assert.equal(seller.verify(p1, '100000').ok, true);
  assert.equal(seller.verify(p1, '100000').code, 'REPLAY');                                 // same voucher again
  const p2 = await a.pay(req(), 'r');
  assert.equal(seller.verify(p2, '50000').code, 'AMOUNT_MISMATCH');                          // underpays a pricier item
  assert.equal(p2.voucher.message.cumulativeDrops, '200000');
  assert.equal(seller.verify(p2, '100000').ok, true);
  // wrong signer: same message, signed by a key that is not the session buyer
  const forged = { ...p2.voucher, message: { ...p2.voucher.message, cumulativeDrops: '300000', nonce: '3' } };
  forged.signature = await W2.signTypedData(sim.DOMAIN, { Voucher: sim.TYPES.Voucher }, forged.message);
  assert.equal(seller.verify({ session: p2.session, voucher: forged }, '100000').code, 'WRONG_SIGNER');
  // seller binding: a voucher bound to S is useless at another seller
  const other = sim.createSeller({ sellerId: X.address, now: () => clock });
  assert.equal(other.verify(p1, '100000').code, 'SELLER_MISMATCH');
  // cap: a buyer-signed voucher above the session cap (bypassing Eterna's gate) is still refused by the seller
  const over = { ...p2.voucher, message: { ...p2.voucher.message, cumulativeDrops: '600000', nonce: '9' } };
  over.signature = await W.signTypedData(sim.DOMAIN, { Voucher: sim.TYPES.Voucher }, over.message);
  assert.equal(seller.verify({ session: p2.session, voucher: over }, '400000').code, 'CAP_EXCEEDED');
  // tampered session terms are caught
  const badSession = { ...p2.session, terms: { ...p2.session.terms, capDrops: '900000' } };
  assert.equal(seller.verify({ session: badSession, voucher: p2.voucher }, '100000').code, 'BAD_SESSION_SIGNATURE');
  // expiry
  const p3 = await a.pay(req(), 'r');
  clock = Number(p3.voucher.message.expiry) * 1000;
  assert.equal(seller.verify(p3, '100000').code, 'EXPIRED');
  // non-simulator object
  assert.equal(seller.verify({ session: { ...p3.session, simulated: false }, voucher: p3.voucher }, '100000').code, 'NOT_SIMULATOR_OBJECT');
});

test('Eterna refuses before signing: over per-voucher limit, non-approved seller, cap; budget is consumed only by issued vouchers', async () => {
  const a = mkAgent();
  let signs = 0; const counting = { address: W.address, signTypedData: (...x) => { signs++; return W.signTypedData(...x); } };
  const b = sim.createGovernedAgent({ wallet: counting, cert, approval, certificateDigest: CD, now: () => T0 + 1000 });
  await assert.rejects(b.pay(req('200000'), 'r'), (e) => e.code === 'POLICY_PER_VOUCHER_EXCEEDED');
  await assert.rejects(b.pay(req('100000', X.address), 'r'), (e) => e.code === 'POLICY_SELLER_NOT_APPROVED');
  assert.equal(signs, 0, 'nothing signed (not even a session) for refused requests');
  assert.equal(b.refusals.length, 2); assert.ok(b.refusals.every((r) => r.signed === false));
  for (let i = 0; i < 5; i++) await a.pay(req(), 'r');
  await assert.rejects(a.pay(req(), 'r'), (e) => e.code === 'POLICY_CAP_EXCEEDED');
  assert.deepEqual(a.budget(), { capDrops: '500000', consumedDrops: '500000' });
  await assert.rejects(a.pay({ ...req(), scheme: 'exact' }, 'r'), (e) => e.code === 'POLICY_SCHEME_UNSUPPORTED');
});

test('redemption batch: statuses ISSUED -> VERIFIED -> REDEEMED_PENDING -> SETTLED, batch digest and full re-verification', async () => {
  const a = mkAgent(), seller = sim.createSeller({ sellerId: S.address, now: () => T0 + 2000 });
  for (let i = 0; i < 3; i++) assert.equal(seller.verify(await a.pay(req(), 'r'), '100000').ok, true);
  const batch = seller.redeem(a.sessions.get(S.address).session.terms.sessionId);
  assert.equal(batch.redeemedCumulativeDrops, '300000'); assert.equal(batch.voucherCount, 3); assert.equal(batch.simulated, true);
  assert.equal(batch.batchDigest, sim.batchDigest(batch));
  const accepted = [...seller.sessions.values()][0].accepted;
  assert.deepEqual(accepted[0].history.map((h) => h.status), ['ISSUED', 'VERIFIED', 'REDEEMED_PENDING']);
  sim.transition(accepted[0], 'SETTLED');
  assert.throws(() => sim.transition(accepted[0], 'VERIFIED'), /BAD_TRANSITION/);
  const ctx = { sellerId: S.address, buyer: W.address, certificateDigest: CD, perVoucherDrops: '100000', capDrops: '500000' };
  assert.deepEqual(sim.verifyBatch(batch, ctx), { ok: true, problems: [], totalDrops: '300000', signaturesChecked: 3 });
  const tampered = { ...batch, vouchers: batch.vouchers.map((v, i) => (i === 1 ? { ...v, message: { ...v.message, cumulativeDrops: '250000' } } : v)) };
  assert.equal(sim.verifyBatch(tampered, ctx).ok, false);
  assert.equal(sim.verifyBatch({ ...batch, redeemedCumulativeDrops: '400000' }, ctx).ok, false);
});

test('local x402-style seller: 402 PAYMENT-REQUIRED (v2 shape) -> voucher retry -> 200 report; refusal and replay paths', async () => {
  const agent = sim.createGovernedAgent({ wallet: W, cert, approval, certificateDigest: CD, now: () => T0 + 5000 });
  const sellerT = sim.createSeller({ sellerId: S.address, now: () => T0 + 5000 });
  const shop = await sim.startSellerServer({ seller: sellerT, routes: { '/report': { priceDrops: '100000', description: 'r', produce: async (v) => ({ ok: true, under: v.digest }) },
    '/premium-report': { priceDrops: '200000', description: 'p', produce: async () => ({}) } } });
  try {
    const raw = await fetch(`${shop.url}/report`);
    assert.equal(raw.status, 402);
    const pr = JSON.parse(Buffer.from(raw.headers.get('payment-required'), 'base64').toString());
    assert.equal(pr.x402Version, 2); assert.equal(pr.accepts[0].scheme, 'eterna-voucher-sim'); assert.equal(pr.accepts[0].payTo, S.address);
    assert.equal(pr.accepts[0].network, 'xrpl:2'); assert.equal(pr.simulated, true); assert.deepEqual(await raw.json(), pr);
    const r1 = await sim.agentFetch(`${shop.url}/report`, agent);
    assert.equal(r1.status, 200); assert.equal(r1.report.under, r1.voucher.digest); assert.equal(r1.paymentResponse.status, 'VERIFIED'); assert.equal(r1.voucher.status, 'VERIFIED');
    const r2 = await sim.agentFetch(`${shop.url}/premium-report`, agent);
    assert.equal(r2.status, 'REFUSED'); assert.equal(r2.refusal.code, 'POLICY_PER_VOUCHER_EXCEEDED');
    // replay the first payment header at the HTTP layer
    const payment = { x402Version: 2, ...sim.SIM, scheme: sim.SCHEME, network: sim.NETWORK, payload: { session: agent.sessions.get(S.address).session, voucher: r1.voucher } };
    const rep = await fetch(`${shop.url}/report`, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') } });
    assert.equal(rep.status, 402); assert.equal((await rep.json()).error, 'REPLAY');
  } finally { await shop.close(); }
});

// ---- transactions ---------------------------------------------------------------------------------------------------
const body = { sequence: 7, fee: '12', lastLedgerSequence: 6390000 };
test('XLS-68 sponsored account create reuses xls68 (1 drop, tfSponsorCreatedAccount, Eterna signs alone)', () => {
  const s = tx.signSingle(tx.buildAgentAccountCreate({ eterna: E.address, agent: A.address, ...body }), E.seed);
  const d = x68.decode(s.tx_blob);
  assert.equal(d.Amount, '1'); assert.equal(d.Flags, 0x80000); assert.equal(d.Destination, A.address);
  assert.equal(x68.txHash(d), s.hash); assert.deepEqual(tx.verifySignatures(d), { signer: true, sponsor: null });
});

test('XLS-75 DelegateSet: Payment-only, certificate memo, Eterna fee+reserve co-sign (SPN) and Rose signature (STX); encodes against the snapshot', () => {
  const s = tx.cosign(tx.buildSponsoredDelegateSet({ rose: R.address, agent: A.address, sponsor: E.address, certificateDigest: CD, ...body }), { signerKey: R.seed, sponsorKey: E.seed });
  assert.ok(s.tx_blob.startsWith('120040'), 'TransactionType DelegateSet = 64 in the Devnet snapshot');
  assert.equal(x68.SNAPSHOT.definitions.TRANSACTION_TYPES.DelegateSet, 64);
  assert.equal(x68.SNAPSHOT.definitions.TRANSACTION_TYPES.Payment, 0);
  assert.ok(s.tx_blob.includes('F01DEF2034' + '00000001' + 'E1F1'), 'Permissions[Permission{PermissionValue = Payment(0)+1}]');
  const d = x68.decode(s.tx_blob);
  assert.deepEqual(d.Permissions, [{ Permission: { PermissionValue: 'Payment' } }]);
  assert.equal(d.SponsorFlags, 3); assert.equal(d.Sponsor, E.address);
  assert.deepEqual(memoValues(d, MEMO.certificate), [CD]);
  assert.deepEqual(tx.verifySignatures(d), { signer: true, sponsor: true });
  // the sponsor signature must be under SPN, not STX
  assert.equal(keypairs.verify(x68.accountSigningData(d), d.SponsorSignature.TxnSignature, E.publicKey), false);
  assert.throws(() => tx.buildSponsoredDelegateSet({ rose: R.address, agent: R.address, sponsor: E.address, certificateDigest: CD, ...body }), /temMALFORMED/);
  assert.throws(() => tx.cosign(tx.buildSponsoredDelegateSet({ rose: R.address, agent: A.address, sponsor: E.address, certificateDigest: CD, ...body }), { signerKey: A.seed, sponsorKey: E.seed }), /tefBAD_AUTH/);
});

test('settlement: delegated Payment signed by the agent, fee-only sponsorship by Eterna, both memo digests', () => {
  const s = tx.cosign(tx.buildDelegatedSettlement({ rose: R.address, agent: A.address, seller: S.address, sponsor: E.address, amountDrops: '300000', batchDigest: D, certificateDigest: CD, ...body }),
    { signerKey: A.seed, sponsorKey: E.seed });
  const d = x68.decode(s.tx_blob);
  assert.equal(d.Account, R.address); assert.equal(d.Delegate, A.address); assert.equal(d.SigningPubKey, A.publicKey);
  assert.equal(d.SponsorFlags, 1); assert.equal(d.Amount, '300000'); assert.equal(d.Destination, S.address);
  assert.deepEqual(memoValues(d, MEMO.voucherBatch), [D]); assert.deepEqual(memoValues(d, MEMO.certificate), [CD]);
  assert.deepEqual(tx.verifySignatures(d), { signer: true, sponsor: true });
  assert.throws(() => tx.cosign(tx.buildDelegatedSettlement({ rose: R.address, agent: A.address, seller: S.address, sponsor: E.address, amountDrops: '1', batchDigest: D, certificateDigest: CD, ...body }), { signerKey: R.seed, sponsorKey: E.seed }), /tefBAD_AUTH/, 'Rose cannot sign as the Delegate');
  const unsponsored = tx.buildDelegatedSettlement({ rose: R.address, agent: A.address, seller: S.address, amountDrops: '300000', batchDigest: D, certificateDigest: CD, ...body });
  assert.equal(unsponsored.Sponsor, undefined);
});

test('forbidden combinations are refused locally (rippled 3.4.1 Transactor.cpp / DelegateSet.cpp)', () => {
  const p = tx.buildDelegatedSettlement({ rose: R.address, agent: A.address, seller: S.address, sponsor: E.address, amountDrops: '300000', batchDigest: D, certificateDigest: CD, ...body });
  const code = (t) => { try { tx.checkMission(t); return 'OK'; } catch (e) { return e.code; } };
  assert.equal(code({ ...p, SponsorFlags: 2 }), 'temINVALID');          // spfSponsorReserve + Delegate
  assert.equal(code({ ...p, SponsorFlags: 3 }), 'temINVALID');
  assert.equal(code({ ...p, Delegate: R.address }), 'temBAD_SIGNER');   // Delegate == Account
  assert.equal(code({ ...p, Sponsor: R.address }), 'temMALFORMED');     // Sponsor == Account
  assert.equal(code({ ...p, SponsorFlags: 0 }), 'temINVALID_FLAG');
  assert.equal(code(p), 'OK');
  const ds = tx.buildSponsoredDelegateSet({ rose: R.address, agent: A.address, sponsor: E.address, certificateDigest: CD, ...body });
  assert.equal(code({ ...ds, Permissions: [...ds.Permissions, ...ds.Permissions] }), 'temMALFORMED');
  assert.equal(code({ ...ds, Permissions: Array.from({ length: 11 }, (_, i) => ({ Permission: { PermissionValue: i + 1 } })) }), 'temARRAY_TOO_LARGE');
  assert.equal(code(ds), 'OK');
});

test('audit anchor AccountSet carries the receipt digest', () => {
  const s = tx.signSingle(tx.buildAnchor({ eterna: E.address, receiptDigest: D, ...body }), E.seed);
  const d = x68.decode(s.tx_blob);
  assert.equal(d.TransactionType, 'AccountSet'); assert.deepEqual(memoValues(d, MEMO.auditReceipt), [D]);
  assert.throws(() => tx.buildAnchor({ eterna: E.address, receiptDigest: 'XYZ', ...body }), /temMALFORMED/);
});

// ---- network guard and evidence shape -----------------------------------------------------------------------------
test('network guard: only allow-listed Devnet hosts; submit only when explicitly enabled; offline modules have no network code', async () => {
  assert.throws(() => reader('https://s1.ripple.com:51234'), /NOT_DEVNET/);
  assert.throws(() => reader('https://xrplcluster.com'), /NOT_DEVNET/);
  await assert.rejects(reader('https://s.devnet.rippletest.net:51234').request('submit', {}), /METHOD_REFUSED/);
  for (const f of ['tx.mjs', 'governance.mjs', 'common.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /fetch\(|WebSocket|node:http|require\('ws'\)/, f);
  }
  assert.doesNotMatch(readFileSync(new URL('./voucher-sim.mjs', import.meta.url), 'utf8'), /rippletest|submit/);
});

test('evidence: voucher-sim is SIMULATED, mastercard-network PENDING, nothing VERIFIED without ledger proof, reports locked', () => {
  const ev = buildEvidence({ certificate: cert, certificateDigest: CD, accounts: { E: E.address, R: R.address, S: S.address, A: A.address }, txs: {}, sim: { reports: [{ x: 1 }] } }, {});
  const by = Object.fromEntries(ev.components.map((c) => [c.key, c]));
  assert.deepEqual(Object.keys(by), ['governance', 'xls68-sponsorship', 'xls75-delegation', 'voucher-sim', 'settlement', 'refusal', 'audit-receipt', 'mastercard-network']);
  assert.equal(by['voucher-sim'].status, 'SIMULATED');
  assert.equal(by['mastercard-network'].status, 'PENDING');
  assert.equal(by['mastercard-network'].detail, 'No Mastercard AP4M sandbox access; vouchers are simulated locally.');
  assert.ok(ev.components.every((c) => c.status !== 'VERIFIED'));
  assert.equal(ev.unlocked, false); assert.deepEqual(ev.reports, []);
  assert.equal(ev.scenario, 'rose-unified-commerce'); assert.equal(ev.network, 'XRPL Devnet');
  assert.equal(digestOf({ a: 1 }), digestOf({ a: 1 }));
});
