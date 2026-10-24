// Four payment capabilities, one governance view: each rail shows only its own evidence, and nothing looks more
// proven than it is (run with: npm test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productsFrom, productFor } from '../public/lib/products.js';
import { renderMission, renderRailDetail } from '../public/components/mission.js';
import { renderProductPage } from '../public/components/product-page.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const cfg = json('../public/products/rails.json'), unified = json('../fixtures/evidence-rose-unified-commerce.json');

test('four payment capabilities plus delegation as a supporting module (not a fifth rail)', () => {
  assert.deepEqual(cfg.rails.map((r) => r.id), ['xrp-micropayments', 'rlusd-payments', 'sponsored-execution', 'voucher-commerce']);
  assert.deepEqual(cfg.supporting.map((r) => r.id), ['delegated-authority']);
  const ps = productsFrom(cfg);
  assert.equal(productFor('store', ps).key, 'xrp-micropayments');           // the Mainnet storefront stays the XRP rail
  assert.equal(productFor('receipt', ps).key, 'xrp-micropayments');
  assert.equal(productFor('mission', ps).key, 'mission');
  for (const r of cfg.rails) assert.ok(r.can.length && r.cannot.length && r.proof.length, `${r.id} states what it can and cannot do`);
});

test('RLUSD is never shown on a payment channel or on Devnet, and stays PENDING until it runs', () => {
  const r = cfg.rails.find((x) => x.id === 'rlusd-payments');
  assert.notEqual(r.network, 'XRPL Devnet');
  assert.ok(r.cannot.some((c) => /payment channels/i.test(c)));
  assert.equal(r.evidence.status, 'PENDING');
  const html = renderRailDetail({ rail: r });
  assert.doesNotMatch(html, /step--done/);                                 // no stage looks complete
  assert.match(html, /What happens next/);
});

test('a signed voucher is never shown as settlement; vouchers stay SIMULATED, settlement comes from the ledger', () => {
  const r = cfg.rails.find((x) => x.id === 'voucher-commerce');
  assert.equal(r.mode, 'SIMULATED');
  const html = renderRailDetail({ rail: r });
  assert.match(html, /Voucher verified<\/strong><span><span class="status" data-status="SIMULATED"/);
  assert.match(html, /Settled<\/strong><span><span class="status" data-status="VERIFIED"/);
  assert.equal(unified.components.find((c) => c.key === 'voucher-sim').status, 'SIMULATED');
  assert.equal(unified.components.find((c) => c.key === 'mastercard-network').status, 'PENDING');
});

test('mission and product pages render for every rail with no missing values', () => {
  for (const r of cfg.rails) {
    const html = renderMission({ cfg, selected: r.id, evidenceFor: () => '' });
    assert.doesNotMatch(html, /undefined|NaN|\[object/, r.id);
  }
  for (const p of productsFrom(cfg).filter((x) => x.key !== 'xrp-micropayments')) {
    const html = renderProductPage({ product: p, evidence: unified });
    assert.doesNotMatch(html, /undefined|NaN|\[object/, p.key);
    for (const k of p.evidence) assert.ok(html.includes(unified.components.find((c) => c.key === k).label), `${p.key} shows ${k}`);
  }
});

test('proof buttons open the transaction on its own network (Bithomp + XRPL explorer) and never invent one', async () => {
  const { proofButtons } = await import('../public/lib/html.js');
  const h = 'D29DBDF54AA8B903775B2BFAAC5EEEFD8877A9C627E82EDBDF53B6ABD998A0DD';
  assert.match(proofButtons(h, 'https://devnet.xrpl.org/transactions/' + h), /dev\.bithomp\.com\/explorer\/D29DBDF5/);
  assert.match(proofButtons(h, 'https://livenet.xrpl.org/transactions/' + h), /https:\/\/bithomp\.com\/explorer\/D29DBDF5.*livenet\.xrpl\.org/s);
  assert.equal(proofButtons(h, 'somewhere'), '');                          // unknown network → no button, never a guess
  assert.equal(proofButtons('not-a-hash', 'mainnet'), '');
});
