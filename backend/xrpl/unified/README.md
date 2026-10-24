# Rose unified commerce: one governed AI purchase on XRPL Devnet

This directory runs one governed AI purchasing mission on **XRPL Devnet only**. It combines four pieces:
- XLS-68 sponsorship;
- XLS-75 delegation;
- a **simulator** of the voucher model of Mastercard Agent Pay for Machines (AP4M);
- independent verification from the ledger, with a linked audit receipt anchored on Devnet.

Rose is a fictional persona. Her "treasury" is a Devnet wallet standing in for her own.

```
node --test unified/unified.test.mjs       # offline tests (from backend/xrpl)
node unified/run-mission.mjs               # the mission (Devnet writes; resumable)
node unified/verify.mjs                    # read-only re-verification of the saved mission; rewrites the evidence
```

The output is `unified/evidence/evidence-rose-unified-commerce.json`, which the presentation reads.

## What is real and what is simulated

| Piece | Real or simulated |
| --- | --- |
| Mission certificate, Rose's approval signature, Eterna's policy gate | Real code. It runs locally. The certificate digest is written on the ledger, and Rose's approval key is the key she uses on the ledger. |
| XLS-68 sponsored agent account, XLS-75 DelegateSet, settlement Payment, audit anchor | **Real XRPL Devnet transactions.** Each is re-read and checked from two readers. |
| 402 → EIP-712 voucher → seller verification → batch redemption | **SIMULATED.** This is Eterna's local model of AP4M as publicly described. Every object carries `simulated: true` and `issuer: "Eterna local simulator — not Mastercard"`. |
| Redemption settlement | One delegated XRPL Devnet Payment, labelled "simulated AP4M redemption settled by Eterna on XRPL Devnet". **It is not a Mastercard settlement.** |
| Mastercard network | **PENDING.** There is no AP4M sandbox access. Nothing here connects to Mastercard. |
| Ledger reports sold by the seller | Real validated Devnet ledger headers. Each one is re-checked on both readers before the reports are unlocked. |

## Architecture

```
governance.mjs   certificate (canonical JSON, sha256), Rose approval (xrpl keypair over "ETERNA-MISSION-APPROVAL\0"||digest),
                 sessionPolicyCheck / policyCheck: seller, per-voucher increment, cap, expiry, agent key, monotonic
voucher-sim.mjs  EIP-712 Session + Voucher (ethers TypedDataEncoder / signTypedData / verifyTypedData),
                 createGovernedAgent (policy gate BEFORE any signature), createSeller (verify, replay, cap, expiry,
                 seller binding, redemption batch), status machine ISSUED→VERIFIED→REDEEMED_PENDING→SETTLED|REJECTED,
                 startSellerServer (node:http on 127.0.0.1, x402 v2 shape), agentFetch (402 → voucher → retry)
tx.mjs           builders and signing: agent account create (from ../xls68), sponsored DelegateSet (port of
                 buildNyDelegateSet), delegated fee-sponsored settlement Payment, anchor AccountSet; checkMission
                 (forbidden combinations); cosign (sponsor SPN + Account/Delegate STX)
rpc.mjs          Devnet-only readers (JSON-RPC and wss), host allow-list, network_id 2 check, faucet, submit+wait
verify.mjs       re-reads each tx in binary from every reader, decodes it locally, re-checks signatures, fields,
                 memos, balance deltas and ledger objects; builds the evidence
store.mjs        keys and state in ~/eterna-private/unified-devnet (dir 0700, files 0600); seeds are never printed
run-mission.mjs  orchestration; persists every signed blob before submitting it
```

**x402 interface (simulated scheme `eterna-voucher-sim`, network `xrpl:2`).**
- `GET /report` with no payment returns `402`. The `PAYMENT-REQUIRED` header (base64 JSON) and the body both contain
  `{x402Version:2, resource, accepts:[{scheme, network, amount, asset:"XRP", payTo:S, maxTimeoutSeconds, extra}]}`.
