// Offline tests for the AP4M kit integration. Two kinds of data, never mixed up:
//   - REAL public chain data: fixtures/public-tape.json (a third-party hackathon payment, captured read-only) -> parser,
//     digest and claim-id conformance, and verify() on two independent readers;
//   - SYNTHETIC stubs (test-support.mjs, STUB_*) -> governance paths (permit / refuse / over-cap before signing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as g from '../commerce/governance.mjs';
import { assertAdapter } from '../commerce/contract.mjs';
import { ADAPTERS } from '../commerce/index.mjs';
import { key } from '../commerce/test-support.mjs';
import adapter from './adapter.mjs';
import * as V from './voucher.mjs';
import { CONTRACTS, NETWORK, LEDGER_ABI, VAULT_ABI, VOUCHER_DOMAIN_NAME, RESOURCE_BINDING_DOMAIN_NAME, PAYMENT_CLAIM_ID_TYPE } from './constants.mjs';
import { replayReader, evmReader } from './readers.mjs';
import { createOwnerVoucherSigner, buildVoucherPermit, signPermit } from './owner-voucher-signer.mjs';
import { governedPurchase, settleAndVerify, permitIssuer } from './governed-agent.mjs';
import { STUB_AGENT_KEY, STUB_OTHER_KEY, STUB_PAYOUT, STUB_CHANNEL, STUB_RESOURCE_URL, STUB_merchant, STUB_kit, STUB_reader, STUB_settlement, STUB_service, stubChannel } from './test-support.mjs';

const require = createRequire(import.meta.url);
const { ethers } = require('ethers');
const ROSE = key(0x21), GOV = key(0x41), BADGOV = key(0x42);
const T0 = Date.parse('2026-10-24T12:00:00Z');
const AGENT = new ethers.Wallet(STUB_AGENT_KEY).address;
const W = (s) => ethers.parseUnits(s, 18);
const certFor = (o = {}) => g.buildMissionCertificate({ missionId: 'ap4m-1', task: 'buy one governed data resource over x402 (AP4M kit, XRPL EVM Testnet)', requester: { id: 'agent:eterna-ap4m' },
  payer: { name: 'Owner (test)', xrpl: ROSE.address }, sellers: [STUB_PAYOUT], rails: ['ap4m-kit'], networks: ['eip155:1449000'],
  limits: { 'RLUSD-EVM': { token: CONTRACTS.rlusdToken, perTx: '0.5', total: '1' } }, maxTransactions: 5, evmAgent: AGENT,
  issuedAt: new Date(T0).toISOString(), expiry: new Date(T0 + 3600e3).toISOString(), ...o });
const engine = (cert = certFor()) => g.createGovernance({ certificate: cert, approval: g.approveCertificate(cert, ROSE.seed), adapters: [...ADAPTERS, adapter], now: () => T0 + 1000 });
const signerFor = (o = {}) => createOwnerVoucherSigner({ privateKey: STUB_AGENT_KEY, trustedGovernanceKey: GOV.publicKey, now: () => T0 + 1000, ...o });
let n = 0;
const purchase = (o = {}) => {
  const channel = o.channel ?? stubChannel();
  const merchant = o.merchant ?? STUB_merchant({ priceWei: o.priceWei ?? W('0.25'), channel, ...(o.raise ? { raisePriceOnRetryTo: o.raise } : {}) });
  const kit = o.kit ?? STUB_kit(), signer = o.signer ?? signerFor();
  return { kit, signer, merchant, run: () => governedPurchase({ gov: o.gov, signer, issuePermit: o.issuePermit ?? permitIssuer(GOV.seed), kit, readers: [STUB_reader('https://rpc.testnet.xrplevm.org', { channel })],
    resourceUrl: STUB_RESOURCE_URL, channelId: STUB_CHANNEL, requester: o.requester ?? 'agent:eterna-ap4m', payer: ROSE.address, requestId: `ap4m-${++n}`, stateDirectory: '/nonexistent', fetch: merchant, now: () => T0 + 1000 }) };
};

