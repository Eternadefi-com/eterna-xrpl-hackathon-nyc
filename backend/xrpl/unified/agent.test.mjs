import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as sim from './voucher-sim.mjs';
import { digestOf } from './common.mjs';
import { STATES } from '../commerce/governance.mjs';
import ap4m from '../commerce/adapters/ap4m-voucher.mjs';
import xls68 from '../commerce/adapters/xls68-sponsored.mjs';
import { createVoucherSigner, createToolHost, runAgent, agentSpawnOptions, agentDecisions, transcriptBytes, sha256, TOOL_SCHEMAS, instructionFor } from './agent-tools.mjs';
import { agentCertificate, approveAsRoseDemo, recordedGovernance, buildAgentReceiptBody, buildAgentEvidence, ROSE_APPROVAL_LABEL, PRICES } from './agent-mission.mjs';

// Offline only. Keys come from fixed, obviously-fake entropy and were never used on any network.
const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const { Wallet } = require('ethers');
const key = (b) => { const seed = keypairs.generateSeed({ entropy: new Uint8Array(16).fill(b), algorithm: 'ed25519' }); const k = keypairs.deriveKeypair(seed); return { seed, ...k, address: keypairs.deriveAddress(k.publicKey) }; };
const E = key(0x11), R = key(0x22), S = key(0x33), A = key(0x44);
const W = new Wallet('0x' + '42'.repeat(32));
const SECRETS = [R.seed, E.seed, A.seed, R.privateKey, A.privateKey, W.privateKey, W.privateKey.slice(2)];
const noSecrets = (label, o) => { const s = typeof o === 'string' ? o : JSON.stringify(o); for (const x of SECRETS) assert.ok(!s.includes(x), `${label} leaks key material`); };

function mission() {
  const now = Date.now();
  const cert = agentCertificate({ missionId: 't', agent: A.address, voucherKey: W.address, rose: R.address, seller: S.address, model: 'fake-model',
    issuedAt: new Date(now - 60e3).toISOString(), expiry: new Date(now + 4 * 3600e3).toISOString() });
  const cd = digestOf(cert), approval = approveAsRoseDemo(cert, R.seed);
  const gov = recordedGovernance({ certificate: cert, approval, adapters: [ap4m, xls68] });
  return { cert, cd, approval, gov };
}
async function shopFor() {
  const seller = sim.createSeller({ sellerId: S.address });
  const delivered = [];
  const produce = (kind) => async (v) => { delivered.push(kind); const body = { kind, ledger_index: 7, ledger_hash: 'AB'.repeat(32), deliveredUnder: { voucherDigest: v.digest } }; return { ...body, reportDigest: digestOf(body) }; };
  let url;
  const shop = await sim.startSellerServer({ seller, routes: {
    '/catalog': { free: true, produce: async () => ({ items: [{ name: 'Validated ledger report', url: `${url}/report`, priceDrops: PRICES.report }, { name: 'Premium ledger bundle', url: `${url}/premium-bundle`, priceDrops: PRICES.premium }] }) },
    '/report': { priceDrops: PRICES.report, description: 'Validated ledger report', produce: produce('report') },
    '/premium-bundle': { priceDrops: PRICES.premium, description: 'Premium ledger bundle', produce: produce('bundle') } } });
  url = shop.url;
  return { seller, shop, delivered };
}
const setup = async () => {
  const mm = mission(), sh = await shopFor();
  const signer = createVoucherSigner({ wallet: W, governance: mm.gov, certificate: mm.cert, certificateDigest: mm.cd });
  const host = createToolHost({ governance: mm.gov, signer, certificate: mm.cert, certificateDigest: mm.cd, sellerOrigin: sh.shop.url });
  return { ...mm, ...sh, signer, host };
};

test('certificate v2: requester is the AI agent, payer Rose; approval is labelled as the operator-held Devnet demo key', () => {
  const { cert, approval, gov } = mission();
  assert.equal(cert.type, 'eterna.mission-certificate.v2');
  assert.deepEqual(cert.limits, { XRP: { perTx: '100000', total: '300000' } });
  assert.equal(cert.maxTransactions, 3);
  assert.equal(cert.requester.kind, 'ai-agent');
  assert.equal(approval.label, ROSE_APPROVAL_LABEL);
  assert.equal(ROSE_APPROVAL_LABEL, 'Rose (fictional) — Devnet demo key held by the operator');
  assert.equal(approval.humanSignature, false);
  assert.equal(gov.validate().ok, true);
});

