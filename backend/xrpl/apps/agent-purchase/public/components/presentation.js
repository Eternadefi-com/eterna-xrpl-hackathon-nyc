// Presentation mode — Rose's story for judges and sponsors. One idea per slide; every slide carries its SOURCE:
//   PERSONA  = fictional character / story (Rose is not a real person)
//   PLANNED  = the Sunday Mainnet allowance terms (not active until the owner approves)
//   RECORDED = real Eterna evidence (Mainnet 2026-10-22 purchases, Devnet refusals)
// DESIGNER OWNS the look and slide order. Content facts come from data — never type numbers in by hand.
import { esc, short, link } from '../lib/html.js';
import { xrp } from '../lib/journey.js';

export function slides({ persona, auth, purchase, owner, refusal, purchases = 0 }) {
  const r = owner?.receipt ?? {}, p = persona?.persona ?? {}, plan = persona?.plannedAuthority ?? {};
  const saved = purchases > 1 ? Math.round(((purchases - 1) / purchases) * 100) : null;
  return [
    { source: 'PERSONA', kicker: 'Meet Rose', title: `${p.name ?? 'Rose'}, ${p.role ?? 'CFO'}`,
      body: `${p.company ?? ''}. Her teams’ AI agents buy ${String(p.buys ?? 'software and cloud services').toLowerCase()}.` },
    { source: 'PERSONA', kicker: '9:00 AM', title: 'Approve everything, or trust blindly?',
      body: 'Every agent purchase either waits for Rose or runs on permissions she can’t check.' },
    { source: 'PERSONA', kicker: 'Her question', title: p.question ?? 'How do I let agents spend without losing control?', body: '' },
    { source: 'PLANNED', kicker: 'Rose signs once', title: `Up to ${plan.totalXrp ?? '—'} XRP · max ${plan.perPurchaseXrp ?? '—'} XRP per purchase`,
      body: `${plan.merchants ?? ''}, until ${String(plan.expiry ?? '').toLowerCase()}. One signature with her own wallet. Eterna never holds her keys.` },
    { source: 'RECORDED', kicker: 'Already proven on Mainnet', title: `1 signature · ${purchases} autonomous purchases`,
      body: `${saved != null ? `${saved}% of approvals eliminated. ` : ''}Limits: ${xrp(auth?.perPurchaseDrops)} per purchase, ${xrp(auth?.maxTotalDrops)} total.`,
      evidence: auth?.channelCreateUrl ? link(auth.channelCreateUrl, 'The signed authority on the ledger ↗') : '' },
    { source: 'RECORDED', kicker: 'The agent buys', title: `${purchase?.requester?.label ?? 'The agent'} → ${purchase?.service?.title ?? ''}`,
      body: 'No new approval from Rose. Eterna checked identity, merchant, amount, expiry and remaining budget automatically.' },
    { source: 'RECORDED', kicker: 'Settled ≠ unlocked', title: `${xrp(r.payment?.paidDrops)} settled in ledger ${r.payment?.ledger ?? '—'}`,
      body: `Delivered only after ${(r.payment?.readers ?? []).length || 2} independent ledger readers confirmed it.`,
      evidence: purchase?.execution?.redeemExplorerUrl ? link(purchase.execution.redeemExplorerUrl, 'Payment on the ledger ↗') : '' },
    { source: 'RECORDED', kicker: 'Over the limit · Devnet evidence', title: refusal?.category ?? 'Refused',
      body: `${refusal?.text ?? ''} Refused before any payment, with its own receipt. She prohibited it, so it can’t happen.` },
    { source: 'RECORDED', kicker: 'Rose’s proof', title: 'Hash · decision · receipt · remaining budget',
      body: `Receipt ${short(r.intent?.digest ?? purchase?.receiptDigest ?? '', 8, 6)} anchored on the ledger. Remaining budget: ${xrp(auth?.remainingDrops)}.`,
      evidence: purchase?.anchor?.explorerUrl ? link(purchase.anchor.explorerUrl, 'Receipt anchored ↗') : '' },
    { source: 'PERSONA', kicker: 'Who controls what', title: 'Rose holds the money. Eterna holds the rules. The ledger holds the proof.',
      body: 'Her wallet signs and funds the cap. Eterna decides each request against her certificate. Two independent readers verify settlement.' },
    { source: 'PERSONA', kicker: 'Eterna.AI · The control layer for agentic commerce', title: 'Her agents can spend. They can’t exceed her authority.',
      body: 'Authorize once. Operate within limits. Verify every transaction. Own Your Agent.' },
  ];
}

const SOURCE_TEXT = { PERSONA: 'PERSONA · fictional story', PLANNED: 'PLANNED · activates only on owner approval', RECORDED: 'RECORDED · real Eterna evidence' };

export function renderPresentation({ deck, i }) {
  const s = deck[i];
  return `
  <section class="present" aria-roledescription="slide" aria-label="${i + 1} of ${deck.length}">
    <p class="present__source" data-source="${esc(s.source)}">${esc(SOURCE_TEXT[s.source] ?? s.source)}</p>
    <p class="present__kicker">${esc(s.kicker)}</p>
    <h1 class="present__title">${esc(s.title)}</h1>
    ${s.body ? `<p class="present__body">${esc(s.body)}</p>` : ''}
    ${s.evidence ? `<p class="present__evidence">${s.evidence}</p>` : ''}
    <nav class="present__nav">
      <button class="btn btn--ghost" data-slide="-1" ${i === 0 ? 'disabled' : ''}>← Back</button>
      <span>${i + 1} / ${deck.length}</span>
      <button class="btn btn--primary" data-slide="1" ${i === deck.length - 1 ? 'disabled' : ''}>Next →</button>
    </nav>
  </section>`;
}
