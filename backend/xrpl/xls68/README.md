# XLS-68 Sponsored Fees and Reserves: offline Devnet builder

This module builds, checks, encodes, signs and verifies XLS-68 transactions for XRPL Devnet. It runs offline only.
`xls68.mjs` contains no network code, and a test enforces that. Nothing in this directory submits a transaction, asks a
faucet for funds or calls `simulate`. `devnet-readonly.mjs` sends only `server_definitions`, `server_info`, `feature`,
`account_info` and `ledger_entry`.

```
node --test xls68/xls68.test.mjs          # from backend/xrpl
node xls68/devnet-readonly.mjs [addr ...] # read-only: snapshot still current? account state?
```

## Sources

| Source | Version |
| --- | --- |
| Spec: XRPLF/XRPL-Standards `XLS-0068-sponsored-fees-and-reserves/README.md` (status Final) | commit `0473ab1dcac4310aa097d8cd81c6bf10c3ce6295` (2026-09-15), https://github.com/XRPLF/XRPL-Standards/blob/0473ab1dcac4310aa097d8cd81c6bf10c3ce6295/XLS-0068-sponsored-fees-and-reserves/README.md |
| Implementation: rippled PR #7350 "XLS-68: Sponsor, #5887 continuation", merged to `develop` 2026-07-10 | merge `fd2cc6dcb308fb811960380eba7bf4309934d05d`, https://github.com/XRPLF/rippled/pull/7350 |
| Code that Devnet runs: rippled tag `3.4.1` | `00e640751460c137636fdb6dae6b4280de355d81`, https://github.com/XRPLF/rippled/tree/3.4.1 |
| Live Devnet (`https://s.devnet.rippletest.net:51234`), read-only | `build_version` 3.4.1, `network_id` 2, definitions hash `1EA05B0F…0FF5`, fetched 2026-10-24T19:17:31Z |

The rippled files read were `src/libxrpl/protocol/Sign.cpp`, `src/libxrpl/protocol/STTx.cpp`,
`include/xrpl/protocol/HashPrefix.h`, `include/xrpl/protocol/TxFlags.h`, `src/libxrpl/tx/Transactor.cpp`,
`src/libxrpl/ledger/helpers/SponsorHelpers.cpp`, `src/libxrpl/ledger/helpers/AccountRootHelpers.cpp`,
`src/libxrpl/tx/transactors/sponsor/SponsorshipSet.cpp`, `SponsorshipTransfer.cpp`,
`src/libxrpl/tx/transactors/payment/Payment.cpp`, `DepositPreauth.cpp`, `src/libxrpl/protocol/Indexes.cpp` and
`src/test/app/Sponsor_test.cpp`. Field names and codes come from the snapshot in
`fixtures/devnet-server-definitions.json`. Where the spec and the code differ, the code wins.

## Rules (verified in the rippled 3.4.1 source and the Devnet snapshot)

**Co-signing.** These common transaction fields are new: `Sponsor` (AccountID, nth 27), `SponsorFlags` (UInt32,
nth 74) and `SponsorSignature` (STObject, nth 38, *not* a signing field). `SponsorSignature` holds either
`SigningPubKey`+`TxnSignature` or `Signers`.
- Both signatures cover the same bytes. That is the transaction serialised without its non-signing fields, so
  `TxnSignature`, `Signers` and the whole of `SponsorSignature` are left out. The account's `SigningPubKey`, `Fee`,
  `Sequence`, `Sponsor` and `SponsorFlags` are all included. The account's `SigningPubKey` must therefore be final
  before either party signs.
- Each signature has its own prefix. The account signs `STX\0` (0x53545800) followed by the body. The sponsor signs
  `SPN\0` (0x53504E00) followed by the body, or `SPM\0` when multi-signing. The role prefix only applies when
  `fixCleanup3_4_0` is enabled; before that, every role signed with STX. **That amendment is enabled on Devnet**, so the
  sponsor must sign with SPN (`Sign.cpp signingPrefix`).
- The sponsor key must be the sponsor's master key or regular key (`Transactor::checkSign`). This library only signs and
  verifies with master keys.

**`SponsorFlags`.** `spfSponsorFee = 1` and `spfSponsorReserve = 2` are taken from `TxFlags.h`, because
`server_definitions` does not publish them. Preflight returns these errors:
- a value of 0, or any other bit set: `temINVALID_FLAG`;
- `Sponsor` without `SponsorFlags`, or the reverse: `temINVALID_FLAG`;
- `SponsorSignature` without both of those fields: `temMALFORMED`;
- `Sponsor == Account`: `temMALFORMED`;
- `spfSponsorReserve` on a transaction type outside the allow-list: `temINVALID_FLAG`;
- `spfSponsorReserve` together with `Delegate`: `temINVALID`.

