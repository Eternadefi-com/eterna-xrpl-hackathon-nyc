# Eterna Agent Purchase Experience: instructions for any Claude Code session working here

You're working on the **complete visual experience** of **Eterna Agent Finance Operations**: governed agent-to-agent commerce, with the clarity of a modern finance-ops product, inspired by Ramp's UX but entirely original. It's for the AI & Fintech XRP Ledger Hackathon in New York (submission due Sun 25 Oct 2026, 13:00 ET). The screens are:
- **Storefront** (`#/store`)
- **Payment console** (`#/console`)
- **Journey** (`#/purchase`)
- **Receipt** (`#/receipt`)
- **Reports** (`#/reports`)
- **Present** (`#/present`)

The design session owns how all of it looks, reads and flows. **Start with `docs/ROSE_PERSONA.md` (the demo persona) and `docs/SPRINT_1.md`**, and read `docs/RAMP_REFERENCE_AND_PRODUCT_MAP.md` for what's functional and what's design-only. Two Claude Code sessions share this repository:

| Session | Who | Branch | Role |
|---|---|---|---|
| **Design** | the designer's own Claude Code | `hackathon/designer-agent-purchase` (and `design/*` branches) | Look, feel, layout, wording, accessibility |
| **Engineering** | Brent's Claude Code | `main` | Data, safety logic, the server, integration into the Eterna backend |

Read these before changing anything:
- `DESIGNER_HANDOFF.md`: setup, the files you own, how to see every state.
- `docs/DESIGN_SPEC.md`: what the experience must communicate.
- `docs/MASTER_STORYBOARD.md`: the ONE master presentation and video system (seven chapters, scenario files, motion rules, capture).
- The newest files in `progress/`: what the other session did last.

## Rules: never break these
1. **Work only on your own branch.** Design never commits to `main`. Engineering never commits to the designer's branch. Changes reach `main` only through a **Pull Request**.
2. **Design edits only:** `public/styles/*`, `public/index.html`, `public/show.html`, `public/components/*`, `public/assets/*`, and layout in `public/app.js`.
   - In `public/scenarios/*.json`, design may edit the copy and look fields: `messages`, `narration`, `imagery`, `durations`, `scenario.problem`. Narration changes need Brent's review.
   - **Don't edit** `public/lib/*`, `server.mjs`, `scripts/*`, `fixtures/*`, `test/*`, or a scenario's `evidence`, `network` or `authority` fields.
   - If a design needs one of those changed, write it in your progress entry and ask engineering.
3. **Honesty is part of the product:**
   - Never make a settled-but-unverified payment look delivered (the 🔒 state).
   - Keep the provenance label (RECORDED / FIXTURE / LIVE) visible.
   - Label Mainnet and Devnet clearly.
   - Never invent a status, amount, hash or name. Show only what the data contains.
4. **No secrets exist here, so don't add any.** This repo has no keys, wallets, tokens or payment code, and none may be added. Don't paste credentials into files, commits or chat.
5. **Before every commit, run `npm test`.** It must pass: 13 pass and 1 skip is normal in this repo.
6. **Log your work.** Add **one new file** in `progress/` per work session (see `progress/README.md`). Never edit another session's progress file. That's how the two sessions avoid overwriting each other.

## Run it
```bash
node server.mjs          # http://localhost:3460  (no install step; Node 20+)
npm test                 # safety tests
```
Refresh the browser after each edit; there's no build step.

## Submit
```bash
git checkout -b design/<short-name>      # or keep working on hackathon/designer-agent-purchase
git add -A
git commit -m "design: <what changed>"
git push -u origin HEAD
gh pr create --base main --fill          # or open the PR on github.com
```
Put **before/after screenshots** in the PR description. Engineering reviews it (tests, honesty rules, accessibility) and Brent approves the merge. After merge, engineering brings `main` into the Eterna hackathon build with `git subtree`.

## Context (for good design decisions)
- **Eterna governs AI-agent purchases.** The owner signs one bounded authority once: limit per purchase, total budget, number of purchases, expiry. The agent then buys automatically inside those limits; anything outside them is refused with a receipt.
- **Payments settle on the XRP Ledger.** Eterna verifies each one **independently, on two ledger readers**, before the purchase unlocks. "Paid ≠ passed. Settled ≠ unlocked."
- **Visual reference:** Eterna's film *The Speed of Trust*: black, gold and restrained violet, an elegant serif with clean sans-serif. The storefront palette (purple/pink/black) is the default theme. **A working, honest experience beats a beautiful one.**
