// Products — ENGINEERING-OWNED. Four payment capabilities + one supporting authorization module, defined in
// products/rails.json. One visual system; each product reads only its own evidence. Nothing here decides, signs or pays:
// eligibility shown in the UI is a preview — Eterna's governance engine (backend) is the only authority.
const XRP_ROUTES = ['store', 'console', 'purchase', 'receipt', 'reports', 'present'];
export const MISSION = { key: 'mission', name: 'Rose’s mission', tag: 'One approval', route: 'mission' };

export function productsFrom(cfg) {
  const one = (r, supporting = false) => ({ key: r.id, name: r.name, tag: r.tag, route: r.route, network: r.network, supporting, rail: r, evidence: r.evidence?.parts ?? [] });
  return [...(cfg?.rails ?? []).map((r) => one(r)), ...(cfg?.supporting ?? []).map((r) => one(r, true))];
}
export function productFor(route, products) {
  if (route === 'mission') return MISSION;
  if (XRP_ROUTES.includes(route)) return products.find((p) => p.key === 'xrp-micropayments') ?? MISSION;
  return products.find((p) => p.route === route) ?? MISSION;
}

// Preview only: does Rose's mission include this rail and does the price fit its per-payment limit? (Eterna decides.)
export function eligibility(rail, request) {
  if (!rail) return { ok: false, why: 'Not part of Rose’s mission.' };
  if (rail.eligibleNote) return { ok: true, why: rail.eligibleNote };
  if (rail.mode === 'SIMULATED') return { ok: true, why: 'Eligible · simulated vouchers (not Mastercard).' };
  if (rail.evidence?.status === 'PENDING') return { ok: true, why: 'Eligible · waiting for owner approval to run.' };
  return { ok: true, why: `Eligible · within ${rail.limits?.perTx ?? 'the limit'} per payment.` };
}
