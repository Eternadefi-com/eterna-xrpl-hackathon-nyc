// D. Purchase Status timeline — REQUESTED → AUTHORIZED → SUBMITTED → SETTLED → VERIFIED → UNLOCKED.
// Step states come from lib/journey.js (which reads the backend). Settled is NOT unlocked: delivery stays locked until
// Eterna's independent verification is reported. Statuses: done | current | locked | refused | todo.
import { esc, link } from '../lib/html.js';

const ICON = { done: '✓', current: '•', locked: '🔒', refused: '✕', todo: '' };

export function renderTimeline({ purchase, j }) {
  const x = purchase?.execution ?? {}, a = purchase?.anchor ?? {};
  const evidence = {
    SETTLED: x.redeemExplorerUrl ? link(x.redeemExplorerUrl, 'Ledger transaction ↗') : '',
    VERIFIED: Array.isArray(x.readers) && x.readers.length >= 2 ? `${x.readers.length} independent readers agree` : '',
    UNLOCKED: a.explorerUrl ? link(a.explorerUrl, 'Receipt anchored ↗') : '',
  };
  return `
  <section class="card timeline" aria-labelledby="tl-h">
    <p class="eyebrow">Status</p>
    <h2 id="tl-h">${j.refused ? 'Refused' : j.locked ? 'Paid · waiting for verification' : j.uncertain ? 'Checking the ledger' : 'Progress'}</h2>
    <ol class="steps">
      ${j.steps.map((s) => `
      <li class="step step--${s.status}" aria-current="${s.status === 'current' ? 'step' : 'false'}">
        <span class="step__dot" aria-hidden="true">${ICON[s.status]}</span>
        <span class="step__body"><strong>${esc(s.title)}</strong><span>${esc(s.status === 'locked' ? 'Locked until Eterna verifies the payment.' : s.detail)}</span>
        ${s.status === 'done' && evidence[s.id] ? `<span class="step__evidence">${evidence[s.id]}</span>` : ''}</span>
      </li>`).join('')}
    </ol>
    ${j.uncertain && !j.refused && !j.locked ? '<p class="note">Outcome uncertain: Eterna reconciles it from the ledger. Nothing is bought twice, and nothing unlocks until it is settled.</p>' : ''}
  </section>`;
}
