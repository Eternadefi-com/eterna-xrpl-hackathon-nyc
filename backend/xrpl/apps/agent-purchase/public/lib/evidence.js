// Scenario evidence — ENGINEERING-OWNED. Resolves a scenario's `evidence` reference to the proof it shows, from the same
// records the app uses (never typed into a scenario file). Status is VERIFIED only when the record itself proves it:
//   mainnet-purchase   : Eterna reports delivered after settlement + 2 readers, and the product hashes to its deliveryDigest
//   devnet-sponsorship : an evidence file written by the verifier after the transaction validated (PENDING until then)
import { verifiedProduct, isUnlocked } from './product.js';

const pickPurchase = (purchases, ref) => {
  const servedAt = (p) => Date.parse(p.ownerView.deliveredResult?.report?.servedAt ?? 0) || 0;
  const done = purchases.filter((p) => p.ownerView && isUnlocked({ ...p.ownerView, facets: p.requesterView?.facets ?? p.ownerView.facets }))
    .sort((a, b) => servedAt(a) - servedAt(b));                         // the observer lists newest first; recordings oldest first
  if (!ref || ref === 'latest') return done[done.length - 1] ?? null;
  const want = String(ref).replace('gpur_', '');
  return purchases.find((p) => p.ownerView?.purchaseId?.replace('gpur_', '').startsWith(want)) ?? null;
};

export async function resolveEvidence(scenario, { recorded, mainnet } = {}) {
  const e = scenario.evidence ?? {};
  if (e.source === 'mainnet-purchase') {
    // Live observer first (engineering machine), else the committed recording; both are real Mainnet records.
    const live = mainnet?.purchases ?? [], rec = recorded?.mainnet?.purchases ?? [];
    const fromLive = pickPurchase(live, e.purchase), p = fromLive ?? pickPurchase(rec, e.purchase);
    if (!p) return { status: 'PENDING', network: 'XRPL Mainnet', note: `No verified Mainnet purchase matches “${e.purchase ?? 'latest'}” yet.` };
    const owner = { ...p.ownerView, facets: p.requesterView?.facets ?? p.ownerView.facets }, x = owner.execution ?? {};
    const product = await verifiedProduct(owner), unlocked = isUnlocked(owner);
    const at = owner.deliveredResult?.report?.servedAt, early = e.notBefore && Date.parse(at) < Date.parse(e.notBefore);
    const undated = e.notBefore && !Date.parse(at);                         // fail closed: no delivery time, no claim it is the live run
    return {
      // REHEARSAL = a real verified Mainnet purchase made before this scenario's live run (never passed off as the live one)
      status: !(unlocked && product.verified) || undated ? 'PENDING' : early ? 'REHEARSAL' : 'VERIFIED', source: fromLive ? 'LIVE' : 'RECORDED', network: 'XRPL Mainnet',
      owner, purchase: p.requesterView, product,
      txHash: x.redeemTx, txUrl: x.redeemExplorerUrl, ledger: x.redeemLedger ?? owner.deliveredResult?.unlockedBundle?.settledLedger,
      readers: (x.readers ?? []).length, amountDrops: x.paidDrops,
      authorizationUrl: owner.authorization?.explorerUrl, authorizationTx: owner.authorization?.createTx,
      receiptUrl: owner.anchor?.explorerUrl, certificateDigest: owner.certificateDigest, at,
    };
  }
  if (e.source === 'devnet-sponsorship') {
    const f = recorded?.evidence?.[e.file] ?? null;
    if (!f || f.status !== 'VERIFIED') return { status: 'PENDING', network: 'XRPL Devnet', note: f?.note ?? 'No Devnet sponsorship transaction yet.' };
    return { ...f, network: 'XRPL Devnet', source: 'RECORDED' };
  }
  if (e.source === 'unified-mission') {
    // Several independent evidence sources. Each keeps its own status; the whole is never called VERIFIED.
    // finalReady = every ledger component the scenario requires is VERIFIED, and the rest are labelled (SIMULATED / PENDING).
    const f = recorded?.evidence?.[e.file] ?? null;
    if (!f?.components?.length) return { status: 'PENDING', network: 'XRPL Devnet', note: f?.note ?? 'The unified mission has not run yet.', components: [] };
    const comps = e.parts ? f.components.filter((c) => e.parts.includes(c.key)) : f.components;
    const by = Object.fromEntries(comps.map((c) => [c.key, c]));
    const required = e.requireVerified ?? [];
    const finalReady = required.every((k) => by[k]?.status === 'VERIFIED') && f.unlocked === true;
    const s = comps.find((c) => c.key === 'settlement') ?? {};
    const allVerified = comps.every((c) => c.status === 'VERIFIED');
    return { status: !finalReady ? 'PENDING' : allVerified ? 'VERIFIED' : 'PARTIAL', finalReady, network: f.network, source: 'RECORDED', components: comps, mission: f.mission,
      reports: f.reports ?? [], unlocked: f.unlocked === true, auditReceipt: f.auditReceipt ?? null,
      txHash: s.txHash, txUrl: s.txUrl, ledger: s.ledger, at: f.generatedAt,
      note: finalReady ? null : `Waiting for: ${required.filter((k) => by[k]?.status !== 'VERIFIED').join(', ') || 'the unlock'}.` };
  }
  return { status: 'PENDING', note: `Unknown evidence source ${e.source}` };
}
