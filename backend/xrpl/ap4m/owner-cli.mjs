#!/usr/bin/env node
// OWNER CLI for the AP4M kit integration (XRPL EVM Testnet only). Runs on the owner's Mac with Node >= 22.13
// (/opt/homebrew/bin/node). Never prints a private key. Every step that signs, sends a transaction or calls an
// authenticated AP4M endpoint refuses unless the exact `--approve <step>` flag is given (RUNBOOK.md lists each step).
//
//   read-only (no flag):  preflight | address | verify --claim <id> --channel <id> --redeem <tx> [--payout <tx> --settlement <tx>]
//   read-only demo:       refuse-demo   (over-cap: Eterna refuses before signing; reads the 402 and the chain only)
//   approval-gated:       sign-in | request-channel --cap <RLUSD> | buy | buy-and-settle [--operation <name>] | close
//   local only:           init-governance  (creates Eterna governance + principal keys under ~/eterna-private/ap4m-governance/, 0600)
//
// Config: ~/eterna-private/ap4m/live-config.json (see live-config.example.json). Session token: ~/eterna-private/ap4m/session.json (0600).
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as g from '../commerce/governance.mjs';
import { ADAPTERS } from '../commerce/index.mjs';
import adapter, { readChannel } from './adapter.mjs';
import { CONTRACTS, CODE_HASHES, NETWORK, SERVICE_URL, PROPOSED } from './constants.mjs';
import { evmReader, assertChain, DEFAULT_READERS } from './readers.mjs';
import { createOwnerVoucherSigner, loadOwnerAgentKey, fileReplayStore } from './owner-voucher-signer.mjs';
import { governedPurchase, settleAndVerify, permitIssuer } from './governed-agent.mjs';
import { ethers } from './voucher.mjs';

