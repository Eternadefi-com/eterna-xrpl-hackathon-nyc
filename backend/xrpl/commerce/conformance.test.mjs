import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ADAPTERS, assertAdapter } from './index.mjs';
import { readOnlyReader } from './readers.mjs';

test('all four adapters conform to the contract', () => {
  assert.deepEqual(ADAPTERS.map((a) => a.id), ['xrp-paychan', 'rlusd', 'xls68-sponsored', 'ap4m-voucher']);
  for (const a of ADAPTERS) {
    assert.equal(assertAdapter(a), a);
    const d = a.describe();
    assert.ok(d.can.length && d.cannot.length, a.id);
    const c = a.challenge({ amount: a.assets[0] === 'RLUSD' ? '1' : '100000', payTo: 'rhtjim3u6C2cntaZrb39YTM4rx2XNCgrXp', network: a.networks.at(-1), resource: 'http://127.0.0.1/x', description: 'x' });
    assert.equal(c.x402Version, 2, a.id); assert.equal(c.accepts.length, 1, a.id); assert.ok(a.networks.includes(c.accepts[0].network), a.id);
  }
  assert.deepEqual(ADAPTERS.map((a) => a.mode), ['LIVE_CAPABLE', 'LIVE_CAPABLE', 'LIVE_CAPABLE', 'SIMULATED']);
});

test('assertAdapter rejects broken adapters', () => {
  const good = ADAPTERS[2];
  const broken = (o) => () => assertAdapter({ ...good, ...o });
  assert.throws(broken({ id: 'Bad Id' }), /ADAPTER_INVALID/);
  assert.throws(broken({ assets: [] }), /assets/);
  assert.throws(broken({ networks: ['mainnet'] }), /networks/);
  assert.throws(broken({ mode: 'LIVE' }), /mode/);
  assert.throws(broken({ verify: undefined }), /verify/);
  assert.throws(broken({ describe: () => ({ ...good.describe(), cannot: [] }) }), /cannot/);
  assert.throws(broken({ describe: () => ({ ...good.describe(), lifecycle: ['AUTHORIZED', 'UNLOCKED'] }) }), /lifecycle/);
  assert.throws(broken({ mode: 'SIMULATED' }), /SIMULATED adapter cannot claim VERIFIED/);
});

test('no submit, sign-with-real-key or faucet path in commerce/ (readers are read-only by construction)', async () => {
  const dir = new URL('./', import.meta.url), adir = new URL('./adapters/', import.meta.url);
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'test-support.mjs').map((f) => new URL(f, dir)), ...readdirSync(adir).map((f) => new URL(f, adir))];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /'submit'|submitAndWait|faucetFund|faucet\.devnet|eterna-private|\.sign\(|cosign\(/, f.pathname);
  }
  await assert.rejects(readOnlyReader('https://s1.ripple.com:51234', 'xrpl:0').request('submit', { tx_blob: '00' }), /METHOD_REFUSED/);
  assert.throws(() => readOnlyReader('https://evil.example', 'xrpl:0'), /READER_HOST_REFUSED/);
  assert.throws(() => readOnlyReader('https://s1.ripple.com:51234', 'xrpl:2'), /READER_HOST_REFUSED/);
});

test('product definitions match the adapters', () => {
  for (const f of ['xrp-micropayments', 'rlusd-payments', 'sponsored-execution', 'voucher-commerce']) {
    const p = JSON.parse(readFileSync(new URL(`./products/${f}.json`, import.meta.url), 'utf8'));
    const a = ADAPTERS.find((x) => x.id === p.adapter);
    assert.ok(a, f); assert.equal(p.rail, a.rail); assert.equal(p.mode, a.mode); assert.deepEqual(p.assets, a.assets); assert.deepEqual(p.networks, a.networks);
    assert.deepEqual(p.can, a.describe().can); assert.deepEqual(p.cannot, a.describe().cannot); assert.deepEqual(p.proofConditions, a.describe().proofConditions);
    assert.ok(['REAL', 'LOCAL_ONLY', 'SIMULATED', 'BLOCKED'].includes(p.status.state) && p.status.reason, f);
  }
});
