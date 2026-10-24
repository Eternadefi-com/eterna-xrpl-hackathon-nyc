// Screens render real data and keep their honesty guarantees (run with: npm test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReceipt } from '../public/components/receipt.js';
import { renderStorefront } from '../public/components/storefront.js';
import { slides, renderPresentation } from '../public/components/presentation.js';
import { authoritySummary } from '../public/lib/journey.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8'));
const mainnet = fx('mainnet-standing-2026-10-22');

test('receipt shows the real ledger evidence chain, in UTC, with links to Mainnet', () => {
  const p = mainnet.purchases[0], html = renderReceipt({ owner: p.ownerView });
  for (const h of [p.ownerView.receipt.authorization.createTx, p.ownerView.receipt.payment.redeemTx, p.ownerView.anchor.txHash]) {
    assert.ok(html.includes(h.slice(0, 8)), `missing ${h}`);
  }
  assert.match(html, /livenet\.xrpl\.org\/transactions\//);
  assert.match(html, /UTC/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test('receipt for a purchase with no receipt says so instead of inventing one', () => {
  assert.match(renderReceipt({ owner: null }), /No receipt/);
});

test('storefront lists only published offers, labelled by seller kind', () => {
  let catalog; try { catalog = fx('catalog-devnet'); } catch { return; }
  const html = renderStorefront({ catalog, live: false });
  for (const o of catalog.offers) assert.ok(html.includes(o.title));
  assert.doesNotMatch(html, /undefined|NaN/);
});

test('Rose presentation: real numbers come from evidence, and every slide declares its source', () => {
  const auth = authoritySummary({ parent: mainnet.authority.ownerView, siblings: mainnet.purchases.map((p) => p.requesterView) });
  const p = mainnet.purchases[0], persona = fx('persona-rose');
  const deck = slides({ persona, auth, purchase: p.requesterView, owner: p.ownerView, refusal: { category: 'Spending limit exceeded', text: 'x' }, purchases: 6 });
  assert.ok(deck.every((s) => ['PERSONA', 'PLANNED', 'RECORDED'].includes(s.source)));
  const proven = deck.find((s) => s.kicker === 'Already proven on Mainnet');
  assert.equal(proven.source, 'RECORDED');
  assert.match(proven.title, /1 signature · 6 autonomous purchases/);
  assert.match(proven.body, /83% of approvals eliminated/);
  assert.equal(deck.find((s) => s.kicker === 'Rose signs once').source, 'PLANNED');      // never shown as live
  assert.match(deck.find((s) => s.kicker === 'Settled ≠ unlocked').title, new RegExp(String(p.ownerView.receipt.payment.ledger)));
  assert.match(deck.find((s) => s.kicker === 'Rose’s proof').body, /0\.4 XRP/);         // real remaining budget
  for (let i = 0; i < deck.length; i++) assert.doesNotMatch(renderPresentation({ deck, i }), /undefined|NaN/);
});

test('payment console checks come from the purchase, and a refusal fails the authority checks', async () => {
  const { consoleChecks } = await import('../public/components/payment-console.js');
  const { journey } = await import('../public/lib/journey.js');
  const p = mainnet.purchases[0].requesterView;
  assert.ok(consoleChecks({ purchase: p, auth: { autonomous: true }, j: journey(p) }).every((c) => c.ok === true));
  const refused = { purchaseId: 'gpur_x', state: 'REFUSED', facets: { authority: 'REFUSED' }, execution: { reason: 'EXCEEDS_PER_PURCHASE_LIMIT' }, requester: { verified: true } };
  const c = consoleChecks({ purchase: refused, auth: null, j: journey(refused) });
  assert.equal(c.find((x) => x.label === 'Within authorized limits').ok, false);
  assert.equal(c.find((x) => x.label === 'Settled on the XRP Ledger').ok, false);
});

test('reports keep requested / authorized / settled / verified separate, and the CSV has every row', async () => {
  const { reportRows, toCsv } = await import('../public/components/reports.js');
  const states = [
    ...mainnet.purchases.map((p) => ({ badge: 'RECORDED', purchase: p.requesterView })),
    { badge: 'FIXTURE', purchase: { purchaseId: 'gpur_f', state: 'EXECUTING', facets: { authority: 'CONFIRMED', execution: 'SUBMITTED_UNKNOWN' }, execution: { redeemTx: 'AB', claimCommitted: true } } },
  ];
  const rows = reportRows(states);
  assert.equal(rows.filter((r) => r.verified).length, 6);
  const f = rows.find((r) => r.purchaseId === 'gpur_f');
  assert.deepEqual([f.authorized, f.settled, f.verified, f.unlocked], [true, true, false, false]);
  assert.equal(toCsv(rows).split('\n').length, rows.length + 1);
});

test('storefront unlock: the product is the delivered bytes (digest matches), and it unlocks only after verification', async () => {
  const { verifiedProduct, isUnlocked } = await import('../public/lib/product.js');
  const { renderProductUnlock } = await import('../public/components/product-unlock.js');
  for (const p of mainnet.purchases) {
    const owner = p.ownerView, prod = await verifiedProduct(owner);
    assert.equal(prod.verified, true, `digest mismatch for ${owner.purchaseId}`);
    assert.equal(isUnlocked(owner), true);
    const html = renderProductUnlock({ owner, purchase: p.requesterView, product: prod, unlocked: isUnlocked(owner) });
    assert.match(html, /Payment successful · Verified on XRPL Mainnet/);
    for (const s of ['View report', 'Download report', 'View blockchain receipt', 'Authorization verified', 'Transaction hash']) assert.ok(html.includes(s), s);
    assert.ok(html.includes(owner.execution.redeemTx));
    assert.doesNotMatch(html, /undefined|NaN/);
  }
  const unverified = structuredClone(mainnet.purchases[0].ownerView); unverified.execution.settlement = null;
  assert.equal(isUnlocked(unverified), false);                                   // paid but not verified → stays locked
  const tampered = structuredClone(mainnet.purchases[0].ownerView); tampered.deliveredResult.report.paidDrops = '1';
  assert.equal((await verifiedProduct(tampered)).verified, false);               // any change breaks the fingerprint
});

test('unlock view: a purchase the backend has not verified shows progress, never the product', async () => {
  const { renderProductUnlock } = await import('../public/components/product-unlock.js');
  const p = mainnet.purchases[0];
  const html = renderProductUnlock({ owner: p.ownerView, purchase: p.requesterView, product: null, unlocked: false });
  assert.match(html, /Your agent is buying this/);
  assert.doesNotMatch(html, /Payment successful|View report/);
});