// ---- the kit's definitions --------------------------------------------------------------------------------------------
const TAPE = JSON.parse(readFileSync(new URL('./fixtures/public-tape.json', import.meta.url), 'utf8'));
const realReaders = () => TAPE.readers.map((r) => replayReader(r.url, TAPE.tape));
const receiptOf = (h) => TAPE.tape[TAPE.readers[0].url][`eth_getTransactionReceipt ${JSON.stringify([h])}`];

test('REAL public chain data: VoucherRedeemed parses; our voucher digest and claim id re-derive the on-chain values exactly', () => {
  const [e] = V.voucherRedeemedLogs(receiptOf(TAPE.redeemTx).logs);
  assert.equal(e.claimId, TAPE.claimId);
  assert.equal(V.voucherDigest({ channelId: e.channelId, cumulativeAmount: e.cumulativeAmount }), e.voucherDigest, 'EIP-712 domain/types match the PaymentLedger');
  assert.equal(V.deriveClaimId({ channelId: e.channelId, previousCumulativeAmount: e.previousCumulativeAmount, cumulativeAmount: e.cumulativeAmount }), e.claimId);
  const [cp] = V.claimPaidLogs(receiptOf(TAPE.payoutTx).logs), [sr] = V.settlementRecordedLogs(receiptOf(TAPE.settlementTx).logs);
  assert.equal(cp.claimId, e.claimId); assert.equal(cp.amount, e.amount); assert.equal(cp.payout, e.payout);
  assert.equal(sr.claimId, e.claimId); assert.equal(sr.channelId, e.channelId);
  assert.ok(V.transferLogs(receiptOf(TAPE.payoutTx).logs).some((t) => t.from === ethers.getAddress(CONTRACTS.pooledEscrowVault) && t.to === e.payout && t.value === e.amount), 'RLUSD moved vault -> payout');
});

test('REAL public chain data: verify() from two independent readers (XRPL EVM RPC + Blockscout) -> VERIFIED; any tamper -> FAILED', async () => {
  const [e] = V.voucherRedeemedLogs(receiptOf(TAPE.redeemTx).logs);
  const expected = { voucherDigest: e.voucherDigest, previousCumulativeAmount: e.previousCumulativeAmount.toString(), cumulativeAmount: e.cumulativeAmount.toString(), amountWei: e.amount.toString(), payTo: e.payout, agent: e.agent };
  const ref = { claimId: TAPE.claimId, channelId: TAPE.channelId, redemptionTx: TAPE.redeemTx, payoutTx: TAPE.payoutTx, settlementTx: TAPE.settlementTx, expected, principal: 'third-party (not Eterna)' };
  const ev = await adapter.verify(ref, realReaders());
  assert.equal(ev.status, 'VERIFIED', JSON.stringify(ev.facts.readers));
  assert.equal(ev.facts.readersAgreeing, 2); assert.equal(ev.facts.blockHashesAgree, true);
  assert.deepEqual(ev.facts.readers.map((r) => r.label), ['xrplevm-rpc', 'blockscout']);
  assert.equal(ev.txHash, V.toEngineHash(TAPE.payoutTx));
  assert.equal((await adapter.verify({ ...ref, expected: { ...expected, amountWei: '1' } }, realReaders())).status, 'FAILED', 'amount not as authorized');
  assert.equal((await adapter.verify({ ...ref, expected: { ...expected, payTo: STUB_PAYOUT } }, realReaders())).status, 'FAILED', 'payout not the authorized seller');
  const one = await adapter.verify(ref, realReaders().slice(0, 1));
  assert.notEqual(one.status, 'VERIFIED', 'one reader is never enough');
  const forked = [realReaders()[0], replayReader(TAPE.readers[1].url, TAPE.tape, (m, p, r) => (m === 'eth_getTransactionReceipt' && r ? { ...r, blockHash: `0x${'ee'.repeat(32)}` } : r))];
  assert.equal((await adapter.verify(ref, forked)).facts.blockHashesAgree, false);
  assert.notEqual((await adapter.verify(ref, forked)).status, 'VERIFIED', 'readers disagree on block hashes');
});

