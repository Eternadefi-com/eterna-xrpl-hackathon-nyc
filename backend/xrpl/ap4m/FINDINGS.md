# AP4M kit findings (B1): 2026-10-24

All of this was gathered read-only:
- public pages of `https://hackathon.ap4m.build`;
- the kit files the service publishes without login;
- `eth_*` read calls to XRPL EVM Testnet.

There was no login, no wallet registration, no faucet and no signature. The earlier assessment's "no kit" is
**outdated**: the kit is public, and it is now vendored (unmodified, git-ignored) by `vendor/fetch-kit.sh`, with a
SHA-256 check for each file.

**Not found:**
- the workshop PDF `Mastercard_AP4M_XRPL_Hackathon_Workshop.pdf` (not in `~/Downloads`, `~/Desktop` or `~/Documents`, and not found by Spotlight);
- `~/eterna-private/ap4m-kit/` (does not exist).

These files are not needed for the integration.

## 1. Service and network

| Item | Value | Source |
| --- | --- | --- |
| Service | `https://hackathon.ap4m.build` (`/health` returns ok) | guide |
| Network | XRPL EVM **Testnet**, chain id **1449000** (`0x161c28`), CAIP-2 `eip155:1449000` | `/public/config`, `eth_chainId` |
| RPC (reader 1) | `https://rpc.testnet.xrplevm.org` | `/public/config`, chainid.network |
| Reader 2 (independent indexer) | `https://explorer.testnet.xrplevm.org/api/eth-rpc` (Blockscout JSON-RPC facade) | probed: chain id and receipts match |
| Explorer | `https://explorer.testnet.xrplevm.org` | `/public/config` |
| Gas faucet | `https://faucet.testevm.ripple.com` (the guide also links `faucet.xrplevm.org`) | `/public/config` |
| Kit terms | "For the Mastercard XRPL Hackathon only … must not be used outside of the hackathon context." | guide, every kit file |

## 2. Contracts (from `GET /public/config`; code confirmed with `eth_getCode` on both readers)

| Contract | Address | Runtime code |
| --- | --- | --- |
| ParticipantRegistry | `0x4cF27435FE56161aa9b1cffdD87784aa68b7D1E8` | 21,926 B, keccak `0x9ae8d15d…` |
| PaymentLedger | `0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91` | 23,925 B, keccak `0xa0427467…` |
| PooledEscrowVault | `0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0` | 23,340 B, keccak `0x05df2985…` |
| RLUSD (ERC-20, 18 decimals; 212-B proxy) | `0x27b57a9D0b8d24EB97259c4E2279e45255e016f3` | keccak `0x5b1a5343…` |

**Deployment identifiers:**
- `deploymentId` `0x1b008272…e3b3` (`PaymentLedger.deploymentId()` agrees);
- `payerPspId` `0x0c4b348a…fc0a`;
- `vaultConfigurationId` `0x9da206a6…5b4d`;
- `environmentManifestDigest` `0x0ebaddb9…965d`;
- vault deployed at block 9192133; confirmation blocks: 1.

The full values are in `constants.mjs`.

**Service test PSPs.** These are Mastercard-operated test identities in this deployment, not production PSPs:
- `mc-payer-psp`, signer `0x23f37318…9563`;
- `mc-payee-psp`, signer `0xae9b83f3…b4f9`.

Real channels show the payee PSP signer as `merchantPspSigner`.

**Chain activity.** The deployment is live and used by other teams. In blocks 9216536–9226535 there were:
- 40 `ChannelOpened`;
- 73 `VoucherRedeemed`;
- 73 `ClaimPaid`;
- 73 `SettlementRecorded`.

Contracts are **not** source-verified on Blockscout. The ABIs come from the kit.

## 3. EIP-712 (from `@ap4m/sdk` 0.10.1 `dist/payment-ledger.js`, `dist/x402.js`; verified against chain)

**Voucher domain:**
```
{ name: "AP4M Payment Ledger", version: "1", chainId: 1449000, verifyingContract: PaymentLedger }
```

**Voucher type:** `Voucher(bytes32 channelId, uint256 cumulativeAmount)`. The amount is **cumulative per Channel**, not per payment.

