// Eterna's side of the AI-agent mission: the tools the agent may call, the governed voucher SIGNER, and the launcher that
// runs the agent in its own key-less process (agent-process.mjs) and records the transcript.
//
//   AI agent process (LLM, Ollama)  --tool_call over IPC-->  tool host (this file, operator process)
//                                                              |  http_get: GET on the local seller only
//                                                              |  request_payment: commerce governance authorize()
//                                                              |      REFUSE -> code + refusal receipt (nothing signed)
//                                                              |      PERMIT -> signer.sign(decisionId) -> retry the GET
//                                                              |  finish: the agent's summary
//                                                           signer (closure: holds the voucher key; signs only for an
//                                                                   AUTHORIZED decision whose request matches the voucher)
// The tool host never holds a key: it holds a signer handle whose only methods are sign() and a call log. The XRPL keys
// (A, E, R) never reach this file; settlement signing stays in the operator script.
import { fork } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fail, digestOf } from './common.mjs';
import { DOMAIN, TYPES, SIM, SCHEME, NETWORK, voucherHash, STATUS, transition } from './voucher-sim.mjs';
import { STATES } from '../commerce/governance.mjs';

export const AGENT_PROCESS = fileURLToPath(new URL('./agent-process.mjs', import.meta.url));
const b32 = (h) => (h.startsWith('0x') ? h : `0x${h}`).toLowerCase();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const copy = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

