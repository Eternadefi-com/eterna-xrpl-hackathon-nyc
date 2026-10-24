# One Eterna.AI design system: four payment capabilities, one governance engine

| Product | Route | Network | Evidence today |
|---|---|---|---|
| **Rose’s mission** (one approval, all four methods) | `#/mission` and `#/mission/<rail>` | n/a | each rail’s own |
| XRP Micropayments (payment channel) | `#/store` and the existing console, journey, receipt and reports | XRPL Mainnet | REHEARSAL (real 10-22 Mainnet purchases; Rose’s live run is pending) |
| Stablecoin Payments (RLUSD) | `#/rlusd` | XRPL Testnet | PENDING (built offline; a Testnet run needs approval) |
| Sponsored Execution (XLS-68) | `#/sponsored` | XRPL Devnet | VERIFIED |
| Voucher Commerce (Mastercard AP4M, simulated) | `#/vouchers` | local simulator + XRPL Devnet | SIMULATED vouchers, VERIFIED settlement, PENDING Mastercard network |
| *Supporting:* Delegated Authority (XLS-75) | `#/xls75` | XRPL Devnet | VERIFIED. This is not a payment rail |

The product copy (what each rail can and can’t do, its limits and proof conditions) lives in `public/products/rails.json`. Behaviour lives in the adapters in `backend/xrpl/commerce/`.

## Shared components (change one, every product follows)
| Need | Component | Where |
|---|---|---|
| Design tokens | colours, type scale, status and network colours, layout, motion | `styles/tokens.css` |
| App shell and navigation | `.top`, `.products` (product switcher), `.nav` (XRP screens) | `index.html`, `components.css` |
| Product selection cards | `.rail` | `components/mission.js` |
| Intention certificate review | `renderCertificateReview`, `.cert__consent` | `components/mission.js` |
| Payment request panel | `renderPaymentRequest` (HTTP 402) | `components/mission.js` |
| Authorization status | `components/owner-authority.js`, `.status` pills | |
| Transaction timeline | `.steps`/`.step` (journey, products, mission) | `components/status-timeline.js`, `mission.js` |
| Evidence and receipt viewer | `.evidence` list; `components/receipt.js` | `product-page.js` |
| Refusal and recovery | `components/refusal.js` (with “What Rose can do”), `.recovery` | |
| What it can and can’t do | `.cando` | `mission.js`, `product-page.js` |

## Mastercard UX guidelines applied
These come from the Open Finance UX guide. It is a design reference, not the voucher specification.
- **Plain, action-oriented language:** “Choose an eligible payment method”, “What Rose can do”, “What happens next”. Technical terms appear only as small tags.
- **Consent-driven:** the certificate states exactly what Rose agrees to, before anything is signed (`.cert__consent`).
- **Accessible calls to action:** buttons are at least 44 px tall, with centred text and the same shape everywhere (`.btn`).
- **Consistent brand and transitions:** one token set and one motion standard (`--motion-*`).
- **Visible status:** every rail and every evidence part shows its own pill. Refusals and pending states give a next step.
- **No Mastercard marks or “Secured by Mastercard”:** we have no licence for them. The label is “Mastercard AP4M · simulated”, in text only.

## Change it once
- **`styles/tokens.css` is the single source:**
  - brand colours, plus the second theme;
  - fonts and the **type scale** (`--text-*`);
  - **status colours** (`--status-verified / -simulated / -pending / -rehearsal / -refused`) and network colours;
  - radius, spacing, **layout** (`--page-max`, `--gutter`);
  - **motion** (`--motion-enter`, `--motion-step`, `--ease-out`).

  The app, all four products, the presenter view and the captured video read these values. The video timing comes from `--motion-*`.
- **`styles/components.css` holds the shared components.** These were already used by Agent Governance and are now used by all four products:
  - `.card`, `.btn`, `.facts`, `.steps`/`.step`, `.eyebrow`, `.note`, `.mono`, `.ledger` table, `.kpi`, top bar and `.nav`.
  - **New:**
    - `.status[data-status]`: the one status pill (VERIFIED, SIMULATED, PENDING, REHEARSAL, REFUSED, PARTIAL). It replaces the presentation's own copies.
    - `.net[data-net]`: the network label.
    - `.evidence`: one row per evidence source, each with its own status.
    - `.products`: the product switcher.
    - `.product-page`: the shared product layout.

## What stays independent
Each product's data, rules and evidence: `lib/products.js` (registry), `lib/evidence.js`, `lib/product.js`, `lib/journey.js`, the server and the fixtures. The Mainnet storefront and its observer are unchanged.

## Owners
- **Design:** `tokens.css`, `components.css`, `show.css`, `components/*` (including `product-page.js` and `show-scene.js`).
- **Engineering:** `lib/*`, `server.mjs`, `fixtures/*`, `scripts/*`.
