# Designer Sprint 1 (Sat 24 Oct → Sun 25 Oct, 10:00 ET freeze)

**Demo persona: Rose Mitchell, CFO (fictional).** Read `docs/ROSE_PERSONA.md` first. Every screen tells her story: she signs once, her agents buy software and cloud services inside her limits, anything outside is refused, and she gets proof. Design for Rose.

**Goal:** a premium, original Eterna look across the screens that carry the **real Mainnet purchase**, plus prototypes that tell the product story, all honestly labelled.

## Must ship (in this order)
1. **Visual language:** finalise `public/styles/tokens.css`. Pick the theme (storefront, film, or a blend), the type scale, and the status colours for requested / authorized / settled / verified / refused.
2. **Agent Payment Console** (`#/console`, `components/payment-console.js`): the hero screen. Ramp-level invoice clarity; the five Eterna checks; the "autonomous execution" moment. *Functional with real data.*
3. **Verifiable receipt** (`#/receipt`, `components/receipt.js`): beautiful and verifiable, with every line linked to the ledger. *Functional.*
4. **Reporting** (`#/reports`, `components/reports.js`): keep the four columns separate; make the CSV export prominent. *Functional.*
5. **Presentation / closing** (`#/present`, `components/presentation.js`): the story arc from `RAMP_REFERENCE_AND_PRODUCT_MAP.md` and the closing screen "The control layer for agentic commerce · Own Your Agent". Label live vs. prototype on every slide.

## Should ship (if time)
6. **Authority Center** (budgets, permitted agents, revoke). A new component with **SAMPLE** data, plus a request to engineering to wire it.
7. **Agent Finance Dashboard** (overview). Real numbers where available, otherwise **SAMPLE**.

## Later / roadmap (concepts only, labelled PROPOSED)
8. Procurement (vendor management)
9. Software & Agent Intelligence (utilisation, duplicates, anomalies)

## Rules
- New screens: add a component in `public/components/`, a route in `public/app.js`, and a nav link in `public/index.html`.
- Sample data lives in a new `fixtures/sample-*.json`, with `"provenance": {"kind": "FIXTURE"}`, and is shown with the amber FIXTURE label. Never mix it into real records.
- Don't touch `public/lib/journey.js`, `server.mjs`, the existing fixtures or the tests. Ask engineering in your progress file.
- `npm test` stays green. Open a pull request early (by ~16:00 Saturday) and often after that.

## Definition of done (per screen)
- Works at 375 px and on a projector.
- Contrast ≥ 4.5:1, keyboard reachable.
- Provenance label visible.
- The four events (requested / authorized / settled / verified) never merged.
- Screenshot in the pull request; progress file added.
