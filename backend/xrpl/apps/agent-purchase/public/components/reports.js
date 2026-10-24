// Agent Intelligence & Reporting — what agents REQUESTED, what Eterna AUTHORIZED, what SETTLED, what Eterna VERIFIED.
// These are different events and are shown in separate columns. Rows are real records (recorded evidence) unless the
// row says FIXTURE. The CSV export contains exactly the rows on screen. DESIGNER OWNS the look.
import { esc, short, when } from '../lib/html.js';
import { journey, xrp, refusalOf } from '../lib/journey.js';

export function reportRows(states) {
  return states.filter((s) => s.purchase?.purchaseId).map((s) => {
    const p = s.purchase, j = journey(p), st = Object.fromEntries(j.steps.map((x) => [x.id, x.status]));
    return {
      source: s.badge, purchaseId: p.purchaseId, agent: p.requester?.label ?? '', agentVerified: p.requester?.verified ?? '',
      merchant: p.seller?.label ?? '', product: p.service?.title ?? '', network: p.network ?? '', amountXrp: p.price?.drops ? Number(p.price.drops) / 1e6 : '',
      requested: st.REQUESTED === 'done', authorized: st.AUTHORIZED === 'done', settled: st.SETTLED === 'done', verified: st.VERIFIED === 'done', unlocked: st.UNLOCKED === 'done',
      refusal: refusalOf(p)?.code ?? '', settlementTx: p.execution?.redeemTx ?? '', receiptAnchorTx: p.anchor?.txHash ?? '', receiptDigest: p.receiptDigest ?? '', updatedAt: p.updatedAt ?? '',
    };
  });
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

export function renderReports({ states }) {
  const rows = reportRows(states);
  const count = (k) => rows.filter((r) => r[k] === true).length;
  const spent = rows.filter((r) => r.verified).reduce((a, r) => a + (Number(r.amountXrp) || 0), 0);
  const yn = (b) => (b ? '<span class="yes">✓</span>' : '<span class="no">—</span>');
  return `
  <section class="reports" aria-labelledby="rep-h">
    <header><p class="eyebrow">Agent intelligence & reporting</p><h1 id="rep-h">What agents asked for, were allowed, paid and proved.</h1></header>
    <div class="kpis">
      <div class="kpi"><p>Requested</p><strong>${rows.length}</strong></div>
      <div class="kpi"><p>Authorized</p><strong>${count('authorized')}</strong></div>
      <div class="kpi"><p>Refused</p><strong>${rows.filter((r) => r.refusal).length}</strong></div>
      <div class="kpi"><p>Settled</p><strong>${count('settled')}</strong></div>
      <div class="kpi"><p>Verified</p><strong>${count('verified')}</strong></div>
      <div class="kpi"><p>Verified spend</p><strong>${esc(xrp(spent * 1e6))}</strong></div>
    </div>
    <div class="table-wrap"><table class="ledger">
      <thead><tr><th>Purchase</th><th>Agent</th><th>Merchant</th><th>Amount</th><th>Requested</th><th>Authorized</th><th>Settled</th><th>Verified</th><th>Outcome</th><th>Source</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="mono">${esc(short(r.purchaseId, 9, 4))}</td><td>${esc(r.agent)}</td><td>${esc(r.merchant)}</td><td>${esc(r.amountXrp === '' ? '—' : `${r.amountXrp} XRP`)}</td>
        <td>${yn(r.requested)}</td><td>${yn(r.authorized)}</td><td>${yn(r.settled)}</td><td>${yn(r.verified)}</td>
        <td>${r.refusal ? `<span class="badge badge--bad">${esc(r.refusal)}</span>` : r.unlocked ? '<span class="badge badge--ok">Delivered</span>' : '<span class="badge badge--warn">Open</span>'}</td>
        <td class="small">${esc(r.source)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="actions"><button class="btn btn--primary" data-export="csv">Export audit CSV</button></div>
    <p class="note">Each row links an agent, an authority decision, a settlement and a verification. Sources are labelled: RECORDED rows are real Eterna records; FIXTURE rows are illustrative. Cost intelligence (duplicates, unused subscriptions, unusual spend) is <strong>proposed</strong>, not built.</p>
  </section>`;
}
