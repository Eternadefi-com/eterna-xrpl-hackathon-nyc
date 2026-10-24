// E. Refusal — exactly why Eterna said no, and the evidence. The reason code is the backend's; the words come from
// lib/journey.js (REFUSALS). Receipt digest / anchor shown when the backend issued them.
import { esc, short, link } from '../lib/html.js';

export function renderRefusal({ purchase, j }) {
  if (!j.refusal) return '';
  const r = j.refusal, a = purchase?.anchor ?? {};
  return `
  <section class="card refusal" role="alert" aria-labelledby="ref-h">
    <p class="eyebrow">Refused before any payment</p>
    <h2 id="ref-h">${esc(r.category)}</h2>
    <p>${esc(r.text)}</p>
    <dl class="facts">
      <div><dt>Reason code</dt><dd class="mono">${esc(r.code)}</dd></div>
      <div><dt>Money moved</dt><dd>None</dd></div>
      ${purchase?.receiptDigest ? `<div><dt>Refusal receipt</dt><dd class="mono">${esc(short(purchase.receiptDigest, 10, 6))}</dd></div>` : ''}
    </dl>
    <div class="recovery"><p class="eyebrow">What Rose can do</p><p>Nothing was paid. If this purchase should be allowed, she can approve new limits in the Eterna app; her agent then retries with no other change.</p></div>
    ${a.explorerUrl ? `<p class="note">${link(a.explorerUrl, 'Refusal receipt anchored on the ledger ↗')}</p>` : r.receipt ? '<p class="note">Eterna issues a refusal receipt for this reason.</p>' : '<p class="note">Rejected at the door: no purchase record, so no receipt.</p>'}
  </section>`;
}
