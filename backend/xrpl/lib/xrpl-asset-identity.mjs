// Explicit XRPL asset identity for governed commerce: XRP and authentic RLUSD, bound to a network.
// Offline foundation for the Mainnet profile (not yet wired into the frozen eterna.agent.payment.v1 path).
// Facts verified 2026-10-09 (read-only RPC + Ripple/XRPL docs):
//  - RLUSD Mainnet issuer rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De, currency 524C555344000000000000000000000000000000,
//    no TransferRate (no transfer fee), RequireAuth off, clawback and freeze enabled.
//  - RLUSD Testnet issuer rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV (test asset, no Mainnet value).
//  - No official RLUSD on Devnet: Devnet is XRP-only here.
//  - NetworkID must be omitted for Mainnet, Testnet and Devnet.
// A bare "RLUSD" label is never sufficient identity: issuer, currency and network are always bound together.

const CLASSIC = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const RLUSD_CURRENCY = '524C555344000000000000000000000000000000';
const TF_PARTIAL_PAYMENT = 0x00020000;
const NETWORK_ASSETS = Object.freeze({
  'xrpl:0': Object.freeze({ XRP: { kind: 'native' }, RLUSD: { kind: 'issued', currency: RLUSD_CURRENCY, issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', official: true } }),
  'xrpl:1': Object.freeze({ XRP: { kind: 'native' }, RLUSD: { kind: 'issued', currency: RLUSD_CURRENCY, issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV', official: false, testAsset: true } }),
  'xrpl:2': Object.freeze({ XRP: { kind: 'native' } }),
});
export class AssetIdentityError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = code => { throw new AssetIdentityError(code); };

// Canonical asset identity. The caller states the asset; for an issued asset the caller's issuer and currency
// must equal the network's registered values (no substitution, no inference from a label).
export function assetIdentity({ network, asset, issuer, currency }) {
  const table = NETWORK_ASSETS[network] ?? refuse('ASSET_NETWORK_UNSUPPORTED');
  const entry = table[asset] ?? refuse('ASSET_NOT_SUPPORTED_ON_NETWORK');
  if (entry.kind === 'native') {
    if (issuer !== undefined || currency !== undefined) refuse('ASSET_NATIVE_HAS_NO_ISSUER');
    return Object.freeze({ network, asset, kind: 'native' });
  }
  if (issuer !== entry.issuer) refuse('ASSET_ISSUER_MISMATCH');
  if (currency !== entry.currency) refuse('ASSET_CURRENCY_MISMATCH');
  return Object.freeze({ network, asset, kind: 'issued', issuer: entry.issuer, currency: entry.currency, official: entry.official, testAsset: !!entry.testAsset });
}

// The registered identity of an asset code on a network (the frozen table above): used where a code has been
// stored after the full identity was verified, e.g. a C56 request row or a human-signed scope's `asset`.
export function registeredAssetIdentity(network, asset) {
  const entry = (NETWORK_ASSETS[network] ?? refuse('ASSET_NETWORK_UNSUPPORTED'))[asset] ?? refuse('ASSET_NOT_SUPPORTED_ON_NETWORK');
  return entry.kind === 'native' ? assetIdentity({ network, asset }) : assetIdentity({ network, asset, issuer: entry.issuer, currency: entry.currency });
}

// --- exact decimal (no floating point) ---------------------------------------------------------------
// Normalized as { digits: string without leading/trailing zeros, exponent } meaning digits * 10^exponent.
function parseDecimal(value) {
  const m = typeof value === 'string' ? /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value) : null;
  if (!m) refuse('AMOUNT_FORMAT_INVALID');
  let digits = (m[1] + (m[2] ?? '')).replace(/^0+/, '');
  let exponent = Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  if (!digits) return { digits: '', exponent: 0 };
  const trailing = digits.match(/0+$/)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing); exponent += trailing;
  return { digits, exponent };
}
function compareDecimal(a, b) {
  if (!a.digits || !b.digits) return (a.digits ? 1 : 0) - (b.digits ? 1 : 0);
  const e = Math.min(a.exponent, b.exponent);
  const x = BigInt(a.digits + '0'.repeat(a.exponent - e)), y = BigInt(b.digits + '0'.repeat(b.exponent - e));
  return x === y ? 0 : x > y ? 1 : -1;
}
function decimalString({ digits, exponent }) {
  if (!digits) return '0';
  if (exponent >= 0) return digits + '0'.repeat(exponent);
  const point = digits.length + exponent;
  return point > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : `0.${'0'.repeat(-point)}${digits}`;
}
const subtractDecimal = (a, b) => {
  const e = Math.min(a.exponent, b.exponent);
  const diff = BigInt(a.digits || '0') * 10n ** BigInt(a.exponent - e) - BigInt(b.digits || '0') * 10n ** BigInt(b.exponent - e);
  return diff <= 0n ? { digits: '', exponent: 0 } : parseDecimal(`${diff}e${e}`);
};

// Exact, positive amount in the asset's own unit. XRP: up to 6 decimals, returned as integer drops.
// Issued: XRPL token precision (15 significant digits, exponent -96..80), returned as a canonical decimal.
export function exactAmount(identity, value) {
  const d = parseDecimal(value);
  if (!d.digits) refuse('AMOUNT_NOT_POSITIVE');
  if (identity.kind === 'native') {
    if (d.exponent < -6) refuse('AMOUNT_XRP_PRECISION');
    const drops = BigInt(d.digits) * 10n ** BigInt(d.exponent + 6);
    if (drops > 100000000000000000n) refuse('AMOUNT_XRP_RANGE');
    return Object.freeze({ kind: 'native', drops: drops.toString() });
  }
  if (d.digits.length > 15) refuse('AMOUNT_TOKEN_PRECISION');
  const sci = d.exponent + d.digits.length - 1;
  if (sci > 95 || sci < -81) refuse('AMOUNT_TOKEN_RANGE');
  return Object.freeze({ kind: 'issued', value: decimalString(d) });
}

// Ledger Amount field for a direct payment of exactly this amount.
export function ledgerAmount(identity, amount) {
  if (identity.kind === 'native') return amount.drops;
  return { currency: identity.currency, issuer: identity.issuer, value: amount.value };
}

// The initial governed profile is a DIRECT payment only: no Paths, no SendMax, no partial-payment flag.
// RLUSD has no transfer fee, so delivered == Amount without SendMax. No NetworkID (0/1/2 must omit it).
export function buildDirectPayment({ identity, amount, account, destination, delegate, destinationTag }) {
  if (!CLASSIC.test(String(account)) || !CLASSIC.test(String(destination))) refuse('PAYMENT_ACCOUNT_INVALID');
  if (account === destination) refuse('PAYMENT_SELF');
  if (identity.kind === 'issued' && destination === identity.issuer) refuse('PAYMENT_TO_ISSUER_REFUSED');
  const tx = { TransactionType: 'Payment', Account: account, Destination: destination, Amount: ledgerAmount(identity, amount), Flags: 0 };
  if (delegate !== undefined) { if (!CLASSIC.test(String(delegate)) || delegate === account) refuse('PAYMENT_DELEGATE_INVALID'); tx.Delegate = delegate; }
  if (destinationTag !== undefined) tx.DestinationTag = destinationTag;
  return Object.freeze(tx);
}

function sameAmount(identity, amount, observed) {
  if (identity.kind === 'native') return typeof observed === 'string' && observed === amount.drops;
  return observed && typeof observed === 'object' && observed.currency === identity.currency && observed.issuer === identity.issuer
    && typeof observed.value === 'string' && compareDecimal(parseDecimal(observed.value), parseDecimal(amount.value)) === 0;
}

// Settlement evidence: the validated transaction delivered EXACTLY the authorized asset and amount to the
// authorized destination, with no partial payment. Anything else is not delivery.
export function verifyDelivered({ identity, amount, destination, tx, meta }) {
  if (!tx || !meta) refuse('DELIVERY_EVIDENCE_MISSING');
  if (meta.TransactionResult !== 'tesSUCCESS') refuse('DELIVERY_NOT_SUCCESS');
  if (tx.TransactionType !== 'Payment' || tx.Destination !== destination) refuse('DELIVERY_DESTINATION_MISMATCH');
  if ((Number(tx.Flags ?? 0) & TF_PARTIAL_PAYMENT) !== 0) refuse('DELIVERY_PARTIAL_PAYMENT_REFUSED');
  if (tx.SendMax !== undefined || tx.Paths !== undefined) refuse('DELIVERY_NOT_DIRECT');
  if (!sameAmount(identity, amount, tx.Amount)) refuse('DELIVERY_AMOUNT_FIELD_MISMATCH');
  if (!sameAmount(identity, amount, meta.delivered_amount)) refuse('DELIVERY_DELIVERED_AMOUNT_MISMATCH');
  return true;
}

// Issued-asset preflight from read-only account_lines / account_info results. The recipient must hold a
// trust line to the exact issuer and currency with headroom; the payer must hold enough; neither side frozen;
// the issuer must not require authorization (RLUSD does not) or the line must be authorized.
export function issuedPaymentPreflight({ identity, amount, payerLines, recipientLines, issuerFlags }) {
  if (identity.kind !== 'issued') return { ok: true };
  if (issuerFlags?.globalFreeze) refuse('PREFLIGHT_ISSUER_GLOBAL_FREEZE');
  const want = parseDecimal(amount.value);
  const line = lines => (lines ?? []).find(l => l.account === identity.issuer && l.currency === identity.currency);
  const payer = line(payerLines), recipient = line(recipientLines);
  if (!payer) refuse('PREFLIGHT_PAYER_TRUST_LINE_MISSING');
  if (!recipient) refuse('PREFLIGHT_RECIPIENT_TRUST_LINE_MISSING');
  for (const l of [payer, recipient]) if (l.freeze || l.freeze_peer) refuse('PREFLIGHT_TRUST_LINE_FROZEN');
  if (issuerFlags?.requireAuthorization && !(recipient.peer_authorized || recipient.authorized)) refuse('PREFLIGHT_RECIPIENT_NOT_AUTHORIZED');
  if (compareDecimal(parseDecimal(String(payer.balance).replace(/^-/, '0')), want) < 0 || String(payer.balance).startsWith('-')) refuse('PREFLIGHT_PAYER_INSUFFICIENT_BALANCE');
  const balance = String(recipient.balance).startsWith('-') ? { digits: '', exponent: 0 } : parseDecimal(String(recipient.balance));
  const headroom = subtractDecimal(parseDecimal(String(recipient.limit)), balance);
  if (compareDecimal(headroom, want) < 0) refuse('PREFLIGHT_RECIPIENT_LIMIT_TOO_LOW');
  return { ok: true };
}
