// ONE governance engine for every payment rail. It generalises unified/governance.mjs (whose canonical digest and
// signDigest / verifyDigestApproval it reuses) from one XRP voucher mission to any rail and asset:
//   identify -> validate certificate -> authorize(request) PERMIT|REFUSE -> route to adapter.prepare ->
//   advance through explicit states -> unlock(decision, evidence) only on the rail's proof conditions -> receipt.
// Budgets are per asset in integer base units (XRP drops; RLUSD micro-units via lib/ny-asset-schemas-v2.mjs), reserved
// at PERMIT, committed at VERIFIED, released on FAILED before anything was submitted. A signed voucher is never
// settlement: SETTLED needs a ledger tx reference, and UNLOCKED needs adapter evidence that meets the proof conditions.
// Offline: no network code. Adapters do the reading.
import { createRequire } from 'node:module';
import { digestOf, fail } from '../unified/common.mjs';
import { signDigest, verifyDigestApproval } from '../unified/governance.mjs';
import { assetIdentity } from '../lib/xrpl-asset-identity.mjs';
import { nyAmountUnits, nyUnitsDecimal } from '../lib/ny-asset-schemas-v2.mjs';
import { assertAdapter, unmetProof } from './contract.mjs';

const require = createRequire(import.meta.url);
const { isValidClassicAddress } = require('ripple-address-codec');

export const STATES = Object.freeze({ AUTHORIZED: 'AUTHORIZED', VOUCHER_VERIFIED: 'VOUCHER_VERIFIED', SUBMITTED: 'SUBMITTED', REDEEMED: 'REDEEMED',
  SETTLED: 'SETTLED', VERIFIED: 'VERIFIED', UNLOCKED: 'UNLOCKED', REFUSED: 'REFUSED', FAILED: 'FAILED' });
const S = STATES;
const NEXT = { AUTHORIZED: [S.VOUCHER_VERIFIED, S.SUBMITTED], VOUCHER_VERIFIED: [S.REDEEMED], REDEEMED: [S.SETTLED], SUBMITTED: [S.SETTLED],
  SETTLED: [S.VERIFIED], VERIFIED: [S.UNLOCKED], UNLOCKED: [], REFUSED: [], FAILED: [] };
const NEEDS_TX = new Set([S.SUBMITTED, S.SETTLED]);
export const REFUSALS = Object.freeze(['CERT_INVALID', 'EXPIRED', 'WRONG_REQUESTER', 'WRONG_PAYER', 'REPLAYED_REQUEST', 'REPLAYED_VOUCHER_NONCE',
  'RAIL_NOT_ALLOWED', 'RAIL_UNAVAILABLE', 'NETWORK_MISMATCH', 'ASSET_NOT_ALLOWED', 'SELLER_NOT_APPROVED', 'AMOUNT_INVALID',
  'PER_TX_EXCEEDED', 'TOTAL_EXCEEDED', 'COUNT_EXHAUSTED', 'MERCHANT_NOT_APPROVED', 'QUOTE_EXPIRED', 'QUOTE_MISMATCH', 'WRONG_AGENT_WALLET']);