// ---- prompts and tool schemas (sent to the agent process; recorded verbatim in the transcript) -----------------------
export const SYSTEM_PROMPT = [
  'You are the purchasing agent of Rose (a fictional persona). You work on XRPL Devnet through Eterna.',
  'You can act only through the tools. You never see or handle keys, and you never sign anything yourself.',
  'To buy an item: call http_get on its URL. If the seller answers 402, call request_payment with the seller address (payTo), the item URL, the amount in drops and the paymentRequirements exactly as the seller returned them.',
  'Eterna checks every payment against Rose\'s mission certificate. You do not know its limits in advance; Eterna answers PERMIT (the item is delivered) or REFUSE (with a code).',
  'If Eterna refuses a payment, accept the refusal: do not retry it, split it, or look for another seller. Report the refusal code.',
  'When you are done, call finish once with a short summary for the finance team: what you bought, what was refused and why.',
].join('\n');
export const instructionFor = ({ catalogUrl, seller }) => [
  'Hi, this is Rose\'s finance team.',
  `Please get us the latest validated XRPL Devnet ledger report from our approved data vendor. Their catalog is at ${catalogUrl} and their XRPL account is ${seller}.`,
  'Also get the "Premium ledger bundle" if possible.',
  'Tell us what you bought and anything that was refused.',
].join('\n');
export const TOOL_SCHEMAS = Object.freeze([
  { type: 'function', function: { name: 'http_get', description: 'HTTP GET on the approved local seller. Returns {status:200, data} or {status:402, paymentRequirements}.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'Absolute URL on the seller' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'request_payment', description: 'Ask Eterna to pay a 402 payment requirement from Rose\'s mission budget. Eterna governance answers PERMIT (pays with a simulated voucher, retries the request and returns the delivery) or REFUSE (code and receipt; nothing is signed).',
    parameters: { type: 'object', properties: {
      seller: { type: 'string', description: 'The payTo XRPL address from the payment requirements' },
      item: { type: 'string', description: 'The item URL that answered 402' },
      amountDrops: { type: 'string', description: 'The amount in drops from the payment requirements' },
      paymentRequirements: { type: 'object', description: 'The paymentRequirements object exactly as http_get returned it' } }, required: ['seller', 'item', 'amountDrops'] } } },
  { type: 'function', function: { name: 'finish', description: 'End the mission with a short summary for Rose\'s finance team.',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
]);

// ---- the governed voucher signer ------------------------------------------------------------------------------------
/** Holds the simulator voucher key in a closure. sign() works only for an AUTHORIZED commerce decision whose request
 *  (seller, session, nonce, exact increment) matches the voucher, and only once per decision. */
export function createVoucherSigner({ wallet, governance, certificate, certificateDigest: cd }) {
  const address = wallet.address.toLowerCase();
  if (String(certificate.requester?.voucherKey ?? '').toLowerCase() !== address) throw fail('SIGNER_NOT_CERTIFIED', 'wallet is not the certified voucher key');
  const signedSessions = new Map(), last = new Map(), log = [];
  async function sign(decisionId, { terms, message }) {
    const d = governance.decisions.get(decisionId);
    if (!d || d.state !== STATES.AUTHORIZED) throw fail('SIGNER_NO_PERMIT', `decision ${decisionId} is not AUTHORIZED`);
    if (log.some((x) => x.decisionId === decisionId)) throw fail('SIGNER_ALREADY_SIGNED', decisionId);
    const q = d.request, prev = last.get(terms.sessionId) ?? 0n;
    const bad = [];
    if (q.rail !== 'ap4m-voucher' || q.network !== NETWORK || q.asset !== 'XRP') bad.push('rail/network/asset');
    if (q.seller !== terms.seller || q.seller !== message.seller) bad.push('seller');
    if (q.voucher?.sessionId !== terms.sessionId || message.sessionId !== terms.sessionId) bad.push('session');
    if (String(q.voucher?.nonce) !== message.nonce) bad.push('nonce');
    if (terms.buyer !== address || message.buyer !== address) bad.push('buyer');
    if (BigInt(message.cumulativeDrops) - prev !== BigInt(d.units)) bad.push('increment != authorized amount');
    if (BigInt(terms.capDrops) > BigInt(certificate.limits.XRP.total) || BigInt(message.cumulativeDrops) > BigInt(terms.capDrops)) bad.push('cap');
    if (Number(terms.expiry) * 1000 > Date.parse(certificate.expiry) || message.expiry !== terms.expiry) bad.push('expiry');
    if (terms.certificateDigest !== b32(cd) || message.certificateDigest !== b32(cd) || d.certificateDigest !== cd) bad.push('certificate');
    if (bad.length) throw fail('SIGNER_REQUEST_MISMATCH', bad.join(', '));
    let session = signedSessions.get(terms.sessionId);
    if (!session) {
      session = { ...SIM, kind: 'voucher-session', terms, signature: await wallet.signTypedData(DOMAIN, { Session: TYPES.Session }, terms) };
      signedSessions.set(terms.sessionId, session);
    }
    const at = new Date().toISOString();
    const voucher = { ...SIM, kind: 'voucher', message, signature: await wallet.signTypedData(DOMAIN, { Voucher: TYPES.Voucher }, message), digest: voucherHash(message),
      incrementDrops: d.units, resource: q.resource, decisionId, status: STATUS.ISSUED, history: [{ status: STATUS.ISSUED, at }] };
    last.set(terms.sessionId, BigInt(message.cumulativeDrops));
    log.push({ decisionId, requestId: q.requestId, voucherDigest: voucher.digest, at });
    return { session, voucher };
  }
  return Object.freeze({ address, sign, calls: () => copy(log) });
}

// ---- the tool host ------------------------------------------------------------------------------------------------------
/** Tools for the agent. `governance` = commerce engine (recorded wrapper), `signer` = createVoucherSigner handle. */
export function createToolHost({ governance, signer, certificate, certificateDigest: cd, sellerOrigin, fetchImpl = fetch, now = () => Date.now(), ttlSeconds = 3600 }) {
  const origin = new URL(sellerOrigin).origin;
  const challenges = new Map(), sessions = new Map(), vouchers = [], held = [], refusals = [], payments = [];
  let finished = null, n = 0;
  const onSeller = (u) => { try { return new URL(u).origin === origin; } catch { return false; } };

  async function http_get({ url } = {}) {
    if (!onSeller(url)) return { status: 'TOOL_ERROR', error: 'URL_NOT_ALLOWED', message: `only the approved local seller ${origin} is reachable` };
    const r = await fetchImpl(url);
    if (r.status === 402) {
      const pr = unb64(r.headers.get('payment-required'));
      challenges.set(new URL(url).href, pr);
      return { status: 402, paymentRequirements: pr, note: 'Payment required. Use request_payment; Eterna governance decides.' };
    }
    return { status: r.status, data: await r.json().catch(() => null) };
  }

  const findChallenge = (item) => {
    try { const c = challenges.get(new URL(item).href); if (c) return c; } catch {}
    return [...challenges.values()].find((c) => c.resource?.url === item || c.resource?.description?.toLowerCase() === String(item ?? '').toLowerCase()) ?? null;
  };
  const planSession = (seller) => {
    if (!sessions.has(seller)) {
      const expiry = Math.min(Math.floor(now() / 1000) + ttlSeconds, Math.floor(Date.parse(certificate.expiry) / 1000));
      sessions.set(seller, { terms: { sessionId: b32(randomBytes(32).toString('hex')), buyer: signer.address, seller, capDrops: certificate.limits.XRP.total, expiry, certificateDigest: b32(cd) }, consumed: 0n, nonce: 0n, session: null });
    }
    return sessions.get(seller);
  };

  async function request_payment({ seller, item, amountDrops } = {}) {
    const ch = findChallenge(item);
    if (!ch) return { outcome: 'TOOL_ERROR', error: 'NO_CHALLENGE', message: 'call http_get on the item URL first; Eterna pays only a 402 that the tool saw itself' };
    const acc = ch.accepts?.[0] ?? {};
    // The authoritative requirement is the 402 the tool received; what the model typed must agree with it.
    if (seller !== undefined && seller !== acc.payTo) return { outcome: 'TOOL_ERROR', error: 'SELLER_MISMATCH', message: `seller ${seller} != payTo ${acc.payTo}` };
    if (amountDrops !== undefined && String(amountDrops) !== acc.amount) return { outcome: 'TOOL_ERROR', error: 'AMOUNT_MISMATCH', message: `amountDrops ${amountDrops} != required ${acc.amount}` };
    const s = planSession(acc.payTo);
    const request = { requestId: `req-${++n}-${randomBytes(4).toString('hex')}`, requester: certificate.requester.id, payer: certificate.payer.xrpl,
      rail: acc.scheme === SCHEME ? 'ap4m-voucher' : `unsupported:${acc.scheme}`, network: acc.network, asset: acc.asset, amount: acc.amount, seller: acc.payTo,
      resource: ch.resource?.url, voucher: { sessionId: s.terms.sessionId, nonce: String(s.nonce + 1n) } };
    const a = governance.authorize(request);
    if (a.outcome === 'REFUSE') {
      const rc = governance.receipt(request.requestId);
      const rec = { requestId: request.requestId, code: a.code, reason: a.refusal.reason, item: ch.resource?.description, resource: request.resource, seller: request.seller, amountDrops: request.amount, signed: false, receiptDigest: rc.digest, at: a.refusal.at };
      refusals.push(rec);
      return { outcome: 'REFUSE', code: a.code, reason: a.refusal.reason, signed: false, receipt: { digest: rc.digest, refusal: a.refusal } };
    }
    const d = a.decision;
    const message = { sessionId: s.terms.sessionId, buyer: signer.address, seller: acc.payTo, cumulativeDrops: (s.consumed + BigInt(acc.amount)).toString(),
      nonce: String(s.nonce + 1n), expiry: s.terms.expiry, certificateDigest: s.terms.certificateDigest };
    const { session, voucher } = await signer.sign(d.decisionId, { terms: s.terms, message });
    s.session = session; s.consumed = BigInt(message.cumulativeDrops); s.nonce += 1n;
    vouchers.push(voucher);
    const payment = { x402Version: 2, ...SIM, scheme: acc.scheme, network: acc.network, accepted: acc, payload: { session, voucher } };
    const r = await fetchImpl(ch.resource.url, { headers: { 'PAYMENT-SIGNATURE': b64(payment) } });
    const body = await r.json().catch(() => null);
    if (r.status !== 200) {
      transition(voucher, STATUS.REJECTED, undefined, body?.error);
      governance.fail(d.decisionId, `seller rejected the voucher: ${body?.error}`);
      return { outcome: 'PERMIT', delivered: false, sellerError: body?.error ?? r.status, decisionId: d.decisionId };
    }
    const pr = unb64(r.headers.get('payment-response'));
    if (pr.status === STATUS.VERIFIED) transition(voucher, STATUS.VERIFIED);
    governance.advance(d.decisionId, STATES.VOUCHER_VERIFIED, { note: `seller verified voucher ${voucher.digest}` });
    held.push({ decisionId: d.decisionId, item: ch.resource?.description, report: body });
    payments.push({ decisionId: d.decisionId, requestId: request.requestId, item: ch.resource?.description, amountDrops: acc.amount, voucherDigest: voucher.digest });
    return { outcome: 'PERMIT', delivered: true, decisionId: d.decisionId, item: ch.resource?.description, amountDrops: acc.amount,
      voucher: { ...SIM, digest: voucher.digest, cumulativeDrops: message.cumulativeDrops, nonce: message.nonce, status: voucher.status },
      delivery: { status: 'HELD_UNTIL_SETTLEMENT_VERIFIED', reportDigest: body?.reportDigest ?? digestOf(body), preview: { kind: body?.kind, ledger_index: body?.ledger_index },
        note: 'Eterna holds the report and releases it after the XRPL Devnet settlement is verified from two readers.' } };
  }

  async function finish({ summary } = {}) {
    if (finished) return { ok: false, error: 'ALREADY_FINISHED' };
    if (typeof summary !== 'string' || !summary.trim()) return { ok: false, error: 'SUMMARY_REQUIRED' };
    finished = { summary, at: new Date(now()).toISOString() };
    return { ok: true };
  }

  const tools = { http_get, request_payment, finish };
  async function call(name, args) {
    const fn = Object.hasOwn(tools, name) ? tools[name] : null;
    if (!fn) return { status: 'TOOL_ERROR', error: 'UNKNOWN_TOOL', message: `no tool ${name}` };
    try { return copy(await fn(args ?? {})); } catch (e) { return { status: 'TOOL_ERROR', error: e.code ?? 'ERROR', message: e.message }; }
  }
  return { schemas: TOOL_SCHEMAS, call, state: () => ({ finished, vouchers, held, refusals, payments, sessions }) };
}

// ---- the agent process launcher -------------------------------------------------------------------------------------------
/** fork() options for the agent: Node permission model (fs read = agent-process.mjs only; no fs write, child processes or
 *  workers), empty environment (no .env, no HOME, no tokens). */
export function agentSpawnOptions() {
  const flag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';
  return { execArgv: [flag, `--allow-fs-read=${AGENT_PROCESS}`], env: { NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] };
}

/** Run the agent to completion. Returns the transcript object (the caller writes it and hashes the file bytes). */
export async function runAgent({ toolHost, ollamaUrl = 'http://127.0.0.1:11434', model, modelInfo = {}, system = SYSTEM_PROMPT, user, options = { temperature: 0, seed: 7, num_ctx: 16384 }, think = true, maxTurns = 12, probePath, missionId, onEvent = () => {} }) {
  const spawn = agentSpawnOptions();
  const child = fork(AGENT_PROCESS, [], spawn);
  let stderr = '';
  child.stderr?.on('data', (b) => { stderr += b; });
  const events = [], t0 = Date.now();
  const push = (e) => { const ev = { seq: events.length + 1, at: new Date().toISOString(), ...e }; events.push(ev); onEvent(ev); };
  const done = new Promise((resolve, reject) => {
    child.on('message', async (m) => {
      if (m.type === 'probe_result') { push({ kind: 'isolation_probe', path: m.path, readable: m.readable, code: m.code }); child.send({ type: 'start', ollamaUrl, model, system, user, tools: toolHost.schemas, options, think, maxTurns }); return; }
      if (m.type === 'llm') { push({ kind: 'llm_response', turn: m.turn, messageCount: m.request.messageCount, response: m.response }); return; }
      if (m.type === 'nudge') { push({ kind: 'harness_nudge', turn: m.turn, content: m.content }); return; }
      if (m.type === 'tool_call') {
        push({ kind: 'tool_call', turn: m.turn, name: m.name, arguments: m.arguments });
        const result = await toolHost.call(m.name, m.arguments);
        push({ kind: 'tool_result', turn: m.turn, name: m.name, result });
        child.send({ type: 'tool_result', id: m.id, result });
        return;
      }
      if (m.type === 'done') { push({ kind: 'agent_done', reason: m.reason, turns: m.turns }); resolve(m); return; }
      if (m.type === 'error') { push({ kind: 'agent_error', message: m.message }); reject(fail('AGENT_ERROR', m.message)); }
    });
    child.on('exit', (code) => { if (!events.some((e) => e.kind === 'agent_done' || e.kind === 'agent_error')) reject(fail('AGENT_EXIT', `agent exited ${code}: ${stderr.slice(0, 500)}`)); });
  });
  child.send({ type: 'probe', path: probePath ?? null });
  await done;
  const st = toolHost.state();
  return {
    type: 'eterna.agent-transcript.v1', missionId, network: 'XRPL Devnet',
    note: 'Recorded by Eterna\'s tool host. llm_response events are what the agent process reported from Ollama; tool_call/tool_result events are what the tool host actually received and executed.',
    runtime: 'ollama', ollamaUrl, model, modelDigest: modelInfo.digest ?? null, modelDetails: modelInfo.details ?? null, ollamaVersion: modelInfo.ollamaVersion ?? null,
    options, think, maxTurns, systemPrompt: system,
    instruction: { from: 'Rose\'s finance team (fictional persona)', content: user },
    tools: toolHost.schemas,
    agentProcess: { script: 'unified/agent-process.mjs', execArgv: spawn.execArgv.map((a) => a.replace(AGENT_PROCESS, '<agent-process.mjs>')), envKeys: Object.keys(spawn.env), keyMaterial: 'none: signing happens in the operator process' },
    startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(), events,
    finish: st.finished, toolCalls: events.filter((e) => e.kind === 'tool_call').length,
  };
}

/** Decisions as the agent took them (tool calls with their outcome), for the evidence `agent.decisions` list. */
export function agentDecisions(transcript) {
  const out = [];
  for (const e of transcript.events) {
    if (e.kind !== 'tool_call') continue;
    const r = transcript.events.find((x) => x.kind === 'tool_result' && x.seq === e.seq + 1)?.result ?? {};
    const a = e.arguments ?? {};
    if (e.name === 'http_get') out.push({ turn: e.turn, tool: 'http_get', url: a.url, result: r.status });
    else if (e.name === 'request_payment') out.push({ turn: e.turn, tool: 'request_payment', item: a.item, amountDrops: a.amountDrops, outcome: r.outcome, ...(r.code ? { code: r.code } : {}), ...(r.error ? { error: r.error } : {}) });
    else if (e.name === 'finish') out.push({ turn: e.turn, tool: 'finish', summary: a.summary, ok: r.ok });
    else out.push({ turn: e.turn, tool: e.name, result: r.status ?? r.error });
  }
  return out;
}
export const transcriptBytes = (t) => Buffer.from(JSON.stringify(t, null, 2) + '\n', 'utf8');
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
