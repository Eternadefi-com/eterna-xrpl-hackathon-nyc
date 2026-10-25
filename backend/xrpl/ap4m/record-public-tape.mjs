#!/usr/bin/env node
// READ-ONLY capture of one complete, PUBLIC AP4M payment on XRPL EVM Testnet (VoucherRedeemed -> ClaimPaid ->
// SettlementRecorded), from two independent readers, into fixtures/public-tape.json. It is used ONLY to test Eterna's
// event parser and claim derivation against real chain data. The payment belongs to whichever hackathon participant
// made it (not Eterna) and is never presented as Eterna's evidence. No key, no signing, no submit path.
//   /opt/homebrew/bin/node ap4m/record-public-tape.mjs [--tx 0x<redemption tx>] [--channel 0x<channelId>]
import { writeFileSync } from 'node:fs';
import { evmReader, assertChain, recording, DEFAULT_READERS } from './readers.mjs';
import { CONTRACTS, CODE_HASHES } from './constants.mjs';
import { TOPICS, voucherRedeemedLogs, channelCall, ethers } from './voucher.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const tape = {};
const readers = DEFAULT_READERS.map((u) => { const inner = evmReader(u); return { ...recording(inner, tape), inner }; });
for (const r of readers) await assertChain(r);
const [a] = readers;
const hex = (n) => `0x${n.toString(16)}`;
let redeemTx = arg('tx'), channelId = arg('channel');
if (!redeemTx) {
  const head = Number(BigInt(await a.request('eth_blockNumber')));
  const logs = await a.request('eth_getLogs', [{ address: CONTRACTS.paymentLedger, topics: [TOPICS.VoucherRedeemed], fromBlock: hex(head - 2000), toBlock: hex(head - 20) }]);
  if (!logs.length) throw new Error('no public VoucherRedeemed in the last 2000 blocks; pass --tx');
  redeemTx = logs.at(-1).transactionHash;
}
const captured = { redeemTx };
const headNow = Number(BigInt(await a.request('eth_blockNumber'))) - 5;
for (const r of readers) {
  const rc = await r.request('eth_getTransactionReceipt', [redeemTx]);
  const [vr] = voucherRedeemedLogs(rc.logs);
  channelId ??= vr.channelId; captured.claimId = vr.claimId; captured.channelId = vr.channelId;
  await r.request('eth_getTransactionByHash', [redeemTx]);
  await r.request('eth_getBlockByNumber', [rc.blockNumber, false]);
  const from = rc.blockNumber, to = hex(Math.min(Number(BigInt(rc.blockNumber)) + 400, headNow));
  const paid = await r.request('eth_getLogs', [{ address: CONTRACTS.pooledEscrowVault, topics: [TOPICS.ClaimPaid, vr.claimId], fromBlock: from, toBlock: to }]);
  const rec = await r.request('eth_getLogs', [{ address: CONTRACTS.paymentLedger, topics: [TOPICS.SettlementRecorded, vr.claimId], fromBlock: from, toBlock: to }]);
  for (const l of [...paid, ...rec]) { const x = await r.request('eth_getTransactionReceipt', [l.transactionHash]); await r.request('eth_getBlockByNumber', [x.blockNumber, false]); }
  captured.payoutTx = paid[0]?.transactionHash ?? null; captured.settlementTx = rec[0]?.transactionHash ?? null; captured.window = [from, to];
  await r.request('eth_call', [channelCall(channelId), 'latest']);
  // code hashes are checked live but kept out of the tape (the bytecode is large); the result is recorded instead
  for (const [k, addr] of Object.entries(CONTRACTS)) { const code = await r.inner.request('eth_getCode', [addr, 'latest']); (captured.codeHashesMatch ??= {})[`${r.label}:${k}`] = ethers.keccak256(code) === CODE_HASHES[k]; }
}
const out = { note: 'READ-ONLY capture of a PUBLIC third-party AP4M hackathon payment on XRPL EVM Testnet (chain 1449000). Used only to test Eterna\'s parser; not Eterna\'s payment and not Eterna evidence.',
  capturedAt: new Date().toISOString(), readers: readers.map((r) => ({ url: r.url, label: r.label })), ...captured, tape };
writeFileSync(new URL('./fixtures/public-tape.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ ...captured, readers: out.readers }, null, 1));
