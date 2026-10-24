// The adapter contract: every payment capability plugs into the one governance engine through this shape.
//   { id, rail, assets[], networks[], mode: 'LIVE_CAPABLE'|'SIMULATED',
//     describe() -> { can[], cannot[], proofConditions, lifecycle[] },
//     challenge(offer) -> HTTP 402 payment request (x402 v2-shaped where it makes sense),
//     prepare(decision, ctx) -> UNSIGNED transaction or voucher draft (signing happens outside the adapter),
//     verify(executionRef, readers) -> { status: VERIFIED|SIMULATED|PENDING|FAILED, facts, txHash?, ledger? } }
// proofConditions = { status: <required evidence status>, facts: [{ fact, equals } | { fact, min }] }: the engine's
// unlock() refuses unless the adapter's evidence meets every condition AND binds to the decision (see governance).
import { fail } from '../unified/common.mjs';

export const MODES = Object.freeze(['LIVE_CAPABLE', 'SIMULATED']);
export const EVIDENCE_STATUS = Object.freeze({ VERIFIED: 'VERIFIED', SIMULATED: 'SIMULATED', PENDING: 'PENDING', FAILED: 'FAILED' });
const METHODS = ['describe', 'challenge', 'prepare', 'verify'];
const nonEmptyStrings = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x.length > 0);

/** Throws { code: 'ADAPTER_INVALID' } naming every violation. Returns the adapter (frozen) when it conforms. */
export function assertAdapter(a) {
  const bad = [];
  if (!a || typeof a !== 'object') throw fail('ADAPTER_INVALID', 'not an object');
  for (const k of ['id', 'rail']) if (typeof a[k] !== 'string' || !/^[a-z0-9-]+$/.test(a[k])) bad.push(`${k} must be a kebab-case string`);
  if (!nonEmptyStrings(a.assets)) bad.push('assets[] required');
  if (!nonEmptyStrings(a.networks) || !a.networks.every((n) => /^xrpl:\d+$/.test(n))) bad.push('networks[] must be xrpl:<id>');
  if (!MODES.includes(a.mode)) bad.push(`mode must be one of ${MODES}`);
  for (const m of METHODS) if (typeof a[m] !== 'function') bad.push(`${m}() missing`);
  if (typeof a.describe === 'function') {
    const d = a.describe();
    if (!nonEmptyStrings(d?.can) || !nonEmptyStrings(d?.cannot)) bad.push('describe() needs can[] and cannot[]');
    const pc = d?.proofConditions;
    if (!pc || !Object.values(EVIDENCE_STATUS).includes(pc.status) || !Array.isArray(pc.facts) || !pc.facts.every((c) => typeof c.fact === 'string' && ('equals' in c || 'min' in c))) bad.push('describe().proofConditions malformed');
    const lc = d?.lifecycle;
    if (!Array.isArray(lc) || lc[0] !== 'AUTHORIZED' || lc.at(-1) !== 'UNLOCKED' || !lc.includes('SETTLED') || !lc.includes('VERIFIED')) bad.push('describe().lifecycle must run AUTHORIZED ... SETTLED, VERIFIED, UNLOCKED');
    if (a.mode === 'SIMULATED' && pc?.status === 'VERIFIED') bad.push('a SIMULATED adapter cannot claim VERIFIED evidence of its own');
  }
  if (bad.length) throw fail('ADAPTER_INVALID', `${a.id ?? '?'}: ${bad.join('; ')}`);
  return Object.freeze(a);
}

/** Evaluate proof conditions against adapter evidence. Returns the unmet conditions (empty = met). */
export function unmetProof(proofConditions, evidence) {
  const unmet = [];
  if (evidence?.status !== proofConditions.status) unmet.push(`status ${evidence?.status} != ${proofConditions.status}`);
  for (const c of proofConditions.facts) {
    const v = evidence?.facts?.[c.fact];
    if ('equals' in c && v !== c.equals) unmet.push(`${c.fact} = ${JSON.stringify(v)} (need ${JSON.stringify(c.equals)})`);
    if ('min' in c && !(typeof v === 'number' && v >= c.min)) unmet.push(`${c.fact} = ${JSON.stringify(v)} (need >= ${c.min})`);
  }
  return unmet;
}

/** Evidence object helper (keeps every adapter's output the same shape). */
export const evidence = (adapter, status, facts, extra = {}) => ({ adapter: adapter.id, rail: adapter.rail, mode: adapter.mode, status, facts, ...extra });

/** x402 v2-shaped 402 body for an XRPL rail (the base64 of it goes in the PAYMENT-REQUIRED header). */
export const x402Challenge = ({ scheme, network, amount, asset, payTo, resource, description, maxTimeoutSeconds = 300, extra = {} }) => ({
  x402Version: 2, error: 'PAYMENT-REQUIRED', resource: { url: resource, description, mimeType: 'application/json' },
  accepts: [{ scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra }] });
/** Count readers whose per-reader check passed, and whether all of them agree on the ledger hash. */
export const agreement = (per) => ({ readersAgreeing: per.filter((p) => p.ok).length, readersAsked: per.length,
  ledgerHashesAgree: per.length > 0 && per.every((p) => p.ledgerHash && p.ledgerHash === per[0].ledgerHash) });