test('Eterna refuses the premium bundle (PER_TX_EXCEEDED) before anything is signed; the report is paid only after PERMIT', async () => {
  const { host, signer, seller, shop, delivered, gov } = await setup();
  try {
    const p402 = await host.call('http_get', { url: `${shop.url}/premium-bundle` });
    assert.equal(p402.status, 402);
    const ref = await host.call('request_payment', { seller: S.address, item: `${shop.url}/premium-bundle`, amountDrops: PRICES.premium, paymentRequirements: p402.paymentRequirements });
    assert.equal(ref.outcome, 'REFUSE');
    assert.equal(ref.code, 'PER_TX_EXCEEDED');
    assert.equal(ref.signed, false);
    assert.match(ref.receipt.digest, /^[0-9a-f]{64}$/);
    assert.equal(signer.calls().length, 0, 'the signer was never called');
    assert.equal(seller.sessions.size, 0, 'the seller never saw a voucher');
    assert.deepEqual(delivered, []);
    assert.equal(gov.decisions.size, 0);

    const r402 = await host.call('http_get', { url: `${shop.url}/report` });
    const ok = await host.call('request_payment', { seller: S.address, item: `${shop.url}/report`, amountDrops: PRICES.report, paymentRequirements: r402.paymentRequirements });
    assert.equal(ok.outcome, 'PERMIT');
    assert.equal(ok.delivered, true);
    assert.equal(ok.delivery.status, 'HELD_UNTIL_SETTLEMENT_VERIFIED');
    assert.equal(signer.calls().length, 1);
    assert.equal(gov.decisions.get(ok.decisionId).state, STATES.VOUCHER_VERIFIED);
    assert.deepEqual(delivered, ['report']);
    // the model cannot change what is paid: amount and seller must match the 402 the tool saw
    assert.equal((await host.call('request_payment', { seller: S.address, item: `${shop.url}/report`, amountDrops: '1' })).error, 'AMOUNT_MISMATCH');
    assert.equal((await host.call('request_payment', { seller: E.address, item: `${shop.url}/report`, amountDrops: PRICES.report })).error, 'SELLER_MISMATCH');
    assert.equal((await host.call('request_payment', { seller: S.address, item: 'http://127.0.0.1:1/x', amountDrops: '1' })).error, 'NO_CHALLENGE');
  } finally { await shop.close(); }
});

test('the agent tool layer never exposes key material', async () => {
  const { host, signer, shop } = await setup();
  try {
    const results = [];
    results.push(await host.call('http_get', { url: `${shop.url}/catalog` }));
    const r402 = await host.call('http_get', { url: `${shop.url}/report` }); results.push(r402);
    results.push(await host.call('request_payment', { seller: S.address, item: `${shop.url}/report`, amountDrops: PRICES.report, paymentRequirements: r402.paymentRequirements }));
    results.push(await host.call('http_get', { url: 'https://example.com/' }));
    results.push(await host.call('nope', {}));
    results.push(await host.call('finish', { summary: 'done' }));
    assert.equal(results[3].error, 'URL_NOT_ALLOWED');
    assert.equal(results[4].error, 'UNKNOWN_TOOL');
    for (const [i, r] of results.entries()) noSecrets(`tool result ${i}`, r);
    noSecrets('tool schemas', TOOL_SCHEMAS);
    noSecrets('signer handle', signer);
    assert.deepEqual(Object.keys(signer).sort(), ['address', 'calls', 'sign']);
    noSecrets('signer log', signer.calls());
    const opts = agentSpawnOptions();
    assert.deepEqual(Object.keys(opts.env), ['NODE_NO_WARNINGS']);
    assert.ok(opts.execArgv.some((a) => /^--(experimental-)?permission$/.test(a)));
    assert.ok(opts.execArgv.some((a) => a.startsWith('--allow-fs-read=') && a.endsWith('agent-process.mjs')));
  } finally { await shop.close(); }
});

