// Product unlock on the storefront — the moment Rose's agent's purchase is verified on Mainnet, the actual product
// appears here. DESIGNER OWNS the look. Data: the purchase's owner view + the verified product (lib/product.js).
import { esc, short, when, link, proofButtons } from '../lib/html.js';
import { xrp, journey, refusalOf } from '../lib/journey.js';

export function renderProductUnlock({ owner, purchase, product, unlocked, live }) {
  if (!owner && !purchase) return '';
  const v = purchase ?? owner, j = journey(v);
  if (j.refused) {
    const r = refusalOf(v);
    return `<section class="unlock unlock--refused" role="status"><p class="eyebrow">Your agent tried to buy this</p>
      <h2>Refused: ${esc(r?.category ?? 'not permitted')}</h2><p>${esc(r?.text ?? '')} No payment was made.</p>
      ${v.anchor?.explorerUrl ? `<p>${link(v.anchor.explorerUrl, 'Refusal receipt on the ledger ↗')}</p>` : ''}</section>`;
  }
  if (!unlocked) {
    const step = j.steps.filter((s) => s.status === 'done').pop();
    return `<section class="unlock unlock--pending" role="status" aria-live="polite"><p class="eyebrow">${live ? 'Live on XRPL Mainnet' : 'Purchase in progress'}</p>
      <h2>Your agent is buying this…</h2>
      <ol class="unlock__steps">${j.steps.map((s) => `<li class="is-${s.status}">${esc(s.title)}</li>`).join('')}</ol>
      <p class="note">${esc(step ? `${step.title}. ` : '')}The report unlocks as soon as Eterna independently verifies the payment.</p></section>`;
  }
  const o = owner, x = o.execution ?? {}, a = o.anchor ?? {}, au = o.authorization ?? {}, rep = o.deliveredResult?.report ?? {}, b = o.deliveredResult?.unlockedBundle ?? {};
  return `
  <section class="unlock unlock--done" role="status" aria-live="polite">
    <p class="unlock__badge">✓ Payment successful · Verified on XRPL Mainnet</p>
    <h2>${esc(o.service?.title ?? 'Your purchase')} is unlocked</h2>
    <p class="note">${esc(xrp(x.paidDrops))} paid by ${esc(o.requester?.label ?? 'the agent')} · settled in ledger ${esc(x.redeemLedger ?? b.settledLedger ?? '—')} · confirmed by ${esc((x.readers ?? []).length)} independent readers</p>
    <div class="actions unlock__actions">
      <button class="btn btn--primary" data-product="view" aria-expanded="false" aria-controls="product-view" ${product?.bytes ? '' : 'disabled'}>View report</button>
      <button class="btn btn--primary" data-product="download" ${product?.verified ? '' : 'disabled'}>Download report</button>
      ${a.explorerUrl ? `<a class="btn btn--ghost" href="${esc(a.explorerUrl)}" target="_blank" rel="noopener noreferrer">View blockchain receipt ↗</a>` : `<a class="btn btn--ghost" href="#/receipt">View receipt</a>`}
    </div>
    <div id="product-view" class="unlock__report" hidden>
      <h3>Validated XRPL ledger report</h3>
      <dl class="facts">
        <div><dt>Seller</dt><dd>${esc(o.deliveredResult?.seller?.label ?? '')} <span class="mono">${esc(short(o.deliveredResult?.seller?.account))}</span></dd></div>
        <div><dt>Seller ledger sequence at delivery</dt><dd class="mono">${esc(rep.sellerSeq)}</dd></div>
        <div><dt>Delivered</dt><dd>${esc(when(rep.servedAt))}</dd></div>
        <div><dt>Paid for this report</dt><dd>${esc(xrp(rep.paidDrops))}</dd></div>
        <div><dt>Settled in ledger</dt><dd class="mono">${esc(b.settledLedger)}</dd></div>
        <div><dt>Independent readers</dt><dd>${esc((b.readers ?? []).length)} · ${b.simulatedLedger === false ? 'real ledger' : 'unknown'}</dd></div>
      </dl>
      ${!product ? '<p class="unlock__fingerprint">Checking the fingerprint…</p>' : `<p class="unlock__fingerprint ${product.verified ? 'is-ok' : 'is-bad'}">${product.verified ? '✓ Fingerprint matches the product Eterna recorded' : '✕ Fingerprint does not match: do not trust this copy'} <span class="mono">${esc(short(product.digest, 10, 8))}</span></p>
      <pre class="unlock__json">${esc(JSON.stringify(JSON.parse(product.bytes), null, 2))}</pre>`}
    </div>
    <dl class="facts unlock__proof">
      <div><dt>Authorization verified</dt><dd>${au.explorerUrl ? link(au.explorerUrl, `Signed once · ${short(au.createTx)}`) : '✓'} · certificate <span class="mono">${esc(short(o.certificateDigest, 8, 6))}</span></dd></div>
      <div><dt>Transaction hash</dt><dd>${x.redeemExplorerUrl ? link(x.redeemExplorerUrl, x.redeemTx) : esc(x.redeemTx ?? '—')}</dd></div>
    </dl>
    ${proofButtons(x.redeemTx, x.redeemExplorerUrl ?? o.network)}
  </section>`;
}
