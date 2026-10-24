# Built during the hackathon vs reused

The AI & Fintech XRP Ledger Hackathon (NYC) build window opened **Sat 24 Oct 2026, 08:30 ET (12:30Z)**. The rules say: "Only what you build during the hackathon counts toward judging." This file separates the two honestly.

## Built during the hackathon (24–25 Oct 2026); everything in this repository
| Area | Path | What |
|---|---|---|
| XLS-68 Sponsored Fees and Reserves builder | `backend/xrpl/xls68/` | Encodes and co-signs sponsored transactions against Devnet's own `server_definitions`; preflight rules ported from rippled 3.4.1 |
| Rose's governed Devnet mission | `backend/xrpl/unified/` | Sponsored agent account (XLS-68), sponsored delegation (XLS-75), HTTP 402 seller, **simulated** AP4M-style EIP-712 vouchers, delegated fee-sponsored settlement, two-reader verification, anchored audit receipt |
| Governance engine and payment adapters | `backend/xrpl/commerce/` | One certificate check, budgets, 15 refusal codes and audit receipts for four rails (XRP payment channel, RLUSD, XLS-68 sponsored, AP4M simulator) |
| Agent purchase experience | `backend/xrpl/apps/agent-purchase/` | Storefront unlock after verified settlement, receipts, the master presentation and video system, one design system, Rose's mission UI, proof buttons (Bithomp and XRPL explorer) |

## Reused (built before the hackathon; NOT in this repository)
- **Eterna's governed-purchase backend and purchase worker** (Oct 13–22): payment channel, standing authority, two-reader verification, delivery gating. The Mainnet purchases shown as **REHEARSAL** in the UI were made on Oct 20–22 with this code.
- The x402 checkout (Jun–Jul) and the XLS-75 delegation and RLUSD libraries (Oct 7–9). `lib/xrpl-asset-identity.mjs` and `lib/ny-asset-schemas-v2.mjs` are included here unchanged because the new adapters import them.
- Eterna's earlier XRPL Commons *Make Waves* entry (Jul 2026): https://github.com/brentheckerman433/eterna-wave-public

## Honest status labels used everywhere
- **VERIFIED:** re-read from the ledger by two independent readers.
- **REHEARSAL:** a real transaction from before this event, never presented as new.
- **SIMULATED:** local simulator; the AP4M vouchers are *not* Mastercard-issued.
- **PENDING:** not happened yet.
