// SIMULATOR of the voucher model of Mastercard Agent Pay for Machines (AP4M) as publicly described: HTTP 402 -> the
// agent signs an EIP-712 voucher -> the seller/facilitator verifies -> vouchers are batched and redeemed later.
// This is NOT Mastercard software, NOT connected to any Mastercard network, and every object it emits says so.
// Redemption here is settled by one delegated XRPL Devnet Payment (see tx.mjs), never by Mastercard.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { digestOf, fail } from './common.mjs';
import { policyCheck, sessionPolicyCheck } from './governance.mjs';

const require = createRequire(import.meta.url);
const { TypedDataEncoder, verifyTypedData } = require('ethers');

export const SIM = Object.freeze({ simulated: true, issuer: 'Eterna local simulator — not Mastercard' });
export const SCHEME = 'eterna-voucher-sim';
export const NETWORK = 'xrpl:2';
export const DOMAIN = Object.freeze({ name: 'Eterna AP4M Simulator', version: '0', chainId: 0 });
export const TYPES = Object.freeze({
  Session: [{ name: 'sessionId', type: 'bytes32' }, { name: 'buyer', type: 'address' }, { name: 'seller', type: 'string' },
    { name: 'capDrops', type: 'uint256' }, { name: 'expiry', type: 'uint64' }, { name: 'certificateDigest', type: 'bytes32' }],
  Voucher: [{ name: 'sessionId', type: 'bytes32' }, { name: 'buyer', type: 'address' }, { name: 'seller', type: 'string' },
    { name: 'cumulativeDrops', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint64' },
    { name: 'certificateDigest', type: 'bytes32' }],
});
const one = (name) => ({ [name]: TYPES[name] });
export const sessionHash = (terms) => TypedDataEncoder.hash(DOMAIN, one('Session'), terms);
export const voucherHash = (msg) => TypedDataEncoder.hash(DOMAIN, one('Voucher'), msg);
const recover = (name, msg, sig) => { try { return verifyTypedData(DOMAIN, one(name), msg, sig).toLowerCase(); } catch { return null; } };
export const recoverVoucherSigner = (v) => recover('Voucher', v.message, v.signature);
export const recoverSessionSigner = (s) => recover('Session', s.terms, s.signature);
const b32 = (hex) => (hex.startsWith('0x') ? hex : `0x${hex}`).toLowerCase();

// ---- redemption-status tracking ------------------------------------------------------------------------------------
export const STATUS = Object.freeze({ ISSUED: 'ISSUED', VERIFIED: 'VERIFIED', REDEEMED_PENDING: 'REDEEMED_PENDING', SETTLED: 'SETTLED', REJECTED: 'REJECTED' });
const NEXT = { ISSUED: ['VERIFIED', 'REJECTED'], VERIFIED: ['REDEEMED_PENDING', 'REJECTED'], REDEEMED_PENDING: ['SETTLED', 'REJECTED'], SETTLED: [], REJECTED: [] };
export function transition(rec, to, at = new Date().toISOString(), note) {
  if (!NEXT[rec.status]?.includes(to)) throw fail('BAD_TRANSITION', `${rec.status} -> ${to}`);
  rec.status = to; rec.history.push({ status: to, at, ...(note ? { note } : {}) });
  return rec;
}

// ---- the agent side: Eterna-governed voucher signer ---------------------------------------------------------------
/** The agent's voucher key is held by Eterna's governed signer: nothing is signed until the policy gate passes. */
export function createGovernedAgent({ wallet, cert, approval, certificateDigest, now = () => Date.now(), ttlSeconds = 3600 }) {
  const sessions = new Map(); // seller -> { session, consumed, nonce }
  const vouchers = [], refusals = [];
  const buyer = wallet.address.toLowerCase();
  const refused = (e, request) => { if (e.refusal) refusals.push({ at: new Date(now()).toISOString(), code: e.code, reason: e.message, request, signed: false, ...SIM_NOTE }); throw e; };

  async function openSession(seller) {
    const expiry = Math.min(Math.floor(now() / 1000) + ttlSeconds, Math.floor(Date.parse(cert.expiry) / 1000));
    const terms = { sessionId: b32(randomBytes(32).toString('hex')), buyer, seller, capDrops: cert.limits.capDrops, expiry, certificateDigest: b32(certificateDigest) };
    sessionPolicyCheck(cert, { approval, seller, voucherKey: buyer, capDrops: terms.capDrops, expiry, now: now() });
    const session = { ...SIM, kind: 'voucher-session', terms, signature: await wallet.signTypedData(DOMAIN, one('Session'), terms) };
    const s = { session, consumed: 0n, nonce: 0n };
    sessions.set(seller, s);
    return s;
  }

  /** Pay one x402 requirement (`accepts` entry). Policy-gated; throws a refusal before any signature on failure. */
  async function pay(req, resource) {
    const request = { seller: req.payTo, amountDrops: req.amount, resource };
    try {
      if (req.scheme !== SCHEME || req.network !== NETWORK) throw Object.assign(fail('POLICY_SCHEME_UNSUPPORTED', `${req.scheme}/${req.network}`), { refusal: true });
      if (!/^[1-9]\d*$/.test(req.amount ?? '')) throw Object.assign(fail('POLICY_BAD_AMOUNT', 'amount must be positive drops'), { refusal: true });
      // the gate runs before a session (or anything) is signed for this seller
      const prev = sessions.get(req.payTo)?.consumed ?? 0n;
      policyCheck(cert, { approval, seller: req.payTo, voucherKey: buyer, previousCumulativeDrops: prev.toString(), cumulativeDrops: (prev + BigInt(req.amount)).toString(), now: now() });
      const s = sessions.get(req.payTo) ?? await openSession(req.payTo);
      const message = { sessionId: s.session.terms.sessionId, buyer, seller: req.payTo, cumulativeDrops: (s.consumed + BigInt(req.amount)).toString(),
        nonce: (s.nonce + 1n).toString(), expiry: s.session.terms.expiry, certificateDigest: s.session.terms.certificateDigest };
      policyCheck(cert, { approval, seller: message.seller, voucherKey: buyer, previousCumulativeDrops: s.consumed.toString(), cumulativeDrops: message.cumulativeDrops, voucherExpiry: message.expiry, now: now() });
      const signature = await wallet.signTypedData(DOMAIN, one('Voucher'), message);
      s.consumed = BigInt(message.cumulativeDrops); s.nonce = BigInt(message.nonce);
      const at = new Date(now()).toISOString();
      const v = { ...SIM, kind: 'voucher', message, signature, digest: voucherHash(message), incrementDrops: req.amount, resource, status: STATUS.ISSUED, history: [{ status: STATUS.ISSUED, at }] };
      vouchers.push(v);
      return { session: s.session, voucher: v };
    } catch (e) { return refused(e, request); }
  }
  const budget = () => ({ capDrops: cert.limits.capDrops, consumedDrops: [...sessions.values()].reduce((a, s) => a + s.consumed, 0n).toString() });
  return { address: buyer, pay, vouchers, refusals, sessions, budget };
}
const SIM_NOTE = { note: 'refused by Eterna policy gate before signing' };

// ---- the seller / facilitator side ---------------------------------------------------------------------------------
/** Seller-side verifier. sellerId is the XRPL address S the voucher must be bound to. */
export function createSeller({ sellerId, now = () => Date.now() }) {
  const sessions = new Map(); // sessionId -> { terms, lastCumulative, lastNonce, accepted: [] }
  const rejections = [];
  const reject = (code, why) => { rejections.push({ at: new Date(now()).toISOString(), code, why }); return { ok: false, code, why }; };

  function verify({ session, voucher }, priceDrops) {
    if (session?.simulated !== true || voucher?.simulated !== true || session.issuer !== SIM.issuer || voucher.issuer !== SIM.issuer) return reject('NOT_SIMULATOR_OBJECT', 'missing simulator markers');
    const t = session.terms, m = voucher.message;
    if (recoverSessionSigner(session) !== t.buyer?.toLowerCase()) return reject('BAD_SESSION_SIGNATURE', 'session not signed by its buyer');
    if (t.seller !== sellerId) return reject('SELLER_MISMATCH', 'session bound to another seller');
    let s = sessions.get(t.sessionId);
    if (s && digestOf(s.terms) !== digestOf(t)) return reject('SESSION_TERMS_CHANGED', 'session terms differ from first use');
    if (recoverVoucherSigner(voucher) !== t.buyer.toLowerCase()) return reject('WRONG_SIGNER', 'voucher not signed by the session buyer');
    if (m.buyer.toLowerCase() !== t.buyer.toLowerCase() || m.sessionId !== t.sessionId || m.certificateDigest !== t.certificateDigest) return reject('SESSION_MISMATCH', 'voucher does not belong to this session');
    if (m.seller !== sellerId) return reject('SELLER_MISMATCH', 'voucher bound to another seller');
    if (Number(m.expiry) > Number(t.expiry)) return reject('EXPIRY_BEYOND_SESSION', 'voucher outlives session');
    if (now() >= Number(m.expiry) * 1000) return reject('EXPIRED', 'voucher expired');
    const last = s?.lastCumulative ?? 0n, lastNonce = s?.lastNonce ?? 0n, cum = BigInt(m.cumulativeDrops), nonce = BigInt(m.nonce);
    if (nonce <= lastNonce || cum <= last) return reject('REPLAY', 'nonce or cumulative amount not increasing');
    if (cum - last !== BigInt(priceDrops)) return reject('AMOUNT_MISMATCH', `increment ${cum - last} != price ${priceDrops}`);
    if (cum > BigInt(t.capDrops)) return reject('CAP_EXCEEDED', 'cumulative exceeds session cap');
    if (!s) sessions.set(t.sessionId, s = { terms: t, lastCumulative: 0n, lastNonce: 0n, accepted: [] });
    s.lastCumulative = cum; s.lastNonce = nonce;
    const rec = { ...SIM, kind: 'voucher', message: m, signature: voucher.signature, digest: voucherHash(m), status: STATUS.ISSUED, history: [...(voucher.history ?? [])] };
    if (!rec.history.length) rec.history.push({ status: STATUS.ISSUED, at: new Date(now()).toISOString() });
    transition(rec, STATUS.VERIFIED, new Date(now()).toISOString());
    s.accepted.push(rec);
    return { ok: true, voucher: rec };
  }

  /** Batch every verified voucher of a session for redemption. The claim is the latest cumulative voucher. */
  function redeem(sessionId) {
    const s = sessions.get(sessionId);
    if (!s?.accepted.length) throw fail('NOTHING_TO_REDEEM', sessionId);
    const at = new Date(now()).toISOString();
    for (const v of s.accepted) if (v.status === STATUS.VERIFIED) transition(v, STATUS.REDEEMED_PENDING, at);
    const body = { ...SIM, kind: 'redemption-batch', scheme: SCHEME, network: NETWORK, seller: sellerId, sessionId, buyer: s.terms.buyer,
      certificateDigest: s.terms.certificateDigest.replace(/^0x/, ''), redeemedCumulativeDrops: s.lastCumulative.toString(), voucherCount: s.accepted.length,
      vouchers: s.accepted.map((v) => ({ digest: v.digest, message: v.message, signature: v.signature })), createdAt: at };
    return { ...body, batchDigest: batchDigest(body) };
  }
  return { sellerId, verify, redeem, sessions, rejections };
}
/** sha256 over the canonical batch body (without batchDigest). This is the digest written in the settlement memo. */
export const batchDigest = (batch) => { const { batchDigest: _, ...body } = batch; return digestOf(body); };

/** Re-check a redemption batch from scratch (used by verify.mjs): every signature, chain of cumulative amounts, totals. */
export function verifyBatch(batch, { sellerId, buyer, certificateDigest, perVoucherDrops, capDrops }) {
  const problems = [];
  if (batch.simulated !== true || batch.issuer !== SIM.issuer) problems.push('missing simulator markers');
  if (batchDigest(batch) !== batch.batchDigest) problems.push('batch digest mismatch');
  let last = 0n, lastNonce = 0n;
  for (const v of batch.vouchers) {
    if (voucherHash(v.message) !== v.digest) problems.push(`digest ${v.digest}`);
    if (recoverVoucherSigner(v) !== buyer.toLowerCase()) problems.push(`signer ${v.digest}`);
    if (v.message.seller !== sellerId) problems.push(`seller ${v.digest}`);
    if (v.message.certificateDigest.replace(/^0x/, '') !== certificateDigest) problems.push(`certificate ${v.digest}`);
    const cum = BigInt(v.message.cumulativeDrops), n = BigInt(v.message.nonce);
    if (cum <= last || n <= lastNonce || cum - last > BigInt(perVoucherDrops) || cum > BigInt(capDrops)) problems.push(`amount chain ${v.digest}`);
    last = cum; lastNonce = n;
  }
  if (last.toString() !== batch.redeemedCumulativeDrops) problems.push('redeemed total != last cumulative voucher');
  return { ok: problems.length === 0, problems, totalDrops: last.toString(), signaturesChecked: batch.vouchers.length };
}

// ---- local x402-style seller (127.0.0.1 only) -------------------------------------------------------------------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
/** routes: { '/report': { priceDrops, description, produce: async (voucher) => reportObject } }; a route with `free: true`
 *  (e.g. a catalog) answers 200 with produce() and never asks for payment. */
/** The x402 v2-shaped 402 body (also sent base64 in the PAYMENT-REQUIRED header). */
export const paymentRequired = ({ url, description, priceDrops, sellerId, error }) => ({ x402Version: 2, error: error ?? 'PAYMENT-REQUIRED', ...SIM,
  resource: { url, description, mimeType: 'application/json' },
  accepts: [{ scheme: SCHEME, network: NETWORK, amount: priceDrops, asset: 'XRP', payTo: sellerId, maxTimeoutSeconds: 300,
    extra: { ...SIM, cumulative: true, voucherDomain: DOMAIN, settlement: 'simulated AP4M redemption settled by Eterna on XRPL Devnet' } }] });
export function startSellerServer({ seller, routes, port = 0 }) {
  const requirements = (path, r, host, error) => paymentRequired({ url: `http://${host}${path}`, description: r.description, priceDrops: r.priceDrops, sellerId: seller.sellerId, error });
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname, r = routes[path];
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' || !r) return send(404, { error: 'not found' });
    if (r.free) return send(200, await r.produce());
    const host = req.headers.host;
    const sig = req.headers['payment-signature'];
    if (!sig) { const pr = requirements(path, r, host); return send(402, pr, { 'PAYMENT-REQUIRED': b64(pr) }); }
    let payment; try { payment = unb64(sig); } catch { const pr = requirements(path, r, host, 'MALFORMED_PAYMENT'); return send(402, pr, { 'PAYMENT-REQUIRED': b64(pr) }); }
    const v = payment?.scheme === SCHEME ? seller.verify(payment.payload ?? {}, r.priceDrops) : { ok: false, code: 'SCHEME_MISMATCH' };
    if (!v.ok) { const pr = requirements(path, r, host, v.code); return send(402, pr, { 'PAYMENT-REQUIRED': b64(pr) }); }
    const report = await r.produce(v.voucher);
    const pay = { success: true, ...SIM, scheme: SCHEME, network: NETWORK, voucherDigest: v.voucher.digest, cumulativeDrops: v.voucher.message.cumulativeDrops, status: v.voucher.status };
    send(200, report, { 'PAYMENT-RESPONSE': b64(pay) });
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

/** Agent HTTP client: GET -> 402 -> governed voucher -> retry. Returns { status, report?, refusal?, voucher? }. */
export async function agentFetch(url, agent) {
  const first = await fetch(url);
  if (first.status !== 402) return { status: first.status, body: await first.json() };
  const pr = unb64(first.headers.get('payment-required'));
  const accepted = pr.accepts?.[0];
  let paid;
  try { paid = await agent.pay(accepted, pr.resource?.url); } catch (e) { if (e.refusal) return { status: 'REFUSED', refusal: { code: e.code, reason: e.message } }; throw e; }
  const payment = { x402Version: 2, ...SIM, scheme: accepted.scheme, network: accepted.network, accepted, payload: { session: paid.session, voucher: paid.voucher } };
  const second = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': b64(payment) } });
  const body = await second.json();
  if (second.status !== 200) { transition(paid.voucher, STATUS.REJECTED, undefined, body.error); return { status: second.status, error: body.error, voucher: paid.voucher }; }
  const response = unb64(second.headers.get('payment-response'));
  if (response.status === STATUS.VERIFIED) transition(paid.voucher, STATUS.VERIFIED);
  return { status: 200, report: body, paymentResponse: response, voucher: paid.voucher };
}
