# Eterna commerce core: one governance engine, four payment capabilities

> One Eterna application. Four payment capabilities. One governance engine. Independent, verifiable evidence.

This is the smallest working architecture behind that sentence. It extends `unified/` (Devnet mission), `xls68/` and the
existing RLUSD / paychan code rather than starting over. Work here is **offline or read-only**:
- no transaction is submitted on any network;
- no real key signs anything;
- no faucet is used.

```
node --test commerce/                    # 24 tests: engine, adapters, conformance, product files (offline, replayed tapes)
node commerce/record-evidence.mjs        # READ-ONLY: re-read the real executions from 2 readers per network, refresh tapes + evidence
```

## Architecture

```
            request (requester, payer, seller, rail, network, asset, amount, requestId, voucher?)
                                   │
  governance.mjs  ── identify ── validate certificate (sha256 canonical digest + Rose's signature)
                  ── authorize ─► PERMIT (decision record, budget reserved) | REFUSE (code + refusal record)
                  ── route ─────► adapter.prepare(decision, ctx) → UNSIGNED tx / claim / voucher draft
                  ── advance ───► AUTHORIZED → [VOUCHER_VERIFIED → REDEEMED | SUBMITTED] → SETTLED   (SUBMITTED/SETTLED need a ledger tx)
                  ── unlock ────► adapter.verify(...) meets proofConditions AND binds to the decision → VERIFIED → UNLOCKED
                  ── receipt ───► sha256 over canonical JSON: certificate, approval, decision, history, evidence, unlock
                                   │
       ┌───────────────┬───────────┴──────────┬──────────────────────┐
  xrp-paychan        rlusd            xls68-sponsored          ap4m-voucher (SIMULATED)
  (Mainnet worker)   (direct Payment)  (Devnet, XLS-68)        settles via a LIVE rail
                                   │
                  delegation.mjs (XLS-75, supporting: any rail; no reserve sponsorship with Delegate)
```

| File | Role |
| --- | --- |
| `governance.mjs` | The engine: certificate v2, `authorize`, budgets, states, `route`, `advance`, `fail`, `unlock`, `receipt`. It generalises `unified/governance.mjs` and reuses its `signDigest` / `verifyDigestApproval`. |
| `contract.mjs` | The adapter contract: `assertAdapter`, `unmetProof`, `x402Challenge` and `agreement`. |
| `adapters/*.mjs` | The four adapters. |
| `delegation.mjs` | XLS-75 helpers: `delegateTx`, `assertDelegationCompatible`, `readDelegationGrant`, plus the grant builder from `unified/tx.mjs`. |
| `readers.mjs` | Read-only readers for Mainnet, Testnet and Devnet. Hosts are allow-listed and the network id is checked. It also provides the recording and replay readers. There is no submit path. |
| `record-evidence.mjs` | Read-only capture into `fixtures/readonly-tape.json` and `evidence/*.json`. |
| `products/*.json` | The product definitions. A test keeps them equal to each adapter's `describe()`. |

### Governance interface

**Certificate v2.** `buildMissionCertificate(...)`, then `approveCertificate(cert, roseKey)`, then `createGovernance({ certificate, approval, adapters, now })`.

Fields:
- `task`;
- `requester { id }`;
- `payer { xrpl }`;
- `sellers[]`, `rails[]`, `networks[]`;
- `limits`:
  - `XRP: { perTx, total }` in drops strings;
  - `RLUSD: { perTx, total, issuer, currency }` as exact decimals (at most 6 places, no floats), bound to the
    issuer/currency/network through `lib/xrpl-asset-identity.mjs`;
- `maxTransactions`, `issuedAt`, `expiry`.

**Refusal codes.**
- `CERT_INVALID`, `EXPIRED`;
- `WRONG_REQUESTER`, `WRONG_PAYER`;
- `REPLAYED_REQUEST` (same `requestId`), `REPLAYED_VOUCHER_NONCE` (same rail + seller + session + nonce);
- `RAIL_NOT_ALLOWED`, `RAIL_UNAVAILABLE`, `NETWORK_MISMATCH`, `ASSET_NOT_ALLOWED`, `SELLER_NOT_APPROVED`;
- `AMOUNT_INVALID`, `PER_TX_EXCEEDED`, `TOTAL_EXCEEDED`, `COUNT_EXHAUSTED`.

**Budget.** Budgets are per asset, in integer base units (XRP drops; RLUSD micro-units via `lib/ny-asset-schemas-v2.mjs`).
- **Reserved** at PERMIT.
- **Committed** at VERIFIED.
- **Released** on FAILED only if nothing reached the ledger. A failure after SUBMITTED/REDEEMED is held as committed,
  because funds may have moved.

**States.**
- AUTHORIZED, VOUCHER_VERIFIED (voucher and claim rails only), SUBMITTED, REDEEMED, SETTLED, VERIFIED, UNLOCKED,
  REFUSED, FAILED.
- Each adapter declares its `lifecycle`.
- VERIFIED and UNLOCKED are reachable only through `unlock()`.