test('signer signs only for an AUTHORIZED decision whose request matches the voucher, once', async () => {
  const { signer, gov, cert, cd, shop } = await setup();
  await shop.close();
  const terms = { sessionId: '0x' + '01'.repeat(32), buyer: W.address.toLowerCase(), seller: S.address, capDrops: '300000', expiry: Math.floor(Date.now() / 1000) + 600, certificateDigest: '0x' + cd };
  const msg = (cum, nonce = '1') => ({ sessionId: terms.sessionId, buyer: terms.buyer, seller: S.address, cumulativeDrops: cum, nonce, expiry: terms.expiry, certificateDigest: terms.certificateDigest });
  await assert.rejects(signer.sign('dec_unknown', { terms, message: msg('100000') }), /SIGNER_NO_PERMIT/);
  const a = gov.authorize({ requestId: 'r1', requester: cert.requester.id, payer: R.address, rail: 'ap4m-voucher', network: 'xrpl:2', asset: 'XRP', amount: '100000', seller: S.address, voucher: { sessionId: terms.sessionId, nonce: '1' } });
  assert.equal(a.outcome, 'PERMIT');
  await assert.rejects(signer.sign(a.decision.decisionId, { terms, message: msg('200000') }), /SIGNER_REQUEST_MISMATCH/);
  await assert.rejects(signer.sign(a.decision.decisionId, { terms, message: msg('100000', '2') }), /SIGNER_REQUEST_MISMATCH/);
  const { voucher } = await signer.sign(a.decision.decisionId, { terms, message: msg('100000') });
  assert.equal(sim.recoverVoucherSigner(voucher), W.address.toLowerCase());
  await assert.rejects(signer.sign(a.decision.decisionId, { terms, message: msg('100000') }), /SIGNER_ALREADY_SIGNED/);
});

test('recorded governance replays to the same decisions and states (resume)', async () => {
  const { gov, cert, approval, host, shop } = await setup();
  try {
    const r402 = await host.call('http_get', { url: `${shop.url}/report` });
    await host.call('request_payment', { seller: S.address, item: `${shop.url}/report`, amountDrops: PRICES.report, paymentRequirements: r402.paymentRequirements });
    const p402 = await host.call('http_get', { url: `${shop.url}/premium-bundle` });
    await host.call('request_payment', { seller: S.address, item: `${shop.url}/premium-bundle`, amountDrops: PRICES.premium, paymentRequirements: p402.paymentRequirements });
    const again = recordedGovernance({ certificate: cert, approval, adapters: [ap4m, xls68], ops: gov.ops() });
    assert.deepEqual([...again.decisions.keys()], [...gov.decisions.keys()]);
    for (const [id, d] of gov.decisions) assert.deepEqual(again.decisions.get(id), d);
    assert.deepEqual(again.refusals, gov.refusals);
    assert.deepEqual(again.budget(), gov.budget());
  } finally { await shop.close(); }
});

