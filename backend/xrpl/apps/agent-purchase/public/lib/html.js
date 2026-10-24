// Tiny templating helpers. Every value from the backend goes through esc() before it reaches the page.
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (s, a = 8, b = 6) => { const t = String(s ?? ''); return t.length > a + b + 1 ? `${t.slice(0, a)}…${t.slice(-b)}` : t; };
// Times are shown in UTC so they match the ledger and the evidence files, whoever is looking.
export const when = (iso) => (iso ? `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC` : '—');
export const link = (href, text) => (href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));

// Proof buttons for any XRPL transaction: Bithomp plus the XRPL Foundation explorer, on the transaction's own network.
// The network comes from the evidence (its explorer URL or label), never from a guess about the page. Opens only; never pays.
const EXPLORERS = {
  mainnet: { bithomp: 'https://bithomp.com/explorer/', xrpl: 'https://livenet.xrpl.org/transactions/', label: 'XRPL Mainnet' },
  testnet: { bithomp: 'https://test.bithomp.com/explorer/', xrpl: 'https://testnet.xrpl.org/transactions/', label: 'XRPL Testnet' },
  devnet: { bithomp: 'https://dev.bithomp.com/explorer/', xrpl: 'https://devnet.xrpl.org/transactions/', label: 'XRPL Devnet' },
};
export const networkOf = (hint) => (/devnet/i.test(hint ?? '') ? 'devnet' : /testnet|altnet/i.test(hint ?? '') ? 'testnet' : /mainnet|livenet/i.test(hint ?? '') ? 'mainnet' : null);
export function proofButtons(hash, hint) {
  const net = networkOf(hint), e = EXPLORERS[net];
  if (!hash || !/^[0-9A-F]{64}$/i.test(hash) || !e) return '';
  const a = (href, text) => `<a class="btn btn--small btn--ghost proof-btn" href="${esc(href + hash)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
  return `<span class="proof-links" aria-label="Verify this ${esc(e.label)} transaction">${a(e.bithomp, `Verify on Bithomp ↗`)}${a(e.xrpl, `${e.label} explorer ↗`)}</span>`;
}