**Which types may be sponsored.** Fee sponsorship is open to every type except pseudo-transactions. Reserve
sponsorship is limited to this list from `isReserveSponsorAllowed`:
`DelegateSet, DepositPreauth, Payment, SignerListSet, CheckCancel/Cash/Create, EscrowCancel/Create/Finish,
PaymentChannelClaim/Create/Fund, Clawback, MPTokenAuthorize, MPTokenIssuanceCreate/Destroy/Set, TrustSet,
CredentialAccept/Create/Delete, AccountSet, SetRegularKey, SponsorshipTransfer`.
`SponsorshipSet` and `OfferCreate` are not on the list.

**How a sponsor authorises a transaction** (`Transactor::checkSponsor`). The `Sponsor` account must exist, or the
result is `terNO_ACCOUNT`.
- A populated `SponsorSignature` is enough on its own.
- Without one, a `Sponsorship(Sponsor, tx.Account)` object must exist, and its `lsfSponsorshipRequireSignFor*` flag for
  each requested type must be clear. Otherwise the result is `terNO_PERMISSION`.
- If a `Sponsorship` object exists, it always governs, even when the transaction is co-signed. The fee comes from
  `FeeAmount`, capped by `MaxFee`, and never falls back to the sponsor's balance.

**Fees.**
- The minimum fee is `base × (1 + |Signers| + |SponsorSignature.Signers|)`. A single-signed sponsor signature adds
  nothing.
- A co-signed sponsor pays the fee from `Balance − accountReserve(sponsor)`. It can never be charged into its own
  reserve. A shortfall gives `terINSUF_FEE_B` or `tecINSUFF_FEE`.
- A fee-sponsored transaction cannot be queued; the result would be `telCAN_NOT_QUEUE`.
- Devnet currently has `base_fee_xrp` = 0.000001 (1 drop), a 1 XRP base reserve and a 0.2 XRP owner reserve.

**Reserve accounting** (`accountReserve`):
`base × ((Sponsor ? 0 : 1) + SponsoringAccountCount) + inc × (OwnerCount − SponsoredOwnerCount + SponsoringOwnerCount)`.
- A sponsored object keeps its owner and gains a `Sponsor` field. A trust line uses `LowSponsor` or `HighSponsor`
  instead.
- The owner's `OwnerCount` and `SponsoredOwnerCount` both go up by 1, and so does the sponsor's
  `SponsoringOwnerCount`.

**Account creation with no XRP.**
- A `Payment` with `tfSponsorCreatedAccount` (0x80000) may send as little as 1 drop.
- That payment must not set `tfNoRippleDirect`, `tfPartialPayment` or `tfLimitQuality` (`temINVALID_FLAG`), and must not
  carry `SendMax` or `Paths` (`temINVALID`). The amount must be XRP (`temBAD_AMOUNT`). If the destination already exists,
  the result is `tecNO_SPONSOR_PERMISSION`.
- The new `AccountRoot.Sponsor` is always `tx.Account`, never `tx.Sponsor`, and `tx.Account` gains 1 on
  `SponsoringAccountCount`.
- An `AccountDelete` of a sponsored account must send the funds to its sponsor.

**SponsorshipSet** (type 91). The fields are `CounterpartySponsor` or `Sponsee` (exactly one), `FeeAmountDelta`
(Amount), `MaxFee` (Amount) and `RemainingOwnerCountDelta` (Int32). The ledger object is `Sponsorship` (0x0090). Its
fields are `Owner`, `Sponsee`, `FeeAmount`, `MaxFee`, `RemainingOwnerCount`, `OwnerNode` and `SponseeNode`. Its key is
`SHA512Half(0x003E ‖ sponsor ‖ sponsee)`.
- Only the sponsor may create or update the object. Either party may delete it with `tfDeleteObject`.
- `FeeAmountDelta` must be non-zero XRP and `MaxFee` must be XRP of at least 0; otherwise `temBAD_AMOUNT`. A delta of 0
  gives `temINVALID`, and a transaction that changes nothing gives `temREDUNDANT`.
- The sponsee must already exist (`tecNO_DST`).
- An object with no budget gives `tecNO_PERMISSION`.
- The sponsor pays the reserve for the object itself. `spfSponsorReserve` is not allowed on `SponsorshipSet`.

