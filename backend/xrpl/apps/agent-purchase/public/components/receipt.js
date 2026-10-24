// Receipt — a verifiable record of one governed purchase: who asked, under which signed authority, what was paid,
// how it was verified, what was delivered, and where it is anchored. Every field is the backend's (owner view `receipt`
// + `anchor`); every hash links to the public ledger. DESIGNER OWNS the look — keep every field verifiable.
import { esc, short, when, link, proofButtons } from '../lib/html.js';
import { xrp } from '../lib/journey.js';

const tx = (network, hash) => (hash ? `https://${/devnet/i.test(network ?? '') ? 'devnet.xrpl.org' : 'livenet.xrpl.org'}/transactions/${hash}` : null);

export function renderReceipt({ owner }) {
  const r = owner?.receipt;
  if (!r) return '<section class="card"><h2>No receipt</h2><p class="note">Receipts exist for completed purchases. Pick an approved purchase.</p></section>';
  const net = owner.network, a = owner.anchor ?? {};
  return `
  <article class="receipt" aria-labelledby="rc-h">
    <header class="receipt__head">
      <p class="eyebrow">Eterna receipt · ${esc(net)}</p>
      <h1 id="rc-h">${esc(owner.service?.title ?? 'Purchase')}</h1>
      <p class="receipt__amount">${esc(xrp(r.payment?.paidDrops))}</p>
      <p class="badge badge--ok">Verified and delivered</p>
    </header>
    <ol class="receipt__chain">
      <li><h3>Authority</h3><p>Signed once by the owner <span class="mono">${esc(short(r.authorization?.signedBy))}</span></p>
        <p>${link(tx(net, r.authorization?.createTx), `Authority on the ledger · ${short(r.authorization?.createTx)}`)}</p></li>
      <li><h3>Request</h3><p>${esc(r.requester?.label)} ${r.requester?.verified ? '· verified credential' : '· unverified'}</p>
        <p class="mono">Intent ${esc(short(r.intent?.digest, 10, 6))}</p></li>
      <li><h3>Decision</h3><p>Covered by the signed authority: no new signature. ${esc(when(r.confirmation?.at))}</p></li>
      <li><h3>Payment</h3><p>${esc(xrp(r.payment?.paidDrops))} to ${esc(r.seller?.label)} <span class="mono">${esc(short(r.seller?.destination))}</span></p>
        <p>${link(tx(net, r.payment?.redeemTx), `Settled in ledger ${r.payment?.ledger} · ${short(r.payment?.redeemTx)}`)}</p>${proofButtons(r.payment?.redeemTx, tx(net, r.payment?.redeemTx))}</li>
      <li><h3>Verification</h3><p>Confirmed independently by ${esc((r.payment?.readers ?? []).length)} ledger readers · ${esc(when(r.verifiedAt))}</p></li>
      <li><h3>Delivery</h3><p>${esc(r.delivery?.status)} · ${esc(when(r.delivery?.servedAt))}</p><p class="mono">Digest ${esc(short(r.delivery?.digest, 10, 6))}</p></li>
      <li><h3>Anchored</h3><p>${a.txHash ? link(a.explorerUrl ?? tx(net, a.txHash), `Receipt fingerprint on the ledger · ${short(a.txHash)}`) : 'Not anchored yet'}</p>
        ${a.memoDigest ? `<p class="mono">Receipt ${esc(short(a.memoDigest, 10, 6))}</p>` : ''}</li>
    </ol>
    <p class="note">Anyone can check this receipt: every line links to a public XRP Ledger transaction.</p>
  </article>`;
}
