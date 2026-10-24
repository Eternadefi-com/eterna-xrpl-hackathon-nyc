// Agent Purchase Experience — page wiring. Four screens (hash routes):
//   #/store    Storefront: published offers an agent can buy
//   #/purchase Purchase journey: agent, authority, request, timeline, refusal (state picker on the left)
//   #/receipt  Verifiable receipt for the selected purchase
//   #/present  Big-type walkthrough for judges and sponsors
// Presentation only: every status shown was reported by the Eterna backend (or is a clearly labelled fixture).
import { journey, authoritySummary, refusalOf } from './lib/journey.js';
import { esc } from './lib/html.js';
import { renderAgentIdentity } from './components/agent-identity.js';
import { renderPurchaseRequest } from './components/purchase-request.js';
import { renderOwnerAuthority } from './components/owner-authority.js';
import { renderTimeline } from './components/status-timeline.js';
import { renderRefusal } from './components/refusal.js';
import { renderStorefront } from './components/storefront.js';
import { renderReceipt } from './components/receipt.js';
import { renderPresentation, slides } from './components/presentation.js';
import { renderPaymentConsole } from './components/payment-console.js';
import { renderReports, reportRows, toCsv } from './components/reports.js';
import { renderProductUnlock } from './components/product-unlock.js';
import { verifiedProduct, isUnlocked } from './lib/product.js';
import { productsFrom, productFor, MISSION } from './lib/products.js';
import { renderProductPage, evidenceList } from './components/product-page.js';
import { renderMission } from './components/mission.js';

// Storefront unlock: which purchase the storefront shows.
//   #/store          → the newest purchase made since this page opened (the live demo moment)
//   #/store/latest   → the newest verified purchase on record (rehearsal / backup)
//   #/store/<id>     → a specific purchase (prefix of its gpur id)
const sessionStart = Date.now();
const productCache = new Map();                                            // purchaseId → { bytes, digest, verified, unlocked }
function storeTarget() {
  const arg = decodeURIComponent(location.hash.split('/')[2] ?? '');
  const withOwner = STATES.filter((s) => s.owner || s.id);
  if (arg === 'latest') return withOwner.find((s) => s.owner && isUnlocked({ ...s.owner, facets: s.purchase?.facets })) ?? STATES.filter((s) => s.owner).slice(-1)[0];
  if (arg) return STATES.find((s) => (s.id ?? s.purchase?.purchaseId ?? '').replace('gpur_', '').startsWith(arg.replace('gpur_', '')));
  return STATES.find((s) => s.createdAt && Date.parse(s.createdAt) >= sessionStart);       // live session purchases only
}

const $ = (s) => document.querySelector(s);
const get = (u, o) => fetch(u, o).then((r) => r.json());

// Devnet refusal evidence → the same shape as the backend's requester view (presentation adapter only).
const fromRefusal = (r) => ({
  purchaseId: r.purchaseId, state: r.final?.state ?? 'REFUSED', facets: r.final?.facets ?? { authority: 'REFUSED' },
  execution: { outcome: 'REFUSED_BY_RULEBOOK', reason: r.reason, paymentExecuted: false }, receiptDigest: r.final?.receiptDigest ?? null,
  network: r.provenance.network, seller: { label: r.offer?.seller }, service: { title: r.offer?.serviceTitle }, price: { drops: r.offer?.priceDrops },
  requester: { label: 'Independent buyer agent', verified: null, id: null },   // not recorded in this evidence file
});
const tag = (p) => (p.kind === 'FIXTURE' ? 'FIXTURE · not a real purchase' : `RECORDED · ${p.network} · ${p.date}`);

function buildStates(rec) {
  const m = rec.mainnet, siblings = m.purchases.map((p) => p.requesterView);
  const auth = authoritySummary({ parent: m.authority.ownerView, siblings });
  return [
    ...m.purchases.map((p, i) => ({ group: 'Approved — real Mainnet purchases', label: `Purchase ${i + 1} of 6 · unlocked`, badge: tag(m.provenance), purchase: p.requesterView, owner: p.ownerView, auth })),
    ...rec.devnetRefusals.map((r) => ({ group: 'Refused — real Devnet refusals', label: r.reason.replaceAll('_', ' ').toLowerCase(), badge: tag(r.provenance), purchase: fromRefusal(r), auth: { notInEvidence: true } })),
    ...rec.scenarios.map((s) => ({ group: 'In progress — design fixtures', label: s.provenance.label, badge: tag(s.provenance), purchase: s.requesterView, auth })),
  ];
}

