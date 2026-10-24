import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as g from './governance.mjs';
import { ADAPTERS } from './index.mjs';
import paychan, { ClaimAcceptor, dropsToXrp } from './adapters/xrp-paychan.mjs';
import rlusd, { preflight } from './adapters/rlusd.mjs';
import sponsored from './adapters/xls68-sponsored.mjs';
import ap4m from './adapters/ap4m-voucher.mjs';
import { delegateTx, assertDelegationCompatible, readDelegationGrant } from './delegation.mjs';
import { key, fixture, realReaders, sponsoredTape, jsonTape, SYNTH_HASH } from './test-support.mjs';
import { memo, MEMO } from '../unified/common.mjs';
import * as sim from '../unified/voucher-sim.mjs';

// Offline. Real evidence = read-only responses replayed from fixtures/readonly-tape.json. Everything else is SYNTHETIC
// (fixed fake keys, hand-built tapes) and exists only to exercise success and failure paths.
const require = createRequire(import.meta.url);
const { signPaymentChannelClaim } = require('xrpl');
const { Wallet } = require('ethers');
const ROSE = key(0x41), AGENT = key(0x42), ETERNA = key(0x43), SELLER = key(0x44), OTHER = key(0x45);
const T0 = Date.parse('2026-10-24T12:00:00Z');
const RL1 = { issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV', currency: '524C555344000000000000000000000000000000' };
const cert = g.buildMissionCertificate({ missionId: 'm2', task: 'buy validated XRPL ledger reports', requester: { id: 'agent:rose-1' }, payer: { xrpl: ROSE.address },
  sellers: [SELLER.address], rails: ['xrp-paychan', 'rlusd', 'xls68-sponsored', 'ap4m-voucher'], networks: ['xrpl:0', 'xrpl:1', 'xrpl:2'],
  limits: { XRP: { perTx: '100000', total: '500000' }, RLUSD: { perTx: '2', total: '5', ...RL1 } }, maxTransactions: 10,
  issuedAt: new Date(T0).toISOString(), expiry: new Date(T0 + 3600e3).toISOString() });
const engine = (now = () => T0 + 1000) => g.createGovernance({ certificate: cert, approval: g.approveCertificate(cert, ROSE.seed), adapters: ADAPTERS, now });
let n = 0;
const req = (o = {}) => ({ requestId: `q${++n}`, requester: 'agent:rose-1', payer: ROSE.address, seller: SELLER.address, network: 'xrpl:2', asset: 'XRP', amount: '100000', ...o });

// ---- xls68-sponsored ----------------------------------------------------------------------------------------------
test('xls68-sponsored: REAL Devnet settlement re-read from two recorded readers is VERIFIED', async () => {
  const dm = fixture('devnet-unified-mission.json');
  const ev = await sponsored.verify({ txHash: dm.txs.settlement, expected: { sponsor: dm.accounts.E, sponsorFlags: 1 } }, realReaders('xrpl:2'));
  assert.equal(ev.status, 'VERIFIED'); assert.equal(ev.facts.readersAgreeing, 2); assert.equal(ev.facts.ledgerHashesAgree, true);
  assert.equal(ev.facts.payer, dm.accounts.R); assert.equal(ev.facts.delegate, dm.accounts.A); assert.equal(ev.facts.sponsorPaidFee, true); assert.equal(ev.facts.amount, '300000');
  assert.ok(ev.facts.memos.some((m) => m.type === MEMO.voucherBatch && m.data === dm.batch.batchDigest));
  // the same real evidence cannot unlock a decision of another principal (this test cert's payer is a fake key)
  const c2 = g.buildMissionCertificate({ ...cert, sellers: [dm.accounts.S], limits: { XRP: { perTx: '300000', total: '300000' } } });
  const e = g.createGovernance({ certificate: c2, approval: g.approveCertificate(c2, ROSE.seed), adapters: ADAPTERS, now: () => T0 + 1000 });
  const d = e.authorize(req({ rail: 'xls68-sponsored', seller: dm.accounts.S, amount: '300000' })).decision;
  e.advance(d, 'SUBMITTED', { txHash: dm.txs.settlement }); e.advance(d, 'SETTLED', { txHash: dm.txs.settlement });
  const u = e.unlock(d, ev);
  assert.equal(u.code, 'UNLOCK_PROOF_NOT_MET'); assert.ok(u.unmet.some((m) => /another principal/.test(m)));
});

test('xls68-sponsored through the engine: prepare unsigned -> SUBMITTED -> SETTLED -> unlock (synthetic tape)', async () => {
  const e = engine(), d = e.authorize(req({ rail: 'xls68-sponsored' })).decision;
  const draft = e.route(d, { sponsor: ETERNA.address, delegate: AGENT.address, sequence: 3 });
  assert.equal(draft.kind, 'unsigned-tx'); assert.equal(draft.tx.SponsorFlags, 1); assert.equal(draft.tx.Delegate, AGENT.address); assert.equal(draft.tx.TxnSignature, undefined);
  const { hash, readers } = sponsoredTape({ payer: ROSE, delegate: AGENT, seller: SELLER.address, sponsor: ETERNA, amount: '100000' });
  e.advance(d, 'SUBMITTED', { txHash: hash });
  assert.equal(e.unlock(d, await sponsored.verify({ txHash: hash }, readers)).code, 'UNLOCK_NOT_SETTLED', 'submitted is not settled');
  e.advance(d, 'SETTLED', { txHash: hash });
  const ev = await sponsored.verify({ txHash: hash }, readers);
  assert.equal(ev.status, 'VERIFIED');
  assert.deepEqual(e.unlock(d, ev).unlocked, true);
  assert.equal(d.state, 'UNLOCKED'); assert.equal(e.budget().XRP.committed, '100000');
  const r = e.receipt(d.decisionId);
  assert.deepEqual(r.body.history.map((h) => h.state), ['AUTHORIZED', 'SUBMITTED', 'SETTLED', 'VERIFIED', 'UNLOCKED']);
  assert.equal(r.body.evidence.txHash, hash);
});

test('xls68-sponsored failures: tec result FAILS and holds budget; one reader / split ledgers / wrong amount never unlock', async () => {
  const e = engine();
  const tec = sponsoredTape({ payer: ROSE, delegate: AGENT, seller: SELLER.address, sponsor: ETERNA, amount: '100000', result: 'tecUNFUNDED_PAYMENT' });
  const d1 = e.authorize(req({ rail: 'xls68-sponsored' })).decision;
  e.advance(d1, 'SUBMITTED', { txHash: tec.hash }); e.advance(d1, 'SETTLED', { txHash: tec.hash });
  const ev1 = await sponsored.verify({ txHash: tec.hash }, tec.readers);
  assert.equal(ev1.status, 'FAILED');
  assert.equal(e.unlock(d1, ev1).code, 'UNLOCK_EVIDENCE_FAILED'); assert.equal(d1.state, 'FAILED'); assert.equal(d1.budget, 'COMMITTED_HELD');
  // settled but unverified: only one reader
  const one = sponsoredTape({ payer: ROSE, delegate: AGENT, seller: SELLER.address, sponsor: ETERNA, amount: '100000', readers: 1 });
  const d2 = e.authorize(req({ rail: 'xls68-sponsored' })).decision;
  e.advance(d2, 'SUBMITTED', { txHash: one.hash }); e.advance(d2, 'SETTLED', { txHash: one.hash });
  const u2 = e.unlock(d2, await sponsored.verify({ txHash: one.hash }, one.readers));
  assert.equal(u2.code, 'UNLOCK_PROOF_NOT_MET'); assert.ok(u2.unmet.some((m) => /readersAgreeing/.test(m))); assert.equal(d2.state, 'SETTLED');
  // readers disagree on the ledger
  const split = sponsoredTape({ payer: ROSE, delegate: AGENT, seller: SELLER.address, sponsor: ETERNA, amount: '100000', ledgerHashes: ['B', 'D'] });
  const d3 = e.authorize(req({ rail: 'xls68-sponsored' })).decision;
  e.advance(d3, 'SUBMITTED', { txHash: split.hash }); e.advance(d3, 'SETTLED', { txHash: split.hash });
  assert.equal(e.unlock(d3, await sponsored.verify({ txHash: split.hash }, split.readers)).code, 'UNLOCK_PROOF_NOT_MET');
  // valid evidence for a different amount
  const other = sponsoredTape({ payer: ROSE, delegate: AGENT, seller: SELLER.address, sponsor: ETERNA, amount: '90000' });
  const d4 = e.authorize(req({ rail: 'xls68-sponsored' })).decision;
  e.advance(d4, 'SUBMITTED', { txHash: other.hash }); e.advance(d4, 'SETTLED', { txHash: other.hash });
  assert.ok(e.unlock(d4, await sponsored.verify({ txHash: other.hash }, other.readers)).unmet.some((m) => /amount/.test(m)));
  // fee not paid by the sponsor
  const nofee = sponsoredTape({ payer: ROSE, delegate: AGENT, seller: SELLER.address, sponsor: ETERNA, amount: '100000', feePaidBy: ROSE });
  assert.equal((await sponsored.verify({ txHash: nofee.hash }, nofee.readers)).facts.sponsorPaidFee, false);
});

test('delegation module: any rail can delegate; reserve sponsorship with Delegate is refused', async () => {
  const p = delegateTx({ TransactionType: 'Payment', Account: ROSE.address, Destination: SELLER.address, Amount: '1', Fee: '12', Sequence: 1 }, { delegate: AGENT.address });
  assert.equal(p.Delegate, AGENT.address);
  assert.throws(() => assertDelegationCompatible({ ...p, Sponsor: ETERNA.address, SponsorFlags: 2 }), /temINVALID/);
  assert.throws(() => assertDelegationCompatible({ ...p, Sponsor: ETERNA.address, SponsorFlags: 3 }), /temINVALID/);
  assert.equal(assertDelegationCompatible({ ...p, Sponsor: ETERNA.address, SponsorFlags: 1 }).SponsorFlags, 1);
  assert.throws(() => delegateTx(p, { delegate: ROSE.address }), /temBAD_SIGNER/);
  const grant = await readDelegationGrant({ request: async () => ({ node: { LedgerEntryType: 'Delegate', Account: ROSE.address, Authorize: AGENT.address, Permissions: [{ Permission: { PermissionValue: 'Payment' } }], Sponsor: ETERNA.address } }) }, { account: ROSE.address, authorize: AGENT.address });
  assert.deepEqual([grant.exists, grant.paymentOnly, grant.sponsor], [true, true, ETERNA.address]);
});

// ---- xrp-paychan ----------------------------------------------------------------------------------------------------
test('xrp-paychan: REAL Mainnet purchase re-read from two recorded readers is VERIFIED; recorded-only is PENDING', async () => {
  const mp = fixture('mainnet-paychan-purchase.json');
  const ref = { network: 'xrpl:0', seller: mp.seller, payer: mp.payer, channelId: mp.channelId, execution: mp.execution };
  const ev = await paychan.verify(ref, realReaders('xrpl:0'));
  assert.equal(ev.status, 'VERIFIED'); assert.equal(ev.txHash, mp.execution.redeemTx); assert.equal(ev.facts.payer, mp.payer);
  assert.equal(ev.facts.amount, '100000'); assert.equal(ev.facts.readersAgreeing, 2); assert.equal(ev.facts.channelMatches, true);
  assert.equal((await paychan.verify(ref, [])).status, 'PENDING');
  assert.equal((await paychan.verify({ ...ref, channelId: 'F'.repeat(64) }, realReaders('xrpl:0'))).status, 'FAILED');
  assert.equal((await paychan.verify({ ...ref, execution: { ...mp.execution, redeemTx: undefined } })).status, 'FAILED');
});

test('xrp-paychan: ported 402 challenge and seller claim acceptance (good, bad signature, underpaid, wrong channel owner)', () => {
  const ch = paychan.challenge({ amount: '100000', payTo: SELLER.address, resource: 'http://127.0.0.1/report' });
  assert.deepEqual([ch.payment, ch.destination, ch.priceDrops], ['xrpl-payment-channel', SELLER.address, '100000']);
  assert.equal(ch.x402Version, 2); assert.equal(ch.accepts[0].scheme, 'xrpl-payment-channel');
  const channelId = 'C'.repeat(64), channel = { evidenceOk: true, destination: SELLER.address, publicKey: AGENT.publicKey, expiresUnix: 2e9, amountDrops: '1000000', balanceDrops: '0' };
  const acc = new ClaimAcceptor({ sellerAccount: SELLER.address, now: () => 1e9 });
  const claim = (cum, k = AGENT) => ({ channelId, cumulativeDrops: cum, publicKey: k.publicKey, signature: signPaymentChannelClaim(channelId, dropsToXrp(cum), k.privateKey) });
  assert.deepEqual(acc.accept(claim('100000'), channel, '100000'), { ok: true, newlyPaidDrops: '100000' });
  assert.equal(acc.accept(claim('150000'), channel, '100000').code, 'UNDERPAID');
  assert.equal(acc.accept({ ...claim('200000'), signature: claim('300000').signature }, channel, '100000').code, 'BAD_SIGNATURE');
  assert.equal(acc.accept(claim('200000', OTHER), channel, '100000').code, 'KEY_MISMATCH');
  assert.equal(acc.accept(claim('200000'), { ...channel, destination: OTHER.address }, '100000').code, 'NOT_MY_CHANNEL');
  assert.equal(dropsToXrp('1500001'), '1.500001');
});

test('xrp-paychan through the engine: claim draft -> VOUCHER_VERIFIED -> REDEEMED -> SETTLED -> unlock (synthetic tape)', async () => {
  const e = engine(), d = e.authorize(req({ rail: 'xrp-paychan', network: 'xrpl:0' })).decision;
  const channelId = 'C'.repeat(64);
  const draft = e.route(d, { channel: { channelId, publicKey: AGENT.publicKey, amountDrops: '1000000' }, previousCumulativeDrops: '200000' });
  assert.deepEqual([draft.kind, draft.cumulativeDrops, draft.amountXrp], ['unsigned-claim', '300000', '0.3']);
  assert.throws(() => paychan.prepare(d, { channel: { channelId, amountDrops: '250000' }, previousCumulativeDrops: '200000' }), /EXCEEDS_CHANNEL_FUNDS/);
  e.advance(d, 'VOUCHER_VERIFIED', { note: 'seller accepted claim' });
  assert.equal(e.unlock(d, { adapter: 'xrp-paychan', status: 'VERIFIED', facts: {} }).code, 'UNLOCK_NOT_SETTLED', 'a signed claim is not settlement');
  const hash = SYNTH_HASH('E');
  const tx = { TransactionType: 'PaymentChannelClaim', Account: SELLER.address, Channel: channelId, Balance: '300000', Fee: '12' };
  const meta = (bal) => ({ TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'PayChannel', FinalFields: { Account: ROSE.address, Destination: SELLER.address, Balance: bal, Amount: '1000000' }, PreviousFields: { Balance: '200000' } } }] });
  const execution = { redeemTx: hash, readers: ['A', 'B'], paidDrops: '100000', claimDrops: '300000', settlement: 'SETTLED', deliveryStatus: 'DELIVERED', deliveryDigest: 'ab'.repeat(32) };
  const ref = { network: 'xrpl:0', seller: SELLER.address, payer: ROSE.address, channelId, execution };
  e.advance(d, 'REDEEMED', { txHash: hash }); e.advance(d, 'SETTLED', { txHash: hash });
  const short = await paychan.verify(ref, jsonTape({ network: 'xrpl:0', hash, tx, meta: meta('250000') }));
  assert.equal(short.status, 'FAILED', 'channel balance does not cover the claim');
  const ev = await paychan.verify(ref, jsonTape({ network: 'xrpl:0', hash, tx, meta: meta('300000') }));
  assert.equal(ev.status, 'VERIFIED');
  assert.equal(e.unlock(d, { ...ev, facts: { ...ev.facts, recordedDelivered: false } }).code, 'UNLOCK_PROOF_NOT_MET');
  assert.equal(e.unlock(d, ev).unlocked, true);
});

