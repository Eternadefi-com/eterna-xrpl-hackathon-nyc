// C. Owner Authorization panel — the owner's signed, bounded authority (Intent Certificate) and what is left of it.
// "Autonomous" means: covered purchases run without another owner signature. Data comes from the backend view.
import { esc, short, when, link } from '../lib/html.js';
import { xrp } from '../lib/journey.js';

export function renderOwnerAuthority({ auth }) {
  if (auth?.notInEvidence) return `<section class="card authority"><p class="eyebrow">Owner authority</p><h2>Not in this record</h2><p class="note">This evidence file records the refusal, not the authority’s details.</p></section>`;
  if (!auth) return `<section class="card authority"><p class="eyebrow">Owner authority</p><h2>None</h2><p class="note">No signed authority applies.</p></section>`;
  const pct = auth.maxTotalDrops && auth.usedDrops != null ? Math.min(100, Math.round((auth.usedDrops / Number(auth.maxTotalDrops)) * 100)) : null;
  const state = auth.ended ? 'Ended by owner' : auth.expired ? 'Expired' : 'Active';
  return `
  <section class="card authority" aria-labelledby="auth-h">
    <p class="eyebrow">Owner authority</p>
    <h2 id="auth-h">Signed once</h2>
    <p class="badge ${state === 'Active' ? 'badge--ok' : 'badge--bad'}">${esc(state)}</p>
    <p class="note">${auth.autonomous
      ? 'Purchases inside these limits run automatically. The owner does not sign each one.'
      : 'Each purchase needs the owner’s approval.'}</p>
    ${pct != null ? `<div class="meter" role="img" aria-label="${pct}% of budget used"><span style="width:${pct}%"></span></div>` : ''}
    <dl class="facts">
      <div><dt>Per purchase</dt><dd>${esc(xrp(auth.perPurchaseDrops))}</dd></div>
      <div><dt>Total budget</dt><dd>${esc(xrp(auth.maxTotalDrops))}</dd></div>
      <div><dt>Used</dt><dd>${auth.usedDrops != null ? esc(xrp(auth.usedDrops)) : '—'} · ${esc(auth.usedPurchases ?? '—')} of ${esc(auth.maxPurchases ?? '—')} purchases</dd></div>
      <div><dt>Remaining</dt><dd>${esc(xrp(auth.remainingDrops))}</dd></div>
      <div><dt>Expires</dt><dd>${esc(when(auth.expiry))}</dd></div>
      <div><dt>Certificate</dt><dd class="mono">${esc(short(auth.digest, 10, 6))}</dd></div>
    </dl>
    ${auth.channelCreateUrl ? `<p class="note">${link(auth.channelCreateUrl, 'See the signed authority on the ledger ↗')}</p>` : ''}
  </section>`;
}