let STATES = [], current = 0, config = {}, rec = {}, catalog = null, slide = 0, rails = { rails: [], supporting: [] };
const route = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'store');

function setProvenance(text) {
  $('#provenance').textContent = text;
  $('#provenance').dataset.kind = text.startsWith('FIXTURE') ? 'fixture' : text.startsWith('LIVE') ? 'live' : 'recorded';
}

function render() {
  const r = route();
  document.querySelectorAll('.nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.route === r ? 'page' : 'false'));
  document.body.dataset.route = r;
  const products = productsFrom(rails), prod = productFor(r, products);
  document.body.dataset.product = prod.key;
  $('#products').innerHTML = [MISSION, ...products].map((p) => `<a href="#/${p.route}" class="${p.supporting ? 'is-supporting' : ''}" aria-current="${p.key === prod.key ? 'page' : 'false'}">${esc(p.name)} <small>${esc(p.tag)}</small></a>`).join('');
  const s = STATES[current];
  const unified = rec.evidence?.['rose-unified-commerce'];
  const partsOf = (keys) => (unified?.components ?? []).filter((c) => keys.includes(c.key));
  if (prod.key === 'mission') {                                            // Rose's one approval, four payment methods
    setProvenance('Rose is a fictional persona · each payment method shows its own evidence status');
    $('#stage').innerHTML = renderMission({ cfg: rails, selected: decodeURIComponent(location.hash.split('/')[2] ?? ''),
      evidenceFor: (rail) => { const parts = partsOf(rail.evidence?.parts ?? []); return parts.length ? `<section><p class="eyebrow">Evidence · each part shows its own status</p>${evidenceList(parts)}</section>` : ''; } });
  } else if (prod.key !== 'xrp-micropayments') {                           // the other capabilities: their own evidence only
    setProvenance(unified?.components?.length && prod.evidence.length ? `RECORDED · XRPL Devnet · ${unified.generatedAt?.slice(0, 10) ?? ''} · each part labelled` : `${prod.rail?.evidence?.status ?? 'PENDING'} · ${prod.network}`);
    $('#stage').innerHTML = renderProductPage({ product: prod, evidence: unified });
  } else if (r === 'store') {
    setProvenance(catalog?.live || catalog?.mainnet ? `LIVE · ${catalog.offers?.[0]?.network ?? ''}` : tag(catalog?.provenance ?? { network: 'XRPL Devnet', date: '' }));
    const t = storeTarget(), id = t?.id ?? t?.purchase?.purchaseId;
    const owner = t?.owner ? { ...t.owner, facets: t.purchase?.facets ?? t.owner.facets } : null;
    const key = owner ? `${id}:${owner.revision}:${owner.state}:${owner.facets?.delivery}` : null;   // re-verify when the purchase moves
    let product = key ? productCache.get(key) : null;
    if (owner && !product) {                                               // verify the product bytes, then re-render
      verifiedProduct(owner).then((p) => { productCache.set(key, p); render(); });
    }
    if (t) setProvenance(t.badge);                                        // the unlocked purchase's own source (Mainnet, recorded or live)
    $('#stage').innerHTML = (t ? renderProductUnlock({ owner, purchase: t.purchase, product, unlocked: Boolean(owner) && isUnlocked(owner), live: catalog?.mainnet }) : '')
      + renderStorefront({ catalog, live: catalog?.live });
    const view = $('[data-product="view"]'), dl = $('[data-product="download"]');
    if (view) view.onclick = () => { const el = $('#product-view'); el.hidden = !el.hidden; view.setAttribute('aria-expanded', String(!el.hidden)); view.textContent = el.hidden ? 'View report' : 'Hide report'; };
    if (dl && product?.bytes) dl.onclick = () => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([product.bytes], { type: 'application/json' })),
        download: `eterna-validated-ledger-report-${id.replace('gpur_', '').slice(0, 8)}.json` });
      a.click(); URL.revokeObjectURL(a.href);
    };
  } else if (r === 'console') {
    setProvenance(s.badge);
    $('#stage').innerHTML = renderPaymentConsole({ purchase: s.purchase, auth: s.auth, j: journey(s.purchase), badge: s.badge });
  } else if (r === 'reports') {
    setProvenance('RECORDED rows are real Eterna records · FIXTURE rows are illustrative');
    $('#stage').innerHTML = renderReports({ states: STATES });
    $('[data-export="csv"]').onclick = () => {
      const blob = new Blob([toCsv(reportRows(STATES))], { type: 'text/csv' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'eterna-agent-audit.csv' });
      a.click(); URL.revokeObjectURL(a.href);
    };
  } else if (r === 'receipt') {
    setProvenance(s.badge);
    $('#stage').innerHTML = renderReceipt({ owner: s.owner });
  } else if (r === 'present') {
    const ok = STATES.find((x) => x.owner), ref = STATES.find((x) => x.purchase?.execution?.reason === 'EXCEEDS_PER_PURCHASE_LIMIT');
    const deck = slides({ persona: rec.persona, auth: ok?.auth, purchase: ok?.purchase, owner: ok?.owner, refusal: refusalOf(ref?.purchase),
      purchases: STATES.filter((x) => x.owner).length });
    slide = Math.max(0, Math.min(slide, deck.length - 1));
    setProvenance('Rose is a fictional persona · each slide shows its source');
    $('#stage').innerHTML = renderPresentation({ deck, i: slide });
    document.querySelectorAll('[data-slide]').forEach((b) => b.onclick = () => { slide += Number(b.dataset.slide); render(); });
  } else {
    const j = journey(s.purchase);
    setProvenance(s.badge);
    $('#stage').innerHTML = `
      <div class="col">${renderAgentIdentity({ purchase: s.purchase, authority: s.purchase?.standing })}${renderOwnerAuthority({ auth: s.auth })}</div>
      <div class="col">${renderPurchaseRequest({ purchase: s.purchase, auth: s.auth, offer: s.offer, live: s.live })}${renderRefusal({ purchase: s.purchase, j })}
        ${renderTimeline({ purchase: s.purchase, j })}${s.owner ? '<p class="note"><a href="#/receipt">View the verifiable receipt →</a></p>' : ''}</div>`;
    wireActions(s);
  }
  document.querySelectorAll('#states button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.i) === current)));
}