**x402 resource binding** (signed by the agent with the voucher):
- domain `"AP4M x402 Resource Binding"` v1, same chainId and verifyingContract;
- type `X402ResourceBinding(bytes32 resourceDigest, bytes32 voucherDigest)`;
- `resourceDigest = keccak256(utf8(canonicalJson({url, description, mimeType})))`, where the kit's canonical JSON is
  sorted keys, `JSON.stringify(_, null, 2)` and a trailing `\n`.

**Claim id:**
```
keccak256(abi.encode(keccak256("PaymentClaim(uint256 chainId,address ledger,bytes32 channelId,uint256 previousCumulativeAmount,uint256 cumulativeAmount,bytes32 voucherDigest)"), chainId, ledger, channelId, previous, cumulative, voucherDigest))
```

**Signature rules:** 65 bytes, with recovery byte 27 or 28.

**Close checkpoint:** `CloseChannelCheckpoint(bytes32 channelId, bytes32 finalizationNonce, bytes32 finalVoucherDigest, uint256 finalCumulativeAmount, uint64 merchantPspSignerGeneration, uint64 signedAt)` in the ledger domain. It is signed by the agent through `closeChannel`.

**Verified on real chain data:** a third-party redemption, tx `0x841904c9…b161`. Eterna's own `voucherDigest()` and
`deriveClaimId()` reproduce the on-chain `voucherDigest` and `claimId` exactly. Test 1 checks this, on the tape in
`fixtures/public-tape.json`.

## 4. Events (verbatim ABI in `constants.mjs`; a kit-conformance test re-checks them)

| Contract | Event | Indexed |
| --- | --- | --- |
| PaymentLedger | `VoucherRedeemed(channelId, claimId, voucherDigest, allocationId, agent, merchantId, payout, submitter, previousCumulativeAmount, cumulativeAmount, amount)` | channelId, claimId, voucherDigest |
| PaymentLedger | `SettlementRecorded(claimId, channelId, settlementDigest)` | all three |
| PaymentLedger | `ChannelOpened(channelId, allocationId, merchantPspId, requestDigest, authorityAttestationId, allocationGeneration, agent, merchantId, merchantAttestationId, merchantGeneration, payout, cap, validAfter, validBefore, merchantPspSigner, merchantPspSignerGeneration)` | channelId, allocationId, merchantPspId |
| PaymentLedger | `ChannelClosed(channelId, allocationId, finalCheckpointDigest, finalVoucherDigest, merchantPspSignerGeneration, redeemed, unusedCapacityReleased)` | first three |
| PooledEscrowVault | `ClaimPaid(claimId, payoutId, channelId, payout, amount, cumulativeDisbursed, paidAt)` | claimId, payoutId, channelId |
| RLUSD | `Transfer(from = vault, to = payout, value)` in the payout tx | from, to |