- The retry carries `PAYMENT-SIGNATURE`: base64 of `{x402Version:2, scheme, network, accepted, payload:{session, voucher}}`.
- On success the seller returns `200` with the report and a `PAYMENT-RESPONSE` header.

**EIP-712.** The domain is `{name:"Eterna AP4M Simulator", version:"0", chainId:0}`.
- `Voucher` has the fields `sessionId, buyer, seller (XRPL address of S), cumulativeDrops, nonce, expiry, certificateDigest`.
- `Session` has the fields `sessionId, buyer, seller, capDrops, expiry, certificateDigest`.
- The buyer is an EVM-style address from a simulator-only key, which is named in the certificate.
- "Per-voucher limit" means the increment one voucher adds over the previous cumulative amount.

## The mission (as run)

| Account | Role |
| --- | --- |
| E | Eterna, the sponsor (faucet) |
| R | Rose's treasury (faucet) |
| S | The seller (faucet) |
| A | Rose's agent, created by E as a sponsored account |
| rogue | A non-approved seller address. It is never funded. |

1. **Governance.**
   - Certificate: agent A plus its voucher key; task "buy validated XRPL ledger reports"; approved seller S;
     0.1 XRP per voucher, 0.5 XRP cap, 24 h expiry.
   - Digest: sha256 over canonical JSON.
   - R signs the digest.
2. **XLS-68.** E sends `Payment` 1 drop to A with `tfSponsorCreatedAccount`. A's `AccountRoot.Sponsor` is E.
3. **XLS-75.** R sends `DelegateSet`, which grants A `Payment` only.
   - It carries `Sponsor` E with `SponsorFlags` 3 (fee + reserve), and E co-signs with the SPN prefix.
   - The memo is the certificate digest.
   - The `Delegate` entry carries `Sponsor` E.
4. **Vouchers.** The agent buys 3 reports at 0.1 XRP each, using cumulative vouchers of 100000, 200000 and 300000
   drops. The seller verifies each voucher, then redeems one batch.
