// Adapter: XLS-68 sponsored execution (Eterna pays the fee; the payer's XRP moves). Wraps unified/tx.mjs and ../xls68/.
// LIVE_CAPABLE on Devnet only (the Sponsor amendment is not on Mainnet/Testnet). It prepares UNSIGNED txs; signing
// (payer or delegate STX + Eterna SPN co-signature) and submission happen outside the adapter.
// verify() re-reads the tx in binary from every reader, decodes and re-hashes it locally, and re-checks signatures,
// sponsorship fields and balance deltas (unified/verify.mjs readTx / balanceDeltas).
import * as x68 from '../../xls68/xls68.mjs';
import { verifySignatures } from '../../unified/tx.mjs';
import { readTx, balanceDeltas } from '../../unified/verify.mjs';
import { memo, MEMO, readMemos } from '../../unified/common.mjs';
import { delegateTx, assertDelegationCompatible } from '../delegation.mjs';
import { evidence, x402Challenge, agreement } from '../contract.mjs';

const SPF = x68.FLAGS.SponsorFlags;
const adapter = {
  id: 'xls68-sponsored', rail: 'xls68-sponsored', assets: ['XRP'], networks: ['xrpl:2'], mode: 'LIVE_CAPABLE',
  describe: () => ({
    can: ['Create an agent account with 1 drop whose reserve Eterna carries (tfSponsorCreatedAccount)',
      'Execute an XRP Payment whose fee Eterna pays (spfSponsorFee, Eterna co-signs with the SPN prefix)',
      'Let the agent sign for Rose through an XLS-75 Payment delegation (fee sponsorship only)',
      'Prove each step from two Devnet readers'],
    cannot: ['Run on Mainnet or Testnet (the Sponsor amendment is Devnet-only today)',
      'Reserve-sponsor a delegated transaction (rippled: temINVALID)', 'Move tokens; XRP only', 'Sign or submit by itself'],
    proofConditions: { status: 'VERIFIED', facts: [{ fact: 'validated', equals: true }, { fact: 'tesSUCCESS', equals: true }, { fact: 'signaturesValid', equals: true },
      { fact: 'sponsorPaidFee', equals: true }, { fact: 'readersAgreeing', min: 2 }, { fact: 'ledgerHashesAgree', equals: true }] },
    lifecycle: ['AUTHORIZED', 'SUBMITTED', 'SETTLED', 'VERIFIED', 'UNLOCKED'],
  }),
  challenge: ({ amount, payTo, resource, description, sponsor }) => x402Challenge({ scheme: 'xrpl-sponsored-payment', network: 'xrpl:2', amount, asset: 'XRP', payTo, resource, description,
    extra: { sponsor, feeSponsored: true, delegationSupported: true, note: 'Eterna co-signs as fee sponsor; the payer (or its delegate) signs the Payment' } }),
  /** UNSIGNED Payment for an AUTHORIZED decision. ctx: { sponsor, delegate?, sequence, fee, lastLedgerSequence } */
  prepare(decision, { sponsor, delegate, sequence = 0, fee = '12', lastLedgerSequence } = {}) {
    const q = decision.request;
    let tx = { TransactionType: 'Payment', Account: q.payer, Destination: q.seller, Amount: q.amount, Fee: fee, Sequence: sequence,
      ...(lastLedgerSequence ? { LastLedgerSequence: lastLedgerSequence } : {}),
      Memos: [memo(MEMO.certificate, decision.certificateDigest), memo('eterna/decision', decision.decisionDigest)] };
    if (delegate) tx = delegateTx(tx, { delegate });
    tx = assertDelegationCompatible(x68.withSponsor(tx, { sponsor, fee: true, reserve: false }));
    return { kind: 'unsigned-tx', network: 'xrpl:2', tx, signers: [delegate ? `agent ${delegate} (Delegate, STX)` : `payer ${q.payer} (STX)`, `sponsor ${sponsor} (SponsorSignature, SPN)`],
      note: 'Unsigned. Signing and submission are outside the adapter.' };
  },
  /** ref: { txHash, expected?: { sponsor, sponsorFlags } }. Proof comes only from the readers. */
  async verify(ref, readers = []) {
    if (!readers.length) return evidence(adapter, 'PENDING', { reason: 'no readers' }, { txHash: ref.txHash });
    const per = [];
    let shown = null;
    for (const r of readers) {
      try {
        const t = await readTx(r, ref.txHash);
        if (t.error) { per.push({ reader: r.url, ok: false, pending: true, problems: [t.error] }); continue; }
        const sig = verifySignatures(t.tx), d = balanceDeltas(t.meta), tx = t.tx;
        const sponsorPaidFee = !!tx.Sponsor && (tx.SponsorFlags & SPF.spfSponsorFee) !== 0 && sig.sponsor === true && d[tx.Sponsor] === (-BigInt(tx.Fee)).toString();
        const facts = { network: 'xrpl:2', asset: 'XRP', txType: tx.TransactionType, payer: tx.Account, delegate: tx.Delegate ?? null, destination: tx.Destination,
          amount: typeof tx.Amount === 'string' ? tx.Amount : null, sponsor: tx.Sponsor ?? null, sponsorFlags: tx.SponsorFlags ?? null, feeDrops: tx.Fee,
          validated: t.validated && t.hashMatches, tesSUCCESS: t.meta?.TransactionResult === 'tesSUCCESS', result: t.meta?.TransactionResult,
          signaturesValid: sig.signer === true && (tx.SponsorSignature ? sig.sponsor === true : true), sponsorPaidFee, balanceDeltas: d, memos: readMemos(tx),
          ...(tx.Flags & x68.FLAGS.Payment.tfSponsorCreatedAccount ? { sponsoredAccountCreate: true } : {}) };
        const problems = [];
        if (ref.expected?.sponsor && facts.sponsor !== ref.expected.sponsor) problems.push('sponsor');
        if (ref.expected?.sponsorFlags !== undefined && facts.sponsorFlags !== ref.expected.sponsorFlags) problems.push('sponsorFlags');
        if (!facts.tesSUCCESS) problems.push(`result ${facts.result}`);
        if (!facts.validated) problems.push('not validated / hash mismatch');
        if (!facts.signaturesValid) problems.push('signature');
        per.push({ reader: r.url, ok: problems.length === 0, ledgerHash: t.ledger_hash, ledger: t.ledger_index, facts, problems, final: t.validated });
        shown ??= facts;
      } catch (e) { per.push({ reader: r.url, ok: false, pending: true, problems: [e.message] }); }
    }
    const ag = agreement(per), problems = [...new Set(per.flatMap((p) => p.problems))];
    const failed = per.some((p) => p.final && !p.ok);
    const status = failed ? 'FAILED' : per.every((p) => p.ok) && ag.ledgerHashesAgree ? 'VERIFIED' : 'PENDING';
    return evidence(adapter, status, { ...(shown ?? {}), ...ag, ...(problems.length ? { problems } : {}), readers: per.map((p) => ({ reader: p.reader, ok: p.ok, ledgerHash: p.ledgerHash ?? null })) },
      { txHash: ref.txHash, ledger: per.find((p) => p.ledger)?.ledger, txUrl: `https://devnet.xrpl.org/transactions/${ref.txHash}` });
  },
};
export default adapter;
