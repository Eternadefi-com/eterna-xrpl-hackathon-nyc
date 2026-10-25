#!/usr/bin/env node
// Eterna's x402 Merchant, built ON the AP4M kit's own createX402Merchant (vendor/kit/ap4m-x402.mjs, unmodified). The kit
// issues the 402 challenge, verifies the agent's voucher, redeems it on the PaymentLedger and returns the resource; Eterna
// only chooses what is sold and at what price. Two listings (the kit serves one fixed-price GET /resource per server):
//   :4308  "governed-report"  PRICE_RLUSD (default 0.25)  -> inside the agent's Eterna certificate: PERMIT, paid
//   :4309  "bulk-export"      OVER_CAP_RLUSD (default 5)  -> above the certificate's perTx: Eterna refuses before signing
// APPROVAL-GATED (--approve merchant): the submitter wallet pays XRP gas for every redemption it submits.
// Loopback only (the kit requires HTTPS for anything else). XRPL EVM Testnet only. Node >= 22.13 (node:sqlite).
//   /opt/homebrew/bin/node ap4m/governed-merchant.mjs --approve merchant
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { SERVICE_URL, NETWORK } from './constants.mjs';

const KIT = new URL('./vendor/kit/', import.meta.url);
const P = (...p) => join(homedir(), 'eterna-private', ...p);
if (!process.argv.includes('--approve') || process.argv[process.argv.indexOf('--approve') + 1] !== 'merchant') { console.error('REFUSED: starting the Merchant lets it submit redemptions (gas). Re-run with --approve merchant (RUNBOOK step 5).'); process.exit(2); }
if (!existsSync(new URL('node_modules/@ap4m/sdk/package.json', KIT))) { console.error('kit SDK not installed: RUNBOOK step 0'); process.exit(1); }
const { ethers } = createRequire(new URL('package.json', KIT))('ethers');
const { createX402Merchant, loadX402Context } = await import(pathToFileURL(new URL('ap4m-x402.mjs', KIT).pathname).href);
const cfg = JSON.parse(readFileSync(P('ap4m', 'live-config.json'), 'utf8'));
const keyFile = P('ap4m-merchant-payout', 'payout.key');
const raw = readFileSync(keyFile, 'utf8').trim(); const pk = raw.startsWith('{') ? JSON.parse(raw).privateKey : raw;
const provider = new ethers.JsonRpcProvider(NETWORK.rpcUrl, Number(NETWORK.chainId), { staticNetwork: true });
const submitter = new ethers.Wallet(pk, provider);
if (submitter.address.toLowerCase() !== cfg.merchantPayout.toLowerCase()) throw new Error('submitter key is not the configured payout wallet');
const context = await loadX402Context(SERVICE_URL);
if (context.network !== NETWORK.caip2) throw new Error(`service reports ${context.network}`);
const listings = [
  { port: 4308, state: 'merchant-state-report', price: process.env.PRICE_RLUSD ?? '0.25', content: { product: 'Eterna governed data report', kind: 'per-call data resource', note: 'sold over x402 on the AP4M kit; XRPL EVM Testnet' } },
  { port: 4309, state: 'merchant-state-bulk', price: process.env.OVER_CAP_RLUSD ?? '5', content: { product: 'Eterna bulk export', kind: 'over-cap listing used to show refusal before signing' } },
];
const running = listings.map((l) => {
  const resourceUrl = `http://127.0.0.1:${l.port}/resource`;
  const m = createX402Merchant({ context, provider, submitter, stateDirectory: P('ap4m', l.state), resourceUrl, merchantParticipantId: cfg.merchantId, payout: cfg.merchantPayout,
    amount: ethers.parseUnits(l.price, 18).toString(), content: l.content });
  m.server.listen(l.port, '127.0.0.1', () => console.log(`Merchant ${resourceUrl}: ${l.content.product} for ${l.price} RLUSD (AP4M kit createX402Merchant)`));
  return m;
});
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => Promise.all(running.map((m) => m.close())).finally(() => process.exit(0)));
