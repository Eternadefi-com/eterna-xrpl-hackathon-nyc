import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from './governance.mjs';
import { ADAPTERS } from './index.mjs';
import { key } from './test-support.mjs';
import { canonicalJson, sha256Hex } from '../unified/common.mjs';

// Offline. Fixed fake keys only.
const ROSE = key(0x21), OTHER = key(0x22), S1 = key(0x31), S2 = key(0x32);
const T0 = Date.parse('2026-10-24T12:00:00Z');
const RL1 = { issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV', currency: '524C555344000000000000000000000000000000' };
export const certFor = (o = {}) => g.buildMissionCertificate({ missionId: 'm1', task: 'buy validated XRPL ledger reports', requester: { id: 'agent:rose-1' }, payer: { name: 'Rose (fictional)', xrpl: ROSE.address },
  sellers: [S1.address], rails: ['xrp-paychan', 'rlusd', 'xls68-sponsored', 'ap4m-voucher'], networks: ['xrpl:0', 'xrpl:1', 'xrpl:2'],
  limits: { XRP: { perTx: '100000', total: '300000' }, RLUSD: { perTx: '1.5', total: '2', ...RL1 } }, maxTransactions: 5,
  issuedAt: new Date(T0).toISOString(), expiry: new Date(T0 + 3600e3).toISOString(), ...o });
const engine = (o = {}) => { const c = o.cert ?? certFor(); return g.createGovernance({ certificate: c, approval: o.approval ?? g.approveCertificate(c, ROSE.seed), adapters: ADAPTERS, now: o.now ?? (() => T0 + 1000) }); };
let n = 0;
const req = (o = {}) => ({ requestId: `r${++n}`, requester: 'agent:rose-1', payer: ROSE.address, seller: S1.address, rail: 'xls68-sponsored', network: 'xrpl:2', asset: 'XRP', amount: '100000', ...o });

test('certificate: canonical sha256 digest, Rose signature over it, tamper and wrong signer refused', () => {
  const c = certFor(), a = g.approveCertificate(c, ROSE.seed);
  assert.equal(g.certificateDigest(c), sha256Hex(canonicalJson(c)));
  assert.equal(g.verifyCertificate(c, a), true);
  assert.equal(g.verifyCertificate({ ...c, sellers: [S1.address, S2.address] }, a), false);
  assert.throws(() => g.approveCertificate(c, OTHER.seed), /APPROVAL_SIGNER/);
  const e = engine({ approval: { ...a, signature: a.signature.replace(/^../, '00') } });
  assert.deepEqual(e.validate(), { ok: false, code: 'CERT_INVALID' });
  assert.equal(e.authorize(req()).code, 'CERT_INVALID');
  assert.deepEqual(engine().identify({ requester: 'agent:rose-1', payer: ROSE.address }), { requester: true, payer: true });
});

test('certificate shape: drops strings for XRP, exact decimals for RLUSD bound to issuer/currency/network', () => {
  assert.throws(() => certFor({ limits: { XRP: { perTx: '0.1', total: '1' } } }), /CERT_INVALID/);
  assert.throws(() => certFor({ limits: { XRP: { perTx: 100000, total: '1' } } }), /CERT_INVALID/);
  assert.throws(() => certFor({ limits: { RLUSD: { perTx: '1', total: '2', issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', currency: RL1.currency } }, networks: ['xrpl:1'] }), /CERT_INVALID/, 'Mainnet issuer on a Testnet-only cert');
  assert.throws(() => certFor({ limits: { RLUSD: { perTx: '1', total: '2', ...RL1 } }, networks: ['xrpl:2'] }), /CERT_INVALID/, 'no RLUSD on Devnet');
  assert.throws(() => certFor({ limits: { RLUSD: { perTx: '1.0000001', total: '2', ...RL1 } } }), /AMOUNT_FORMAT_INVALID|CERT_INVALID/);
  assert.throws(() => certFor({ limits: { XRP: { perTx: '500', total: '100' } } }), /CERT_INVALID/);
  assert.throws(() => certFor({ maxTransactions: 0 }), /CERT_INVALID/);
});

test('authorize: PERMIT carries a decision record and reserves budget', () => {
  const e = engine(), r = e.authorize(req());
  assert.equal(r.outcome, 'PERMIT'); assert.equal(r.decision.state, 'AUTHORIZED'); assert.equal(r.decision.budget, 'RESERVED');
  assert.match(r.decision.decisionDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(e.budget().XRP, { reserved: '100000', committed: '0', total: '300000', remaining: '200000' });
  assert.equal(e.budget().transactions.reserved, 1);
});

test('authorize: every refusal code, each with a refusal record and nothing reserved', () => {
  const e = engine();
  const code = (o) => e.authorize(req(o)).code;
  assert.equal(code({ requester: 'agent:mallory' }), 'WRONG_REQUESTER');
  assert.equal(code({ payer: OTHER.address }), 'WRONG_PAYER');
  assert.equal(code({ seller: S2.address }), 'SELLER_NOT_APPROVED');
  assert.equal(code({ rail: 'card-network' }), 'RAIL_NOT_ALLOWED');
  assert.equal(code({ network: 'xrpl:1' }), 'NETWORK_MISMATCH', 'xls68 is Devnet-only');
  assert.equal(code({ rail: 'rlusd', network: 'xrpl:2', asset: 'RLUSD', amount: '1' }), 'NETWORK_MISMATCH');
  assert.equal(code({ asset: 'RLUSD', amount: '1' }), 'ASSET_NOT_ALLOWED', 'RLUSD on the XRP-only sponsored rail');
  assert.equal(code({ rail: 'rlusd', network: 'xrpl:1', asset: 'XRP' }), 'ASSET_NOT_ALLOWED');
  assert.equal(code({ amount: '0.1' }), 'AMOUNT_INVALID', 'XRP must be integer drops (no floats)');
  assert.equal(code({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '1.0000001' }), 'AMOUNT_INVALID');
  assert.equal(code({ amount: '100001' }), 'PER_TX_EXCEEDED');
  assert.equal(code({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '1.500001' }), 'PER_TX_EXCEEDED');
  const r1 = req(); e.authorize(r1);
  assert.equal(e.authorize({ ...r1 }).code, 'REPLAYED_REQUEST');
  const narrow = g.createGovernance({ certificate: certFor({ rails: ['rlusd'] }), approval: g.approveCertificate(certFor({ rails: ['rlusd'] }), ROSE.seed), adapters: [], now: () => T0 });
  assert.equal(narrow.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '1' })).code, 'RAIL_UNAVAILABLE');
  const late = engine({ now: () => T0 + 3600e3 });
  assert.equal(late.authorize(req()).code, 'EXPIRED');
  assert.equal(e.budget().XRP.reserved, '100000', 'only r1 reserved');
  assert.ok(e.refusals.length >= 12 && e.refusals.every((r) => r.state === 'REFUSED' && r.signed === false && r.code));
  for (const c of g.REFUSALS) assert.ok(typeof c === 'string');
});

test('budget: total, count, exact RLUSD decimals; release on failure before submission, hold after', () => {
  const e = engine();
  const a = e.authorize(req()), b = e.authorize(req());
  assert.equal(e.authorize(req({ amount: '100001' })).code, 'PER_TX_EXCEEDED');
  const c = e.authorize(req());
  assert.equal(e.authorize(req({ amount: '1' })).code, 'TOTAL_EXCEEDED');
  e.fail(c.decision, 'signer offline');                 // nothing reached the ledger -> released
  assert.equal(e.budget().XRP.reserved, '200000');
  e.advance(b.decision, 'SUBMITTED', { txHash: 'B'.repeat(64) });
  e.fail(b.decision, 'tec');                            // submitted -> held (funds may have moved)
  assert.deepEqual([e.budget().XRP.reserved, e.budget().XRP.committed], ['100000', '100000']);
  const r1 = e.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '0.1' }));
  const r2 = e.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '0.2' }));
  assert.equal(e.budget().RLUSD.reserved, '0.3', 'exact: 0.1 + 0.2 = 0.3');
  assert.equal(e.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '1.5' })).outcome, 'PERMIT');
  assert.equal(e.budget().RLUSD.remaining, '0.2');
  assert.equal(e.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '0.1' })).code, 'COUNT_EXHAUSTED', 'five decisions counted (one released)');
  const f = engine();
  f.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '1.5' }));
  assert.equal(f.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '0.500001' })).code, 'TOTAL_EXCEEDED');
  assert.equal(f.authorize(req({ rail: 'rlusd', network: 'xrpl:1', asset: 'RLUSD', amount: '0.5' })).outcome, 'PERMIT', 'exactly at the total');
  void a; void r1; void r2;
});