test('kit conformance: ABI strings, EIP-712 names and claim type appear verbatim in the vendored kit (skipped if not vendored)', (t) => {
  const dist = new URL('./vendor/kit/sdk-package/dist/', import.meta.url);
  if (!existsSync(dist)) return t.skip('vendor/kit not present: run ap4m/vendor/fetch-kit.sh');
  const text = ['participant-requests.js', 'pooled-escrow-vault.js', 'payment-ledger.js', 'x402.js'].map((f) => readFileSync(new URL(f, dist), 'utf8')).join('\n');
  for (const s of [...LEDGER_ABI, ...VAULT_ABI]) assert.ok(text.includes(JSON.stringify(s)), s);
  for (const s of [VOUCHER_DOMAIN_NAME, RESOURCE_BINDING_DOMAIN_NAME, PAYMENT_CLAIM_ID_TYPE]) assert.ok(text.includes(s), s);
  const sdk = readFileSync(new URL('./vendor/kit/ap4m-hackathon-sdk.js', import.meta.url), 'utf8');
  assert.ok(sdk.includes("name: 'AP4M Payment Ledger'") && sdk.includes("{ name: 'channelId', type: 'bytes32' }") && sdk.includes("{ name: 'cumulativeAmount', type: 'uint256' }"));
});

test('adapter conforms to the existing adapter contract (LIVE_CAPABLE, eip155:1449000, RLUSD-EVM)', () => {
  assert.doesNotThrow(() => assertAdapter(adapter));
  assert.equal(adapter.mode, 'LIVE_CAPABLE'); assert.deepEqual(adapter.networks, ['eip155:1449000']);
  const d = adapter.describe();
  assert.ok(d.cannot.some((c) => /not KYA or PSP certification/.test(c)), 'never claims KYA/PSP');
  assert.ok(d.proofConditions.facts.some((f) => f.fact === 'readersAgreeing' && f.min === 2));
});

test('x402 challenge comes from the merchant 402; field binding: amount, payTo, channel, ledger, asset, network', async () => {
  const m = STUB_merchant({ priceWei: W('0.25') });
  const c = await adapter.challenge({ resourceUrl: STUB_RESOURCE_URL, channelId: STUB_CHANNEL, fetch: m });
  assert.equal(c.status, 402); assert.equal(c.amountWei, W('0.25')); assert.equal(c.payTo, STUB_PAYOUT); assert.equal(c.ledger, ethers.getAddress(CONTRACTS.paymentLedger));
  const req = adapter.toRequest(c, { requestId: 'x', requester: 'r', payer: ROSE.address, agent: AGENT });
  assert.equal(req.amount, '0.25'); assert.equal(req.asset, 'RLUSD-EVM'); assert.equal(req.network, 'eip155:1449000'); assert.equal(req.voucher.sessionId, STUB_CHANNEL);
  const bad = (mut) => { const pr = m.required(W('0.25')); mut(pr.accepts[0]); return () => V.readChallenge(V.encodeHeader(pr)); };
  assert.throws(bad((a) => { a.network = 'eip155:8453'; }), /X402_INVALID/, 'Base or any other chain refused');
  assert.throws(bad((a) => { a.extra.pricingMode = 'dynamic'; }), /X402_INVALID/);
  assert.throws(bad((a) => { a.scheme = 'exact'; }), /X402_INVALID/);
  assert.throws(() => V.readChallenge('not base64!'), /X402_INVALID/);
});

