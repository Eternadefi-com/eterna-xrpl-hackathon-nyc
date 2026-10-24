// Product pages for XLS-68 · XLS-75 · Voucher Commerce — DESIGNER OWNS the look. Built only from the shared system
// (card, facts, steps, evidence, status, net, ledger table), so they read exactly like Agent Governance.
// Data: each product's OWN evidence parts from the recorded Devnet mission (lib/products.js lists which). A part shows
// its own status — VERIFIED (proven on the ledger), SIMULATED (local simulator) or PENDING — never merged.
import { esc, short, when, link, proofButtons } from '../lib/html.js';
import { xrp } from '../lib/journey.js';
import { renderRailDetail } from './mission.js';

const pill = (status) => `<span class="status" data-status="${esc(status)}">${esc(status)}</span>`;
const ICON = { VERIFIED: '✓', SIMULATED: '◇', PENDING: '', FAILED: '✕' };

export function evidenceList(parts) {
  return `<ol class="evidence">${parts.map((c) => `<li>
      <div class="evidence__head">${pill(c.status)}<strong>${esc(c.label)}</strong></div>
      <p>${esc(c.detail ?? '')}</p>
      ${c.txUrl ? `<p class="mono">${link(c.txUrl, `${c.txHash} ↗`)}</p>${proofButtons(c.txHash, c.txUrl)}` : ''}${c.ledger ? `<p>Ledger ${esc(c.ledger)}${c.facts?.readersAgreeing ? ` · ${esc(c.facts.readersAgreeing)} readers agree` : ''}</p>` : ''}
    </li>`).join('')}</ol>`;
}

function steps(items) {          // the same timeline component as the purchase journey
  return `<ol class="steps">${items.map(([title, detail, status]) => {
    const st = status === 'VERIFIED' ? 'done' : status === 'FAILED' ? 'refused' : status === 'SIMULATED' ? 'current' : 'todo';
    return `<li class="step step--${st}"><span class="step__dot" aria-hidden="true">${ICON[status] ?? ''}</span>
      <span class="step__body"><strong>${esc(title)}</strong><span>${esc(detail)}</span></span></li>`;
  }).join('')}</ol>`;
}

const facts = (rows) => `<dl class="facts">${rows.filter(Boolean).map(([k, v, mono]) => `<div><dt>${esc(k)}</dt><dd class="${mono ? 'mono' : ''}">${esc(v ?? '—')}</dd></div>`).join('')}</dl>`;

const COPY = {
  'sponsored-execution': {
    title: 'Sponsored Execution',
    lede: 'Eterna pays the network fees and reserves for Rose’s agents, so no agent account has to hold company XRP.',
    control: (m, by) => [['Sponsor', short(m.sponsor), true], ['Agent account', short(m.agent), true], ['Agent balance', `${by['xls68-sponsorship']?.facts?.agentBalanceDrops ?? '—'} drop`],
      ['Accounts Eterna sponsors', by['xls68-sponsorship']?.facts?.eternaSponsoringAccountCount], ['Objects Eterna sponsors', by['xls68-sponsorship']?.facts?.eternaSponsoringOwnerCount]],
    flow: (by) => [['Eterna creates the agent account', 'A 1-drop payment with the sponsored-account flag.', by['xls68-sponsorship']?.status],
      ['The ledger records Eterna as sponsor', 'The agent’s reserve is carried by Eterna, not by Rose or the agent.', by['xls68-sponsorship']?.status],
      ['Eterna also pays the agent’s fees', 'Fee sponsorship on the delegated settlement (see Voucher Commerce).', by.settlement?.status]],
  },
  'delegated-authority': {
    title: 'Delegated Authority',
    lede: 'Rose gives her agent exactly one ledger permission. Eterna still checks every request against her mission before anything is signed.',
    control: (m, by) => [['Rose’s treasury', short(m.rose), true], ['Delegated to', short(m.agent), true], ['Permissions', (by['xls75-delegation']?.facts?.permissions ?? []).join(', ')],
      ['Mission certificate', short(m.certificateDigest, 10, 8), true], ['Approved seller', short(m.seller), true], ['Per payment · total', `${xrp(m.perVoucherDrops)} · ${xrp(m.capDrops)}`], ['Expires', when(m.expiry)]],
    flow: (by) => [['Rose approves one mission', 'Eterna issues the certificate; Rose signs its digest.', by.governance?.status],
      ['Rose delegates Payment only', 'DelegateSet on the ledger, fee and reserve sponsored by Eterna.', by['xls75-delegation']?.status],
      ['Out-of-policy requests refused', 'Over the per-payment limit, or a seller she did not approve: refused before signing.', by.refusal?.status]],
  },
  'voucher-commerce': {
    title: 'Voucher Commerce',
    lede: 'The seller asks for payment with HTTP 402; the agent pays with signed vouchers. Here the vouchers come from Eterna’s local simulator of Mastercard’s Agent Pay model — not from Mastercard.',
    control: (m, by) => [['Voucher issuer', by['voucher-sim']?.facts?.issuer ?? 'Eterna local simulator — not Mastercard'], ['Scheme', by['voucher-sim']?.facts?.scheme],
      ['Vouchers', (by['voucher-sim']?.facts?.vouchers ?? []).length], ['Redeemed total', xrp(by.settlement?.facts?.amountDrops)], ['Settled on', 'XRPL Devnet · delegated payment'], ['Mastercard network', 'Not connected (no sandbox access)']],
    flow: (by) => [['Seller answers HTTP 402', 'x402-style payment request from the seller.', by['voucher-sim']?.status],
      ['Eterna checks the mission, then the agent signs', 'EIP-712 vouchers, cumulative, bound to the approved seller.', by['voucher-sim']?.status],
      ['Seller redeems the batch', 'Settled by one delegated XRPL Devnet payment, fee paid by Eterna.', by.settlement?.status],
      ['Eterna proves it', 'Every part re-read from the ledger; one audit receipt anchored.', by['audit-receipt']?.status],
      ['Mastercard network', 'Pending real AP4M sandbox access.', by['mastercard-network']?.status]],
  },
};

