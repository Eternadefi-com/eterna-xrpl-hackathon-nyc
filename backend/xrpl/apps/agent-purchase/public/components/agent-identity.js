// A. Agent Identity panel — who is asking. DESIGNER OWNS the markup and classes; keep the data fields.
// Shows the requester label, whether Eterna verified its credential, and which owner authority applies.
// Never shows credentials: the backend view does not contain them.
import { esc, short } from '../lib/html.js';

export function renderAgentIdentity({ purchase, authority }) {
  const r = purchase?.requester ?? {};
  const verified = r.verified === true, unknown = r.verified == null;
  const parent = purchase?.standing?.parentPurchaseId ?? authority?.purchaseId ?? null;
  return `
  <section class="card agent" aria-labelledby="agent-h">
    <p class="eyebrow">Agent</p>
    <h2 id="agent-h" class="agent__name">${esc(r.label ?? 'Unknown agent')}</h2>
    <p class="badge ${verified ? 'badge--ok' : 'badge--warn'}">${unknown ? 'Identity not in this record' : verified ? 'Verified credential' : 'Unverified requester'}</p>
    <dl class="facts">
      <div><dt>Agent ID</dt><dd class="mono">${esc(short(r.id ?? '—', 10, 6))}</dd></div>
      <div><dt>Acting under</dt><dd class="mono">${parent ? esc(short(parent, 10, 6)) : 'No owner authority'}</dd></div>
    </dl>
    <p class="note">${unknown ? 'This evidence record does not include the agent’s identity.' : verified
      ? 'This agent authenticated with its own Eterna credential, so it may use the owner’s standing authority.'
      : 'Unverified requesters can only draft purchases. They cannot spend standing authority.'}</p>
  </section>`;
}
