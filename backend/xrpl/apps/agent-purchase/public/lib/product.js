// The purchased product, exactly as delivered — ENGINEERING-OWNED (designers: don't edit; style product-unlock.js).
// The seller's delivery is stored by Eterna with deliveryDigest = sha256(JSON.stringify(delivery)) in the worker's key
// order. Postgres reorders JSON keys, so the delivery is re-serialised in that original order; the bytes then hash to the
// recorded digest (verified on every recorded Mainnet delivery). The download is those exact bytes: the actual product.

export function canonicalDelivery(d) {
  if (!d) return null;
  return {
    report: d.report && { kind: d.report.kind, sellerSeq: d.report.sellerSeq, servedAt: d.report.servedAt, paidDrops: d.report.paidDrops, cumulativeDrops: d.report.cumulativeDrops },
    unlockedBundle: d.unlockedBundle && { reports: d.unlockedBundle.reports, settledLedger: d.unlockedBundle.settledLedger, readers: d.unlockedBundle.readers, simulatedLedger: d.unlockedBundle.simulatedLedger },
    seller: d.seller && { label: d.seller.label, account: d.seller.account },
  };
}

export const productBytes = (owner) => { const c = canonicalDelivery(owner?.deliveredResult); return c ? JSON.stringify(c) : null; };

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** { bytes, digest, expected, verified } — verified only when the bytes hash to the digest Eterna recorded. */
export async function verifiedProduct(owner) {
  const bytes = productBytes(owner);
  const expected = owner?.execution?.deliveryDigest ?? owner?.receipt?.delivery?.digest ?? null;
  if (!bytes) return { bytes: null, digest: null, expected, verified: false };
  const digest = await sha256Hex(bytes);
  return { bytes, digest, expected, verified: Boolean(expected) && digest === expected };
}

/** Unlock only when the backend reports delivery after verified settlement — never on payment alone. */
export function isUnlocked(owner) {
  const x = owner?.execution ?? {};
  return owner?.facets?.delivery === 'DELIVERED' && x.settlement === 'SETTLED' && Array.isArray(x.readers) && x.readers.length >= 2 && Boolean(owner?.deliveredResult);
}
