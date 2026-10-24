// Test support: fixed fake keys and SYNTHETIC ledger tapes (clearly not real ledger data) for the failure and success
// paths that real recorded evidence cannot cover. Real read-only responses live in fixtures/readonly-tape.json.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as x68 from '../xls68/xls68.mjs';
import { cosign } from '../unified/tx.mjs';
import { replayReader } from './readers.mjs';
import { canonicalJson } from '../unified/common.mjs';

const require = createRequire(import.meta.url);
const keypairs = require('ripple-keypairs');
const codec = require('ripple-binary-codec');

export const key = (b) => { const seed = keypairs.generateSeed({ entropy: new Uint8Array(16).fill(b), algorithm: 'ed25519' }); const k = keypairs.deriveKeypair(seed); return { seed, ...k, address: keypairs.deriveAddress(k.publicKey) }; };
export const REAL = JSON.parse(readFileSync(new URL('./fixtures/readonly-tape.json', import.meta.url), 'utf8')).tape;
export const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
export const realReaders = (network) => Object.keys(REAL).filter((u) => ({ 'xrpl:0': /ripple\.com|xrplcluster/, 'xrpl:1': /altnet|testnet\.xrpl-labs/, 'xrpl:2': /devnet/ })[network].test(u))
  .map((u) => replayReader(u, network, REAL));

const H = (c) => c.repeat(64);
const node = (Account, prev, fin, extra = {}) => ({ ModifiedNode: { LedgerEntryType: 'AccountRoot', LedgerIndex: H('A'), FinalFields: { Account, Balance: fin, Flags: 0, OwnerCount: 0, Sequence: 9, ...extra }, PreviousFields: { Balance: prev } } });
const ledgerResp = (i, hash) => ({ ledger_hash: hash, ledger_index: i, validated: true, ledger: { ledger_hash: hash } });
/** SYNTHETIC tape builder: tapes[url] keyed exactly like recording() keys. */
const tapeFor = (urls, entries) => Object.fromEntries(urls.map((u, i) => [u, Object.fromEntries(entries(i))]));
const k = (m, p) => `${m} ${canonicalJson(p)}`;

/** A co-signed, fee-sponsored (optionally delegated) Devnet Payment with a matching meta, as binary tx responses. */
export function sponsoredTape({ payer, delegate, seller, sponsor, amount, memos, result = 'tesSUCCESS', validated = true, readers = 2, ledgerHashes = ['B', 'B'], feePaidBy }) {
  const tx = { TransactionType: 'Payment', Account: payer.address, Destination: seller, Amount: amount, Fee: '12', Sequence: 3, Sponsor: sponsor.address, SponsorFlags: 1,
    ...(delegate ? { Delegate: delegate.address } : {}), ...(memos ? { Memos: memos } : {}) };
  const s = cosign(tx, { signerKey: (delegate ?? payer).seed, sponsorKey: sponsor.seed });
  const ok = result === 'tesSUCCESS';
  const meta = { TransactionIndex: 0, TransactionResult: result, AffectedNodes: [node((feePaidBy ?? sponsor).address, '1000000', String(1000000 - 12)),
    ...(ok ? [node(payer.address, '50000000', String(50000000 - Number(amount))), node(seller, '20000000', String(20000000 + Number(amount)))] : [])] };
  const metaBlob = codec.encode(meta, x68.DEVNET_DEFINITIONS);
  const urls = ['https://s.devnet.rippletest.net:51234', 'wss://devnet.honeycluster.io/'].slice(0, readers);
  const tape = tapeFor(urls, (i) => [[k('tx', { binary: true, transaction: s.hash }), { tx: s.tx_blob, meta: metaBlob, validated, ledger_index: 100 }], [k('ledger', { ledger_index: 100 }), ledgerResp(100, H(ledgerHashes[i]))]]);
  return { hash: s.hash, readers: urls.map((u) => replayReader(u, 'xrpl:2', tape)) };
}

/** SYNTHETIC JSON tx tape (Mainnet/Testnet style responses). */
export function jsonTape({ network, hash, tx, meta, validated = true, readers = 2, urls }) {
  const us = (urls ?? { 'xrpl:0': ['https://s1.ripple.com:51234', 'https://xrplcluster.com'], 'xrpl:1': ['https://s.altnet.rippletest.net:51234', 'wss://testnet.xrpl-labs.com/'] }[network]).slice(0, readers);
  const tape = tapeFor(us, () => [[k('tx', { transaction: hash }), { ...tx, hash, meta, validated, ledger_index: 200 }], [k('ledger', { ledger_index: 200 }), ledgerResp(200, H('C'))]]);
  return us.map((u) => replayReader(u, network, tape));
}
export const SYNTH_HASH = (c) => H(c);
