// Agent Payment Console — the invoice-to-payment moment, governed. One purchase, shown like a merchant invoice,
// with Eterna's checks underneath. Every check is read from the backend's view of THIS purchase; nothing is assumed.
// DESIGNER OWNS the look (Ramp-inspired simplicity, Eterna's own identity — never Ramp's layout or branding).
import { esc, short, when, link } from '../lib/html.js';
import { xrp } from '../lib/journey.js';

const mark = (ok) => (ok === true ? '<span class="check check--ok" aria-label="passed">✓</span>' : ok === false ? '<span class="check check--bad" aria-label="failed">✕</span>' : '<span class="check check--wait" aria-label="pending">…</span>');

export function consoleChecks({ purchase: p, auth, j }) {
  const x = p?.execution ?? {}, verified = j?.steps?.find((s) => s.id === 'VERIFIED')?.status === 'done';
  return [
    { label: 'Agent identity verified', ok: p?.requester?.verified ?? null, note: p?.requester?.label },
    { label: 'Standing authority valid', ok: j?.refused ? false : p?.facets?.authority === 'CONFIRMED' ? true : null,
      note: auth?.autonomous ? 'Signed once by the owner. No new signature for this purchase.' : null },
    { label: 'Within authorized limits', ok: j?.refused ? false : p?.facets?.authority === 'CONFIRMED' ? true : null,
      note: auth?.perPurchaseDrops ? `Limit ${xrp(auth.perPurchaseDrops)} per purchase` : null },
    { label: 'Settled on the XRP Ledger', ok: x.redeemTx ? true : j?.refused ? false : null, note: x.redeemTx ? `Ledger ${x.redeemLedger ?? ''}` : null },
    { label: 'Independently verified', ok: verified ? true : j?.refused ? false : null, note: verified ? `${x.readers.length} ledger readers agree` : null },
  ];
}

export function renderPaymentConsole({ purchase: p, auth, j, badge }) {
  const checks = consoleChecks({ purchase: p, auth, j });
  const ref = p?.purchaseId ? `INV-${p.purchaseId.replace('gpur_', '').slice(0, 6).toUpperCase()}` : 'INV-—';   // short display ref of the purchase id
  const status = j?.refused ? 'Refused: no payment made' : j?.steps?.find((s) => s.id === 'UNLOCKED')?.status === 'done' ? 'Paid · verified · delivered'
    : j?.locked ? 'Paid · awaiting independent verification' : 'In progress';
  return `
  <section class="console" aria-labelledby="con-h">
    <header class="console__head">
      <p class="eyebrow">Eterna.AI · Agent commerce · Purchase review</p>
      <h1 id="con-h">${esc(p?.service?.title ?? 'Purchase')}</h1>
      <p class="console__meta"><span class="mono">${esc(ref)}</span> · ${esc(p?.seller?.label ?? '')} · ${esc(p?.network ?? '')}</p>
    </header>
    <div class="console__body">
      <div class="console__invoice">
        <p class="eyebrow">Amount</p>
        <p class="console__amount">${esc(xrp(p?.price?.drops))}</p>
        <dl class="facts">
          <div><dt>Requesting agent</dt><dd>${esc(p?.requester?.label ?? '—')}</dd></div>
          <div><dt>Merchant</dt><dd>${esc(p?.seller?.label ?? '—')}</dd></div>
          <div><dt>Payment network</dt><dd>${esc(p?.network ?? '—')}</dd></div>
          <div><dt>Updated</dt><dd>${esc(when(p?.updatedAt))}</dd></div>
        </dl>
        <p class="console__status">${esc(status)}</p>
      </div>
      <div class="console__checks">
        <p class="eyebrow">Eterna checks</p>
        <ul>${checks.map((c) => `<li>${mark(c.ok)}<span><strong>${esc(c.label)}</strong>${c.note ? `<small>${esc(c.note)}</small>` : ''}</span></li>`).join('')}</ul>
        <p class="note"><strong>Autonomous execution:</strong> an agent the owner has already authorized proceeds without a new owner signature, as long as every check passes. Delivery waits for independent verification.</p>
        ${p?.execution?.redeemExplorerUrl ? `<p class="note">${link(p.execution.redeemExplorerUrl, 'Payment on the ledger ↗')}</p>` : ''}
      </div>
    </div>
    <p class="console__provenance">${esc(badge ?? '')}</p>
  </section>`;
}
