# What a real Mastercard Agent Pay for Machines (AP4M) connection still needs

Today `adapters/ap4m-voucher.mjs` is a **simulator**: `mode: 'SIMULATED'`, issuer "Eterna local simulator — not
Mastercard". The `mastercard-network` component is **PENDING / BLOCKED**, because we have no access.

## What is public

These facts are as given in our brief. We have not verified them against Mastercard documents, since the portal is gated.
- Early access opened on **2026-10-20**.
- The protocol is **x402-based**: HTTP 402 with a payment requirement, then a retry carrying payment.
- Buyers sign **EIP-712 vouchers**.
- Redemption is **deferred and batched**.
- **Settlement was on Base** in the public demo.
- The developer portal at **ap4m.build is gated**.

## Outstanding requirements

Status values: **UNKNOWN** means we do not have it, and no public source we have specifies it.

| # | Requirement | Status | Fills (our adapter) | What changes when we get it |
| --- | --- | --- | --- | --- |
| 1 | Early Access credentials (account, API keys or client cert) | UNKNOWN / not granted | `challenge`, `verify`, plus a new facilitator client | The adapter can call Mastercard. Without this, `mode` stays SIMULATED. |
| 2 | Sandbox base URL(s) | UNKNOWN | the facilitator client used by `verify` | Becomes the reader for voucher status. |
| 3 | Buyer API (session open, voucher submit) and seller API (402 requirement format, voucher acceptance) | UNKNOWN | `challenge(offer)`, `prepare(decision, ctx)` | Replace our `eterna-voucher-sim` scheme and the `paymentRequired` shape with the real `accepts[]` entry. |
| 4 | Voucher **EIP-712 domain** (name, version, chainId, verifyingContract) and **types** (field names, order, units, nonce and expiry semantics, cumulative or per-voucher) | UNKNOWN | `prepare` (typed-data draft), seller-side verification | Replace `DOMAIN` / `TYPES` in `unified/voucher-sim.mjs`. Replay rules (`REPLAYED_VOUCHER_NONCE`) adapt to their nonce model. |
| 5 | Chain and token for the voucher value (the public demo used Base; which token?) | UNKNOWN beyond "Base in demo" | `assets`, `networks`, `verify` | The asset and network of the adapter change. Today it is `XRP` on `xrpl:2`. |
| 6 | Funded buyer wallet on that chain, and the key-custody model (who signs vouchers) | UNKNOWN | the signer outside `prepare` | Eterna's governed signer would hold or approve the voucher key, as in the simulator. |
| 7 | KYA (know-your-agent) / agent registration requirements | UNKNOWN | `identify` (governance), `challenge` | Maps to the certificate `requester` identity. It may require a registered agent id. |
| 8 | Facilitator **verify** endpoint (voucher validity) | UNKNOWN | `verify` (VOUCHER_VERIFIED stage) | Replaces `createSeller().verify`. |
| 9 | Facilitator **redeem** endpoint (batch submission) | UNKNOWN | REDEEMED stage | Replaces `createSeller().redeem`. |
| 10 | Facilitator **settle** endpoint, or a settlement report | UNKNOWN | the SETTLED stage and its `txHash` | Settlement evidence comes from Mastercard or the chain instead of our XRPL Devnet payment. |
| 11 | Webhook or reconciliation feed (status changes, chargebacks or reversals, final settlement ids) | UNKNOWN | `verify` (reconciliation), proof conditions | New proof conditions, for example `settlementFinal: true` and a reconciled batch id. |
| 12 | Terms: test-mode limits, allowed merchants and sellers, fees | UNKNOWN | certificate limits | Certificate `limits` and `sellers` may need to mirror them. |

## What stays the same

The governance engine does not change:
- a voucher is signed only after PERMIT;
- VOUCHER_VERIFIED is not settlement;
- UNLOCKED requires settlement evidence that meets the adapter's proof conditions and binds to the decision.

Only the adapter's `challenge`, `prepare`, `verify`, `assets`, `networks` and `mode` change.