test('states: explicit transitions; SUBMITTED/SETTLED need a ledger tx; VERIFIED/UNLOCKED only via unlock()', () => {
  const e = engine(), d = e.authorize(req()).decision;
  assert.throws(() => e.advance(d, 'VOUCHER_VERIFIED'), /BAD_TRANSITION/, 'not a voucher rail');
  assert.throws(() => e.advance(d, 'SETTLED', { txHash: 'A'.repeat(64) }), /BAD_TRANSITION/);
  assert.throws(() => e.advance(d, 'SUBMITTED'), /LEDGER_REF_REQUIRED/);
  e.advance(d, 'SUBMITTED', { txHash: 'A'.repeat(64) });
  assert.throws(() => e.advance(d, 'SETTLED', { txHash: 'C'.repeat(64) }), /LEDGER_REF_MISMATCH/);
  e.advance(d, 'SETTLED', { txHash: 'A'.repeat(64) });
  assert.throws(() => e.advance(d, 'VERIFIED'), /BAD_TRANSITION/);
  assert.deepEqual(d.history.map((h) => h.state), ['AUTHORIZED', 'SUBMITTED', 'SETTLED']);
  assert.equal(e.unlock(d, { adapter: 'rlusd', status: 'VERIFIED', facts: {} }).code, 'UNLOCK_WRONG_ADAPTER');
});

test('receipt: sha256 over canonical JSON linking certificate, decision, history, evidence, unlock (and refusals)', () => {
  const e = engine(), d = e.authorize(req()).decision, refused = e.authorize(req({ seller: S2.address }));
  const r = e.receipt(d.decisionId);
  assert.equal(r.digest, sha256Hex(canonicalJson(r.body)));
  assert.equal(r.body.certificateDigest, g.certificateDigest(certFor()));
  assert.equal(r.body.decision.decisionDigest, d.decisionDigest);
  const rr = e.receipt(refused.refusal.requestId);
  assert.equal(rr.body.refusal.code, 'SELLER_NOT_APPROVED');
});