test('PERMIT -> exact voucher draft -> owner signer signs ONLY the permitted voucher + binding (stub kit) -> REDEEMED', async () => {
  const gov = engine(), p = purchase({ gov });
  const r = await p.run();
  assert.equal(r.outcome, 'PAID', JSON.stringify(r.trace));
  assert.equal(r.decision.state, 'REDEEMED');
  assert.deepEqual(r.signerLog.map((x) => x.kind), ['Voucher', 'X402ResourceBinding']);
  const t = r.draft.typedData;
  assert.equal(t.domain.name, 'AP4M Payment Ledger'); assert.equal(t.domain.chainId, 1449000n); assert.equal(t.domain.verifyingContract, ethers.getAddress(CONTRACTS.paymentLedger));
  assert.equal(t.message.cumulativeAmount, W('0.25')); assert.equal(t.message.channelId, STUB_CHANNEL);
  assert.equal(r.purchase.claimId, r.draft.claimId, 'claim id Eterna predicted == claim id the kit flow derives');
  assert.equal(ethers.verifyTypedData(t.domain, t.types, t.message, r.purchase.agentSignature), AGENT, 'signature recovers to the certified agent');
  assert.equal(r.draft.ap4mAttestations.merchantPspSignerIsServicePsp, true);
  assert.equal(gov.budget()['RLUSD-EVM'].reserved, '0.25');
});

test('OVER-CAP is refused BEFORE signing: per-tx, total and the on-chain channel cap; refusal receipts; kit never called', async () => {
  const gov = engine();
  const big = purchase({ gov, priceWei: W('0.75') });
  const r1 = await big.run();
  assert.equal(r1.outcome, 'REFUSED'); assert.equal(r1.code, 'PER_TX_EXCEEDED'); assert.equal(r1.signed, false);
  assert.deepEqual(r1.signerLog, []); assert.equal(big.kit.called(), 0);
  assert.equal(r1.receipt.body.refusal.code, 'PER_TX_EXCEEDED'); assert.equal(r1.receipt.body.refusal.signed, false); assert.match(r1.receipt.digest, /^[0-9a-f]{64}$/);
  // total: 0.5 + 0.5 fits the 1 RLUSD total; the third is refused
  let ch = stubChannel();
  for (const _ of [1, 2]) { const ok = await purchase({ gov, priceWei: W('0.5'), channel: ch }).run(); assert.equal(ok.outcome, 'PAID'); ch = stubChannel({ redeemed: ch.redeemed + W('0.5') }); }
  const r3 = purchase({ gov, priceWei: W('0.1'), channel: ch });
  const out3 = await r3.run();
  assert.equal(out3.code, 'TOTAL_EXCEEDED'); assert.equal(r3.kit.called(), 0); assert.deepEqual(out3.signerLog, []);
  // on-chain channel cap (AP4M Authorized Spend Limit) below Eterna's limit: refused in prepare, budget released
  const gov2 = engine();
  const tight = purchase({ gov: gov2, priceWei: W('0.5'), channel: stubChannel({ cap: W('0.4') }) });
  const r4 = await tight.run();
  assert.equal(r4.code, 'CAP_EXCEEDED'); assert.equal(tight.kit.called(), 0); assert.deepEqual(r4.signerLog, []);
  assert.equal(r4.decision.state, 'FAILED'); assert.equal(gov2.budget()['RLUSD-EVM'].reserved, '0');
});

test('refusals before signing: wrong agent wallet, unapproved merchant payout, closed channel, foreign agent on the channel', async () => {
  const gov = engine();   // each refused PERMIT keeps its voucher nonce burned, so each case below uses a fresh engine where needed
  const other = createOwnerVoucherSigner({ privateKey: STUB_OTHER_KEY, trustedGovernanceKey: GOV.publicKey, now: () => T0 + 1000 });
  assert.equal((await purchase({ gov, signer: other, channel: stubChannel({ agent: other.address }) }).run()).code, 'WRONG_AGENT_WALLET');
  assert.equal((await purchase({ gov, channel: stubChannel({ payout: ethers.getAddress(`0x${'66'.repeat(20)}`) }) }).run()).code, 'SELLER_NOT_APPROVED');
  assert.equal((await purchase({ gov, channel: stubChannel({ status: 2 }) }).run()).code, 'CHANNEL_NOT_OPEN');
  assert.equal((await purchase({ gov, channel: stubChannel({ status: 1 }) }).run()).code, 'REPLAYED_VOUCHER_NONCE', 'same channel + cumulative amount is never permitted twice');
  assert.equal((await purchase({ gov: engine(), channel: stubChannel({ agent: other.address }) }).run()).code, 'AGENT_MISMATCH');
  assert.equal((await purchase({ gov: engine(), requester: 'agent:someone-else' }).run()).code, 'WRONG_REQUESTER');
});

