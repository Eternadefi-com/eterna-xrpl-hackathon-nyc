# Eterna.AI: an AI agent can spend, but never beyond its owner's authority

Built at the **AI & Fintech XRP Ledger Hackathon** (NYC, 24–25 Oct 2026). Track: **Agentic Finance**.

Rose (a fictional CFO) approves **one** bounded mission: what to buy, from whom, per-payment and total limits, and an expiry. Her AI agent then pays on its own. Eterna checks every request against her certificate **before anything is signed**, refuses anything outside it with a receipt, and unlocks the purchase **only after independent readers confirm settlement on the XRP Ledger**.

> What was built during the event and what was reused: **[BUILT_DURING_HACKATHON.md](BUILT_DURING_HACKATHON.md)**

## Live on XRPL Mainnet during the event (25 Oct 2026): a third-party agent, governed end to end

The OpenClaw agent runtime asked Eterna to buy a 0.1 XRP validated-ledger report. It presented its own enrolled credential ("Coach (OpenClaw)"), and Eterna governed every step on **XRPL Mainnet**:

| Time (UTC) | What happened | Mainnet transaction |
|---|---|---|
| 15:12:35 | OpenClaw asks to buy. **Refused** before any payment: no active authority (expired). Refusal receipt anchored | [`1F2C8B8E…381F0CE`](https://livenet.xrpl.org/transactions/1F2C8B8E033544541D7DF24C6D922B5E5ABA4E53602A190CF60E17253381F0CE) |
| 15:25:04 | The owner signs **once** in Xaman: a standing authority of 1 XRP total, 0.1 XRP per purchase, OpenClaw only, no ask per purchase (payment channel) | [`F8093F73…73919DF2`](https://livenet.xrpl.org/transactions/F8093F73D0F86C5406C89EC4FC6E086ED0EEDB3093FE85ECE1EBF0EA73919DF2) |
| 16:04:24 | OpenClaw asks again. **Covered** by the signed authority (purchase 1 of 10), with no new human approval | — |
| 16:04:33 | **Settled**: the 0.1 XRP channel claim is redeemed. Two independent readers verify it, and only then does the report unlock | [`852AB69B…4445D8B0`](https://livenet.xrpl.org/transactions/852AB69BB32EF5FD74736A181AAB9D3C79966BEE683B2A14856283984445D8B0) |
| 16:04:44 | **Receipt anchored** (the memo is the receipt's SHA-256 digest) | [`20CA4D19…5066DB4`](https://livenet.xrpl.org/transactions/20CA4D19F763A67B4F1AC68D207EFB69043BDA54375E132E8E094AFDE5066DB4) |

Every transaction above was re-verified, read-only, on **three independent readers**: s1.ripple.com, xrplcluster.com and **Quicknode**. Evidence: [`backend/xrpl/mainnet/evidence/live-2026-10-25/`](backend/xrpl/mainnet/evidence/live-2026-10-25/). Re-run the check yourself:

```bash
cd backend/xrpl && npm install && node mainnet/quicknode-verify.mjs   # uses s1 + xrplcluster; add QUICKNODE_XRPL_MAINNET_URL for the third reader
```

## Mastercard AP4M: a governed agent purchase on XRPL EVM **Testnet** (25 Oct 2026)

This is a separate network from the Mainnet run above: XRPL EVM Testnet, chain 1449000, using **test RLUSD**. Code: [`backend/xrpl/ap4m/`](backend/xrpl/ap4m/). It runs on the unmodified AP4M hackathon kit; the kit itself is not redistributed, and `vendor/fetch-kit.sh` downloads it and checks it against hashes.

1. The agent receives the merchant's HTTP 402 challenge from the kit's own `createX402Merchant`.
2. Eterna issues a permit within the funded spend limit (per transaction 0.5 RLUSD; channel cap 1 RLUSD).
3. The agent signs the EIP-712 Voucher and the x402 resource binding **only** under that permit. The signer refuses anything else and cannot send transactions.
4. The merchant redeems on chain, AP4M pays the merchant and records the settlement, and the product is delivered.

| Event | XRPL EVM Testnet transaction |
|---|---|
| Merchant registered | `0x44161e3f30d27f71ccc8d2d0acf6633bf7eee3472841390cec1404f11822d151` |
| **VoucherRedeemed** | `0x6d22cf7926e3cf0aa6e5b687de5ec0f83c926e92c193a0fa4bbc710f08958838` |
| **ClaimPaid** | `0x8d6f0f247d07e04dd8cec2bad44947b1b0bd0752ed1a630cfe7364706c6ba191` |
| **SettlementRecorded** | `0xac4ba92a45dab805979109a03c7e8dc892b3eba3ca117cc9b718b6da9da47800` |

- The merchant payout's balance went from 0 to **0.25 test RLUSD**.
- Each transaction was confirmed on two readers (the public RPC and Blockscout) with matching block hashes.
- Evidence: [`backend/xrpl/ap4m/evidence/live-testnet-2026-10-25.json`](backend/xrpl/ap4m/evidence/live-testnet-2026-10-25.json).
- During the run, Eterna's signer correctly **refused** a resource binding whose digest did not match its permit. The digest was then fixed to match the kit byte for byte (`ap4m/voucher.mjs`).
- **Not shown live on this rail:** an over-limit refusal. The kit merchant cannot quote above the channel cap. It is covered by `ap4m/ap4m.test.mjs` and, on Mainnet, by the live refusal above.

**How an agent asks.** This is the call OpenClaw makes; the credential is the agent's own and never appears in a conversation:

```bash
curl -s -X POST https://mainnet.governance-coach.com/api/purchase/v1/requests \
  -H "Content-Type: application/json" -H "X-Eterna-C56-Requester-Credential: <agent credential>" \
  -d '{"agentAddress":"<owner Eterna agent address>","agentLabel":"Coach (OpenClaw)","request":"Buy a validated XRPL ledger report from Ledger Data Agent for 0.1 XRP","structuredPurchaseDetails":{"seller":"Ledger Data Agent","amount":"0.1","network":"mainnet"},"clientRequestId":"openclaw-mainnet-<UTC timestamp>"}'
```

**What is in this repository, and what is not.**
- In this repository: the governance engine and rulebook, the verification readers including Quicknode, the website, and the Devnet agent work.
- Not in this repository: the Mainnet purchase service and worker that executed the run above. They are Eterna's pre-existing production backend (built 13–22 Oct, private).

See [`BUILT_DURING_HACKATHON.md`](BUILT_DURING_HACKATHON.md) for the full split.


## The AI agent at work (XRPL Devnet, built during the event)
A local LLM (**qwen3:30b-a3b** on Ollama, tool calling, temperature 0) is Rose's agent. It runs in its own sandboxed process with **no access to keys**: Node's permission model lets it read only its own file. It can only call `http_get`, `request_payment` and `finish`. Asked to "get the latest validated ledger report, and also the Premium ledger bundle if possible", it:
1. Reads the seller's **HTTP 402** for the report (0.1 XRP) and asks Eterna to pay. Eterna **permits** it, a voucher is signed, and the report is delivered.
2. Reads the 402 for the premium bundle (0.25 XRP) and asks again. Eterna **refuses** it with `PER_TX_EXCEEDED` (limit 0.1 XRP) **before anything is signed**.
3. Reports back: *"Bought: Validated ledger report (100,000 drops). Refused: Premium ledger bundle (250,000 drops) due to PER_TX_EXCEEDED."*

| Step | Transaction | What it proves |
|---|---|---|
| Settlement: one delegated payment of 0.1 XRP, Rose → seller, signed by the agent (`Delegate`), fee paid by Eterna (`Sponsor`, fee only) | [5B04D8EB…](https://devnet.xrpl.org/transactions/5B04D8EB99AE1A15FD0350DF90AAB4894C753C094518167D75796D48D88E3371) | Only the permitted purchase was paid; memos carry the voucher batch and certificate digests |
| Audit receipt anchored; includes the **sha256 of the agent's full transcript** | [058F94DC…](https://devnet.xrpl.org/transactions/058F94DCCF6398D9057AB95AF265B4E1F59DAE551D6AA9D139B26C85EEF864FD) | The decision log is tamper-evident |

Transcript: [`backend/xrpl/unified/evidence/agent-transcript-2026-10-24.json`](backend/xrpl/unified/evidence/agent-transcript-2026-10-24.json) (sha256 `5df0d4e2…260a`). Evidence: [`evidence-rose-agent-mission.json`](backend/xrpl/unified/evidence/evidence-rose-agent-mission.json).

## Verify it yourself (XRPL Devnet, built during the event)
| Step | Transaction | What it proves |
|---|---|---|
| XLS-68: Eterna creates the agent's account (1 drop) and sponsors its reserve | [67CC1CFE…](https://devnet.xrpl.org/transactions/67CC1CFE9DBF75327653A25F89254ECFE035E28A45A304923F3F39A69537C622) | Agent account has `Sponsor` = Eterna |
| XLS-75: Rose delegates **only** the `Payment` permission; Eterna sponsors its fee and reserve | [069C9A78…](https://devnet.xrpl.org/transactions/069C9A78292CCD7A4E98BF03151F3A1DAC53D51307B3ECAEF89FEA379E6B00A9) | Delegate entry carries `Sponsor`; Rose's sponsored owner count |
| Settlement: one delegated payment of 0.3 XRP to the seller, signed by the agent, fee paid by Eterna (fee-only sponsorship; reserve sponsorship with `Delegate` is forbidden by the ledger and never attempted) | [D29DBDF5…](https://devnet.xrpl.org/transactions/D29DBDF54AA8B903775B2BFAAC5EEEFD8877A9C627E82EDBDF53B6ABD998A0DD) | Amount = the sum of the (simulated) vouchers; memos carry the voucher batch and certificate digests |
| Audit receipt anchored | [9E2909EF…](https://devnet.xrpl.org/transactions/9E2909EFBDAFA5D6208B6ACA369435F366702379BEDFDA7B7311468CF852725B) | sha256 over all mission evidence |

The same transactions on Bithomp: `https://dev.bithomp.com/explorer/<hash>`.

**Refusals:** an over-limit purchase and a non-approved seller were refused before signing. On the ledger, Rose's account shows **no** payment outside the mission.

**Labels:**
- Rose is fictional. On Devnet her approval is signed with a demo key held by the operator.
- The AP4M vouchers come from Eterna's local simulator, modelled on Mastercard Agent Pay for Machines. They are **not** Mastercard-issued.

### Pre-hackathon Mainnet evidence (REHEARSAL, reused work)
Governed purchases on XRPL Mainnet, Oct 20–22, under one signed standing authority. Example settlement: [1D92503B…](https://livenet.xrpl.org/transactions/1D92503BFB2FF4D5E71E8D643AF90234894BC402BD1CFE22CAF0ADF8AFFF7C36). Shown as REHEARSAL, never as new.

## Run it
```bash
npm install
npm test          # governance engine, adapters, XLS-68 encoding, Devnet mission, UI honesty tests
npm run verify    # READ-ONLY: re-reads every claimed transaction from two public ledger servers per network
npm run preview   # http://127.0.0.1:3460: storefront, Rose's mission (#/mission), presentation (/show.html)
```
Node ≥ 22. There are no secrets in this repository. The mission runner needs its own funded Devnet keys (`UNIFIED_DEVNET_DIR`) to submit anything; tests use fixed fake keys.

## Architecture
```
Rose (owner) ── signs one mission certificate ──▶ Eterna governance (commerce/governance.mjs)
                                                    │ identify requester and payer · task · seller · asset · network
                                                    │ per-payment / total / count · expiry · replay
AI agent ── HTTP 402 from seller ── asks Eterna ────┤ PERMIT ─▶ payment adapter ─▶ ledger
                                                    │ REFUSE ─▶ refusal receipt (nothing signed)
Independent readers (2 per network) ── verify ──────┤ settled ≠ unlocked: unlock only on verified evidence
                                                    └ audit receipt (sha256) anchored on the ledger
Adapters: xrp-paychan (Mainnet, reused worker) · rlusd (exact direct Payment; Testnet pending) ·
          xls68-sponsored (Devnet, verified) · ap4m-voucher (SIMULATED) · delegation (XLS-75, supporting)
```
Details: [`backend/xrpl/commerce/README.md`](backend/xrpl/commerce/README.md), [`backend/xrpl/unified/README.md`](backend/xrpl/unified/README.md), [`backend/xrpl/xls68/README.md`](backend/xrpl/xls68/README.md), and the real Mastercard requirements in [`backend/xrpl/commerce/MASTERCARD_REQUIREMENTS.md`](backend/xrpl/commerce/MASTERCARD_REQUIREMENTS.md).

Built with Claude Code (AI-assisted development). MIT licensed.