// A scripted stand-in for Ollama (offline test of the IPC loop; the live run uses the real local model).
async function fakeOllama(script) {
  let i = 0;
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const body = JSON.parse(b), step = script[Math.min(i++, script.length - 1)](body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, done: true, done_reason: 'stop', eval_count: 1, message: { role: 'assistant', content: step.content ?? '', thinking: step.thinking, tool_calls: step.calls?.map(([name, args]) => ({ function: { name, arguments: args } })) } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('agent process: isolated (cannot list a key directory), drives tools over IPC; transcript sha256 goes into the receipt', async () => {
  const { host, shop, signer, cert, cd, approval, gov } = await setup();
  const keyDir = mkdtempSync(join(tmpdir(), 'eterna-agent-keys-'));
  writeFileSync(join(keyDir, 'rose.xrpl.json'), JSON.stringify({ seed: R.seed }));
  const ollama = await fakeOllama([
    () => ({ thinking: 'look at the catalog', calls: [['http_get', { url: `${shop.url}/catalog` }]] }),
    () => ({ calls: [['http_get', { url: `${shop.url}/report` }]] }),
    (b) => ({ calls: [['request_payment', { seller: S.address, item: `${shop.url}/report`, amountDrops: '100000', paymentRequirements: JSON.parse(b.messages.at(-1).content).paymentRequirements }]] }),
    () => ({ calls: [['http_get', { url: `${shop.url}/premium-bundle` }]] }),
    () => ({ calls: [['request_payment', { seller: S.address, item: `${shop.url}/premium-bundle`, amountDrops: '250000' }]] }),
    () => ({ content: 'thinking out loud' }),
    () => ({ calls: [['finish', { summary: 'Bought the report; premium refused: PER_TX_EXCEEDED' }]] }),
  ]);
  let t;
  try {
    t = await runAgent({ toolHost: host, ollamaUrl: ollama.url, model: 'fake-model', modelInfo: { digest: 'f'.repeat(64) }, user: instructionFor({ catalogUrl: `${shop.url}/catalog`, seller: S.address }), probePath: keyDir, missionId: 't' });
  } finally { await ollama.close(); await shop.close(); }
  const probe = t.events.find((e) => e.kind === 'isolation_probe');
  assert.equal(probe.readable, false);
  assert.equal(probe.code, 'ERR_ACCESS_DENIED');
  assert.equal(t.toolCalls, 6);
  assert.ok(t.events.some((e) => e.kind === 'harness_nudge'));
  const dec = agentDecisions(t);
  assert.deepEqual(dec.map((d) => d.tool), ['http_get', 'http_get', 'request_payment', 'http_get', 'request_payment', 'finish']);
  assert.equal(dec[2].outcome, 'PERMIT');
  assert.deepEqual([dec[4].outcome, dec[4].code], ['REFUSE', 'PER_TX_EXCEEDED']);
  assert.equal(t.finish.summary, 'Bought the report; premium refused: PER_TX_EXCEEDED');
  noSecrets('transcript', t);
  assert.equal(signer.calls().length, 1);

  // receipt and evidence carry the transcript hash
  const bytes = transcriptBytes(t), h = sha256(bytes);
  const st = host.state();
  const m = { certificate: cert, certificateDigest: cd, approval, accounts: { E: E.address, R: R.address, S: S.address, A: A.address }, readers: [{ url: 'r1' }, { url: 'r2' }],
    model: { name: 'fake-model', digest: 'f'.repeat(64) }, agent: { transcriptFile: 'unified/evidence/agent-transcript-test.json', transcriptSha256: h, toolCalls: t.toolCalls, decisions: dec, finish: t.finish },
    prior: { txs: { agentCreate: { hash: 'A'.repeat(64) }, delegateSet: { hash: 'B'.repeat(64) } } }, txs: { settlement: { hash: 'C'.repeat(64), ledger: 1 } },
    sim: { reports: st.held.map((x) => x.report), refusals: st.refusals, signerCalls: signer.calls(), payments: st.payments, sellerVouchers: [], batch: { batchDigest: 'd'.repeat(64), vouchers: [], redeemedCumulativeDrops: '100000', voucherCount: 1 } },
    unlocks: [...gov.decisions.keys()].map((id) => ({ decisionId: id, unlocked: false, receiptDigest: gov.receipt(id).digest })), unlocked: false };
  const body = buildAgentReceiptBody(m, {});
  assert.equal(body.agent.transcriptSha256, h);
  assert.equal(body.governance.refusals[0].code, 'PER_TX_EXCEEDED');
  assert.notEqual(digestOf(body), digestOf(buildAgentReceiptBody({ ...m, agent: { ...m.agent, transcriptSha256: '0'.repeat(64) } }, {})), 'the receipt digest commits to the transcript hash');
  m.receipt = { body, digest: digestOf(body) };
  const ev = buildAgentEvidence(m, {});
  assert.equal(ev.agent.transcriptSha256, h);
  assert.equal(ev.auditReceipt.transcriptSha256, h);
  const c = Object.fromEntries(ev.components.map((x) => [x.key, x]));
  assert.equal(c['agent-decisions'].status, 'RECORDED');
  assert.equal(c['voucher-sim'].status, 'SIMULATED');
  assert.equal(c['mastercard-network'].status, 'PENDING');
  assert.equal(c.refusal.facts.code, 'PER_TX_EXCEEDED');
  assert.equal(c.refusal.facts.signerCallsForRefusedRequests, 0);
  assert.ok(ev.components.every((x) => x.status !== 'VERIFIED'), 'nothing is VERIFIED without ledger proof');
  assert.deepEqual(ev.reports, [], 'reports stay locked until verified');
});