test('owner signer: refuses without a permit, with a forged permit, a raised price, a replay, other typed data, raw messages and transactions', async () => {
  const s = signerFor();
  const t = V.voucherTypedData({ channelId: STUB_CHANNEL, cumulativeAmount: W('0.25') });
  await assert.rejects(s.signTypedData(t.domain, t.types, t.message), /NO_PERMIT/);
  await assert.rejects(s.signMessage('hello'), /SIGN_IN_NOT_ARMED/);
  assert.throws(() => s.sendTransaction({ to: CONTRACTS.paymentLedger }), /TX_REFUSED/);
  // merchant raises the price between Eterna's read and the kit's signing: the kit's own maximumAmount (= the permitted
  // amount) stops it; and if a client ignored that, the owner signer refuses. Nothing is signed; the budget is released.
  const gov = engine(), r0 = await purchase({ gov, priceWei: W('0.25'), raise: W('0.3') }).run();
  assert.equal(r0.signed, false); assert.match(r0.reason, /purchase authority/); assert.equal(gov.budget()['RLUSD-EVM'].reserved, '0');
  const govB = engine(), r = await purchase({ gov: govB, priceWei: W('0.25'), raise: W('0.3'), kit: STUB_kit({ ignoreMaximum: true }) }).run();
  assert.equal(r.outcome, 'REFUSED'); assert.match(r.reason, /VOUCHER_PERMIT_MISMATCH/); assert.deepEqual(r.signerLog, []);
  assert.equal(r.decision.state, 'FAILED'); assert.equal(govB.budget()['RLUSD-EVM'].reserved, '0');
  // forged permit (signed by another governance key) and replayed permit
  const gov2 = engine();
  const ch = stubChannel(), m = STUB_merchant({ priceWei: W('0.25'), channel: ch });
  const c = await adapter.challenge({ resourceUrl: STUB_RESOURCE_URL, channelId: STUB_CHANNEL, fetch: m });
  const d = gov2.authorize(adapter.toRequest(c, { requestId: 'p1', requester: 'agent:eterna-ap4m', payer: ROSE.address, agent: AGENT })).decision;
  const draft = gov2.route(d, { challenge: c, channel: ch, nowSeconds: Math.floor(T0 / 1000) });
  const body = buildVoucherPermit({ decision: d, draft, certificateDigest: d.certificateDigest, expiresAt: new Date(T0 + 60e3).toISOString() });
  assert.throws(() => s.arm(signPermit(body, BADGOV.seed)), /PERMIT_SIGNATURE_INVALID/);
  assert.throws(() => s.arm({ ...signPermit(body, GOV.seed), cumulativeAmount: W('9').toString() }), /PERMIT_SIGNATURE_INVALID/, 'altered after signing');
  const good = signPermit(body, GOV.seed);
  s.arm(good);
  const cd = V.resourceBindingTypedData({ resourceDigest: draft.resourceDigest, voucherDigest: draft.voucherDigest });
  await assert.rejects(s.signTypedData(cd.domain, cd.types, cd.message), /ORDER_INVALID/, 'binding before voucher');
  await assert.rejects(s.signTypedData({ ...draft.typedData.domain, chainId: 1440000n }, draft.typedData.types, draft.typedData.message), /TYPED_DATA_REFUSED/, 'Mainnet chain id');
  s.arm(good);
  await s.signTypedData(draft.typedData.domain, draft.typedData.types, draft.typedData.message);
  await s.signTypedData(cd.domain, cd.types, cd.message);
  assert.throws(() => s.arm(good), /PERMIT_REPLAYED/);
  assert.throws(() => signerFor({ now: () => T0 + 120e3 }).arm(good), /PERMIT_EXPIRED/);
});