export function renderProductPage({ product, evidence }) {
  const copy = COPY[product.key], comps = evidence?.components ?? [];
  if (!copy) return `<section class="product-page"><header class="product-page__hero"><p class="eyebrow">${esc(product.tag)} · Rose’s purchasing mission</p>
      <h1>${esc(product.name)}</h1><p>${esc(product.rail?.evidence?.detail ?? '')}</p>
      <div class="product-page__meta"><span class="net" data-net="${esc(product.network)}">${esc(product.network)}</span>${pill(product.rail?.evidence?.status ?? 'PENDING')}</div></header>
    ${renderRailDetail({ rail: product.rail })}</section>`;
  const by = Object.fromEntries(comps.map((c) => [c.key, c])), mine = product.evidence.map((k) => by[k]).filter(Boolean), m = evidence?.mission ?? {};
  const vouchers = by['voucher-sim']?.facts?.vouchers ?? [];
  return `
  <section class="product-page">
    <header class="product-page__hero">
      <p class="eyebrow">${esc(product.tag)} · ${product.supporting ? 'supporting authorization module' : 'Rose’s purchasing mission'}</p>
      <h1>${esc(copy.title)}</h1>
      <p>${esc(copy.lede)}</p>
      <div class="product-page__meta"><span class="net" data-net="${esc(product.network)}">${esc(product.network)}</span>${mine.map((c) => pill(c.status)).join('')}</div>
    </header>
    ${!comps.length ? `<p class="card">${esc(evidence?.note ?? 'The Devnet mission has not run yet.')}</p>` : `
    <div class="product-page__grid">
      <section class="card"><p class="eyebrow">What Rose controls</p><h2>${esc(copy.title)}</h2>${facts(copy.control(m, by))}</section>
      <section class="card"><p class="eyebrow">How it works</p><h2>Step by step</h2>${steps(copy.flow(by))}</section>
    </div>
    ${product.rail ? `<section class="card"><p class="eyebrow">What it can and can’t do</p><ul class="cando">${(product.rail.can ?? []).map((c) => `<li class="cando__yes">${esc(c)}</li>`).join('')}${(product.rail.cannot ?? []).map((c) => `<li class="cando__no">${esc(c)}</li>`).join('')}</ul></section>` : ''}
    ${product.key === 'voucher-commerce' && vouchers.length ? `<section class="card"><p class="eyebrow">Simulated vouchers · not Mastercard</p><h2>Vouchers</h2>
      <div class="table-wrap"><table class="ledger"><thead><tr><th>#</th><th>Cumulative</th><th>Status</th><th>Voucher digest</th></tr></thead><tbody>
      ${vouchers.map((v) => `<tr><td>${esc(v.nonce)}</td><td>${esc(xrp(v.cumulativeDrops))}</td><td>${pill('SIMULATED')} ${esc(v.status.toLowerCase())}</td><td class="mono">${esc(short(v.digest, 10, 8))}</td></tr>`).join('')}
      </tbody></table></div>
      ${evidence.unlocked ? `<p class="note">${esc((evidence.reports ?? []).length)} Devnet ledger reports unlocked after Eterna verified the settlement.</p>` : ''}</section>` : ''}
    <section><p class="eyebrow">Evidence · each part shows its own status</p>${evidenceList(mine)}</section>`}
  </section>`;
}
