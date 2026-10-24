# Design spec: Agent Purchase Experience

## The one idea
**"Sign once. Your agent shops. Eterna proves every step."** The screen has to make three things obvious in a few seconds:
1. **Who** is buying, and whether Eterna trusts it.
2. **Under what authority**: the owner's limits, and what's left.
3. **Where the purchase is**, and that nothing is delivered until Eterna has independently verified the payment.

## What the design must demonstrate (the designer owns all of it)
| # | Outcome | Screen | Starting point |
|---|---|---|---|
| 1 | A premium, frictionless agent-commerce storefront | Storefront | `components/storefront.js` (real published offers) |
| 2 | Agent identity and recognisable authorisation status | Purchase | `components/agent-identity.js` |
| 3 | Standing authority through Eterna intent certificates ("signed once") | Purchase | `components/owner-authority.js` |
| 4 | A clear journey from agent request to ledger settlement | Purchase | `components/status-timeline.js`, `purchase-request.js` |
| 5 | Independent settlement verification and unlock | Purchase / Receipt | Timeline "Verified" + "Unlocked"; the locked state |
| 6 | Trustworthy refusal and protection screens | Purchase | `components/refusal.js` (real refusals) |
| 7 | A beautiful, verifiable transaction receipt | Receipt | `components/receipt.js` (real Mainnet receipt; every line links to the ledger) |
| 8 | A cohesive presentation for judges and sponsors | Present | `components/presentation.js` (7 slides, real numbers, arrow keys) |

All four screens already work with real data. The job is to make them **beautiful, coherent and judge-ready**, not to rebuild what they do.

## Audience
- Hackathon judges (projector, 3 m away, 3-minute demo).
- Merchants and owners: non-technical, on a phone.

## The journey (backend states, in order)
| Step | Meaning | Visual must say |
|---|---|---|
| Requested | The agent asked to buy | "An agent wants something" |
| Authorized | Eterna checked the signed authority; no new owner signature | "Allowed by your rules, automatically" |
| Submitted | A payment claim was signed | "Paying…" |
| Settled | The payment exists on the XRP Ledger | "Paid on the ledger" (with link) |
| Verified | Eterna confirmed it on two independent readers | "Proven" |
| Unlocked | Delivery released | "Delivered" |

**Special states:**
- **Locked:** settled, not yet verified. It must **not** look delivered.
- **Uncertain:** reconciling from the ledger.
- **Refused:** stops at Authorized, with a reason and a receipt.

## Panels
- **A. Agent:** name, verified or unverified badge, the authority it acts under.
- **B. Purchase:** product, seller, price, network, per-purchase limit, the action. The action is enabled only when the backend reports valid authority.
- **C. Owner authority:** "Signed once"; status (Active / Expired / Ended); per purchase, total, used, remaining, expiry; a ledger link.
- **D. Timeline:** the six steps above, with evidence links on the steps that are done.
- **E. Refusal:** a plain-language category, the backend reason code, "Money moved: None", the receipt.

## Refusal language (fixed meanings; wording can be improved)
| Category | Backend codes |
|---|---|
| Spending limit exceeded | EXCEEDS_PER_PURCHASE_LIMIT, EXCEEDS_TOTAL_LIMIT, PURCHASE_COUNT_EXHAUSTED |
| Authorization expired | AUTHORIZATION_EXPIRED |
| No valid authorization | NO_EXISTING_AUTHORITY |
| Agent not authorized | CONNECTION_REVOKED |
| Unknown agent | REQUESTER_CREDENTIAL_UNKNOWN / REQUIRED (rejected at the door, no receipt) |
| Wrong network | NETWORK_NOT_SERVED_HERE |
| Execution stopped | EXECUTION_REFUSED |

## Non-negotiables
- The provenance label is always visible: **RECORDED** (real evidence) / **FIXTURE** (illustrative) / **LIVE**.
- Mainnet vs Devnet is labelled on every purchase.
- Text contrast ≥ 4.5:1; full keyboard access; respect `prefers-reduced-motion`.
- Works at 375 px wide (phone) and on a projector.
- No credential, token or key is ever displayed.

## Open design opportunities (yours)
- A memorable "signed once" moment for the owner authority.
- The verification moment: making "two independent readers agree" feel like proof.
- The refusal: firm, calm, trustworthy, not an error page.
- A judge-friendly "demo mode" layout (big type, one purchase at a time).
- Choosing between, or blending, the storefront and film themes.
