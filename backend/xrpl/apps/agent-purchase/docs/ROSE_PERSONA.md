# Demo persona: Rose Mitchell, CFO (fictional)

> **Rose is fictional.** Her company, role and story are illustrative. Every number shown as *fact* in the demo comes from real Eterna records (labelled **RECORDED**). Her authority terms are **PLANNED** until Brent activates a Mainnet allowance.

**Decision (2026-10-24):** Rose buys **software, cloud and data services for her company**. The transaction is simple, the merchant storefront is visible, and judges get it immediately. Managing many agents across departments is the roadmap story.

## The seven components

| # | Component | Rose |
|---|---|---|
| 1 | **Persona** | Rose Mitchell, Chief Financial Officer of a mid-market company (250 employees). |
| 2 | **Position** | She owns the company's spending policy: budgets, approved vendors, limits. She can delegate authority to agents, but she stays accountable for every dollar. |
| 3 | **Motivation** | Her teams deploy AI agents that buy software subscriptions, cloud services and data. She wants the speed without the risk. |
| 4 | **Day in the life** | 9:00 AM: an inbox of approval requests. Every agent purchase either waits for her or runs on broad permissions she can't independently check. |
| 5 | **Pain point** | When agents spend, she gets one of two bad options: approve everything by hand (the agents stop being autonomous) or trust a provider's opaque permissions (she can't prove what was allowed). Neither shows her what was **requested vs. authorized vs. settled vs. verified**. |
| 6 | **User journey** | See below: sign once, agents buy inside the limits, anything outside is refused, everything is proven. |
| 7 | **Architecture** | See "Trust boundary" and "What happens technically". |

## Rose's journey (the demo)
1. **Rose authorizes once:** an intent certificate. *Planned terms:* up to **3 XRP total**, **1 XRP per purchase**, **approved merchants only**, expiring at the end of the day. She signs once, with her own wallet.
2. **Her AI agent discovers a product** on an Eterna-powered storefront.
3. **Eterna evaluates authority:** agent identity, merchant, amount, expiry, remaining budget.
4. **The payment executes on XRPL Mainnet** through the authorised payment channel, with **no per-purchase CFO approval**.
5. **Eterna verifies settlement:** two independent ledger readers. The storefront unlocks only after that.
6. **Rose gets proof:** the transaction hash, the authorization decision, the receipt (anchored on the ledger), and the remaining budget.
7. **Contrast:** the agent tries a purchase over her 1 XRP limit. **Eterna refuses it before any payment** and issues a refusal receipt.

## The four extras

| | |
|---|---|
| **Trigger event** | Last quarter, an agent renewed an unused software tier and nobody could show who had allowed it. The audit committee asked Rose for proof of control over agent spending. *(Fictional.)* |
| **Success metric** | **Approvals eliminated, with proof kept.** Real evidence: on 2026-10-22, **1 owner signature covered 6 Mainnet purchases**, so **5 of 6 approvals (83%) were eliminated**, with every purchase verified and receipted. At Rose's planned terms, up to 3 purchases per signature. |
| **Trust boundary** | **Rose controls the money**: her wallet signs the authority and funds the channel cap, and Eterna never holds her keys. **Eterna controls the authorization decision**: it checks every request against her certificate and refuses anything outside it. **The XRP Ledger plus two independent readers verify settlement**: proof that doesn't depend on Eterna's word. |
| **Judge's aha moment** | The agent buys something **without asking Rose again**, and **cannot** buy what she prohibited. |

## What happens technically (for the architecture slide)
1. **Authority:** Rose's wallet signs a payment-channel create on XRPL. Its memo carries the intent-certificate digest; the cap equals the total budget.
2. **Request:** the agent (OpenClaw) calls Eterna's public MCP / purchase API with its own enrolled credential.
3. **Decision:** the Eterna rulebook checks identity, merchant, amount, count, expiry and remaining budget, with an atomic reservation. Outcome: `CONFIRMED_UNDER_SIGNED_NO_ASK` or `REFUSED` with a reason.
4. **Payment:** a signed claim within the channel; the seller redeems on XRPL Mainnet.
5. **Verification:** two independent ledger readers confirm the redeem is validated → `SERVICE_DELIVERED` (unlock).
6. **Proof:** a receipt whose digest is anchored on XRPL; refusals get their own anchored receipt.

## Pitch (30 seconds)
> "Meet Rose. She's a CFO who wants the efficiency of autonomous AI purchasing without giving up control of her company's money. Eterna lets her authorize once, lets her agents operate within those limits, and independently verifies every transaction. **Her agents can spend. They can't exceed her authority.**"

## What's real today vs. planned
- **Real (RECORDED):**
  - the signed-once authority and 6 autonomous Mainnet purchases (2026-10-22);
  - two-reader verification;
  - anchored receipts;
  - refusals: Devnet anchored; Mainnet refusal anchoring is in progress this weekend.
- **Planned:** Rose's 3 XRP / 1 XRP terms on Mainnet. Activation needs **Brent's explicit approval**; then the purchases run automatically.
- **Product:** the real Mainnet product is a data service (the validated ledger report). The storefront shows real published offers.