function renderPicker() {
  const groups = {};
  STATES.forEach((s, i) => (groups[s.group] ??= []).push(`<button type="button" data-i="${i}">${esc(s.label)}</button>`));
  $('#states').innerHTML = Object.entries(groups).map(([g, b]) => `<div class="picker__group"><p>${esc(g)}</p>${b.join('')}</div>`).join('');
  $('#states').onclick = (e) => { const b = e.target.closest('button[data-i]'); if (b) { current = Number(b.dataset.i); if (['store', 'present', 'reports'].includes(route())) location.hash = '#/purchase'; render(); } };
}

// LIVE (test backend) — real requests to the configured backend. The backend decides; we poll its status.
function wireActions(s) {
  if (!s.live) return;
  document.querySelectorAll('[data-action]').forEach((btn) => btn.onclick = async () => {
    btn.disabled = true; $('#live-msg').textContent = 'Sending the request to Eterna…';
    const r = await get('/api/preview/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offerId: s.offer.offerId }) });
    if (!r.localId) { $('#live-msg').textContent = `Eterna answered: ${r.error ?? r.state ?? r.status ?? 'see response'}${r.detail ? ` — ${r.detail}` : ''}`; btn.disabled = false; return; }
    const poll = async () => {
      const v = await get(`/api/preview/requests/${r.localId}`);
      STATES[current] = { ...s, purchase: v, badge: `LIVE · ${v.network ?? 'test network'} · ${new Date().toLocaleTimeString()}` };
      render();
      const f = v.facets ?? {};
      if (!(v.state === 'REFUSED' || f.delivery === 'DELIVERED' || v.state === 'DRAFT')) setTimeout(poll, 3000);
      else $('#live-msg').textContent = `Final backend state: ${v.state}`;
    };
    poll();
  });
}

// MAINNET (observer mode, engineering machine only): real Mainnet purchases, read-only, refreshed every few seconds.
// Each purchase's authority comes from its real standing parent; nothing is computed that the backend did not report.
function mainnetStates(m) {
  const all = m.purchases, at = new Date(m.provenance.readAt).toLocaleTimeString();
  const parents = new Map(all.filter((p) => p.ownerView.standing?.role === 'STANDING_AUTHORIZATION').map((p) => [p.ownerView.purchaseId, p]));
  const childrenOf = (id) => all.filter((p) => p.requesterView.standing?.parentPurchaseId === id).map((p) => p.requesterView);
  const group = (p) => (p.ownerView.state === 'REFUSED' ? 'Live Mainnet — refused' : p.ownerView.state === 'DRAFT' ? 'Live Mainnet — drafts (need the owner)'
    : p.ownerView.standing?.role === 'STANDING_AUTHORIZATION' ? null : 'Live Mainnet — purchases');
  return all.filter((p) => group(p)).map((p) => {
    const parentId = p.requesterView.standing?.parentPurchaseId, parent = parentId ? parents.get(parentId) : null;
    return { group: group(p), label: `${p.ownerView.service?.title ?? 'Purchase'} · ${p.ownerView.purchaseId.slice(5, 11)} · ${p.ownerView.state.toLowerCase()}`,
      badge: `LIVE · XRPL Mainnet · read ${at}`, purchase: p.requesterView, owner: p.ownerView.receipt || p.ownerView.deliveredResult ? p.ownerView : null, id: p.ownerView.purchaseId, createdAt: p.createdAt,
      auth: parent ? authoritySummary({ parent: parent.ownerView, siblings: childrenOf(parentId) }) : null };
  });
}
let lastMainnet = '';
async function refreshMainnet(first) {
  const m = await get('/api/preview/mainnet');
  const sig = m.purchases.map((p) => `${p.ownerView.purchaseId}:${p.ownerView.state}:${p.ownerView.revision}`).join('|');
  if (!first && sig === lastMainnet) { $('#provenance').textContent = `LIVE · XRPL Mainnet · read ${new Date(m.provenance.readAt).toLocaleTimeString()}`; return; }
  lastMainnet = sig;                                                       // re-render only when Mainnet actually changed
  const keep = STATES[current]?.id;
  const live = mainnetStates(m);
  STATES = [...live, ...STATES.filter((s) => !s.id)];
  catalog = { provenance: { kind: 'LIVE', network: 'XRPL Mainnet', date: 'live' }, offers: m.offers, mainnet: true };
  if (keep) current = Math.max(0, STATES.findIndex((s) => s.id === keep));
  else if (first) current = 0;
  renderPicker(); render();
}

async function boot() {
  config = await get('/api/preview/config');
  rec = await get('/api/preview/recorded');
  rails = await get('/products/rails.json');
  STATES = buildStates(rec);
  catalog = rec.catalog;
  if (config.mode === 'mainnet') {
    $('#mode').textContent = 'LIVE · XRPL Mainnet (read-only observer)';
    await refreshMainnet(true);
    setInterval(() => refreshMainnet(false).catch(() => {}), 2500);          // fast enough that the unlock feels immediate
    return;
  }
  if (config.mode === 'live') {
    const o = await get('/api/preview/offers');
    catalog = { live: true, offers: o.offers ?? [] };
    catalog.offers.forEach((offer) => STATES.unshift({ group: `Live — ${o.network === 'mainnet' ? 'MAINNET' : 'test network'} backend`, label: `${offer.title} · ${offer.seller?.label ?? ''}`,
      badge: `LIVE · ${offer.network}`, live: true, offer, purchase: { seller: offer.seller, service: { title: offer.title }, price: { drops: offer.priceDrops }, network: offer.network,
        requester: { label: config.agent.label, verified: config.credentialConfigured } }, auth: null }));
  }
  $('#mode').textContent = config.mode === 'live' ? `Live data from ${config.backend}` : 'Recorded evidence (no backend connected)';
  renderPicker();
  // Deep link from the storefront: #/purchase/<offerId> selects that live offer when present.
  const want = decodeURIComponent(location.hash.split('/')[2] ?? '');
  if (want) { const i = STATES.findIndex((x) => x.offer?.offerId === want); if (i >= 0) current = i; }
  render();
}
document.addEventListener('DOMContentLoaded', () => {
  if (new URLSearchParams(location.search).get('theme') === 'film') document.documentElement.dataset.theme = 'film';   // preview / capture
  $('#theme').onclick = () => { const h = document.documentElement; h.dataset.theme = h.dataset.theme === 'film' ? '' : 'film'; };
  window.addEventListener('hashchange', render);
  window.addEventListener('keydown', (e) => { if (route() !== 'present') return; if (e.key === 'ArrowRight') { slide++; render(); } if (e.key === 'ArrowLeft') { slide--; render(); } });
  boot().catch((e) => { $('#stage').innerHTML = `<p class="card">Could not load: ${esc(e.message)}</p>`; });
});
