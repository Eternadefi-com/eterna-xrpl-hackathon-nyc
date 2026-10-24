# Ramp reference → Eterna Agent Finance Operations

The designer studied Ramp's finance-operations demo end to end: expense management, invoice-to-payment, procurement, software usage, visibility and reporting, and the closing "one platform" message.

**Use it for UX inspiration only:** clarity, density, calm confidence, the invoice-to-payment simplicity. **Never copy its layouts, components, illustrations, wording or branding.** Eterna's identity comes from its own tokens and film.

## The translation

| Ramp (people and finance teams) | Eterna (AI agents and their owners) |
|---|---|
| Employees submit expenses | Agents automatically produce **governed purchase records** |
| Managers approve spending | Owners **sign standing authority once** (intent certificates) |
| Vendors receive payments | Agents pay vendors over authorised rails (XRP Ledger) |
| Software usage is monitored | **Agent identity, activity and authority usage** are monitored |
| Reports reconcile expenses | **Independent ledger verification** backs every record |

**The distinction Eterna must always show:** what an agent **requested** ≠ what Eterna **authorized** ≠ what **settled** ≠ what Eterna **verified**. Those are four different events, never merged into one "paid" status.

**Pitch:** *Ramp shows businesses where their money went. Eterna shows what their AI agents were allowed to do, what they actually did, and the independently verifiable proof.*

## The six modules: status today (inventory before design)

Status meanings:
- **FUNCTIONAL:** works in the preview with real Eterna data.
- **BACKEND EXISTS:** Eterna has it, but this UI doesn't show it yet; engineering wires it.
- **DESIGN ONLY:** the designer creates it with labelled sample data.
- **PROPOSED:** roadmap, not built.

| # | Module | What exists in Eterna (reuse; never rebuild) | Status in this UI | Designer sprint scope |
|---|---|---|---|---|
| 1 | **Agent Payment Console** (centrepiece; `#/console`) | Governed purchase API, rulebook decisions, paychan settlement, two-reader verification | **FUNCTIONAL**: the real Mainnet purchase with the five Eterna checks | Make it the hero: invoice-to-payment clarity, autonomous-execution moment |
| 2 | **Authority Management** | Intent certificates, standing authority (limits, count, expiry), permitted requesters, "end standing" route, requester revoke | Purchase screen "Owner authority" panel **FUNCTIONAL** (read-only). Create / revoke in the UI: **BACKEND EXISTS** (owner sign-in + Xaman; engineering only) | Authority Center design: budgets, permitted agents, the revoke affordance (the action stays wired by engineering) |
| 3 | **Verification & Reporting** (`#/reports`, `#/receipt`) | Receipts, receipt anchors, ledger hashes, two-reader evidence | **FUNCTIONAL**: the report table with requested/authorized/settled/verified, a real **CSV audit export**, and the verifiable receipt | Visual hierarchy, filters, export design |
| 4 | **Agent Finance Dashboard** | Per-purchase records and standing-budget usage (the API exists per purchase; an owner list endpoint needs sign-in) | **DESIGN ONLY**: KPIs exist inside Reports | Dashboard overview (spend, agents, limits, activity), using real numbers where they exist, otherwise labelled **SAMPLE** |
| 5 | **Agent Procurement** | Storefront offers (`GET /api/purchase/v1/offers`), seller self-listing (storefront), independent sellers | Storefront **FUNCTIONAL** with real Devnet offers | Vendor and purchase management views: **DESIGN ONLY** beyond the catalog |
| 6 | **Software & Agent Intelligence** | Requester records (verified/unverified, last seen) | **PROPOSED**: utilisation, duplicates, unused subscriptions, anomalies | Concept screens, clearly labelled **PROPOSED** |

## The demo: one real purchase at the centre
The primary hackathon demo is **one complete, real, governed agent purchase on XRPL Mainnet**, using the existing infrastructure:
1. OpenClaw requests.
2. The standing authority is checked automatically.
3. The payment settles on Mainnet.
4. Two readers verify it.
5. Delivery unlocks.
6. The receipt is shown.

The payment console, receipt and reports display that purchase. Everything else is the product story around it, and it is **labelled as prototype** on screen.

## Story structure (from the reference, in Eterna's voice)
Introduction → spending controls (authority, signed once) → purchasing (storefront + console) → payment operations (settle and verify) → procurement → reporting (requested / authorized / settled / verified) → close.

**Closing screen:**
> **ETERNA.AI** · The control layer for agentic commerce
> AI agents can request, purchase and transact. Humans define the authority. Eterna verifies the outcome.
> **Own Your Agent.**

**Honesty rule for the presentation:** every screen shows whether it's **LIVE ON MAINNET**, **RECORDED EVIDENCE** or **DESIGN PROTOTYPE**.
