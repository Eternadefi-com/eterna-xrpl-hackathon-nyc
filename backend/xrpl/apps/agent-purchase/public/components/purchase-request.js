// B. Purchase Request panel — what is being bought, for how much, under which limits.
// The action button only REQUESTS; the backend rulebook decides. It is enabled only when the backend reports
// valid authority for this offer (offer.authority !== 'NONE') — the UI never decides on its own.
import { esc } from '../lib/html.js';
import { xrp } from '../lib/journey.js';

export function renderPurchaseRequest({ purchase, auth, offer, live }) {
  const seller = purchase?.seller?.label ?? offer?.seller?.label ?? '—';
  const product = purchase?.service?.title ?? offer?.title ?? '—';
  const drops = purchase?.price?.drops ?? offer?.priceDrops ?? null;
  const network = purchase?.network ?? offer?.network ?? '—';
  const backendAuthority = offer?.authority ?? null;
  const canAct = live && offer && backendAuthority && backendAuthority !== 'NONE';
  return `
  <section class="card request" aria-labelledby="req-h">
    <p class="eyebrow">Purchase</p>
    <h2 id="req-h">${esc(product)}</h2>
    <p class="request__seller">from ${esc(seller)}</p>
    <p class="price">${esc(xrp(drops))}</p>
    <dl class="facts">
      <div><dt>Network</dt><dd>${esc(network)}</dd></div>
      <div><dt>Per-purchase limit</dt><dd>${esc(xrp(auth?.perPurchaseDrops))}</dd></div>
      <div><dt>Status</dt><dd>${esc(purchase?.facets?.authority ?? backendAuthority ?? '—')}</dd></div>
    </dl>
    ${live ? `
    <div class="actions">
      <button class="btn btn--primary" data-action="request" ${canAct ? '' : 'disabled'}>Let the agent buy</button>
      <button class="btn btn--ghost" data-action="request-anyway" title="Sends the request anyway so you can see Eterna refuse it">Try without authority</button>
    </div>
    <p class="note">${canAct ? 'Covered by the owner’s signed authority: no new signature needed.' : 'No valid owner authority covers this offer, so Eterna will refuse it.'}</p>` : ''}
  </section>`;
}
