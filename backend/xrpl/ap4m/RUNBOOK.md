# AP4M runbook: owner-approved steps, in order (XRPL EVM **Testnet** only)

Everything below changes state, signs with a real key, or installs third-party code, so **each step needs the owner's
explicit go**. Nothing here has been run.

The only things run so far:
- read-only probes;
- offline tests;
- `owner-cli.mjs preflight` and `owner-cli.mjs address`.

**Rules:**
- Commands run from `backend/xrpl/` of the `hackathon/ap4m` worktree, with Node ≥ 22.13: `N=/opt/homebrew/bin/node` (v25.9). The default `node` is v20, which lacks `node:sqlite`.
- Keys live only in `~/eterna-private/` (0600) and are never printed.
- Test assets only: XRP gas from the faucet, hackathon RLUSD. No Mainnet, no Ledger.

## Wallets (agent ≠ payout ≠ funding)

| Role | Address | Key | Needs |
| --- | --- | --- | --- |
| Agent (signs vouchers, opens channels) | `0x8559285aa94E04C3a6F689546276A47Bd8Ea7e36` | `~/eterna-private/mastercard-evm/evm.key` | XRP gas (for `requestChannel`) |
| Merchant payout and redemption submitter | **new**, created in step 1 | `~/eterna-private/ap4m-merchant-payout/payout.key` | XRP gas (it submits `redeemVoucher`) |
| Funding wallet | the owner's choice, or staff funding | owner | test RLUSD for the budget deposit |
| Eterna governance and principal (off-chain approvals only) | XRPL ed25519, created in step 1 | `~/eterna-private/ap4m-governance/` | nothing; these cannot move funds |

## Steps

| # | Step | Exact command / action | On-chain effect | Cost (test assets) | Evidence produced |
| --- | --- | --- | --- | --- | --- |
| 0 | **Install the kit** (sponsor code; installing it runs npm) | `sh ap4m/vendor/fetch-kit.sh && (cd ap4m/vendor/kit && printf '{"private":true}\n' > package.json && npm install ethers@6.17.0 ./ap4m-sdk.tgz)` | none | none | `vendor/kit/` hashes match `vendor/MANIFEST.json` (the script fails on any mismatch) |
| 1 | **Create local keys**: payout, plus Eterna governance and principal | `$N -e "const {Wallet}=require('./node_modules/ethers');const fs=require('fs'),d=require('os').homedir()+'/eterna-private/ap4m-merchant-payout';fs.mkdirSync(d,{recursive:true,mode:0o700});const w=Wallet.createRandom();fs.writeFileSync(d+'/payout.key',w.privateKey,{mode:0o600,flag:'wx'});console.log(w.address)"`, then `$N ap4m/owner-cli.mjs init-governance` | none | none | payout address, printed once. Copy it to `live-config.json`. |
| 2 | **Portal registration** (owner, in a browser at `https://hackathon.ap4m.build/participant`) | sign up the team; **My setup** → add agent `0x8559…7e36` (it signs once to prove ownership); add the merchant payout from step 1; note the **Merchant ID** | ParticipantRegistry `ParticipantRecorded` (PSP-attested agent and merchant participants, written by the service) | none for us (service gas) | portal screenshot; `ParticipantRecorded` tx hashes |
| 3 | **Faucet** (owner) | `https://faucet.testevm.ripple.com`: request gas for the **agent** and the **payout** wallets | XRP gas arrives | free test XRP | faucet tx hashes; `$N ap4m/owner-cli.mjs preflight` shows `xrpGas > 0` |
| 4 | **Fund the budget** (owner) | portal **My setup** → deposit RLUSD from the funding wallet (or ask staff) | Vault `FundingAccountOpened` / `DepositReserved`: the **funded Authorized Spend Limit** | test RLUSD (e.g. 2) and gas | deposit tx; `agentAllocations(allocationId)` cap |
| 5 | **Config + preflight** (read-only) | `cp ap4m/live-config.example.json ~/eterna-private/ap4m/live-config.json`; fill in teamName, merchantId, merchantPayout and fundingWallet; then `$N ap4m/owner-cli.mjs preflight` | none | none | code hashes OK on 2 readers; config matches; balances; payout differs from agent and funding |
| 6 | **Sign in** (personal_sign with the agent key, off-chain) | `$N ap4m/owner-cli.mjs sign-in --approve sign-in` | none | none | `~/eterna-private/ap4m/session.json` (0600) |
| 7 | **requestChannel** (agent sends 1 vault tx) | `$N ap4m/owner-cli.mjs request-channel --cap 1 --approve request-channel`; then put the printed `channel_id` into `live-config.json` | Vault `PayoutBindingRequested` (agent tx) → `PayoutBound` → Ledger `ChannelOpened` (service): cap 1 RLUSD, payout bound, PSP attestation ids | agent gas; reserves 1 RLUSD of the budget | `evidence/*-request-channel.json`; ChannelOpened tx |
| 8 | **Start the governed merchant** (it submits redemptions) | `$N ap4m/governed-merchant.mjs --approve merchant` (2 listings: `:4308` at 0.25 RLUSD, `:4309` at 5 RLUSD) | none until paid | none | the merchant log |
| 9 | **Over-cap refusal** (signs nothing, sends nothing) | `$N ap4m/owner-cli.mjs refuse-demo` | **none**: Eterna refuses `PER_TX_EXCEEDED` (5 > 0.5) before any signature | none | `evidence/*-refusal.json`: the Eterna refusal receipt (sha256), `signed:false`, empty signer log |
| 10 | **Allowed purchase**: 402 → PERMIT → voucher → **redeem** → resource → **record-redemption** → **settlement** | `$N ap4m/owner-cli.mjs buy-and-settle --approve purchase+settle --operation report-1` | (a) agent signs the EIP-712 voucher and resource binding off-chain, only through the Eterna permit; (b) the merchant submitter sends `redeemVoucher` → **VoucherRedeemed**; (c) `POST /record-redemption`; (d) the service pays: Vault **ClaimPaid** plus RLUSD `Transfer` vault → payout; (e) Ledger **SettlementRecorded** | 0.25 test RLUSD (budget → payout); payout-wallet gas | `evidence/*-purchase.json` (402 challenge, decision, permit digest, voucher digest, claim id, redemption tx, resource) and `evidence/*-settle-verify-unlock.json` (2-reader VERIFIED evidence, UNLOCKED, Eterna receipt digest, the AP4M `receipt_url`) |
| 11 | **Independent receipt check** (read-only, the kit's verifier) | `(cd ap4m/vendor/kit && $N verify-receipt.mjs <AP4M receipt_url>)` | none | none | output of the kit verifier |
| 12 | *(optional)* **close channel** (agent signs the close checkpoint; the service submits) | `$N ap4m/owner-cli.mjs close --approve close` | Ledger `ChannelClosed`; unused capacity released | none for us | `evidence/*-close.json` |

**Stop conditions (any step):**
- preflight shows a code-hash or config mismatch;
- a reader reports a chain other than 1449000;
- the merchant challenge is for another network, ledger or asset;
- `verify` is not `VERIFIED` on 2 readers with agreeing block hashes.

## Evidence manifest

Fill `EVIDENCE_MANIFEST.template.json` from the files in `~/eterna-private/ap4m/evidence/`. Only fields backed by a
tx hash, or by an evidence file, may say `"real": true`. Everything from the offline tests is `SYNTHETIC` or
`third-party public tape`, never Eterna's payment.
