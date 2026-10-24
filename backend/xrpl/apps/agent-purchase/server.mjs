#!/usr/bin/env node
// Agent Purchase Experience — preview server (hackathon/governed-a2a). Zero dependencies.
//
// Serves the purchase experience (public/) and a thin, read-mostly bridge to an EXISTING Eterna governed-purchase
// backend. It never decides, enforces, signs or pays: every decision comes from the backend rulebook.
//
//   RECORDED mode (default): committed evidence rendered through the backend's own view() (fixtures/), labelled.
//   LIVE mode: proxies an Eterna backend's public purchase API (offers, requester intake, requester status).
//
// Safety: LIVE requests are refused when the backend serves Mainnet unless PREVIEW_ALLOW_MAINNET=owner-approved.
// The requester credential (if any) is read from a file at call time, sent only to the backend, never to the browser,
// never logged. Request status tokens stay server-side.
//
// env: PORT (3460) · HOST (127.0.0.1) · PURCHASE_BACKEND_URL (unset = recorded only; e.g. http://127.0.0.1:3310 Devnet)
//      PREVIEW_AGENT_ADDRESS (the agent's Eterna address, e.g. hy7h-bcjj-47r6) · PREVIEW_AGENT_LABEL
//      REQUESTER_CREDENTIAL_FILE (optional) · PREVIEW_ALLOW_MAINNET (owner-approved | unset)
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const APP = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(APP, 'public');
const env = process.env;
const BACKEND = (env.PURCHASE_BACKEND_URL || '').replace(/\/$/, '') || null;
const AGENT = { address: env.PREVIEW_AGENT_ADDRESS || null, label: env.PREVIEW_AGENT_LABEL || 'OpenClaw' };
const MAINNET_OK = env.PREVIEW_ALLOW_MAINNET === 'owner-approved';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };

const fixture = (n) => JSON.parse(readFileSync(join(APP, 'fixtures', `${n}.json`), 'utf8'));
const recorded = () => ({ mainnet: fixture('mainnet-standing-2026-10-22'), devnetRefusals: fixture('devnet-refusals-2026-10-20').refusals, scenarios: fixture('scenarios').scenarios,
  catalog: existsSync(join(APP, 'fixtures', 'catalog-devnet.json')) ? fixture('catalog-devnet') : null,
  persona: existsSync(join(APP, 'fixtures', 'persona-rose.json')) ? fixture('persona-rose') : null,
  evidence: Object.fromEntries(['devnet-xls68', 'rose-unified-commerce'].map((k) => [k, existsSync(join(APP, 'fixtures', `evidence-${k}.json`)) ? fixture(`evidence-${k}`) : null])) });
// MAINNET OBSERVE (engineering machine only): PREVIEW_OBSERVER=mainnet loads the read-only observer from the Eterna repo
// (backend/xrpl/scripts/purchase-observer.mjs — not part of the designer repo). Loopback only; never sends requests.
const OBSERVER_PATH = join(APP, '..', '..', 'scripts', 'purchase-observer.mjs');
const OBSERVE = env.PREVIEW_OBSERVER === 'mainnet';
if (OBSERVE && !['127.0.0.1', 'localhost', '::1'].includes(env.HOST || '127.0.0.1')) throw new Error('Mainnet observe runs on loopback only');
const observer = OBSERVE ? await import(OBSERVER_PATH) : null;
const credential = () => (env.REQUESTER_CREDENTIAL_FILE && existsSync(env.REQUESTER_CREDENTIAL_FILE) ? readFileSync(env.REQUESTER_CREDENTIAL_FILE, 'utf8').trim() : null);
const live = new Map();                                                    // local id → { purchaseId, token } (server-side only)

