// Storefront — the agent-commerce catalog: products any AI agent can discover and buy under its owner's authority.
// Data: the backend's published offers (GET /api/purchase/v1/offers), recorded or live. DESIGNER OWNS the look.
import { esc } from '../lib/html.js';
import { xrp } from '../lib/journey.js';

const sellerKind = (k) => (k === 'INDEPENDENT' ? 'Independent seller' : k === 'DEMONSTRATION_ADAPTER' ? 'Eterna demo seller' : 'Seller');

export function renderStorefront({ catalog, live }) {
  const offers = catalog?.offers ?? [];
  return `
  <section class="store" aria-labelledby="store-h">
    <header class="store__hero">
      <p class="eyebrow">Agent storefront · ${esc(catalog?.provenance?.network ?? offers[0]?.network ?? '')}</p>
      <h1 id="store-h">Products your agent can buy.</h1>
      <p class="note">Your agent finds them, Eterna checks your signed limits, and the XRP Ledger settles. You sign once.</p>
    </header>
    <div class="store__grid">
      ${offers.map((o) => `
      <article class="product">
        <p class="product__seller">${esc(o.seller?.label ?? '')}<span class="product__kind">${esc(sellerKind(o.seller?.kind))}</span></p>
        <h2 class="product__title">${esc(o.title)}</h2>
        <p class="product__desc">${esc(o.description ?? o.deliveryTerms?.deliverableDescription ?? '')}</p>
        <p class="product__price">${esc(xrp(o.priceDrops))}</p>
        <dl class="facts">
          <div><dt>Delivered as</dt><dd>${esc(o.deliveryTerms?.outputType ?? '—')}</dd></div>
          <div><dt>Settles</dt><dd>${esc(o.network ?? '—')}</dd></div>
          <div><dt>Your authority</dt><dd>${esc(o.authority === 'NONE' ? 'Not yet granted' : o.authority ?? '—')}</dd></div>
        </dl>
        ${catalog?.mainnet
          ? `<p class="note">Agents buy this through Eterna’s MCP (<span class="mono">eterna_purchase_request</span>) under the owner’s signed authority.</p>
             <a class="btn btn--primary product__cta" href="#/console">See live Mainnet purchases</a>`
          : `<a class="btn btn--primary product__cta" href="#/purchase/${encodeURIComponent(o.offerId)}">${live ? 'Let my agent buy' : 'See how a purchase works'}</a>`}
      </article>`).join('') || '<p class="note">No published offers.</p>'}
    </div>
  </section>`;
}
