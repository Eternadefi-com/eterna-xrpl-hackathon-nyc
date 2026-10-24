#!/usr/bin/env node
// Builds the preview's recorded data from COMMITTED evidence, through the backend's own view() and facetsOf().
// The UI therefore shows exactly what the governed-purchase API reports — no states are invented here.
//   node apps/agent-purchase/scripts/build-fixtures.mjs        (run from backend/xrpl)
// Outputs apps/agent-purchase/fixtures/*.json. Every record carries `provenance` saying where it came from.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { view, facetsOf } from '../../../routes/governed-purchase.mjs';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = join(APP, '..', '..', '..', '..');
const OUT = join(APP, 'fixtures');
mkdirSync(OUT, { recursive: true });

// Holder identifiers are internal; they are not needed by the experience and are dropped.
const sanitize = (row) => { const r = { ...row }; delete r.holder_id; return r; };

// ── 1. Mainnet standing authority, 2026-10-22 (committed evidence, SHA256SUMS verified) ─────────────────────────────
const MAINNET_DIR = 'docs/evidence/mainnet-shared-budget-2026-10-22';
const rows = JSON.parse(readFileSync(join(REPO, MAINNET_DIR, 'purchases-db-export.json'), 'utf8')).map(sanitize);
const parent = rows.find((r) => r.state === 'STANDING_ACTIVE');
const children = rows.filter((r) => r.state === 'ANCHORED');
const mainnet = {
  provenance: { kind: 'RECORDED_EVIDENCE', network: 'XRPL Mainnet', date: '2026-10-22', source: `${MAINNET_DIR}/purchases-db-export.json`,
    note: 'Real purchases, exported from the Mainnet backend. Rendered through the backend view() — the same function the API uses.' },
  authority: { requesterView: view(parent, { owner: false }), ownerView: view(parent, { owner: true }), events: parent.events },
  purchases: children.map((r) => ({ requesterView: view(r, { owner: false }), ownerView: view(r, { owner: true }), facets: facetsOf(r), events: r.events })),
};
writeFileSync(join(OUT, 'mainnet-standing-2026-10-22.json'), JSON.stringify(mainnet, null, 1));

// ── 2. Devnet refusals, 2026-10-20 end-to-end harness (committed evidence) ──────────────────────────────────────────
const DEVNET_DIR = 'docs/evidence/devnet-e2e-2026-10-20';
const refusals = ['NO_EXISTING_AUTHORITY', 'EXCEEDS_PER_PURCHASE_LIMIT', 'AUTHORIZATION_EXPIRED', 'PURCHASE_COUNT_EXHAUSTED'].map((reason) => {
  const ev = JSON.parse(readFileSync(join(REPO, DEVNET_DIR, `buyer-refusal-${reason}.json`), 'utf8'));
  return {
    provenance: { kind: 'RECORDED_EVIDENCE', network: 'XRPL Devnet', date: '2026-10-20', source: `${DEVNET_DIR}/buyer-refusal-${reason}.json` },
    reason, purchaseId: ev.request?.purchaseId ?? null, offer: ev.offer ?? null, transitions: ev.transitions ?? [], final: ev.final ?? null,
    paymentExecuted: ev.request?.paymentExecuted ?? null,
  };
});
writeFileSync(join(OUT, 'devnet-refusals-2026-10-20.json'), JSON.stringify({ refusals }, null, 1));

// ── 3. Scenario fixtures: states the evidence does not contain. Clearly labelled; built by MUTATING a real row so the
//       shape is the backend's, then rendered through view()/facetsOf(). Never presented as evidence.
const base = children[0];
const scenario = (label, patch) => {
  const r = { ...base, ...patch, execution: patch.execution === undefined ? base.execution : patch.execution };
  return { provenance: { kind: 'FIXTURE', label, note: 'Illustrative state for design work. Not a real purchase.' },
    requesterView: view(r, { owner: false }), facets: facetsOf(r) };
};
const scenarios = [
  // Ledger says the redeem exists, but Eterna's two-reader verification has not confirmed it: must stay LOCKED.
  scenario('Settled on the ledger, not yet independently verified', {
    state: 'EXECUTING', anchor: null, receipt_digest: null,
    execution: { redeemTx: base.execution.redeemTx, claimDrops: base.execution.claimDrops, claimCommitted: true } }),
  // Outcome unknown after a restart: reconciled from the ledger, never re-bought, nothing unlocked.
  scenario('Outcome uncertain — reconciling from the ledger', {
    state: 'UNCERTAIN', anchor: null, receipt_digest: null, execution: { claimCommitted: true, afterRestart: { action: 'PAID_BEFORE_RESTART' } } }),
  // Authorized under standing authority, waiting for the worker to execute.
  scenario('Authorized, waiting to execute', { state: 'CONFIRMED', anchor: null, receipt_digest: null, execution: null }),
];
writeFileSync(join(OUT, 'scenarios.json'), JSON.stringify({ scenarios }, null, 1));

// ── 4. Storefront catalog: the Devnet backend's public offers, captured from GET /api/purchase/v1/offers. Refreshed when
//       a backend is reachable (PURCHASE_BACKEND_URL, default the Devnet test stack); otherwise the last capture is kept.
const CATALOG = join(OUT, 'catalog-devnet.json');
try {
  const url = (process.env.PURCHASE_BACKEND_URL || 'http://127.0.0.1:3310').replace(/\/$/, '') + '/api/purchase/v1/offers';
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await r.json();
  if (!Array.isArray(body.offers)) throw new Error('no offers');
  writeFileSync(CATALOG, JSON.stringify({ provenance: { kind: 'RECORDED_EVIDENCE', network: 'XRPL Devnet', date: new Date().toISOString().slice(0, 10),
    source: 'GET /api/purchase/v1/offers (Devnet test backend)', note: 'Real published offers. Test network: no real funds.' }, offers: body.offers }, null, 1));
} catch (e) { console.log(`catalog: kept previous capture (${e.message})`); }

console.log(`fixtures: mainnet authority + ${children.length} purchases; ${refusals.length} devnet refusals; ${scenarios.length} labelled scenarios`);