async function backend(path, init = {}) {
  const r = await fetch(`${BACKEND}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
  const body = await r.json().catch(() => ({ error: 'BAD_BACKEND_RESPONSE' }));
  return { status: r.status, body };
}
const isMainnet = (offers) => (offers ?? []).some((o) => /mainnet/i.test(String(o.network ?? '')));
const strip = (o) => { if (!o || typeof o !== 'object') return o; const c = { ...o }; for (const k of ['token', 'statusToken', 'statusUrl']) delete c[k]; return c; };

async function api(req, url) {
  if (url.pathname === '/api/preview/mainnet' && req.method === 'GET') {
    if (!observer) return [404, { error: 'MAINNET_OBSERVE_OFF' }];
    return [200, { provenance: { kind: 'LIVE', network: 'XRPL Mainnet', readAt: new Date().toISOString(), note: 'Read-only observation of the Mainnet backend.' },
      offers: observer.mainnetOffers(), purchases: await observer.observeMainnet({ limit: 30 }) }];
  }
  if (url.pathname === '/api/preview/config' && req.method === 'GET') {
    if (observer) return [200, { mode: 'mainnet', backend: 'Mainnet (read-only observer)', agent: { label: 'OpenClaw', addressConfigured: false }, credentialConfigured: false, mainnetAllowed: false }];
    return [200, { mode: BACKEND ? 'live' : 'recorded', backend: BACKEND ? new URL(BACKEND).host : null,
      agent: { label: AGENT.label, addressConfigured: Boolean(AGENT.address) }, credentialConfigured: Boolean(credential()), mainnetAllowed: MAINNET_OK }];
  }
  if (url.pathname === '/api/preview/recorded' && req.method === 'GET') return [200, recorded()];
  if (url.pathname === '/api/preview/offers' && req.method === 'GET') {
    if (!BACKEND) return [200, { offers: [], note: 'No backend configured (recorded mode).' }];
    const { status, body } = await backend('/api/purchase/v1/offers');
    return [status, { ...body, network: isMainnet(body.offers) ? 'mainnet' : 'test' }];
  }
  if (url.pathname === '/api/preview/requests' && req.method === 'POST') {
    if (!BACKEND) return [409, { error: 'NO_BACKEND', detail: 'Start the preview with PURCHASE_BACKEND_URL to make live requests.' }];
    if (!AGENT.address) return [409, { error: 'NO_AGENT_ADDRESS', detail: 'Set PREVIEW_AGENT_ADDRESS to the agent’s Eterna address.' }];
    const offers = (await backend('/api/purchase/v1/offers')).body.offers ?? [];
    if (isMainnet(offers) && !MAINNET_OK) return [403, { error: 'MAINNET_REQUIRES_OWNER_APPROVAL', detail: 'This preview will not send requests to a Mainnet backend unless the owner approves (PREVIEW_ALLOW_MAINNET=owner-approved).' }];
    const input = JSON.parse(await bodyOf(req) || '{}');
    const offer = offers.find((o) => o.offerId === input.offerId);
    if (!offer) return [400, { error: 'UNKNOWN_OFFER' }];
    const xrp = (Number(input.amountDrops ?? offer.priceDrops) / 1e6).toString();
    // existingAuthorityOnly: the agent buys only under the owner's existing signed authority — it never asks the owner
    // per purchase. Not covered → the backend refuses (with a receipt) instead of drafting a new certificate.
    const payload = { agentAddress: AGENT.address, agentLabel: AGENT.label, clientRequestId: `preview-${randomUUID().slice(0, 18)}`, existingAuthorityOnly: true,
      request: `Buy ${offer.title} from ${offer.seller?.label ?? 'the seller'} for ${xrp} XRP`,
      structuredPurchaseDetails: { ...(offer.howToBuy?.structuredPurchaseDetails ?? {}), amount: xrp, asset: 'XRP' } };
    const headers = { 'content-type': 'application/json' }; const cred = credential(); if (cred) headers['X-Eterna-C56-Requester-Credential'] = cred;
    const { status, body } = await backend('/api/purchase/v1/requests', { method: 'POST', headers, body: JSON.stringify(payload) });
    const token = body?.statusToken ?? body?.token;
    if (body?.purchaseId && token) { const id = randomUUID(); live.set(id, { purchaseId: body.purchaseId, token }); return [status, { localId: id, ...strip(body) }]; }
    return [status, strip(body)];
  }
  const m = /^\/api\/preview\/requests\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (m && req.method === 'GET') {
    const l = live.get(m[1]); if (!l) return [404, { error: 'UNKNOWN_LOCAL_REQUEST' }];
    const { status, body } = await backend(`/api/purchase/v1/requests/${l.purchaseId}?token=${encodeURIComponent(l.token)}`);
    return [status, strip(body)];
  }
  return [404, { error: 'NOT_FOUND' }];
}
const bodyOf = (req) => new Promise((ok, no) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) no(new Error('too large')); }); req.on('end', () => ok(s)); req.on('error', no); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const sec = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'" };
  try {
    if (url.pathname.startsWith('/api/')) {
      const [status, body] = await api(req, url);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...sec }); return res.end(JSON.stringify(body));
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) { res.writeHead(404, sec); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...sec });
    res.end(readFileSync(file));
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json', ...sec }); res.end(JSON.stringify({ error: 'PREVIEW_ERROR', detail: String(e.message).slice(0, 200) }));
  }
});
const PORT = Number(env.PORT || 3460), HOST = env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`agent-purchase preview: http://${HOST}:${PORT}  mode=${BACKEND ? `live (${BACKEND})` : 'recorded'}`));