// ---- RLUSD on XRPL EVM Testnet (the Mastercard AP4M hackathon kit, ap4m/) ----------------------------------------------
// An ERC-20 with 18 decimals at a fixed token contract on eip155:1449000. It is a different asset from XRPL RLUSD
// (issuer + currency), so it has its own asset id and its own budget. Amounts are exact decimal strings (<= 18 places).
export const EVM_RLUSD = Object.freeze({ asset: 'RLUSD-EVM', network: 'eip155:1449000', decimals: 18 });
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
export function evmUnits(v, decimals = EVM_RLUSD.decimals) {
  const m = /^(0|[1-9]\d{0,20})(?:\.(\d{1,18}))?$/.exec(typeof v === 'string' ? v : '');
  if (!m || (m[2] ?? '').length > decimals) throw fail('AMOUNT_INVALID', `amount ${v} must be a decimal string with at most ${decimals} places`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}
export function evmDecimal(units, decimals = EVM_RLUSD.decimals) {
  const u = BigInt(units), base = 10n ** BigInt(decimals), frac = (u % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${u / base}${frac ? `.${frac}` : ''}`;
}

// ---- certificate -----------------------------------------------------------------------------------------------------
export const CERT_TYPE = 'eterna.mission-certificate.v2';
const iso = (t) => typeof t === 'string' && !Number.isNaN(Date.parse(t));
const DROPS = /^[1-9]\d{0,16}$/;
/** Per-asset limits in base units, with RLUSD bound to issuer + currency on every certificate network that has it. */
function limitUnits(cert) {
  const out = {};
  for (const [asset, l] of Object.entries(cert.limits ?? {})) {
    if (asset === 'XRP') { if (!DROPS.test(l.perTx ?? '') || !DROPS.test(l.total ?? '')) throw fail('CERT_INVALID', 'XRP limits are drops strings'); out.XRP = { perTx: BigInt(l.perTx), total: BigInt(l.total) }; continue; }
    if (asset === EVM_RLUSD.asset) {
      if (!cert.networks.includes(EVM_RLUSD.network)) throw fail('CERT_INVALID', `${asset} needs network ${EVM_RLUSD.network}`);
      if (!EVM_ADDR.test(l.token ?? '')) throw fail('CERT_INVALID', `${asset} limits need the token contract address`);
      let perTx, total; try { perTx = evmUnits(l.perTx); total = evmUnits(l.total); } catch { throw fail('CERT_INVALID', `${asset} limits are exact decimal strings`); }
      if (perTx <= 0n) throw fail('CERT_INVALID', `${asset} perTx must be positive`);
      out[asset] = { perTx, total, networks: [EVM_RLUSD.network], token: l.token.toLowerCase() }; continue;
    }
    if (asset !== 'RLUSD') throw fail('CERT_INVALID', `unsupported asset ${asset}`);
    const nets = cert.networks.filter((n) => n === 'xrpl:0' || n === 'xrpl:1');
    if (!nets.length) throw fail('CERT_INVALID', 'RLUSD needs a network that has RLUSD (xrpl:0 or xrpl:1)');
    const ids = nets.map((network) => { try { return assetIdentity({ network, asset: 'RLUSD', issuer: l.issuer, currency: l.currency }); } catch { return null; } }).filter(Boolean);
    if (!ids.length) throw fail('CERT_INVALID', 'RLUSD issuer/currency do not match any certificate network');
    const id = ids[0];
    out.RLUSD = { perTx: BigInt(nyAmountUnits(id, l.perTx)), total: BigInt(nyAmountUnits(id, l.total)), networks: ids.map((i) => i.network) };
  }
  for (const v of Object.values(out)) if (v.perTx > v.total) throw fail('CERT_INVALID', 'perTx above total');
  return out;
}
/** Rose's mission certificate (v2). Amount fields: XRP drops strings; RLUSD exact decimal strings (<= 6 decimals). */
// Optional merchant extension (WHAT IF? product): `merchants[]` (approved merchant accounts for merchant purchases),
// `usdReference { perTx, total }` (exact USD decimals, a reference cap checked against the quote's usdPrice) and
// `quotePolicy { required, network, maxAgeSeconds }` (a merchant purchase must carry an unexpired, untampered quote whose
// xrpDrops equal the request amount). Certificates without these fields behave exactly as before.
// Optional `evmAgent` (0x address): the only EVM wallet that may sign for this certificate on an eip155 network (AP4M kit).
export function buildMissionCertificate({ missionId, task, requester, payer, sellers, rails, networks, limits, maxTransactions, issuedAt, expiry, merchants, usdReference, quotePolicy, evmAgent }) {
  const cert = { type: CERT_TYPE, missionId, issuer: 'Eterna', task, requester, payer, sellers, rails, networks, limits, maxTransactions, issuedAt, expiry, merchants, usdReference, quotePolicy, evmAgent };
  for (const k of ['merchants', 'usdReference', 'quotePolicy', 'evmAgent']) if (cert[k] === undefined) delete cert[k];
  assertCertificateShape(cert);
  return cert;
}
export function assertCertificateShape(c) {
  const bad = (w) => { throw fail('CERT_INVALID', w); };
  if (c?.type !== CERT_TYPE) bad('type');
  if (typeof c.task !== 'string' || !c.task) bad('task');
  if (typeof c.requester?.id !== 'string' || !c.requester.id) bad('requester.id');
  if (!isValidClassicAddress(c.payer?.xrpl ?? '')) bad('payer.xrpl');
  if (!Array.isArray(c.sellers) || !c.sellers.length || !c.sellers.every((s) => typeof s === 'string' && s)) bad('sellers[]');
  if (!Array.isArray(c.rails) || !c.rails.length) bad('rails[]');
  if (!Array.isArray(c.networks) || !c.networks.length || !c.networks.every((n) => /^xrpl:[0-2]$/.test(n) || n === EVM_RLUSD.network)) bad('networks[]');
  if (c.evmAgent !== undefined && !EVM_ADDR.test(c.evmAgent)) bad('evmAgent');
  if (!Number.isSafeInteger(c.maxTransactions) || c.maxTransactions < 1) bad('maxTransactions');
  if (!iso(c.issuedAt) || !iso(c.expiry) || Date.parse(c.expiry) <= Date.parse(c.issuedAt)) bad('issuedAt/expiry');
  limitUnits(c);
  if (c.merchants !== undefined && (!Array.isArray(c.merchants) || !c.merchants.length || !c.merchants.every((m) => isValidClassicAddress(m)))) bad('merchants[]');
  if (c.usdReference !== undefined) { try { if (usdUnits(c.usdReference.perTx) > usdUnits(c.usdReference.total)) bad('usdReference perTx above total'); } catch { bad('usdReference'); } }
  if (c.quotePolicy !== undefined && (typeof c.quotePolicy.required !== 'boolean' || !/^xrpl:[0-2]$/.test(c.quotePolicy.network ?? '') || !Number.isSafeInteger(c.quotePolicy.maxAgeSeconds))) bad('quotePolicy');
  return c;
}
/** Exact USD reference amount (decimal string, <= 6 places) -> integer micro-USD. No floats. */
export function usdUnits(v) {
  const m = /^(0|[1-9]\d{0,12})(?:\.(\d{1,6}))?$/.exec(typeof v === 'string' ? v : '');
  if (!m) throw fail('AMOUNT_INVALID', `usd amount ${v} must be a decimal string with at most 6 places`);
  return BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}
const usdString = (u) => { const s = u.toString().padStart(7, '0'); return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, '') || '0'; };
/** A quote's id is sha256 over its canonical JSON without quoteId (whatif/quote.mjs builds them). */
export const quoteIdOf = (quote) => { const { quoteId: _, ...body } = quote ?? {}; return digestOf(body); };
/** Quote check for merchant purchases. Returns null (ok) or { code, reason }. */
export function checkQuote(policy, q, nowMs) {
  const t = q.quote;
  if (!t || typeof t !== 'object') return { code: 'QUOTE_MISMATCH', reason: 'a price quote is required' };
  if (t.quoteId !== quoteIdOf(t) || (q.quoteId !== undefined && q.quoteId !== t.quoteId)) return { code: 'QUOTE_MISMATCH', reason: 'quoteId does not match the quote contents' };
  if (t.source?.network !== ({ 'xrpl:0': 'XRPL Mainnet', 'xrpl:1': 'XRPL Testnet', 'xrpl:2': 'XRPL Devnet' })[policy.network]) return { code: 'QUOTE_MISMATCH', reason: `quote source ${t.source?.network} is not the certificate's quote network` };
  const at = Date.parse(t.quotedAt), exp = Date.parse(t.expiresAt);
  if (!(exp > at) || exp - at > policy.maxAgeSeconds * 1000) return { code: 'QUOTE_MISMATCH', reason: 'quote validity window exceeds the certificate policy' };
  if (nowMs >= exp) return { code: 'QUOTE_EXPIRED', reason: `quote expired at ${t.expiresAt}` };
  if (q.amount !== t.xrpDrops) return { code: 'QUOTE_MISMATCH', reason: `amount ${q.amount} != quoted ${t.xrpDrops} drops` };
  if (q.usdPrice !== t.usdPrice) return { code: 'QUOTE_MISMATCH', reason: `usdPrice ${q.usdPrice} != quoted ${t.usdPrice}` };
  return null;
}
export const certificateDigest = (cert) => digestOf(cert);
/** Rose (the payer) signs the certificate digest. Local key only; tests use fixed fake keys. */
export const approveCertificate = (cert, payerKey) => signDigest(certificateDigest(cert), payerKey, cert.payer.xrpl);
export const verifyCertificate = (cert, approval) => { try { assertCertificateShape(cert); return verifyDigestApproval(certificateDigest(cert), approval, cert.payer.xrpl); } catch { return false; } };

// ---- amounts -----------------------------------------------------------------------------------------------------------
/** Request amount -> base units. XRP: drops string. RLUSD: exact decimal string, identity-bound to the request network. */
export function amountUnits({ asset, amount, network, issuer, currency }) {
  if (asset === 'XRP') { if (!DROPS.test(amount ?? '')) throw fail('AMOUNT_INVALID', 'XRP amount is a drops string'); return BigInt(amount); }
  if (asset === 'RLUSD') return BigInt(nyAmountUnits(assetIdentity({ network, asset, issuer, currency }), amount));
  if (asset === EVM_RLUSD.asset) { if (network !== undefined && network !== EVM_RLUSD.network) throw fail('ASSET_NOT_ALLOWED', `${asset} on ${network}`); const u = evmUnits(amount); if (u <= 0n) throw fail('AMOUNT_INVALID', 'amount must be positive'); return u; }
  throw fail('ASSET_NOT_ALLOWED', asset);
}
export const unitsToAmount = (asset, units) => {
  const u = BigInt(units);
  if (asset === 'XRP' || u <= 0n) return u.toString();
  if (asset === EVM_RLUSD.asset) return evmDecimal(u);
  return nyUnitsDecimal(u.toString()); // 6-decimal base units (lib/ny-asset-schemas-v2.mjs)
};

// ---- the engine ----------------------------------------------------------------------------------------------------------
export function createGovernance({ certificate, approval, adapters = [], now = () => Date.now() }) {
  const at = () => new Date(now()).toISOString();
  const registry = new Map(adapters.map((a) => [assertAdapter(a).rail, a]));
  const certOk = verifyCertificate(certificate, approval);
  const cd = certOk ? certificateDigest(certificate) : null;
  const limits = certOk ? limitUnits(certificate) : {};
  const budgets = Object.fromEntries(Object.keys(limits).map((k) => [k, { reserved: 0n, committed: 0n }]));
  const count = { reserved: 0, committed: 0 };
  const usdCap = certOk && certificate.usdReference ? { perTx: usdUnits(certificate.usdReference.perTx), total: usdUnits(certificate.usdReference.total) } : null;
  const usdBudget = { reserved: 0n, committed: 0n };
  const decisions = new Map(), refusals = [], seenRequests = new Set(), seenNonces = new Set();

  const identify = ({ requester, payer }) => ({ requester: requester === certificate.requester?.id, payer: payer === certificate.payer?.xrpl });
  const validate = () => (certOk ? { ok: true, certificateDigest: cd } : { ok: false, code: 'CERT_INVALID' });

  function refuse(request, code, reason) {
    const r = { kind: 'refusal', state: S.REFUSED, code, reason, requestId: request?.requestId ?? null, requestDigest: request ? digestOf(stripUndef(request)) : null, certificateDigest: cd, at: at(), signed: false };
    refusals.push(r);
    return { outcome: 'REFUSE', code, refusal: r };
  }

  /** PERMIT (with a decision record and a budget reservation) or REFUSE (with a code and a refusal record). */
  function authorize(input) {
    const q = input ?? {};
    if (!certOk) return refuse(q, 'CERT_INVALID', 'certificate digest or payer approval does not verify');
    const replay = typeof q.requestId === 'string' && seenRequests.has(q.requestId);
    if (typeof q.requestId === 'string') seenRequests.add(q.requestId);
    if (typeof q.requestId !== 'string' || !q.requestId) return refuse(q, 'AMOUNT_INVALID', 'requestId required');
    if (replay) return refuse(q, 'REPLAYED_REQUEST', `requestId ${q.requestId} already used`);
    const nonceKey = q.voucher ? `${q.rail}|${q.seller}|${q.voucher.sessionId}|${q.voucher.nonce}` : null;
    if (nonceKey && seenNonces.has(nonceKey)) return refuse(q, 'REPLAYED_VOUCHER_NONCE', `voucher nonce ${q.voucher.nonce} reused in session`);
    if (now() >= Date.parse(certificate.expiry)) return refuse(q, 'EXPIRED', 'mission certificate expired');
    if (q.requester !== certificate.requester.id) return refuse(q, 'WRONG_REQUESTER', 'requester is not the certified agent');
    if (q.payer !== certificate.payer.xrpl) return refuse(q, 'WRONG_PAYER', 'payer is not the certificate principal');
    if (typeof q.network === 'string' && q.network.startsWith('eip155:') && (!certificate.evmAgent || String(q.agent ?? '').toLowerCase() !== certificate.evmAgent.toLowerCase()))
      return refuse(q, 'WRONG_AGENT_WALLET', 'the EVM agent wallet is not the one this certificate names');
    if (!certificate.rails.includes(q.rail)) return refuse(q, 'RAIL_NOT_ALLOWED', `rail ${q.rail} not allowed by the certificate`);
    const adapter = registry.get(q.rail);
    if (!adapter) return refuse(q, 'RAIL_UNAVAILABLE', `no adapter registered for ${q.rail}`);
    if (!certificate.networks.includes(q.network) || !adapter.networks.includes(q.network)) return refuse(q, 'NETWORK_MISMATCH', `network ${q.network} not allowed for ${q.rail}`);
    if (!limits[q.asset] || !adapter.assets.includes(q.asset) || (q.asset === 'RLUSD' && !limits.RLUSD.networks.includes(q.network))) return refuse(q, 'ASSET_NOT_ALLOWED', `asset ${q.asset} not allowed on ${q.rail}/${q.network}`);
    if (q.merchant === true) { if (!(certificate.merchants ?? []).includes(q.seller)) return refuse(q, 'MERCHANT_NOT_APPROVED', `merchant ${q.seller} not approved by the certificate`); }
    else if (!certificate.sellers.includes(q.seller)) return refuse(q, 'SELLER_NOT_APPROVED', `seller ${q.seller} not approved`);
    if (certificate.quotePolicy?.required && q.merchant === true) { const bad = checkQuote(certificate.quotePolicy, q, now()); if (bad) return refuse(q, bad.code, bad.reason); }
    let usd = null;
    if (usdCap && q.merchant === true) {
      try { usd = usdUnits(q.usdPrice); } catch (e) { return refuse(q, 'AMOUNT_INVALID', e.message); }
      if (usd > usdCap.perTx) return refuse(q, 'PER_TX_EXCEEDED', `USD reference ${q.usdPrice} > per-tx ${certificate.usdReference.perTx}`);
    }
    let units;
    try { units = amountUnits(q.asset === 'RLUSD' ? { ...q, issuer: certificate.limits.RLUSD.issuer, currency: certificate.limits.RLUSD.currency } : q); }
    catch (e) { return refuse(q, e.code === 'ASSET_NOT_ALLOWED' ? 'ASSET_NOT_ALLOWED' : 'AMOUNT_INVALID', e.message); }
    const L = limits[q.asset], B = budgets[q.asset];
    if (units > L.perTx) return refuse(q, 'PER_TX_EXCEEDED', `${unitsToAmount(q.asset, units)} > per-tx ${unitsToAmount(q.asset, L.perTx)}`);
    if (count.reserved + count.committed >= certificate.maxTransactions) return refuse(q, 'COUNT_EXHAUSTED', `maxTransactions ${certificate.maxTransactions} reached`);
    if (B.reserved + B.committed + units > L.total) return refuse(q, 'TOTAL_EXCEEDED', `total would exceed ${unitsToAmount(q.asset, L.total)}`);
    if (usd !== null && usdBudget.reserved + usdBudget.committed + usd > usdCap.total) return refuse(q, 'TOTAL_EXCEEDED', `USD reference total would exceed ${certificate.usdReference.total}`);
    if (usd !== null) usdBudget.reserved += usd;
    // PERMIT: reserve budget and the voucher nonce
    B.reserved += units; count.reserved++;
    if (nonceKey) seenNonces.add(nonceKey);
    const request = stripUndef(q);
    const d = { kind: 'decision', decisionId: `dec_${digestOf({ cd, request }).slice(0, 24)}`, certificateDigest: cd, request, rail: q.rail, adapter: adapter.id,
      units: units.toString(), ...(usd !== null ? { usdUnits: usd.toString() } : {}), state: S.AUTHORIZED, history: [{ state: S.AUTHORIZED, at: at() }], budget: 'RESERVED', evidence: null, unlock: null };
    d.decisionDigest = digestOf({ decisionId: d.decisionId, certificateDigest: cd, request, units: d.units });
    decisions.set(d.decisionId, d);
    return { outcome: 'PERMIT', decision: d };
  }
  const get = (id) => decisions.get(typeof id === 'string' ? id : id?.decisionId) ?? (() => { throw fail('UNKNOWN_DECISION', String(id)); })();
  const lifecycle = (d) => registry.get(d.rail).describe().lifecycle;

  /** Route an AUTHORIZED decision to its adapter. Returns the UNSIGNED draft (signers live outside adapters). */
  function route(id, ctx = {}) {
    const d = get(id);
    if (d.state !== S.AUTHORIZED) throw fail('NOT_AUTHORIZED', d.state);
    return registry.get(d.rail).prepare(d, ctx);
  }
  /** Move a decision forward. SUBMITTED and SETTLED need a ledger tx reference; a voucher alone never settles. */
  function advance(id, to, ref = {}) {
    const d = get(id);
    if (!NEXT[d.state]?.includes(to) || !lifecycle(d).includes(to)) throw fail('BAD_TRANSITION', `${d.rail}: ${d.state} -> ${to}`);
    if (to === S.VERIFIED || to === S.UNLOCKED) throw fail('BAD_TRANSITION', `${to} is reached only through unlock()`);
    if (NEEDS_TX.has(to) && !/^[0-9A-F]{64}$/.test(ref.txHash ?? '')) throw fail('LEDGER_REF_REQUIRED', `${to} needs a ledger transaction hash`);
    if (to === S.SETTLED && d.txHash && ref.txHash !== d.txHash) throw fail('LEDGER_REF_MISMATCH', 'settled tx differs from submitted tx');
    if (ref.txHash) d.txHash = ref.txHash;
    d.state = to; d.history.push({ state: to, at: at(), ...(ref.txHash ? { txHash: ref.txHash } : {}), ...(ref.note ? { note: ref.note } : {}) });
    return d;
  }
  /** Mark FAILED. The reservation is released only if nothing reached the ledger; otherwise it is held as committed. */
  function failDecision(id, reason) {
    const d = get(id);
    if ([S.UNLOCKED, S.FAILED].includes(d.state)) throw fail('BAD_TRANSITION', `${d.state} -> FAILED`);
    const touched = d.history.some((h) => [S.SUBMITTED, S.REDEEMED, S.SETTLED].includes(h.state));
    settleBudget(d, touched ? 'COMMITTED_HELD' : 'RELEASED');
    d.state = S.FAILED; d.history.push({ state: S.FAILED, at: at(), reason });
    return d;
  }
  function settleBudget(d, how) {
    if (d.budget !== 'RESERVED') return;
    const B = budgets[d.request.asset], u = BigInt(d.units);
    B.reserved -= u; count.reserved--;
    if (how !== 'RELEASED') { B.committed += u; count.committed++; }
    if (d.usdUnits) { const x = BigInt(d.usdUnits); usdBudget.reserved -= x; if (how !== 'RELEASED') usdBudget.committed += x; }
    d.budget = how;
  }
  /** Unlock only if the adapter's evidence meets this rail's proof conditions AND binds to this decision. */
  function unlock(id, ev) {
    const d = get(id);
    const no = (code, unmet = []) => { const r = { unlocked: false, code, unmet, at: at() }; d.unlockAttempts = [...(d.unlockAttempts ?? []), r]; return r; };
    if (![S.SETTLED, S.VERIFIED].includes(d.state)) return no('UNLOCK_NOT_SETTLED', [`state ${d.state}`]);
    if (ev?.adapter !== d.adapter) return no('UNLOCK_WRONG_ADAPTER', [`evidence from ${ev?.adapter}`]);
    if (ev.status === 'FAILED') { failDecision(d, `evidence FAILED: ${JSON.stringify(ev.facts?.problems ?? [])}`); return no('UNLOCK_EVIDENCE_FAILED', ev.facts?.problems ?? []); }
    const unmet = unmetProof(registry.get(d.rail).describe().proofConditions, ev);
    const f = ev.facts ?? {}, q = d.request;
    if (f.network !== q.network) unmet.push(`network ${f.network} != ${q.network}`);
    if (f.destination !== q.seller) unmet.push(`destination ${f.destination} != ${q.seller}`);
    if (f.asset !== q.asset) unmet.push(`asset ${f.asset} != ${q.asset}`);
    if (f.payer !== q.payer) unmet.push(`payer ${f.payer} != ${q.payer} (evidence is for another principal)`);
    let u = null; try { u = amountUnits(q.asset === 'RLUSD' ? { asset: q.asset, amount: f.amount, network: q.network, issuer: certificate.limits.RLUSD.issuer, currency: certificate.limits.RLUSD.currency } : { asset: q.asset, amount: f.amount }); } catch {}
    if (u === null || u.toString() !== d.units) unmet.push(`amount ${f.amount} != authorized ${unitsToAmount(q.asset, BigInt(d.units))}`);
    if (d.txHash && ev.txHash !== d.txHash) unmet.push(`evidence tx ${ev.txHash} != settled tx ${d.txHash}`);
    if (unmet.length) return no('UNLOCK_PROOF_NOT_MET', unmet);
    d.evidence = ev; d.evidenceDigest = digestOf(stripUndef(ev));
    if (d.state === S.SETTLED) { d.state = S.VERIFIED; d.history.push({ state: S.VERIFIED, at: at(), evidenceDigest: d.evidenceDigest }); }
    settleBudget(d, 'COMMITTED');
    d.state = S.UNLOCKED; d.unlock = { unlocked: true, at: at(), evidenceDigest: d.evidenceDigest }; d.history.push({ state: S.UNLOCKED, at: d.unlock.at });
    return d.unlock;
  }
  /** Linked audit receipt: certificate, approval, decision (or refusal), state history, adapter evidence, unlock. */
  function receipt(id) {
    // a refusal record may be passed directly (a replayed requestId would otherwise resolve to the original decision)
    const ref = id?.kind === 'refusal' && refusals.includes(id) ? id : decisions.get(id) ?? refusals.find((r) => r.requestId === id) ?? get(id);
    const body = stripUndef({ type: 'eterna.commerce-receipt.v1', certificateDigest: cd, certificate, approval,
      ...(ref.kind === 'refusal' ? { refusal: ref } : { decision: { decisionId: ref.decisionId, decisionDigest: ref.decisionDigest, request: ref.request, units: ref.units, rail: ref.rail, adapter: ref.adapter },
        history: ref.history, state: ref.state, budget: ref.budget, txHash: ref.txHash ?? null, evidence: ref.evidence, evidenceDigest: ref.evidenceDigest ?? null, unlock: ref.unlock, unlockAttempts: ref.unlockAttempts ?? [] }) });
    return { body, digest: digestOf(body) };
  }
  const budget = () => Object.fromEntries(Object.entries(budgets).map(([k, b]) => [k, { reserved: unitsToAmount(k, b.reserved), committed: unitsToAmount(k, b.committed),
    total: unitsToAmount(k, limits[k].total), remaining: unitsToAmount(k, limits[k].total - b.reserved - b.committed) }]).concat([['transactions', { ...count, max: certificate.maxTransactions }]])
    .concat(usdCap ? [['USD_REFERENCE', { reserved: usdString(usdBudget.reserved), committed: usdString(usdBudget.committed), total: certificate.usdReference.total, remaining: usdString(usdCap.total - usdBudget.reserved - usdBudget.committed) }]] : []));
  return { identify, validate, authorize, route, advance, fail: failDecision, unlock, receipt, budget, decisions, refusals, adapters: registry };
}
const stripUndef = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
