# Built during the hackathon vs reused

The AI & Fintech XRP Ledger Hackathon (NYC) build window opened **Sat 24 Oct 2026, 08:30 ET (12:30Z)**. The rules say: "Only what you build during the hackathon counts toward judging." This file separates the two honestly.

## Built during the hackathon (24–25 Oct 2026); everything in this repository
| Area | Path | What |
|---|---|---|
| XLS-68 Sponsored Fees and Reserves builder | `backend/xrpl/xls68/` | Encodes and co-signs sponsored transactions against Devnet's own `server_definitions`; preflight rules ported from rippled 3.4.1 |
| Rose's governed Devnet mission | `backend/xrpl/unified/` | Sponsored agent account (XLS-68), sponsored delegation (XLS-75), HTTP 402 seller, **simulated** AP4M-style EIP-712 vouchers, delegated fee-sponsored settlement, two-reader verification, anchored audit receipt |
| AI agent mission | `backend/xrpl/unified/agent-*.mjs` | Local LLM (Ollama qwen3:30b-a3b) decides via tools in a key-less sandbox; Eterna permits or refuses; transcript hash anchored on Devnet |
| Governance engine and payment adapters | `backend/xrpl/commerce/` | One certificate check, budgets, 15 refusal codes and audit receipts for four rails (XRP payment channel, RLUSD, XLS-68 sponsored, AP4M simulator) |
| Agent purchase experience | `backend/xrpl/apps/agent-purchase/` | Storefront unlock after verified settlement, receipts, the master presentation and video system, one design system, Rose's mission UI, proof buttons (Bithomp and XRPL explorer) |

## Also built during the hackathon (24–25 Oct 2026); the Quicknode, live-run and AP4M rows are in this repository
| Area | Where | What | Status |
|---|---|---|---|
| Public website (later version of the agent purchase experience above) | Live at https://eterna-hackathon.pages.dev; source in Eterna's private UI repository | Public home with the real recorded Allowed vs Refused evidence; Rose's six-stage journey (authority → replay of a recorded Mainnet purchase → report unlock → recorded refusal → proof); Get started (connect your agent over MCP or HTTP, a browser-only limits **preview** that signs nothing, request access); one consistent design, desktop and mobile | LIVE (static, recorded data) |
| Mastercard AP4M integration on the real kit (**XRPL EVM Testnet**, test RLUSD) | `backend/xrpl/ap4m/`, plus AP4M additions in `backend/xrpl/commerce/governance.mjs` and `contract.mjs`; permit signing in `backend/xrpl/owner-signer/owner-signer.mjs` (logic only; no keys or configuration) | Adapter, governed voucher signer, kit merchant and agent, two-reader event verification; 12 tests. **Live run:** VoucherRedeemed `0x6d22cf79…`, ClaimPaid `0x8d6f0f24…`, SettlementRecorded `0xac4ba92a…`; merchant +0.25 test RLUSD. The AP4M kit itself is not redistributed (fetched and hash-checked by `vendor/fetch-kit.sh`) | **VERIFIED** (Testnet, during the event) |
| Quicknode as a third independent Mainnet reader | `backend/xrpl/commerce/readers.mjs`, `backend/xrpl/mainnet/quicknode-verify.mjs` | Quicknode added (never substituted) alongside s1.ripple.com and xrplcluster.com; re-verified all 45 recorded Mainnet txs (8 authorities, 18 settlements, 18 receipt anchors, 1 refusal anchor): all validated, tesSUCCESS, identical fields and ledger hashes on all three readers. Evidence: `backend/xrpl/mainnet/evidence/quicknode-mainnet-verification.json` (token-free) | **VERIFIED** (read-only, 2026-10-25) |
| **Live OpenClaw → Eterna → XRPL Mainnet run (25 Oct)** | `README.md` (top section), `backend/xrpl/mainnet/evidence/live-2026-10-25/` | OpenClaw refused with no authority (`1F2C8B8E…`) → owner signs a standing authority once (`F8093F73…`) → OpenClaw buys autonomously, covered with no new approval → settled (`852AB69B…`) → two-reader verification → report unlocked → receipt anchored (`20CA4D19…`); all re-verified on s1, xrplcluster and Quicknode. Executed by Eterna's pre-existing Mainnet backend (private) | **VERIFIED** (Mainnet, during the event) |
| Demo film | Submission video | Narration, music, sound effects and the Rose portrait generated with ElevenLabs for presentation; every amount, hash and date shown is a real recorded XRPL record | — |

## Reused (built before the hackathon; NOT in this repository)
- **Eterna's governed-purchase backend and purchase worker** (Oct 13–22): payment channel, standing authority, two-reader verification, delivery gating. The Mainnet purchases shown as **REHEARSAL** in the UI were made on Oct 20–22 with this code.
- The x402 checkout (Jun–Jul) and the XLS-75 delegation and RLUSD libraries (Oct 7–9). `lib/xrpl-asset-identity.mjs` and `lib/ny-asset-schemas-v2.mjs` are included here unchanged because the new adapters import them.
- Eterna's earlier XRPL Commons *Make Waves* entry (Jul 2026): https://github.com/brentheckerman433/eterna-wave-public

## Honest status labels used everywhere
- **VERIFIED:** re-read from the ledger by two independent readers.
- **REHEARSAL:** a real transaction from before this event, never presented as new.
- **SIMULATED:** local simulator; the AP4M vouchers are *not* Mastercard-issued.
- **PENDING:** not happened yet.
