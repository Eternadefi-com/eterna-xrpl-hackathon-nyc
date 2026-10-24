// Rose's unified mission — DESIGNER OWNS the look. One approval, one payment request, four eligible payment methods,
// each with its own stages and evidence. Built from the shared system: card, facts, status, net, steps, evidence, btn.
// Data: products/rails.json (copy) + each rail's recorded evidence. Never shows a stage as done without evidence.
import { esc } from '../lib/html.js';
import { eligibility } from '../lib/products.js';

const pill = (s) => `<span class="status" data-status="${esc(s)}">${esc(s)}</span>`;
const SOURCE = { PLANNED: 'PLANNED · activates only when Rose signs', RECORDED: 'RECORDED' };

export function renderCertificateReview({ mission, rails }) {
  return `<section class="card cert" aria-labelledby="cert-h">
    <p class="eyebrow">${esc(SOURCE[mission.source] ?? mission.source)} · intention certificate</p>
    <h2 id="cert-h">${esc(mission.title)}</h2>
    <dl class="facts">
      <div><dt>Task</dt><dd>${esc(mission.task)}</dd></div>
      <div><dt>Who asks</dt><dd>${esc(mission.requester)}</dd></div>
      <div><dt>Who pays</dt><dd>${esc(mission.payer)}</dd></div>
      <div><dt>Approved sellers</dt><dd>${esc(mission.sellers.join(', '))}</dd></div>
      <div><dt>Expires</dt><dd>${esc(mission.expiry)}</dd></div>
    </dl>
    <div class="table-wrap"><table class="ledger"><thead><tr><th>Payment method</th><th>Asset</th><th>Per payment</th><th>Total</th><th>Network</th></tr></thead><tbody>
      ${rails.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.asset)}</td><td>${esc(r.limits.perTx)}</td><td>${esc(r.limits.total)}</td><td>${esc(r.network)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="cert__consent">${esc(mission.consent)}</p>
  </section>`;
}

export function renderPaymentRequest({ request }) {
  return `<section class="card" aria-labelledby="req-h">
    <p class="eyebrow">Payment request · HTTP 402</p>
    <h2 id="req-h">${esc(request.seller)} asks to be paid</h2>
    <dl class="facts"><div><dt>For</dt><dd>${esc(request.item)}</dd></div><div><dt>Price</dt><dd>${esc(request.price)}</dd></div>
      <div><dt>Asked by</dt><dd>${esc(request.agent)}</dd></div></dl>
    <p class="note">The agent picks a payment method Rose allowed. Eterna checks the request against her certificate before anything is signed.</p>
  </section>`;
}

export function renderRailCards({ rails, request, selected }) {
  return `<section aria-labelledby="rails-h"><p class="eyebrow" id="rails-h">Choose an eligible payment method</p>
    <div class="rails">${rails.map((r) => { const e = eligibility(r, request); return `
      <a class="rail${r.id === selected ? ' is-selected' : ''}" href="#/mission/${esc(r.id)}" aria-current="${r.id === selected}">
        <span class="rail__head"><strong>${esc(r.name)}</strong>${pill(r.evidence.status)}</span>
        <span class="rail__tag">${esc(r.tag)} · ${esc(r.asset)}</span>
        <span class="net" data-net="${esc(r.network)}">${esc(r.network)}</span>
        <span class="rail__why">${esc(e.why)}</span>
      </a>`; }).join('')}</div></section>`;
}

const STAGES = {
  'xrp-micropayments': ['Authorized', 'Claim signed', 'Redeemed', 'Settled', 'Verified', 'Unlocked'],
  'rlusd-payments': ['Authorized', 'Submitted', 'Settled', 'Verified', 'Unlocked'],
  'sponsored-execution': ['Authorized', 'Sponsor co-signed', 'Submitted', 'Settled', 'Verified'],
  'voucher-commerce': ['Authorized', 'Voucher verified', 'Redeemed', 'Settled', 'Verified', 'Unlocked'],
};
// Each stage's status, from the rail's evidence only. Voucher stages before settlement stay SIMULATED, never VERIFIED.
function stageStatus(rail, stage) {
  const s = rail.evidence.status;
  if (s === 'PENDING') return stage === 'Authorized' ? 'PENDING' : 'TODO';
  if (rail.id === 'voucher-commerce' && ['Voucher verified', 'Redeemed'].includes(stage)) return 'SIMULATED';
  if (rail.id === 'voucher-commerce') return 'VERIFIED';                     // settlement, verification, unlock: Devnet ledger
  return s;                                                                  // VERIFIED (Devnet) or REHEARSAL (earlier Mainnet run)
}
const STEP = { VERIFIED: ['done', '✓'], REHEARSAL: ['rehearsal', '↺'], SIMULATED: ['current', '◇'], PENDING: ['locked', '…'], TODO: ['todo', ''] };

export function renderRailDetail({ rail, evidenceList }) {
  if (!rail) return '';
  const stages = STAGES[rail.id] ?? [];
  return `<div class="product-page__grid">
    <section class="card" aria-labelledby="st-h"><p class="eyebrow">${esc(rail.name)} · status</p><h2 id="st-h">${esc(rail.evidence.detail)}</h2>
      <ol class="steps">${stages.map((st) => { const v = stageStatus(rail, st), [cls, icon] = STEP[v]; return `
        <li class="step step--${cls}"><span class="step__dot" aria-hidden="true">${icon}</span><span class="step__body"><strong>${esc(st)}</strong><span>${v === 'TODO' ? 'Not yet' : pill(v)}</span></span></li>`; }).join('')}</ol>
      ${rail.evidence.status === 'PENDING' ? `<div class="recovery"><p class="eyebrow">What happens next</p><p>${esc(rail.evidence.detail)}</p></div>` : ''}
    </section>
    <section class="card"><p class="eyebrow">What it can and can’t do</p><h2>${esc(rail.tag)}</h2>
      <ul class="cando">${rail.can.map((c) => `<li class="cando__yes">${esc(c)}</li>`).join('')}${rail.cannot.map((c) => `<li class="cando__no">${esc(c)}</li>`).join('')}</ul>
      <p class="eyebrow" style="margin-top:16px">Unlocks only when</p><ul class="cando">${rail.proof.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
    </section>
  </div>${evidenceList ?? ''}`;
}

export function renderMission({ cfg, selected, evidenceFor }) {
  const rails = cfg.rails, rail = rails.find((r) => r.id === selected);
  const request = { seller: 'Ledger Data Agent', item: 'Validated XRPL ledger report', price: '0.1 XRP · or the equivalent in the chosen asset', agent: cfg.mission.requester };
  return `<section class="product-page">
    <header class="product-page__hero"><p class="eyebrow">One approval · four payment methods · one governance engine</p>
      <h1>Rose’s purchasing mission</h1>
      <p>Rose approves once. Whichever way her agent pays, Eterna enforces the same certificate and proves what happened.</p></header>
    <div class="mission__top">${renderCertificateReview({ mission: cfg.mission, rails })}${renderPaymentRequest({ request })}</div>
    ${renderRailCards({ rails, request, selected })}
    ${rail ? renderRailDetail({ rail, evidenceList: evidenceFor(rail) }) : '<p class="note">Choose a payment method to see its stages and evidence.</p>'}
  </section>`;
}
