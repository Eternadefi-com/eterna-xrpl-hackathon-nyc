// RLUSD v2 schema set (offline, 2026-10-09). Not wired into the live path: v1 (Devnet XRP, frozen) and v2
// (network-bound XRP) are unchanged, and nothing here is imported by a route, the resolver, the signer or
// settlement yet. This module is the single definition each of those layers will use when RLUSD is wired.
//
// Unit model: every governed amount is an integer count of BASE UNITS at the asset's fixed scale, so the
// existing C56 integer columns (authority_requests.amount, envelope ceilings, consumptions) and the cumulative
// BigInt arithmetic stay exactly as they are. XRP: scale 6, base unit = drop. RLUSD: scale 6, base unit =
// micro-RLUSD (0.000001). The ledger representation is derived from units; it is never the source of truth.
// Asset identity always binds network + code + issuer + currency (lib/xrpl-asset-identity.mjs).
import { z } from 'zod';
import { assetIdentity, ledgerAmount, registeredAssetIdentity, verifyDelivered } from './xrpl-asset-identity.mjs';
export { registeredAssetIdentity };

export const NY_ASSET_SCALE = 6;
const MAX_UNITS = 9007199254740991n; // the C56 integer bound (2^53 - 1)
const RLUSD_CURRENCY = '524C555344000000000000000000000000000000';
const CLASSIC = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const UNITS = /^[1-9][0-9]{0,15}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Contract asset field: "XRP" or { code:'RLUSD', issuer, currency }.
export const nyContractAssetSchema = z.union([z.literal('XRP'),
  z.strictObject({ code: z.literal('RLUSD'), issuer: z.string().regex(CLASSIC), currency: z.literal(RLUSD_CURRENCY) })]);

// Network-bound identity from a contract asset field. Refuses a wrong issuer, Devnet RLUSD, unknown networks.
export function nyAssetIdentity(network, asset) {
  const a = nyContractAssetSchema.parse(asset);
  return a === 'XRP' ? assetIdentity({ network, asset: 'XRP' }) : assetIdentity({ network, asset: 'RLUSD', issuer: a.issuer, currency: a.currency });
}
export const nyContractAsset = identity => identity.kind === 'native' ? 'XRP'
  : { code: identity.asset, issuer: identity.issuer, currency: identity.currency };

