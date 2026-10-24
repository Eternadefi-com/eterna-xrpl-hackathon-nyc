// Master presentation scenes — DESIGNER OWNS the look (layout, type, motion). One renderer per chapter of the master
// storyboard (lib/master.js); content comes from the scenario file and its resolved evidence, never typed in here.
// Motion: every animated element gets --in (0..1) from reveal(); styles/show.css turns that into the shared transitions.
// The "transaction" and "outcome" chapters reuse the real app components, so the video shows the actual product UI.
import { esc, short, when, proofButtons } from '../lib/html.js';
import { xrp } from '../lib/journey.js';
import { reveal, MOTION } from '../lib/master.js';
import { renderProductUnlock } from './product-unlock.js';

const v = (local, at) => `style="--in:${reveal(local, at).toFixed(3)}"`;
const STATUS = {
  VERIFIED: 'VERIFIED on the ledger', REHEARSAL: 'REHEARSAL · real earlier transaction, not the live run', PENDING: 'PENDING · no transaction yet',
  PARTIAL: 'Each part labelled · ledger VERIFIED · vouchers SIMULATED',
};
const chip = (status) => `<span class="status" data-status="${esc(status)}">${esc(status)}</span>`;   // shared pill

// Unified mission: every part keeps its own status (VERIFIED / SIMULATED / PENDING) — never merged into one claim.
function missionCard(s, ev, local, { proof = false } = {}) {
  if (!ev.components?.length) return `<div class="show__proof show__proof--pending" ${v(local, 300)}><p>${esc(ev.note ?? 'Not run yet.')}</p></div>`;
  return `<ol class="show__mission">${ev.components.map((c, n) => `<li ${v(local, 250 + n * MOTION.stepMs)}>
      <div class="show__mission-head">${chip(c.status)}<strong>${esc(c.label)}</strong></div>
      <p>${esc(c.detail ?? '')}</p>${proof && c.txHash ? `<p class="mono">${esc(c.txHash)}</p>` : ''}</li>`).join('')}</ol>
    ${proof && ev.auditReceipt?.digest ? `<p class="show__link" ${v(local, 250 + ev.components.length * MOTION.stepMs)}>Audit receipt ${esc(ev.auditReceipt.digest)}${ev.auditReceipt.anchorTx ? ` · anchored ${esc(ev.auditReceipt.anchorTx)}` : ''}</p>` : ''}`;
}

function chrome(s, ev, i, n) {
  return `<header class="show__chrome">
      <span class="show__brand">ETERNA<span>.AI</span></span>
      <span class="net" data-net="${esc(s.network.label)}">${esc(s.network.label)}${s.network.realValue ? '' : ' · test network'}</span>
      <span class="status" data-status="${esc(ev.status)}">${esc(STATUS[ev.status] ?? ev.status)}</span>
      <span class="show__count">${i + 1} / ${n}</span>
    </header>`;
}

const hero = (s, imageOk) => (imageOk
  ? `<div class="show__hero" style="background-image:url('${esc(s.imagery.hero)}')" role="img" aria-label="${esc(s.imagery.context)}"></div>`
  : `<div class="show__hero show__hero--placeholder" role="img" aria-label="${esc(s.imagery.context)}"><span>IMAGERY PENDING · ${esc(s.imagery.context)}</span></div>`);

function proofCard(s, ev, local) {
  if (ev.components) return missionCard(s, ev, local, { proof: true });
  if (ev.status === 'PENDING') return `<div class="show__proof show__proof--pending" ${v(local, 300)}><p>${esc(ev.note ?? 'No transaction yet.')}</p></div>`;
  const rows = ev.network === 'XRPL Mainnet' ? [
    ['Network', ev.network], ['Transaction hash', ev.txHash, 'mono'], ['Settled in ledger', ev.ledger, 'mono'],
    ['Amount', xrp(ev.amountDrops)], ['Independent readers', `${ev.readers} confirmed`], ['Authority', `Signed once · ${short(ev.authorizationTx)}`, 'mono'],
    ['Product fingerprint', ev.product?.verified ? `✓ ${short(ev.product.digest, 10, 8)}` : 'not verified', 'mono'],
  ] : [
    ['Network', `${ev.network} · amendment ${ev.amendment ?? 'Sponsor'}`], ['Transaction hash', ev.txHash, 'mono'], ['Validated ledger', ev.ledger, 'mono'],
    ['Sponsor', ev.sponsor, 'mono'], ['Sponsored account', ev.sponsee, 'mono'], ['Covered', ev.covered], ['Result', ev.result],
  ];
  return `<dl class="show__proof">${rows.map(([k, val, cls], n) => `<div ${v(local, 250 + n * MOTION.stepMs)}><dt>${esc(k)}</dt><dd class="${cls ?? ''}">${esc(val ?? '—')}</dd></div>`).join('')}</dl>
    ${ev.txUrl ? `<p class="show__link" ${v(local, 250 + rows.length * MOTION.stepMs)}>${esc(ev.txUrl)}</p><p class="show__verify" ${v(local, 400 + rows.length * MOTION.stepMs)}>${proofButtons(ev.txHash, ev.txUrl)}</p>` : ''}`;
}

