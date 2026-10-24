// Master presentation: one storyboard, scenario files only fill slots, evidence is never upgraded (run with: npm test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAPTERS, validateScenario, timeline, totalMs, frameAt } from '../public/lib/master.js';
import { resolveEvidence } from '../public/lib/evidence.js';
import { renderScene } from '../public/components/show-scene.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const scenarios = ['mainnet-purchase', 'devnet-xls68', 'rose-unified-commerce'].map((id) => json(`../public/scenarios/${id}.json`));
const recorded = { mainnet: json('../fixtures/mainnet-standing-2026-10-22.json'), evidence: { 'devnet-xls68': json('../fixtures/evidence-devnet-xls68.json'), 'rose-unified-commerce': json('../fixtures/evidence-rose-unified-commerce.json') } };

test('both scenario files are valid against the one master storyboard', () => {
  for (const s of scenarios) assert.deepEqual(validateScenario(s), [], s.id);
  assert.ok(validateScenario({ ...scenarios[0], narration: { ...scenarios[0].narration, bonus: 'x' } }).some((e) => /unknown chapter bonus/.test(e)));
  assert.ok(validateScenario({ ...scenarios[0], network: { label: 'Mainnet-ish' } }).some((e) => /network.label/.test(e)));
});

test('the timeline keeps the master order; scenarios can only lengthen chapters', () => {
  const tl = timeline({ durations: { proof: 15000 } });
  assert.deepEqual(tl.map((c) => c.key), CHAPTERS.map((c) => c.key));
  assert.equal(tl.find((c) => c.key === 'proof').ms, 15000);
  assert.equal(totalMs(tl), CHAPTERS.reduce((a, c) => a + c.ms, 0) + 5000);
  assert.equal(frameAt(tl, 0).key, 'opening');
  assert.equal(frameAt(tl, totalMs(tl) + 99).key, 'closing');
});

test('Mainnet evidence: an earlier real purchase is REHEARSAL, never passed off as the live run', async () => {
  const s = scenarios[0], ev = await resolveEvidence(s, { recorded });
  assert.equal(ev.status, 'REHEARSAL');
  assert.match(ev.txHash, /^[0-9A-F]{64}$/);
  const live = await resolveEvidence({ ...s, evidence: { ...s.evidence, notBefore: null } }, { recorded });
  assert.equal(live.status, 'VERIFIED');
  assert.ok(live.product.verified && live.readers >= 2);
});

test('XLS-68 scenario: VERIFIED only from its own Devnet ledger parts; with no evidence it stays PENDING with no hash', async () => {
  const ev = await resolveEvidence(scenarios[1], { recorded });
  assert.equal(ev.status, 'VERIFIED');
  assert.deepEqual(ev.components.map((c) => c.key).sort(), ['settlement', 'xls68-sponsorship', 'xls75-delegation']);
  const none = await resolveEvidence(scenarios[1], { recorded: { evidence: {} } });
  assert.equal(none.status, 'PENDING');
  const html = renderScene({ s: scenarios[1], ev: none, f: { i: 4, key: 'proof', local: 9000 }, n: 7, imageOk: false });
  assert.match(html, /PENDING/);
  assert.doesNotMatch(html, /[0-9A-F]{64}/);                           // no transaction hash invented
});

test('every chapter renders for both scenarios with no missing values', async () => {
  for (const s of scenarios) {
    const ev = await resolveEvidence(s, { recorded }), tl = timeline(s);
    for (const c of tl) {
      const html = renderScene({ s, ev, f: frameAt(tl, c.end - 1), n: tl.length, imageOk: false });
      assert.doesNotMatch(html, /undefined|NaN|\[object/, `${s.id}/${c.key}`);
      assert.ok(html.includes(s.network.label), `${s.id}/${c.key} network label`);
    }
  }
  const s = scenarios[0], ev = await resolveEvidence(s, { recorded }), tl = timeline(s);
  assert.ok(renderScene({ s, ev, f: frameAt(tl, tl[4].end - 1), n: 7 }).includes(ev.txHash));
});

test('unified mission: each part keeps its own status; simulated vouchers never make the whole VERIFIED', async () => {
  const s = scenarios[2], c = (key, status) => ({ key, label: key, status, detail: key, ...(status === 'VERIFIED' ? { txHash: 'AB'.repeat(32) } : {}) });
  const parts = ['governance', 'xls68-sponsorship', 'xls75-delegation', 'settlement', 'audit-receipt'];
  const full = { network: 'XRPL Devnet', unlocked: true, components: [...parts.map((k) => c(k, 'VERIFIED')), c('voucher-sim', 'SIMULATED'), c('mastercard-network', 'PENDING')] };
  const ev = await resolveEvidence(s, { recorded: { evidence: { 'rose-unified-commerce': full } } });
  assert.equal(ev.status, 'PARTIAL');
  assert.equal(ev.finalReady, true);
  const html = renderScene({ s, ev, f: { i: 4, key: 'proof', local: 20000 }, n: 7 });
  assert.match(html, /SIMULATED/); assert.match(html, /PENDING/);
  const missing = { ...full, components: full.components.map((x) => (x.key === 'settlement' ? c('settlement', 'PENDING') : x)) };
  const ev2 = await resolveEvidence(s, { recorded: { evidence: { 'rose-unified-commerce': missing } } });
  assert.equal(ev2.finalReady, false);
  assert.match(ev2.note, /settlement/);
  const ev3 = await resolveEvidence(s, { recorded: { evidence: { 'rose-unified-commerce': { ...full, unlocked: false } } } });
  assert.equal(ev3.finalReady, false);
});