// ---- rlusd -----------------------------------------------------------------------------------------------------------
const rlTx = (o = {}) => ({ TransactionType: 'Payment', Account: ROSE.address, Destination: SELLER.address, Amount: { ...RL1, value: '1.25' }, Flags: 0, Fee: '12', ...o });
const rlMeta = (v = '1.25', o = {}) => ({ TransactionResult: 'tesSUCCESS', delivered_amount: { ...RL1, value: v }, AffectedNodes: [], ...o });

test('rlusd: exact unsigned direct Payment (no partial flag, no paths); challenge binds issuer/currency/network', () => {
  const e = engine(), d = e.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '1.25' })).decision;
  const p = e.route(d, { delegate: AGENT.address, sequence: 7 });
  assert.deepEqual(p.tx.Amount, { ...RL1, value: '1.25' }); assert.equal(p.tx.Flags, 0); assert.equal(p.tx.SendMax, undefined); assert.equal(p.tx.Paths, undefined);
  assert.equal(p.tx.Delegate, AGENT.address); assert.equal(p.tx.TxnSignature, undefined);
  const c = rlusd.challenge({ amount: '1.25', payTo: SELLER.address, network: 'xrpl:1' });
  assert.deepEqual(c.accepts[0].asset, { code: 'RLUSD', ...RL1 }); assert.equal(c.accepts[0].extra.partialPayment, false);
  assert.throws(() => rlusd.challenge({ amount: '1', payTo: SELLER.address, network: 'xrpl:2' }), /ASSET_NOT_SUPPORTED_ON_NETWORK/);
  assert.equal(e.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '2.5' })).code, 'PER_TX_EXCEEDED');
});