function sponsorshipCard(s, ev, local) {           // Devnet XLS-68: the sponsored transaction, in the Eterna receipt style
  return `<section class="unlock unlock--done show__ui" ${v(local, 200)}>
      <p class="unlock__badge">${ev.status === 'PENDING' ? 'Waiting for the sponsored transaction' : `✓ Sponsored · validated on ${esc(ev.network)}`}</p>
      <h2>${esc(s.scenario.title)}</h2>
      <p class="note">${esc(s.authority.sponsoredBy)} covers: ${esc(s.authority.covers)} · ${esc(s.authority.policy)}</p>
      ${ev.status === 'PENDING' ? '' : `<dl class="facts unlock__proof"><div><dt>Sponsor</dt><dd class="mono">${esc(short(ev.sponsor))}</dd></div>
        <div><dt>Agent account</dt><dd class="mono">${esc(short(ev.sponsee))}</dd></div><div><dt>Transaction hash</dt><dd class="mono">${esc(ev.txHash)}</dd></div></dl>`}
    </section>`;
}

export function renderScene({ s, ev, f, n, imageOk }) {
  const L = f.local, head = chrome(s, ev, f.i, n), a = s.authority ?? {};
  const body = {
    opening: () => `<div class="show__center"><p class="show__kicker" ${v(L, 0)}>${esc(s.sponsor.name)}</p>
        <h1 class="show__title" ${v(L, 300)}>${esc(s.messages.opening)}</h1><p class="show__sub" ${v(L, 1200)}>${esc(s.capability.name)}</p></div>`,
    problem: () => `${hero(s, imageOk)}<div class="show__side"><p class="show__kicker" ${v(L, 0)}>Meet Rose · CFO · fictional persona</p>
        <h1 class="show__title" ${v(L, 300)}>${esc(s.scenario.problem)}</h1></div>`,
    solution: () => `<div class="show__center"><p class="show__kicker" ${v(L, 0)}>Eterna · ${esc(s.scenario.summary)}</p>
        <h1 class="show__title" ${v(L, 300)}>${esc(s.capability.oneLiner)}</h1>
        <ul class="show__terms">${(a.terms ?? (a.totalXrp != null ? [`Up to ${a.totalXrp} XRP`, `Max ${a.perPurchaseXrp} XRP per purchase`, a.merchants, a.expiry]
          : [`Sponsor: ${a.sponsoredBy}`, `Covers: ${a.covers}`, a.policy])).map((t, k) => `<li ${v(L, 1200 + k * MOTION.stepMs)}>${esc(t)}</li>`).join('')}</ul></div>`,
    transaction: () => `<div class="show__stagewide"><p class="show__kicker" ${v(L, 0)}>The actual transaction · ${esc(s.network.label)}</p>
        ${ev.owner ? `<div class="show__ui" ${v(L, 400)}>${renderProductUnlock({ owner: ev.owner, purchase: ev.purchase, product: ev.product, unlocked: true, live: true })}</div>`
          : ev.components ? missionCard(s, ev, L) : sponsorshipCard(s, ev, L)}</div>`,
    proof: () => `<div class="show__stagewide"><p class="show__kicker" ${v(L, 0)}>Proof · independently verifiable</p>${proofCard(s, ev, L)}</div>`,
    outcome: () => `<div class="show__center"><p class="show__kicker" ${v(L, 0)}>Outcome</p>
        <h1 class="show__title" ${v(L, 300)}>${esc(s.narration.outcome)}</h1>${ev.at ? `<p class="show__sub" ${v(L, 900)}>${esc(when(ev.at))}</p>` : ''}</div>`,
    closing: () => `<div class="show__center"><h1 class="show__title" ${v(L, 0)}>${esc(s.messages.closing)}</h1>
        <p class="show__sub" ${v(L, 900)}>tryeterna.ai</p></div>`,
  }[f.key];
  return `<section class="show__scene show__scene--${f.key}">${head}${body()}<p class="show__caption" ${v(L, 200)}>${esc(s.narration[f.key])}</p></section>`;
}