test('settleAndVerify: SETTLED needs the payout tx; UNLOCKED only on two agreeing readers (SYNTHETIC receipts)', async () => {
  const gov = engine(), r = await purchase({ gov }).run();
  const s = STUB_settlement({ draft: r.draft });
  const readers = ['https://rpc.testnet.xrplevm.org', 'https://explorer.testnet.xrplevm.org/api/eth-rpc'].map((u) => STUB_reader(u, { receipts: s.receipts }));
  const service = STUB_service({ payoutTx: s.payoutTx, settleTx: s.settleTx });
  const out = await settleAndVerify({ gov, paid: r, service, readers, principal: ROSE.address });
  assert.equal(out.evidence.status, 'VERIFIED', JSON.stringify(out.evidence.facts.readers));
  assert.equal(out.unlock.unlocked, true, JSON.stringify(out.unlock));
  assert.equal(r.decision.state, 'UNLOCKED'); assert.equal(gov.budget()['RLUSD-EVM'].committed, '0.25');
  assert.deepEqual(service.recorded, [s.redeem]);
  assert.deepEqual(out.receipt.body.history.map((h) => h.state), ['AUTHORIZED', 'VOUCHER_VERIFIED', 'REDEEMED', 'SETTLED', 'VERIFIED', 'UNLOCKED']);
  // a payout to someone else never unlocks
  const gov2 = engine(), r2 = await purchase({ gov: gov2 }).run();
  const s2 = STUB_settlement({ draft: r2.draft, payout: ethers.getAddress(`0x${'77'.repeat(20)}`) });
  const out2 = await settleAndVerify({ gov: gov2, paid: r2, service: STUB_service({ payoutTx: s2.payoutTx, settleTx: s2.settleTx }), readers: readers.map((x) => STUB_reader(x.url, { receipts: s2.receipts })), principal: ROSE.address });
  assert.equal(out2.evidence.status, 'FAILED'); assert.equal(out2.unlock.unlocked, false); assert.notEqual(r2.decision.state, 'UNLOCKED');
});

test('read-only boundary: readers refuse every write method and unknown hosts; no Mainnet values in ap4m/', () => {
  const r = evmReader(NETWORK.rpcUrl);
  for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4']) assert.rejects(r.request(m, []), /METHOD_REFUSED/);
  assert.throws(() => evmReader('https://rpc.xrplevm.org'), /READER_HOST_REFUSED/, 'Mainnet RPC is not allow-listed');
  for (const f of ['constants.mjs', 'adapter.mjs', 'readers.mjs', 'voucher.mjs', 'owner-voucher-signer.mjs', 'governed-agent.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.ok(!/1440000[^0-9]|rpc\.xrplevm\.org|eip155:1440000/.test(src.replace(/chainId: 1440000n/g, '')), `${f} has a Mainnet value`);
    assert.ok(!/BEGIN|privateKey\s*[:=]\s*['"]0x[0-9a-f]{64}/i.test(src), `${f} embeds a key`);
  }
});

test('governance extension stays backward compatible: RLUSD-EVM is its own asset; XRPL certificates unaffected', () => {
  assert.equal(g.evmUnits('0.25'), W('0.25')); assert.equal(g.evmDecimal(W('1.5')), '1.5'); assert.throws(() => g.evmUnits('0.1234567890123456789'), /AMOUNT_INVALID/);
  assert.throws(() => certFor({ networks: ['xrpl:1'] }), /CERT_INVALID/, 'RLUSD-EVM needs eip155:1449000');
  assert.throws(() => certFor({ evmAgent: 'rNotAnEvmAddress' }), /CERT_INVALID/);
  assert.throws(() => certFor({ limits: { 'RLUSD-EVM': { perTx: '1', total: '2' } } }), /CERT_INVALID/, 'token contract required');
  const e = engine();
  assert.equal(e.authorize({ requestId: 'q', requester: 'agent:eterna-ap4m', payer: ROSE.address, agent: AGENT, rail: 'ap4m-kit', network: 'eip155:1449000', asset: 'RLUSD', amount: '0.1', seller: STUB_PAYOUT }).code, 'ASSET_NOT_ALLOWED', 'XRPL RLUSD is not RLUSD-EVM');
});