const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const P = (...p) => join(homedir(), 'eterna-private', ...p);
const KIT = new URL('./vendor/kit/', import.meta.url);
const gate = (step) => { if (arg('approve') !== step) { console.error(`REFUSED: '${step}' changes state on XRPL EVM Testnet or signs with the agent key. Re-run with --approve ${step} after the owner approves it (RUNBOOK.md).`); process.exit(2); } };
const cfg = () => { const f = P('ap4m', 'live-config.json'); if (!existsSync(f)) throw new Error(`missing ${f} (copy ap4m/live-config.example.json)`); return JSON.parse(readFileSync(f, 'utf8')); };
const save = (f, v) => { mkdirSync(P('ap4m'), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify(v, null, 1), { mode: 0o600 }); chmodSync(f, 0o600); };
const session = () => JSON.parse(readFileSync(P('ap4m', 'session.json'), 'utf8')).token;
const agentKey = () => loadOwnerAgentKey(P('mastercard-evm', 'evm.key'));
const readers = () => DEFAULT_READERS.map((u) => evmReader(u));
const kitSdk = () => { if (!existsSync(new URL('node_modules/@ap4m/sdk/package.json', KIT))) throw new Error('kit SDK not installed: RUNBOOK step 0'); return createRequire(new URL('package.json', KIT))('./ap4m-hackathon-sdk.js'); };
const kitX402 = async () => import(pathToFileURL(new URL('ap4m-x402.mjs', KIT).pathname).href);
const evidenceOut = (name, v) => { const d = P('ap4m', 'evidence'); mkdirSync(d, { recursive: true, mode: 0o700 }); const f = join(d, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.json`); writeFileSync(f, JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1), { mode: 0o600 }); console.log(`evidence: ${f}`); };

function governance(c) {
  const gk = JSON.parse(readFileSync(P('ap4m-governance', 'governance.key'), 'utf8')), pk = JSON.parse(readFileSync(P('ap4m-governance', 'principal.key'), 'utf8'));
  const cert = g.buildMissionCertificate({ missionId: c.missionId, task: c.task, requester: { id: c.requester }, payer: { name: c.principalName, xrpl: pk.address },
    sellers: [ethers.getAddress(c.merchantPayout)], rails: ['ap4m-kit'], networks: [NETWORK.caip2], limits: { 'RLUSD-EVM': { token: CONTRACTS.rlusdToken, perTx: c.perTxRlusd, total: c.totalRlusd } },
    maxTransactions: c.maxTransactions, evmAgent: PROPOSED.agent, issuedAt: c.issuedAt, expiry: c.expiry });
  const gov = g.createGovernance({ certificate: cert, approval: g.approveCertificate(cert, pk.seed), adapters: [...ADAPTERS, adapter] });
  return { gov, cert, issuePermit: permitIssuer(gk.seed), governancePublicKey: gk.publicKey, principal: pk.address };
}

try {
  if (cmd === 'address') { console.log(agentKey().address); }
  else if (cmd === 'preflight') {
    const out = { readers: [], contracts: {}, config: null };
    for (const r of readers()) out.readers.push(await assertChain(r));
    const [r] = readers();
    for (const [k, a] of Object.entries(CONTRACTS)) out.contracts[k] = { address: a, codeHashOk: ethers.keccak256(await r.request('eth_getCode', [a, 'latest'])) === CODE_HASHES[k] };
    const pc = await (await fetch(`${SERVICE_URL}/public/config`)).json();
    out.config = { chainIdOk: pc.network.chainId === Number(NETWORK.chainId), contractsOk: Object.entries(CONTRACTS).every(([k, a]) => pc.contracts[k]?.toLowerCase() === a.toLowerCase()), vaultBalance: pc.vaultBalance };
    out.merchants = await (await fetch(`${SERVICE_URL}/public/merchants`)).json();
    const bal = async (a) => ethers.formatEther(BigInt(await r.request('eth_getBalance', [a, 'latest'])));
    out.agent = { address: PROPOSED.agent, xrpGas: await bal(PROPOSED.agent), nonce: Number(BigInt(await r.request('eth_getTransactionCount', [PROPOSED.agent, 'latest']))) };
    if (existsSync(P('ap4m', 'live-config.json'))) { const c = cfg(); out.payout = { address: c.merchantPayout, xrpGas: await bal(c.merchantPayout), distinctFromAgent: c.merchantPayout.toLowerCase() !== PROPOSED.agent.toLowerCase() && c.merchantPayout.toLowerCase() !== (c.fundingWallet ?? '').toLowerCase() }; }
    console.log(JSON.stringify(out, null, 1));
  }
  else if (cmd === 'init-governance') {
    const dir = P('ap4m-governance'); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    for (const name of ['governance', 'principal']) {
      const f = join(dir, `${name}.key`); if (existsSync(f)) { console.log(`${name}: exists`); continue; }
      const seed = keypairs.generateSeed({ algorithm: 'ed25519' }), kp = keypairs.deriveKeypair(seed);
      writeFileSync(f, JSON.stringify({ purpose: `Eterna ${name} key for the AP4M hackathon governance (off-chain approvals only; cannot move funds)`, seed, publicKey: kp.publicKey, address: keypairs.deriveAddress(kp.publicKey) }), { mode: 0o600, flag: 'wx' });
      console.log(`${name}: created ${f}`);
    }
  }
  else if (cmd === 'sign-in') {
    gate('sign-in');
    const c = cfg(), k = agentKey(), sdk = kitSdk();
    const s = createOwnerVoucherSigner({ wallet: k.wallet(), trustedGovernanceKey: 'none' }); s.armSignIn();
    const sess = await sdk.signIn(SERVICE_URL, c.teamName, s);
    save(P('ap4m', 'session.json'), { token: sess.token, expiresInSeconds: sess.expiresInSeconds, at: new Date().toISOString() });
    console.log(`signed in as ${k.address}; token saved (0600), expires in ${sess.expiresInSeconds}s`);
  }
  else if (cmd === 'request-channel') {
    gate('request-channel');
    const cap = arg('cap'); if (!/^\d+(\.\d+)?$/.test(cap ?? '')) throw new Error('--cap <RLUSD>');
    const sdk = kitSdk(), k = agentKey(), provider = new ethers.JsonRpcProvider(NETWORK.rpcUrl, Number(NETWORK.chainId), { staticNetwork: true });
    const ch = await sdk.requestChannel(SERVICE_URL, session(), k.wallet().connect(provider), { capRlusd: cap, merchantId: cfg().merchantId || undefined });
    evidenceOut('request-channel', ch); console.log(`channel ${ch.channel_id} ${ch.channel_status} cap ${ethers.formatUnits(ch.cap_wei, 18)} RLUSD`);
  }
  else if (cmd === 'buy' || cmd === 'buy-and-settle' || cmd === 'refuse-demo') {
    if (cmd === 'buy') gate('purchase');
    if (cmd === 'buy-and-settle') gate('purchase+settle');
    const c = cfg(), k = agentKey(), { gov, issuePermit, governancePublicKey, principal } = governance(c);
    const provider = new ethers.JsonRpcProvider(NETWORK.rpcUrl, Number(NETWORK.chainId), { staticNetwork: true });
    const x = await kitX402(), context = await x.loadX402Context(SERVICE_URL);
    const signer = createOwnerVoucherSigner({ wallet: k.wallet(), trustedGovernanceKey: governancePublicKey, replay: fileReplayStore(P('ap4m', 'used-permits.json')) });
    // refuse-demo asks the Merchant for an over-cap resource (config.overCapResourceUrl, priced above perTx): Eterna refuses
    // before signing, so the kit is never reached. It signs nothing and sends nothing (it reads the 402 and the chain only).
    const resourceUrl = cmd === 'refuse-demo' ? c.overCapResourceUrl : c.merchantResourceUrl;
    const kit = cmd === 'refuse-demo' ? { context, buyResource: () => { throw new Error('refuse-demo never reaches the kit'); } } : { context, buyResource: x.buyResource };
    const r = await governedPurchase({ gov, signer, issuePermit, kit, readers: readers(), resourceUrl, channelId: c.channelId, requester: c.requester, payer: principal,
      requestId: `${cmd}-${Date.now()}`, operation: arg('operation'), stateDirectory: P('ap4m', 'agent-state'), provider });
    evidenceOut(cmd === 'refuse-demo' ? 'refusal' : 'purchase', r);
    console.log(JSON.stringify({ outcome: r.outcome, code: r.code ?? null, redemptionTx: r.purchase?.transactionHash ?? null, claimId: r.purchase?.claimId ?? null, signatures: r.signerLog?.length ?? 0, resource: r.resource ?? null }, null, 1));
    if (cmd === 'buy-and-settle' && r.outcome === 'PAID') {
      const sdk = kitSdk(), token = session();
      const service = { settle: (ch) => sdk.settle(SERVICE_URL, token, ch), recordRedemption: async (tx) => { const res = await fetch(`${SERVICE_URL}/public/participant/record-redemption`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ tx_hash: tx }) }); if (!res.ok) throw new Error(`record-redemption HTTP ${res.status}`); return res.json(); } };
      const out = await settleAndVerify({ gov, paid: r, service, readers: readers(), principal });
      evidenceOut('settle-verify-unlock', out);
      console.log(JSON.stringify({ evidence: out.evidence.status, unlocked: out.unlock.unlocked, payoutTx: out.evidence.facts.payoutTx, settlementTx: out.evidence.facts.settlementTx, ap4mReceipt: out.ap4mReceiptUrl ? `${SERVICE_URL}${out.ap4mReceiptUrl}` : null, receiptDigest: out.receipt.digest }, null, 1));
    }
  }
  else if (cmd === 'close') {
    gate('close');
    const sdk = kitSdk(), k = agentKey();
    const r = await sdk.closeChannel(SERVICE_URL, session(), k.wallet(), cfg().channelId);   // signs the CloseChannelCheckpoint with the agent key
    evidenceOut('close', r); console.log(`closed ${r.channel_id} tx ${r.tx_hash}`);
  }
  else if (cmd === 'verify') {
    const ch = await readChannel(readers()[0], arg('channel'));
    const ev = await adapter.verify({ claimId: arg('claim'), channelId: arg('channel'), redemptionTx: arg('redeem'), payoutTx: arg('payout'), settlementTx: arg('settlement'), principal: arg('principal'),
      expected: JSON.parse(readFileSync(arg('expected'), 'utf8')) }, readers());
    console.log(JSON.stringify({ channel: ch, evidence: ev }, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1));
  }
  else { console.error('usage: preflight | address | init-governance | sign-in | request-channel | buy | buy-and-settle | refuse-demo | close | verify (see header)'); process.exit(1); }
} catch (e) { console.error(e.code ?? 'ERROR', e.message); process.exit(1); }