**`unlock(decision, evidence)` is refused** in any of these cases:
- the decision is not SETTLED;
- the evidence is from another adapter;
- the evidence status or facts miss the rail's `proofConditions`;
- the evidence does not bind to the decision: network, payer, destination, asset, exact amount and settled tx hash must
  all match.

Evidence with status FAILED marks the decision FAILED.

**A signed voucher is never settlement.** Tests check this at each stage:
- VOUCHER_VERIFIED cannot unlock;
- REDEEMED cannot reach SETTLED without a ledger tx;
- SETTLED with PENDING evidence cannot unlock.

### Adapter contract

Each adapter has the fields `{ id, rail, assets, networks, mode: 'LIVE_CAPABLE'|'SIMULATED' }` and these methods:

| Method | Returns |
| --- | --- |
| `describe()` | `{ can[], cannot[], proofConditions, lifecycle[] }` |
| `challenge(offer)` | An x402 v2-shaped 402 body |
| `prepare(decision, ctx)` | An UNSIGNED draft |
| `verify(executionRef, readers)` | `{ status, facts, txHash?, ledger? }` |

`assertAdapter()` enforces the shape. One rule: a SIMULATED adapter cannot declare VERIFIED proof.

## Per-adapter status

| Product / adapter | Mode | Status | Evidence |
| --- | --- | --- | --- |
| XRP micropayments / `xrp-paychan` | LIVE_CAPABLE | **REAL** (Mainnet, executed by the purchase worker, not by this adapter) | Redeem tx `7CC6078F…D971` (ledger 107822136) re-read from `s1.ripple.com` and `xrplcluster.com`: VERIFIED. See `evidence/xrp-paychan.mainnet.json`. |
| RLUSD payments / `rlusd` | LIVE_CAPABLE | **LOCAL-ONLY**; evidence PENDING | Builder, preflight and verifier are tested. Testnet issuer flags were read live: RequireAuth off, no global freeze, no transfer fee, clawback on. No payment until a Testnet run is approved. |
| Sponsored execution / `xls68-sponsored` (+ `delegation.mjs`) | LIVE_CAPABLE | **REAL** (Devnet) | Settlement `D29DBDF5…A0DD`, DelegateSet `069C9A78…00A9` and agent create `67CC1CFE…C622`, re-read from two Devnet readers: VERIFIED. |
| Voucher commerce / `ap4m-voucher` | SIMULATED | **SIMULATED**; Mastercard network **BLOCKED** | The real Devnet batch reconciles with the real delegated settlement: `settlementCoversBatch` is true and the status stays SIMULATED. See `MASTERCARD_REQUIREMENTS.md`. |

## Reused (file @ commit)

| Code | Source |
| --- | --- |
| Generalised: `signDigest` / `verifyDigestApproval` (extracted, no fork), `voucher-sim.paymentRequired` (extracted), `verify.balanceDeltas` (exported) | `unified/governance.mjs`, `unified/voucher-sim.mjs`, `unified/verify.mjs` @ `4c6bba5` |
| Snapshot definitions, sponsor preflight, SPN/STX signing data, hashing | `xls68/xls68.mjs` @ `5963ba1` |
| `assetIdentity`, `registeredAssetIdentity`, `exactAmount`, `buildDirectPayment`, `issuedPaymentPreflight`, `verifyDelivered` | `lib/xrpl-asset-identity.mjs` @ `dac1f07` / `60cb291` |
| `nyAmountUnits`, `nyUnitsDecimal` (exact RLUSD base units) | `lib/ny-asset-schemas-v2.mjs` @ `60cb291` |
| Testnet readers and issuer-flag bits | `lib/ny-testnet-profile.mjs` + `scripts/ny-testnet-rlusd-rehearsal.mjs` @ `dc92f4a` |
| Ported (pure only): the 402 body, `ClaimAcceptor.accept` and `dropsToXrp` | `tools/paychan-demo/src/seller-agent.mjs` @ `f0c4e1c` and `src/claims.mjs` @ `32fb894`, branch `codex/ny-agent-orchestration-v1` (HEAD `67a0014`), read only |
| Recorded Mainnet execution, copied read-only into `fixtures/mainnet-paychan-purchase.json` | `hackathon-governed-a2a` `apps/agent-purchase/fixtures/mainnet-standing-2026-10-22.json` (`purchases[0].ownerView`) |

## Honest limits

- **Synthetic tapes.** The positive engine paths use SYNTHETIC tapes with fake keys (`test-support.mjs`). Real evidence is
  for a payer whose key we must not use, so it can only be shown through adapter `verify()`. The tests prove that the
  same real evidence is refused for a different principal.
- **Certificates and approvals.** No v2 certificate has been signed by a real Rose key. The Devnet mission's v1
  certificate (in `unified/`) is the one real approval.
- **Paychan execution.** It stays with the purchase worker. The adapter only drafts claims, accepts claims and verifies.
- **Policy is software.** The engine's limits are software policy, as in `unified/`. On the ledger, a Payment
  delegation is not amount-limited.
- **Reader independence.** It is inferred from host and operator, not attested.