// Exact decimal (asset unit) -> integer base units. No floats; more than 6 decimals is refused, not rounded.
export function nyAmountUnits(identity, decimal) {
  if (typeof decimal !== 'string' || !DECIMAL.test(decimal)) fail('AMOUNT_FORMAT_INVALID');
  const [whole, frac = ''] = decimal.split('.');
  const units = BigInt(whole) * 10n ** BigInt(NY_ASSET_SCALE) + BigInt(frac.padEnd(NY_ASSET_SCALE, '0'));
  if (units <= 0n) fail('AMOUNT_NOT_POSITIVE');
  if (units > MAX_UNITS) fail('AMOUNT_RANGE');
  return units.toString();
}
export function nyUnitsDecimal(units) {
  if (typeof units !== 'string' || !UNITS.test(units) || BigInt(units) > MAX_UNITS) fail('AMOUNT_UNITS_INVALID');
  const s = units.padStart(NY_ASSET_SCALE + 1, '0'), whole = s.slice(0, -NY_ASSET_SCALE), frac = s.slice(-NY_ASSET_SCALE).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
// Ledger Amount for exactly `units`: drops string for XRP, { currency, issuer, value } for RLUSD.
export function nyLedgerAmount(identity, units) {
  const value = nyUnitsDecimal(units);
  return identity.kind === 'native' ? units : ledgerAmount(identity, { kind: 'issued', value });
}

// --- C56 action scope v2 (asset binding) -------------------------------------------------------------
// The signed scope keeps `asset` (the existing ^[A-Z0-9]{2,16}$ column: 'XRP' | 'RLUSD') and integer ceilings in
// base units, and ADDS the identity a bare label lacks. For RLUSD the human signs issuer, currency and scale.
export const nyScopeAssetV2Schema = z.union([
  z.strictObject({ asset: z.literal('XRP'), amount_scale: z.literal(NY_ASSET_SCALE) }),
  z.strictObject({ asset: z.literal('RLUSD'), asset_issuer: z.string().regex(CLASSIC), asset_currency: z.literal(RLUSD_CURRENCY),
    amount_scale: z.literal(NY_ASSET_SCALE) })]);
export function nyScopeAssetV2(identity) {
  return identity.kind === 'native' ? { asset: 'XRP', amount_scale: NY_ASSET_SCALE }
    : { asset: identity.asset, asset_issuer: identity.issuer, asset_currency: identity.currency, amount_scale: NY_ASSET_SCALE };
}
// A signed scope authorizes exactly one asset identity on one network. The requested identity must equal it.
export function assertNyScopeAsset({ scope, network, requested }) {
  const s = nyScopeAssetV2Schema.parse({ asset: scope.asset, amount_scale: scope.amount_scale,
    ...(scope.asset === 'RLUSD' ? { asset_issuer: scope.asset_issuer, asset_currency: scope.asset_currency } : {}) });
  const bound = nyAssetIdentity(network, s.asset === 'XRP' ? 'XRP' : { code: 'RLUSD', issuer: s.asset_issuer, currency: s.asset_currency });
  if (requested && JSON.stringify(nyContractAsset(requested)) !== JSON.stringify(nyContractAsset(bound))) fail('NY_SCOPE_ASSET_MISMATCH');
  for (const k of ['per_action_ceiling', 'cumulative_ceiling']) if (!Number.isSafeInteger(scope[k]) || scope[k] < 1) fail('NY_SCOPE_CEILING_INVALID');
  return bound;
}

// --- Intent certificate terms v2 ---------------------------------------------------------------------
export const nyCertificateTermsV2Schema = z.strictObject({
  asset: nyContractAssetSchema.nullable(), amount: z.string().regex(DECIMAL).nullable(), amountUnits: z.string().regex(UNITS).nullable(),
  scale: z.literal(NY_ASSET_SCALE), destination: z.string().regex(CLASSIC).nullable(), purpose: z.string().min(1).max(256).nullable(),
  network: z.enum(['xrpl:0', 'xrpl:1', 'xrpl:2']),
}).superRefine((t, ctx) => {
  if ((t.amount === null) !== (t.amountUnits === null) || (t.amount !== null && t.asset === null)) ctx.addIssue({ code: 'custom', message: 'TERMS_AMOUNT_INCOMPLETE' });
  if (t.asset === null || t.amount === null) return;
  try {
    const id = nyAssetIdentity(t.network, t.asset);
    if (nyAmountUnits(id, t.amount) !== t.amountUnits) ctx.addIssue({ code: 'custom', message: 'TERMS_AMOUNT_UNITS_MISMATCH' });
  } catch (e) { ctx.addIssue({ code: 'custom', message: e.code ?? 'TERMS_ASSET_INVALID' }); }
});

// --- Signer contract v2: the exact transaction amount -------------------------------------------------
// The signer co-signs only a DIRECT payment of exactly the authorized units of the authorized identity, within
// its own configured ceiling (in base units of that asset). Fees stay XRP drops and are checked separately.
export function assertNySignerAmountV2({ tx, identity, amountUnits, signerCeilingUnits }) {
  if (tx?.TransactionType !== 'Payment') fail('NY_SIGNER_TRANSACTION_SCOPE');
  if (tx.SendMax !== undefined || tx.Paths !== undefined || tx.DeliverMin !== undefined || (Number(tx.Flags ?? 0) & 0x00020000)) fail('NY_SIGNER_NOT_DIRECT');
  if (identity.kind === 'issued' && tx.Destination === identity.issuer) fail('NY_SIGNER_PAYMENT_TO_ISSUER');
  if (JSON.stringify(tx.Amount) !== JSON.stringify(nyLedgerAmount(identity, amountUnits))) fail('NY_SIGNER_AMOUNT_MISMATCH');
  if (typeof signerCeilingUnits !== 'string' || !UNITS.test(signerCeilingUnits) || BigInt(amountUnits) > BigInt(signerCeilingUnits)) fail('NY_SIGNER_AMOUNT_CEILING');
  return true;
}

// --- Settlement amount v2 -----------------------------------------------------------------------------
export const nySettlementAmountV2Schema = z.strictObject({
  asset: nyContractAssetSchema, amountUnits: z.string().regex(UNITS), scale: z.literal(NY_ASSET_SCALE),
  ledgerAmount: z.union([z.string().regex(/^[1-9][0-9]*$/), z.strictObject({ currency: z.string(), issuer: z.string(), value: z.string() })]),
});
// Validated tx + meta delivered EXACTLY the authorized units of the authorized identity: tesSUCCESS, exact
// destination, exact Amount and delivered_amount, no partial payment, no paths. Returns the settlement amount.
export function nySettlementAmountV2({ identity, amountUnits, destination, tx, meta }) {
  const value = nyUnitsDecimal(amountUnits);
  const amount = identity.kind === 'native' ? { kind: 'native', drops: amountUnits } : { kind: 'issued', value };
  try { verifyDelivered({ identity, amount, destination, tx, meta }); }
  catch (e) { fail(e.code === 'DELIVERY_NOT_SUCCESS' ? 'NY_SETTLEMENT_NOT_SUCCESS' : 'NY_DELIVERED_AMOUNT_MISMATCH'); }
  return nySettlementAmountV2Schema.parse({ asset: nyContractAsset(identity), amountUnits, scale: NY_ASSET_SCALE, ledgerAmount: nyLedgerAmount(identity, amountUnits) });
}

// --- wiring helpers (live path) ------------------------------------------------------------------------
// Identity authorized by a human-signed NY scope on its network: XRP carries no asset_identity; any other asset
// must carry exactly the registered { issuer, currency, scale } (lib/c56-delegation-proof.mjs derives it).
export function nyScopeIdentity(scope, network) {
  const identity = registeredAssetIdentity(network, scope?.asset);
  if (identity.kind === 'native') { if (Object.hasOwn(scope, 'asset_identity')) fail('NY_SCOPE_ASSET_INVALID'); return identity; }
  const s = scope.asset_identity;
  if (!s || Object.keys(s).length !== 3 || s.issuer !== identity.issuer || s.currency !== identity.currency || s.scale !== NY_ASSET_SCALE) fail('NY_SCOPE_ASSET_INVALID');
  return identity;
}
// Exact ledger-amount equality (drops string, or issued { currency, issuer, value } compared by exact decimal).
export function nySameLedgerAmount(identity, observed, units) {
  if (identity.kind === 'native') return typeof observed === 'string' && observed === units;
  if (!observed || typeof observed !== 'object' || Object.keys(observed).length !== 3 || observed.currency !== identity.currency || observed.issuer !== identity.issuer) return false;
  try { return nyAmountUnits(identity, decimalFromLedgerValue(observed.value)) === units; } catch { return false; }
}
// Ledger IOU values may be rendered in exponent form (e.g. "1e-6"); normalize exactly, refusing > scale digits.
function decimalFromLedgerValue(value) {
  const m = typeof value === 'string' ? /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value) : null;
  if (!m) fail('AMOUNT_FORMAT_INVALID');
  let digits = m[1] + (m[2] ?? ''), point = m[1].length + Number(m[3] ?? 0);
  if (point <= 0) { digits = '0'.repeat(1 - point) + digits; point = 1; }
  if (point > digits.length) digits = digits.padEnd(point, '0');
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, ''), frac = digits.slice(point).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
// Exact equality of two ledger Amounts: identical drops strings, or same currency + issuer and equal decimal value.
export function nyLedgerAmountsEqual(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return typeof a === 'string' && a === b && /^[1-9][0-9]*$/.test(a);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Object.keys(a).length !== 3 || Object.keys(b).length !== 3
    || a.currency !== b.currency || a.issuer !== b.issuer) return false;
  try { return decimalFromLedgerValue(a.value) === decimalFromLedgerValue(b.value); } catch { return false; }
}
// Session/receipt view of a prepared Amount: XRP keeps { amount: drops, currency: 'XRP' } exactly as before.
export function nyReceiptAmount(amount) {
  if (typeof amount === 'string') return { amount, currency: 'XRP' };
  return { amount: decimalFromLedgerValue(amount.value), currency: 'RLUSD', issuer: amount.issuer, currencyCode: amount.currency };
}
// Integer base units of a prepared Amount (XRP: drops; RLUSD: value at scale 6), for the x402 session amount.
export function nyLedgerAmountUnits(network, amount) {
  if (typeof amount === 'string') return amount;
  const identity = registeredAssetIdentity(network, 'RLUSD');
  if (amount?.currency !== identity.currency || amount?.issuer !== identity.issuer) fail('NY_AMOUNT_ASSET_MISMATCH');
  return nyAmountUnits(identity, decimalFromLedgerValue(amount.value));
}