5. **Settlement.** One `Payment` with these fields:
   - `Account` R, `Delegate` A (A's key signs), `Destination` S, `Amount` 300000;
   - `Sponsor` E with `SponsorFlags` 1 (fee only), co-signed by E;
   - memos: the batch digest and the certificate digest.

   The balance deltas are R −300000, S +300000, E −fee. A is unchanged.
6. **Verify.** Every reader must prove every component. Only then are the reports unlocked and the vouchers marked
   SETTLED. Then the audit receipt is built: sha256 over the certificate, the approval, the tx hashes, the voucher and
   report digests, the refusals and the verification facts. One `AccountSet` memo from E anchors it, and that
   transaction is verified too.
7. **Refusals.** Two requests are refused before anything is signed (not even a session):
   - a premium report at 0.2 XRP: `POLICY_PER_VOUCHER_EXCEEDED`;
   - the rogue seller: `POLICY_SELLER_NOT_APPROVED`.

   The seller also rejects a replayed voucher (`REPLAY`). The ledger shows that R's only delegated payment went to S.

**Resumable.** State is kept in `~/eterna-private/unified-devnet/mission-state.json`.
- A rerun skips validated steps.
- An interrupted step resubmits the same signed blob, so the hash is the same.
- A blob whose `LastLedgerSequence` has passed without validation is re-signed.
- Any `tec`/`tem`/`tef` result stops the run.

To start a fresh mission, move the state file aside. The keys are reused.

## Combination rules (rippled 3.4.1, tag `00e6407`)

| Rule | Source |
| --- | --- |
| `spfSponsorReserve` + `Delegate` → `temINVALID`. Never built; `checkMission` refuses it. | `src/libxrpl/tx/Transactor.cpp` `checkSponsor`; `Sponsor_test.cpp` `testDelegateBlockReserveSponsor` |
| `spfSponsorFee` + `Delegate` is **allowed**. With a co-signature, the sponsor account pays the fee. | `Transactor::getFeePayer`; `Sponsor_test.cpp` `testDelegateSponsorFeePayer` (co-signing case) |
| The delegated tx is signed by the Delegate. The fee payer is the Delegate unless the tx is sponsored. | `Transactor::checkSign` (`idAccount = Delegate`); `STTx::getInitiator` |
| A prefunded `Sponsorship` for a delegated tx must be (sponsor, **delegate**). Not used here; we co-sign. | `Transactor::checkSponsor` (`getInitiator`) |
| A `DelegateSet` may be fee- and reserve-sponsored. The created `Delegate` entry carries `Sponsor`. | `SponsorHelpers.cpp` `isReserveSponsorAllowed`; `Sponsor_test.cpp` `testDelegate` |
| `Delegate == Account` → `temBAD_SIGNER`. A self-authorising DelegateSet, a duplicate permission or a non-delegable permission → `temMALFORMED`. More than 10 permissions → `temARRAY_TOO_LARGE`. A missing `Authorize` account → `tecNO_TARGET`. | `Transactor::preflight1`; `DelegateSet.cpp`; `Protocol.h` `kPermissionMaxSize` |
| The full `Payment` permission covers XRP payments. Granular Payment permissions do not cover XRP. | `Transactor::checkPermission`; `Payment.cpp` `checkGranularSemantics` |

These rules held on Devnet: every mission transaction returned `tesSUCCESS` on the first submission.

## Reuse and deviations

- **XLS-68:** the code imports `../xls68/xls68.mjs`, which provides the snapshot definitions, the preflight, the SPN/STX
  signing data and the hash.
- **The snapshot is still current.** Devnet's `server_definitions` hash matched `1EA05B0F…0FF5`, so no refresh was needed.
  `run-mission.mjs` aborts if the hash changes.
- **XLS-75:** `tx.mjs` ports `buildNyDelegateSet` from `backend/xrpl/lib/delegate-binding-resolver.mjs` at commit `97b9193`
  (branch `codex/ny-agent-orchestration-v1`), together with its Payment-only rule. The C56 proof inputs are replaced by
  the mission certificate digest.
- **Codec bug, worked around in place.** `ripple-binary-codec` 2.7.0 builds snapshot definitions without a
  `PermissionValue` type (`associateTypes` runs before `delegatablePermissions` exists). `tx.mjs` re-associates once.
  Tests pin the encoding `Payment` → `00000001`.
- **Different signing helpers.** The settlement is signed by the Delegate, not the Account. `xls68.signAsAccount`
  requires the Account's key, so `tx.cosign` signs instead, using xls68's signing-data functions.
- **Reports are held, not encrypted.** The seller returns each report after verifying the voucher. Eterna holds the reports
  and releases them in the evidence (`unlocked`) only after the ledger verification passes.
- **The budget counts issued vouchers.** A voucher the seller rejected still counts against the budget, because it is
  signed and cumulative.

## Honest limits

- **Readers.** There are two readers.
  - The primary is `https://s.devnet.rippletest.net:51234`, which is load-balanced (host ids `FUSS`/`JO`).
  - The second is `wss://devnet.honeycluster.io/`, a separate rippled: its host id is `abby` and it holds a different
    `complete_ledgers` range. Its independence is inferred from that; it is not attested.
  - `clio.devnet.rippletest.net` was unusable because its TLS certificate had expired. It was not bypassed.
- **The AP4M model is our reading of public descriptions.** It is not Mastercard's specification, SDK or network. No
  Mastercard credential or sandbox was used.
- **Devnet may be reset.** The explorer links then stop resolving, but the evidence file keeps the hashes and facts.
- **The policy gate is not on the ledger.** It is enforced by Eterna's signer, which holds the agent's voucher key. On the
  ledger, the XLS-75 Payment permission is broad: it does not limit amount or destination. The cap is enforced by
  Eterna's policy and by the seller's verification. The ledger only proves what was actually paid.
