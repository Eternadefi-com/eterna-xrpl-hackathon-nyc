// Acceptance tests for the purchase journey, run against the backend's own rendered views (fixtures built from
// committed evidence by scripts/build-fixtures.mjs) and the real backend view()/facetsOf() for edge states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { journey, authoritySummary, refusalOf, REFUSALS } from '../public/lib/journey.js';

// In the full Eterna repo these tests also check against the backend source. In the standalone designer repo
// (UI only, no backend) those two checks are skipped; everything else runs.
const ROUTES = new URL('../../../routes/governed-purchase.mjs', import.meta.url);
const HAS_BACKEND = existsSync(ROUTES);

const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'));
const mainnet = fx('mainnet-standing-2026-10-22');
const scenarios = fx('scenarios').scenarios;
const status = (j, id) => j.steps.find((s) => s.id === id).status;

test('a verified Mainnet purchase reaches UNLOCKED, with every step done', () => {
  for (const p of mainnet.purchases) {
    const j = journey(p.requesterView);
    assert.deepEqual(j.steps.map((s) => s.status), ['done', 'done', 'done', 'done', 'done', 'done'], p.requesterView.purchaseId);
    assert.equal(j.locked, false);
  }
});

test('settled on the ledger but not independently verified stays LOCKED', () => {
  const s = scenarios.find((x) => x.provenance.label.startsWith('Settled on the ledger'));
  const j = journey(s.requesterView);
  assert.equal(status(j, 'SETTLED'), 'done');
  assert.equal(status(j, 'VERIFIED'), 'current');
  assert.equal(status(j, 'UNLOCKED'), 'locked');
  assert.equal(j.locked, true);
});

test('delivery reported without verification is still shown LOCKED (defence in depth)', () => {
  const v = structuredClone(mainnet.purchases[0].requesterView);
  v.execution.settlement = null;                                     // verification evidence missing
  assert.equal(status(journey(v), 'UNLOCKED'), 'locked');
});

test('uncertain outcome is flagged and never unlocked', () => {
  const s = scenarios.find((x) => x.provenance.label.startsWith('Outcome uncertain'));
  const j = journey(s.requesterView);
  assert.equal(j.uncertain, true);
  assert.notEqual(status(j, 'UNLOCKED'), 'done');
});

test('a refused purchase stops at AUTHORIZED with the backend reason and receipt flag', () => {
  for (const code of ['EXCEEDS_PER_PURCHASE_LIMIT', 'AUTHORIZATION_EXPIRED', 'NO_EXISTING_AUTHORITY', 'PURCHASE_COUNT_EXHAUSTED']) {
    const v = { purchaseId: 'gpur_x', state: 'REFUSED', facets: { authority: 'REFUSED', execution: 'NOT_STARTED', delivery: 'NOT_STARTED', receipt: 'ANCHORED' },
      execution: { outcome: 'REFUSED_BY_RULEBOOK', reason: code, paymentExecuted: false } };
    const j = journey(v);
    assert.equal(status(j, 'AUTHORIZED'), 'refused');
    assert.ok(j.steps.slice(2).every((s) => s.status === 'todo'));
    assert.equal(j.refusal.code, code);
    assert.equal(j.refusal.receipt, true);
  }
});

test('every backend refusal code has words for the owner', { skip: !HAS_BACKEND && 'backend not in this checkout' }, () => {
  const src = readFileSync(ROUTES, 'utf8');
  const codes = new Set([...src.matchAll(/reason: '([A-Z_]+)'/g)].map((m) => m[1]));
  for (const c of codes) assert.ok(REFUSALS[c], `missing explanation for ${c}`);
  assert.equal(refusalOf({ execution: { reason: 'SOMETHING_NEW' } }).category, 'Refused');
});

test('the 10-22 standing authority reads as autonomous, with limits and remaining budget — and expired now', () => {
  const a = authoritySummary({ parent: mainnet.authority.ownerView, siblings: mainnet.purchases.map((p) => p.requesterView) });
  assert.equal(a.autonomous, true);
  assert.equal(a.maxPurchases, 10);
  assert.equal(a.maxTotalDrops, '1000000');
  assert.equal(a.perPurchaseDrops, '100000');
  assert.equal(a.usedPurchases, 6);
  assert.equal(a.usedDrops, 600000);
  assert.equal(a.remainingDrops, 400000);
  assert.equal(a.expired, true);                                     // deadline 2026-10-23T06:25:05Z
});

test('the requester view never carries credentials or tokens', () => {
  const json = JSON.stringify([mainnet, scenarios]);
  assert.doesNotMatch(json, /eterna_req_|request_token|"token"|seed|secret/i);
  // and the backend's requester view of a raw row omits the owner-only certificate
  const raw = { ...mainnet.purchases[0].requesterView };
  assert.equal('certificate' in raw, false);
});