**SponsorshipTransfer** (type 90). Exactly one of `tfSponsorshipEnd`, `tfSponsorshipCreate` or `tfSponsorshipReassign`
must be set.
- End must not carry `Sponsor`. It may name `Sponsee` when the sponsor submits it.
- Create and Reassign need `Sponsor` together with `spfSponsorReserve`, and must not carry `Sponsee`.
- An account-level Create or Reassign (no `ObjectID`) must carry a `SponsorSignature` (`temMALFORMED`).

## Where the spec and the code differ

1. **Different field names.** The task brief's "FeeAmount" on SponsorshipSet is really `FeeAmountDelta`, and
   `RemainingOwnerCountDelta` is a signed Int32. `FeeAmount` and `RemainingOwnerCount` are fields of the ledger object.
2. **The spec's examples use invalid addresses** (for example `rN7n7otQDd6FczFgLdlqtyMVrn3HMfXpf` contains an `l`).
   The tests derive their own addresses.
3. Apart from that, every rule this module copies (result codes, flags, the allow-list, prefixes, the reserve formula)
   reads the same in spec commit `0473ab1` and the 3.4.1 code.

## Recommended demo (unsigned templates from `demoPlan`)

Autofill `Sequence`, `Fee` and `LastLedgerSequence` at submission time. `Sequence: 0` is only a placeholder; on a real
transaction it would mean "use a ticket". Leave out `NetworkID`, because Devnet's id is 2, which is 1024 or less.

1. **Eterna creates Rose's agent account and pays its reserve.** Eterna signs alone.
   `{"TransactionType":"Payment","Account":"<ETERNA>","Destination":"<ROSE_AGENT>","Amount":"1","Flags":524288}`
   Evidence: `AccountRoot(ROSE_AGENT).Sponsor == ETERNA`, a balance of `"1"`, and
   `ETERNA.SponsoringAccountCount == 1`.
2. **Recommended single transaction: a co-signed `DepositPreauth`.** Rose's agent pre-authorises Eterna. Eterna pays the
   fee and the reserve for the new object.
   `{"TransactionType":"DepositPreauth","Account":"<ROSE_AGENT>","Authorize":"<ETERNA>","Sponsor":"<ETERNA>","SponsorFlags":3}`
   This needs `SponsorSignature` from Eterna (SPN) and `TxnSignature` from Rose's agent (STX), which `cosign()` produces.
   Evidence:
   - the validated transaction carries `Sponsor`, `SponsorFlags` and `SponsorSignature`;
   - the `DepositPreauth` entry has `Sponsor == ETERNA`;
   - Rose's agent has `OwnerCount` 1 and `SponsoredOwnerCount` 1, and its balance is still `"1"`, so it could not have
     paid the fee itself;
   - Eterna has `SponsoringOwnerCount` 1 and its balance is lower by the fee.

   rippled's own test runs the same transaction (`Sponsor_test.cpp testDepositPreauth`, `deposit::auth(alice, sponsor)`).
3. *(Optional)* **A pre-funded budget.** Eterna sends `SponsorshipSet` with `Sponsee` = Rose's agent,
   `FeeAmountDelta` "100000", `MaxFee` "100" and `RemainingOwnerCountDelta` 1. This creates a `Sponsorship` ledger
   entry, which can be read with `ledger_entry {sponsorship:{sponsor,sponsee}}`.
4. *(Optional)* **Rose's agent draws on the budget.** It sends `AccountSet` with `Sponsor` and `SponsorFlags: 1` and no
   `SponsorSignature`. The fee comes out of `FeeAmount`.

Run step 2 before step 3. Once a `Sponsorship` exists, its budget governs co-signed transactions too.

**Accounts.** Eterna, the sponsor, must be a funded Devnet account. It needs at least 1 XRP for its own reserve, plus 1
XRP for each account it sponsors, plus 0.2 XRP for each object it sponsors or owns, plus fees. Rose's agent needs only a
keypair; step 1 creates the account. The owner decides how Eterna is funded, for example from the faucet or from an
existing Devnet wallet.

## Unknowns and risks

- No sponsored transaction has been checked on the ledger. Signature bytes follow `Sign.cpp`/`STTx.cpp` at 3.4.1 and
  have been checked locally (with ripple-keypairs and, separately, with node:crypto for ed25519). The first real
  submission is the end-to-end test. A `tem` failure costs nothing.
- The local preflight copies the rippled checks above but not the ledger-state checks (`tec`/`ter`).
- xrpl.js 4.6.0 has no sponsorship models. This module uses `ripple-binary-codec`'s `XrplDefinitions` and
  `ripple-keypairs` directly. Submitting through xrpl.js `Client` autofill or `validate` may reject these transaction
  types; submit the `tx_blob`.
- Devnet may be reset or upgraded. `devnet-readonly.mjs` checks the definitions hash against the snapshot.