test('rlusd verify: exact delivery VERIFIED (fee reported separately) and unlocks; partial, short, wrong issuer, tec FAIL', async () => {
  const e = engine(), d = e.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '1.25' })).decision;
  const hash = SYNTH_HASH('F'), ref = { txHash: hash, network: 'xrpl:1', expected: { payer: ROSE.address, destination: SELLER.address, amount: '1.25' } };
  const ok = await rlusd.verify(ref, jsonTape({ network: 'xrpl:1', hash, tx: rlTx(), meta: rlMeta() }));
  assert.equal(ok.status, 'VERIFIED'); assert.equal(ok.facts.amount, '1.25'); assert.equal(ok.facts.feeXrpDrops, '12'); assert.equal(ok.facts.issuer, RL1.issuer);
  const code = async (tx, meta) => (await rlusd.verify(ref, jsonTape({ network: 'xrpl:1', hash, tx, meta }))).facts.problems;
  assert.ok((await code(rlTx({ Flags: 0x00020000 }), rlMeta('1'))).includes('DELIVERY_PARTIAL_PAYMENT_REFUSED'));
  assert.ok((await code(rlTx(), rlMeta('1.2'))).includes('DELIVERY_DELIVERED_AMOUNT_MISMATCH'));
  assert.ok((await code(rlTx(), rlMeta('1.25', { delivered_amount: { ...RL1, issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', value: '1.25' } }))).includes('DELIVERY_DELIVERED_AMOUNT_MISMATCH'));
  assert.ok((await code(rlTx(), rlMeta('1.25', { TransactionResult: 'tecPATH_PARTIAL' }))).includes('DELIVERY_NOT_SUCCESS'));
  const partial = await rlusd.verify(ref, jsonTape({ network: 'xrpl:1', hash, tx: rlTx({ Flags: 0x00020000 }), meta: rlMeta('1') }));
  assert.equal(partial.status, 'FAILED');
  e.advance(d, 'SUBMITTED', { txHash: hash }); e.advance(d, 'SETTLED', { txHash: hash });
  const notValidated = await rlusd.verify(ref, jsonTape({ network: 'xrpl:1', hash, tx: rlTx(), meta: rlMeta(), validated: false }));
  assert.equal(notValidated.status, 'PENDING');
  assert.equal(e.unlock(d, notValidated).code, 'UNLOCK_PROOF_NOT_MET', 'settled but unverified');
  assert.equal(e.unlock(d, ok).unlocked, true);
  assert.equal(e.budget().RLUSD.committed, '1.25');
  const d2 = e.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '1.25' })).decision;
  e.advance(d2, 'SUBMITTED', { txHash: hash }); e.advance(d2, 'SETTLED', { txHash: hash });
  assert.equal(e.unlock(d2, partial).code, 'UNLOCK_EVIDENCE_FAILED'); assert.equal(d2.state, 'FAILED');
});

test('rlusd preflight: REAL Testnet issuer flags (recorded) + missing trust lines; synthetic headroom checks', async () => {
  const dm = fixture('devnet-unified-mission.json');
  const [r] = realReaders('xrpl:1');
  const real = await preflight(r, { network: 'xrpl:1', payer: dm.accounts.R, destination: dm.accounts.S, amount: '1' });
  assert.equal(real.ok, false); assert.equal(real.code, 'PREFLIGHT_PAYER_TRUST_LINE_MISSING');
  assert.deepEqual([real.issuerFlags.requireAuthorization, real.issuerFlags.globalFreeze, real.checks.noTransferFee], [false, false, true]);
  const line = (balance, limit) => ({ account: RL1.issuer, currency: RL1.currency, balance, limit });
  const fake = (payerBal, recvBal, recvLimit) => ({ url: 'synthetic', request: async (m, p) => m === 'account_info' ? { account_data: { Account: RL1.issuer, Flags: 0 } }
    : { lines: [p.account === ROSE.address ? line(payerBal, '1000') : line(recvBal, recvLimit)] } });
  assert.equal((await preflight(fake('5', '0', '100'), { network: 'xrpl:1', payer: ROSE.address, destination: SELLER.address, amount: '1.25' })).ok, true);
  assert.equal((await preflight(fake('1', '0', '100'), { network: 'xrpl:1', payer: ROSE.address, destination: SELLER.address, amount: '1.25' })).code, 'PREFLIGHT_PAYER_INSUFFICIENT_BALANCE');
  assert.equal((await preflight(fake('5', '99', '100'), { network: 'xrpl:1', payer: ROSE.address, destination: SELLER.address, amount: '1.25' })).code, 'PREFLIGHT_RECIPIENT_LIMIT_TOO_LOW');
});

// ---- ap4m-voucher ---------------------------------------------------------------------------------------------------
test('ap4m-voucher: REAL Devnet batch reconciles with the REAL delegated settlement: SIMULATED, never VERIFIED', async () => {
  const dm = fixture('devnet-unified-mission.json');
  const settlement = await sponsored.verify({ txHash: dm.txs.settlement }, realReaders('xrpl:2'));
  const ref = { batch: dm.batch, voucherDigest: dm.batch.vouchers[1].digest, buyer: dm.certificate.agent.voucherKey, certificateDigest: dm.certificateDigest,
    perVoucherDrops: dm.certificate.limits.perVoucherDrops, capDrops: dm.certificate.limits.capDrops, settlement };
  const ev = await ap4m.verify(ref);
  assert.equal(ev.status, 'SIMULATED'); assert.equal(ev.facts.simulated, true); assert.equal(ev.facts.issuer, 'Eterna local simulator — not Mastercard');
  assert.deepEqual([ev.facts.batchValid, ev.facts.voucherInBatch, ev.facts.settlementCoversBatch, ev.facts.amount, ev.facts.voucherSignaturesChecked], [true, true, true, '100000', 3]);
  assert.equal(ev.txHash, dm.txs.settlement);
  const tampered = { ...dm.batch, vouchers: dm.batch.vouchers.map((v, i) => (i ? v : { ...v, signature: dm.batch.vouchers[1].signature })) };
  assert.equal((await ap4m.verify({ ...ref, batch: tampered })).status, 'FAILED', 'bad voucher signature');
  assert.equal((await ap4m.verify({ ...ref, settlement: { ...settlement, mode: 'SIMULATED' } })).facts.settlementCoversBatch, false);
});

test('ap4m-voucher through the engine: voucher signed != settled; settles only with live-rail evidence', async () => {
  const e = engine(() => T0 + 2000);
  const wallet = new Wallet('0x' + '61'.repeat(32));
  const seller = sim.createSeller({ sellerId: SELLER.address, now: () => T0 + 2000 });
  const terms = { sessionId: '0x' + '11'.repeat(32), buyer: wallet.address.toLowerCase(), seller: SELLER.address, capDrops: '500000', expiry: Math.floor((T0 + 3000e3) / 1000), certificateDigest: '0x' + g.certificateDigest(cert) };
  const session = { ...sim.SIM, kind: 'voucher-session', terms, signature: await wallet.signTypedData(sim.DOMAIN, { Session: sim.TYPES.Session }, terms) };
  const ch = ap4m.challenge({ amount: '100000', payTo: SELLER.address, resource: 'http://127.0.0.1/report' });
  assert.equal(ch.accepts[0].scheme, 'eterna-voucher-sim'); assert.equal(ch.simulated, true);
  const decisions = [];
  let prev = '0';
  for (const nonce of [1, 2]) {
    const d = e.authorize(req({ rail: 'ap4m-voucher', voucher: { sessionId: terms.sessionId, nonce } })).decision;
    const draft = e.route(d, { session, previousCumulativeDrops: prev });
    assert.equal(draft.kind, 'unsigned-voucher'); assert.equal(draft.simulated, true);
    const signature = await wallet.signTypedData(draft.typedData.domain, draft.typedData.types, draft.typedData.message); // signer outside the adapter
    const v = seller.verify({ session, voucher: { ...sim.SIM, message: draft.typedData.message, signature } }, '100000');
    assert.equal(v.ok, true);
    e.advance(d, 'VOUCHER_VERIFIED', { note: v.voucher.digest });
    prev = draft.typedData.message.cumulativeDrops; decisions.push({ d, digest: v.voucher.digest });
  }
  assert.equal(e.authorize(req({ rail: 'ap4m-voucher', voucher: { sessionId: terms.sessionId, nonce: 2 } })).code, 'REPLAYED_VOUCHER_NONCE');
  const [{ d }] = decisions;
  assert.equal(e.unlock(d, { adapter: 'ap4m-voucher', status: 'SIMULATED', facts: {} }).code, 'UNLOCK_NOT_SETTLED', 'a VERIFIED voucher is not settlement');
  const batch = seller.redeem(terms.sessionId);
  for (const x of decisions) e.advance(x.d, 'REDEEMED');
  assert.throws(() => e.advance(d, 'SETTLED'), /LEDGER_REF_REQUIRED/, 'redemption without a ledger settlement cannot settle');
  // settlement on a live rail: a delegated, fee-sponsored payment of the batch total carrying the batch digest
  const st = sponsoredTape({ payer: ROSE, delegate: AGENT, seller: SELLER.address, sponsor: ETERNA, amount: batch.redeemedCumulativeDrops, memos: [memo(MEMO.voucherBatch, batch.batchDigest)] });
  const settlement = await sponsored.verify({ txHash: st.hash }, st.readers);
  const ref = (x) => ({ batch, voucherDigest: x.digest, buyer: wallet.address, certificateDigest: g.certificateDigest(cert), perVoucherDrops: '100000', capDrops: '500000', settlement });
  for (const x of decisions) { e.advance(x.d, 'SETTLED', { txHash: st.hash }); assert.equal(e.unlock(x.d, await ap4m.verify(ref(x))).unlocked, true); }
  assert.equal(e.budget().XRP.committed, '200000');
  // expired session: governance refuses before anything is signed
  assert.equal(g.createGovernance({ certificate: cert, approval: g.approveCertificate(cert, ROSE.seed), adapters: ADAPTERS, now: () => T0 + 3600e3 })
    .authorize(req({ rail: 'ap4m-voucher', voucher: { sessionId: terms.sessionId, nonce: 9 } })).code, 'EXPIRED');
  // a settlement that is still PENDING never unlocks
  const e2 = engine(), d2 = e2.authorize(req({ rail: 'ap4m-voucher', voucher: { sessionId: terms.sessionId, nonce: 1 } })).decision;
  e2.advance(d2, 'VOUCHER_VERIFIED'); e2.advance(d2, 'REDEEMED'); e2.advance(d2, 'SETTLED', { txHash: st.hash });
  const pending = await ap4m.verify({ ...ref(decisions[0]), settlement: { ...settlement, status: 'PENDING' } });
  assert.equal(e2.unlock(d2, pending).code, 'UNLOCK_PROOF_NOT_MET');
});
