// Agent Purchase Experience — journey model.
// Pure functions: turn the governed-purchase API's requester view (state, facets, execution, anchor) into what the
// screens show. DISPLAY ONLY. Nothing here decides or enforces authority — the backend rulebook does that; this file
// only explains, in words, what the backend already reported. Runs in the browser and in node:test.

export const STEPS = ['REQUESTED', 'AUTHORIZED', 'SUBMITTED', 'SETTLED', 'VERIFIED', 'UNLOCKED'];

export const STEP_TEXT = {
  REQUESTED: { title: 'Requested', detail: 'The agent asked to buy.' },
  AUTHORIZED: { title: 'Authorized', detail: 'Eterna checked the owner’s signed authority.' },
  SUBMITTED: { title: 'Submitted', detail: 'A payment claim was signed for this purchase.' },
  SETTLED: { title: 'Settled', detail: 'The payment exists on the XRP Ledger.' },
  VERIFIED: { title: 'Verified', detail: 'Eterna confirmed it independently on two ledger readers.' },
  UNLOCKED: { title: 'Unlocked', detail: 'Delivery released only after verification.' },
};

// Every refusal code the backend rulebook can return (routes/governed-purchase.mjs). Grouped into the categories the
// owner understands. `receipt` = the backend issues a refusal receipt for it.
export const REFUSALS = {
  EXCEEDS_PER_PURCHASE_LIMIT: { category: 'Spending limit exceeded', text: 'This purchase costs more than the per-purchase limit the owner signed.', receipt: true },
  EXCEEDS_TOTAL_LIMIT: { category: 'Spending limit exceeded', text: 'This purchase would go over the total budget the owner signed.', receipt: true },
  PURCHASE_COUNT_EXHAUSTED: { category: 'Spending limit exceeded', text: 'The agent has used every purchase the owner allowed.', receipt: true },
  AUTHORIZATION_EXPIRED: { category: 'Authorization expired', text: 'The owner’s signed authority has passed its expiry.', receipt: true },
  NO_EXISTING_AUTHORITY: { category: 'No valid authorization', text: 'No signed authority covers this purchase.', receipt: true },
  CONNECTION_REVOKED: { category: 'Agent not authorized', text: 'The owner revoked this agent’s connection.', receipt: true },
  NETWORK_NOT_SERVED_HERE: { category: 'Wrong network', text: 'This request is for a network this Eterna does not serve.', receipt: true },
  EXECUTION_REFUSED: { category: 'Execution stopped', text: 'Execution did not meet its conditions, so nothing was paid or delivered.', receipt: true },
  // Not refusal rows: rejected at the door (HTTP errors), so there is no purchase record and no receipt.
  REQUESTER_CREDENTIAL_UNKNOWN: { category: 'Unknown agent', text: 'The agent’s credential is not one Eterna issued. Nothing was recorded.', receipt: false },
  REQUESTER_CREDENTIAL_REQUIRED: { category: 'Unknown agent', text: 'The agent did not identify itself. Nothing was recorded.', receipt: false },
};
// Honest gaps, shown in the designer guide: the backend has no separate refusal code for "merchant outside scope"
// (an out-of-scope seller is simply not covered → it becomes a draft that needs the owner) and no refusal row for a
// failed settlement verification (that purchase stays SUBMITTED_UNKNOWN / UNCERTAIN and is never unlocked).

export function refusalOf(v) {
  const code = v?.execution?.reason ?? v?.refusal?.reason ?? v?.reason ?? null;
  if (!code) return null;
  const known = REFUSALS[code];
  return { code, category: known?.category ?? 'Refused', text: known?.text ?? 'Eterna refused this purchase.', receipt: known?.receipt ?? false };
}

/** The six-step journey for one purchase, from the backend's own view. Each step: done | current | locked | refused | todo. */
export function journey(v) {
  const f = v?.facets ?? {}, x = v?.execution ?? {};
  const refused = v?.state === 'REFUSED' || f.authority === 'REFUSED';
  const reached = {
    REQUESTED: Boolean(v?.purchaseId),
    AUTHORIZED: f.authority === 'CONFIRMED',
    SUBMITTED: ['PREPARED', 'SUBMITTED_UNKNOWN', 'SETTLED'].includes(f.execution) || x.claimCommitted === true || Boolean(x.claimDrops),
    SETTLED: Boolean(x.redeemTx),
    // Verification = Eterna's independent check, reported by the backend as settlement SETTLED with both readers.
    VERIFIED: x.settlement === 'SETTLED' && Array.isArray(x.readers) && x.readers.length >= 2,
    UNLOCKED: f.delivery === 'DELIVERED',
  };
  const steps = [];
  let blocked = false;
  for (const s of STEPS) {
    let status;
    if (blocked) status = 'todo';
    else if (reached[s]) status = 'done';
    else if (refused && s === 'AUTHORIZED') { status = 'refused'; blocked = true; }
    else if (s === 'UNLOCKED' && reached.SETTLED && !reached.VERIFIED) { status = 'locked'; blocked = true; }
    else { status = 'current'; blocked = true; }
    steps.push({ id: s, ...STEP_TEXT[s], status });
  }
  // A paid-but-unverified purchase must never look unlocked, whatever else the data says: delivery is LOCKED until
  // Eterna's independent verification is reported.
  if (!refused && (reached.SETTLED || reached.UNLOCKED) && !reached.VERIFIED) steps.find((s) => s.id === 'UNLOCKED').status = 'locked';
  const uncertain = v?.state === 'UNCERTAIN' || f.execution === 'SUBMITTED_UNKNOWN';
  return { steps, refused, uncertain, locked: steps.some((s) => s.status === 'locked'), refusal: refused ? refusalOf(v) : null };
}

/** Owner-authority summary for the Authorization panel (from the standing parent's view, or a child's `standing`). */
export function authoritySummary({ parent, child, siblings = [] } = {}) {
  const s = parent?.standing ?? null, c = child?.standing ?? null;
  const limits = parent?.terms?.limits ?? parent?.certificate?.limits ?? null;
  const maxPurchases = s?.maxPurchases ?? c?.maxPurchases ?? limits?.maxPurchases ?? null;
  const maxTotalDrops = s?.maxTotalDrops ?? c?.maxTotalDrops ?? limits?.maxTotalDrops ?? null;
  const perPurchaseDrops = limits?.maxPerPurchaseDrops ?? null;
  const usedDrops = siblings.reduce((a, p) => a + Number(p?.execution?.paidDrops ?? 0), 0);
  const expiry = parent?.terms?.expiry ?? parent?.certificate?.expiry ?? null;
  const facet = parent?.facets?.authority ?? null;
  return {
    digest: parent?.certificateDigest ?? c?.parentDigest ?? null,
    expiry, expired: facet === 'EXPIRED' || (expiry ? Date.parse(expiry) <= Date.now() : false),
    ended: Boolean(s?.endedAt),
    autonomous: s?.role === 'STANDING_AUTHORIZATION' || Boolean(c?.parentPurchaseId),
    maxPurchases, maxTotalDrops, perPurchaseDrops,
    usedPurchases: siblings.length || (c?.purchaseNumber ?? null),
    usedDrops: siblings.length ? usedDrops : null,
    remainingDrops: siblings.length && maxTotalDrops ? Number(maxTotalDrops) - usedDrops : null,
    permittedRequesters: s?.permittedRequesters ?? [],
    channelCreateUrl: parent?.authorization?.explorerUrl ?? null,
  };
}

export const xrp = (drops) => (drops == null ? '—' : `${(Number(drops) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} XRP`);