**Observed ordering for one payment:**
1. `VoucherRedeemed` (block N, sent by the merchant's submitter);
2. `ClaimPaid` and the RLUSD `Transfer` (block N+2, the payout tx);
3. `SettlementRecorded` (block N+4, the settlement tx).

## 5. Read functions (PaymentLedger)

- `channels(bytes32)` returns 18 fields:
  - allocationId, merchantPspId, requestDigest, **authorityAttestationId**, **merchantAttestationId**, merchantId;
  - latestVoucherDigest, **cap**, **redeemed**, agent, allocationGeneration;
  - **status** (1 = open, 2 = closed, as observed), payout, merchantGeneration, **merchantPspSigner**, merchantPspSignerGeneration;
  - validAfter, validBefore.
- `claims(bytes32)` returns (channelId, amount, settlementDigest).
- `agentAllocations(bytes32)` returns the **funded Authorized Spend Limit**: cap, reserved, spent and the authority/scope commitments.
- `availableAgentCapacity(bytes32)`.
- The only agent write is `redeemVoucher((channelId, cumulativeAmount), agentSignature)`. In the x402 flow the **merchant** sends it.

## 6. Service API (from the kit source; Bearer = session token)

**Public, no auth:**
- `GET /public/config`;
- `GET /public/x402-context` (schema `ap4m.hackathon-service.x402-context.v1`);
- `GET /public/merchants` (today `cross_team_payments: false` and an empty list: a channel pays **your own team's** merchant);
- `GET /public/evidence/claims/<claimId>[/<settlementDigest>.json]` (the `ap4m.claim-receipt.v1` receipt).

**Sign-in:**
1. `POST /public/participant/challenge {teamName, wallet}`;
2. personal_sign of `message`;
3. `POST /public/participant/session {challengeId, signature}`, which returns `{token, expiresInSeconds}`.

Sign-in is off-chain, but it is a signature with the agent key, so the owner must approve it.

**Bearer endpoints:**
- `POST /public/participant/channel-requests/prepare {cap_rlusd, merchant_id}` returns `{to, data}`. The **agent sends
  this vault transaction (gas)**, then calls `POST /public/participant/channel-requests {tx_hash}`. Polling
  `GET /public/participant/channels` then shows `open`.
- `POST /public/participant/record-redemption {tx_hash}`.
- `POST /public/participant/settle {channel_id}`: answers 202 while confirming, then returns `{settlement_tx, payout_tx, amount_rlusd, recipient, claim_id, receipt_url, receipts[]}`.
- `GET /public/participant/close-channel-challenge` and `POST /public/participant/close-channel {agent_signature_r, agent_signature_vs, channel_id}`.
- `GET /public/participant/me`.

**x402 (kit `ap4m-x402.mjs`):**
- The merchant sends `GET /resource` with `X-AP4M-CHANNEL-ID` and gets back **402** with header `PAYMENT-REQUIRED` (canonical base64 JSON, x402 v2).
- The challenge has scheme `batch-settlement`, network `eip155:1449000`, `amount` (wei), `asset` (RLUSD), `payTo` (the channel payout) and
  `extra {bindingVersion "1", ledger, pricingMode "fixed", channelId, acceptedCumulativeAmount}`. It expires in 300 s or less.
- The agent retries with `PAYMENT-SIGNATURE` (voucher, agentSignature, resourceDigest, resourceSignature).
- The merchant **redeems on chain** and answers **200** with `PAYMENT-RESPONSE {success, transaction, network}` and the resource.
- `buyResource` refuses a price above `maximumAmount`, or one that would take the cumulative amount over the channel `cap`.
- The merchant keeps state in SQLite (`node:sqlite`), so it needs **Node ≥ 22.13**. The Mac has `/opt/homebrew/bin/node` v25.9; the default `node` on PATH is v20.

**Onboarding (portal only, not code):**
- add the agent wallet (it signs once to prove ownership);
- add the merchant payout address;
- fund the budget by depositing RLUSD from the funding wallet, or ask staff.

**Wallet rule:** agent ≠ payout, and payout ≠ funding (the agent may also be the funding wallet).

## 7. Eterna's wallets (read-only state at block ~9226535)

- **Agent:** `0x8559285aa94E04C3a6F689546276A47Bd8Ea7e36`. 0 XRP gas, nonce 0, 0 RLUSD. Its key file loads to this address, and the key is never printed.
- **Merchant payout (PROPOSED, not created):** a new EOA generated by the owner into `~/eterna-private/ap4m-merchant-payout/payout.key` (0600). It must differ from the agent and the funding wallet. It also serves as the merchant's redemption submitter, so it needs gas.

## 8. Still missing / unknown

1. **Portal-only material.** We could not read it without a session:
   - `/docs/*.md`, `/llms.txt`, `/llms-full.txt` and `/admin/network.html` (401 without a session);
   - the per-team `example-agent.js`;
   - the exact sign-in wallet-ownership message;
   - the per-deposit channel limits ("listed in `/llms.txt`").
2. **Our team's onboarding state.** We do not know the team name, merchant id or budget. Today `cross_team_payments` is false.
3. **The workshop PDF.** Not found on this Mac.
4. **Contract source.** It is not verified on the explorer; we rely on the kit ABIs and on matching real event data.
5. **`agentAllocations` read for our team:** possible only after onboarding (it needs our allocationId from `ChannelOpened`).
