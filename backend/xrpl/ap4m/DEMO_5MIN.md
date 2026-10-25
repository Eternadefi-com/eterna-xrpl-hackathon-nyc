# Eterna × Mastercard AP4M: 5-minute demo (XRPL EVM **Testnet**)

**One line.** An AI agent pays for data by itself over HTTP 402 with the real AP4M kit. Before the agent's key can
sign anything, Eterna's governance decides whether it may. The agent pays inside its limits, is refused above them, and
every payment is proven on chain from two independent readers.

## What is real and what is pending (state on 2026-10-24)

| Piece | Status |
| --- | --- |
| AP4M kit (`@ap4m/sdk` 0.10.1, `ap4m-x402.mjs`, `ap4m-hackathon-sdk.js`) | **Real, vendored unmodified.** The x402 Merchant, `buyResource`, `requestChannel`, `settle` and `closeChannel` are the kit's own code. |
| AP4M contracts and service (PaymentLedger, PooledEscrowVault, ParticipantRegistry, RLUSD on chain 1449000) | **Real** (Mastercard's hackathon deployment). Addresses and code hashes were checked read-only on 2 readers. |
| Eterna governance gate, voucher drafting, owner-side signer, 2-reader verification | **Built and tested offline** (12 tests). The digest and claim-id math is proven against a real public testnet payment. |
| Eterna's own onboarding, faucet gas, channel, purchase and settlement | **PENDING owner approval** (RUNBOOK steps 0–12). There are no Eterna tx hashes yet. |
| Mainnet | **None.** The kit is testnet-only. |

## Architecture

```
 Agent (Eterna Coach)            Eterna (governance)                 Owner's Mac                AP4M (Mastercard hackathon)
 ───────────────────            ───────────────────                ───────────               ─────────────────────────────
 GET /resource  ───────────────────────────────────────────────────────────────────────────►  kit x402 Merchant
                ◄──── 402 PAYMENT-REQUIRED (batch-settlement, RLUSD, payTo, channelId) ─────
 read channel on chain (cap, redeemed, agent, payout, PSP attestation ids) ◄─── PaymentLedger.channels()
 authorize(request) ──────────► PERMIT | REFUSE  (certificate: perTx, total, seller, agent wallet, expiry, replay)
                                 │ REFUSE → refusal receipt (sha256), nothing signed
                                 ▼ PERMIT → adapter.prepare: exact Voucher(channelId, cumulative) or refuse CAP_EXCEEDED
                                 permit (governance key; cannot move funds) ──► owner-voucher-signer: signs ONLY that
                                                                                 voucher + its x402 resource binding
 kit buyResource(wallet = governed signer) ──── PAYMENT-SIGNATURE ─────────────────────────►  Merchant redeemVoucher()
                ◄──── 200 resource + PAYMENT-RESPONSE ──────────────────────────────────────    → VoucherRedeemed
 POST /record-redemption, settle ───────────────────────────────────────────────────────────►  service: Vault ClaimPaid
                                                                                                + RLUSD → payout;
                                                                                                Ledger SettlementRecorded
 adapter.verify: VoucherRedeemed + ClaimPaid + Transfer + SettlementRecorded, re-derived claimId/voucherDigest,
                 from rpc.testnet.xrplevm.org AND the Blockscout indexer, block hashes agree → VERIFIED → UNLOCKED
```

## The 5 minutes, beat by beat (mapped to judging weights)

| Time | Beat | What judges see | Weight it serves |
| --- | --- | --- | --- |
| 0:00–0:40 | **Setup** | The agent wants a per-call data report from Eterna's merchant, a real kit `createX402Merchant` on `:4308`. Preflight: chain 1449000; contract code hashes match on both readers; agent ≠ payout ≠ funding. | Use case / utility 25 |
| 0:40–1:40 | **CONTROL** | (1) PSP-attested identities: the channel's `authorityAttestationId`, `merchantAttestationId` and `merchantPspSigner` (= Mastercard Payee PSP) read from `PaymentLedger.channels()`. (2) Funded Authorized Spend Limit: the deposit and the channel cap (1 RLUSD). (3) The Eterna certificate on top: 0.5 per call, 1 total, this merchant and this agent wallet only. (4) **Over-cap:** the agent asks `:4309` (5 RLUSD) and gets `PER_TX_EXCEEDED` with a refusal receipt; the signer log is **empty**, so nothing was signed. | Trust & control 25 |
| 1:40–3:00 | **PAYMENT** | Live: GET → **HTTP 402**, then the agent decides by itself → Eterna PERMIT → the owner-side signer signs **the AP4M EIP-712 voucher** (domain "AP4M Payment Ledger", chain 1449000) inside the kit's `buyResource` → the merchant redeems → **resource returned at once**. | Technical execution 25, autonomy |
| 3:00–4:20 | **PROOF** | Explorer: **VoucherRedeemed** (PaymentLedger), **ClaimPaid** plus the RLUSD transfer to the payout (Vault), **SettlementRecorded** (Ledger); the payout balance changed. The AP4M `receipt_url`, checked with the kit's `verify-receipt.mjs`. Eterna's receipt: 2 readers agree → VERIFIED → UNLOCKED. | Technical execution 25, demo 10 |
| 4:20–5:00 | **Path to production** | The same adapter contract as Eterna's XRPL rails. The governance engine doesn't change. Swap the hackathon kit for production AP4M, and the test PSPs for real PSP onboarding. | Path to production 15 |

**Fallback, if live testnet is slow:**
- show the offline suite (`node --test ap4m/ap4m.test.mjs`);
- show the real third-party payment tape verified from 2 readers.

Always say that this is not Eterna's payment.

## Exact sponsor assets used

- **AP4M hackathon service** `https://hackathon.ap4m.build`:
  - `/public/config`, `/public/x402-context`, `/public/merchants`;
  - participant sign-in, channel request, record-redemption, settle and close;
  - evidence receipts.
- **Kit:**
  - `ap4m-hackathon-sdk.js` (signIn, requestChannel, settle, closeChannel);
  - `ap4m-x402.mjs` (loadX402Context, buyResource, createX402Merchant);
  - `@ap4m/sdk` 0.10.1 (`ap4m-sdk.tgz`);
  - `verify-receipt.mjs`.
- **Contracts on XRPL EVM Testnet:**
  - PaymentLedger `0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91`;
  - PooledEscrowVault `0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0`;
  - ParticipantRegistry `0x4cF27435FE56161aa9b1cffdD87784aa68b7D1E8`;
  - RLUSD `0x27b57a9D0b8d24EB97259c4E2279e45255e016f3`.
- **Test PSPs:** `mc-payer-psp`, `mc-payee-psp`.
- **XRPL EVM Testnet:** RPC, Blockscout explorer and faucet.

## Production-readiness assessment

**Ready to carry over:**
- the governance engine, unchanged; the only change is a backward-compatible `RLUSD-EVM` asset and an `evmAgent` binding, with 56 tests green across commerce, unified and ap4m;
- the refuse-before-sign custody boundary (permit → owner-side signer);
- 2-reader verification;
- the receipts.

**Hackathon-only, to replace:**
- the kit itself (its terms forbid use outside the hackathon);
- the test PSPs: production needs real Payer/Payee PSP onboarding and KYA, done by PSPs and not by Eterna;
- the service-run settlement;
- `node:sqlite` merchant state;
- loopback HTTP: production needs HTTPS.

**Gaps to close for production:**
- HSM or secure-enclave custody for the agent key, instead of a 0600 file;
- a governance key on a separate machine (one Mac in the demo);
- persistent governance state: today the decision store is in-memory per process;
- chargeback and reversal handling;
- monitoring of contract code hashes;
- multi-merchant routing once cross-team payments are on.

**Risk notes:**
- **Testnet RPCs are single-operator.** Blockscout is an independent indexer, but not an independent node operator.
- **Contracts are unverified on the explorer.** We rely on the kit ABIs, and on real events matching our re-derived digests.

## Draft submission text (Mastercard form)

> **Eterna: governed autonomous payments on AP4M.**
>
> Our AI agent buys per-call data from a merchant over HTTP 402 using the Mastercard AP4M hackathon kit on the XRPL EVM
> Testnet. AP4M gives the agent:
> - PSP-attested identities;
> - a funded Authorized Spend Limit;
> - RLUSD settlement with on-chain receipts.
>
> Eterna adds the owner's rules in front of the agent's key. Before any voucher is signed, Eterna's governance engine
> checks the owner's certificate: per-call and total caps, the approved merchant, the bound agent wallet, expiry and
> replay. It then either permits that exact voucher or refuses with a hashed refusal receipt.
>
> The agent key lives on the owner's machine, behind a signer that signs only a voucher Eterna has permitted. Eterna can
> refuse a payment, but it can never send one.
>
> In the demo:
> - the agent reads the 402, decides by itself, and pays 0.25 RLUSD inside its limits;
> - the resource is delivered at once;
> - an over-cap request (5 RLUSD) is refused before signing;
> - we prove VoucherRedeemed, ClaimPaid and SettlementRecorded on chain, re-derived from two independent readers, and
>   match them to the AP4M receipt.
>
> Eterna's checks are governance evidence. They are not Mastercard KYA or PSP certification. Everything runs on XRPL EVM
> Testnet with hackathon test assets.

*(Before submitting: replace the bracketed numbers with the actual tx hashes from the evidence manifest. If the live
run has not happened, say "pending" rather than describing it as done.)*
