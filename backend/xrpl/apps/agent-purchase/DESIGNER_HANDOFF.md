# Designer handoff: Eterna Agent Purchase Experience

Welcome. You own the **complete visual experience** of Eterna's governed agent commerce: the storefront, the purchase journey, the receipt, and the presentation for judges. See `docs/DESIGN_SPEC.md` for the eight outcomes it must demonstrate. At its heart is the moment an AI agent buys something under its owner's signed authority. Eterna checks the authority, the payment settles on the XRP Ledger, Eterna verifies it independently, and only then is the purchase delivered. **You own how this looks and feels.** The rules underneath are already built and tested; nothing you change here can alter them.

**Using Claude Code?** Open this folder in Claude Code and it reads `CLAUDE.md` automatically: the rules, your branch, what you own and how to submit. The shared brief is `docs/DESIGN_SPEC.md`, and the shared log is `progress/`. Try asking it: *"Read CLAUDE.md and the latest progress file, then redesign the refusal card to feel calm and trustworthy."*

## 1. Where to work

| | |
|---|---|
| Repository | `https://github.com/Eternadefi-com/eterna-agent-purchase-ui` (private). *Brent creates it; see the end of this file.* |
| Your branch | `hackathon/designer-agent-purchase` |
| Default branch | `main`: the engineering version. Don't push to it directly. |
| Needs | **Node.js 20 or newer** (`node -v`) and git. Nothing else; there are no packages to install. |

## 2. Start your preview (2 minutes)

```bash
git clone https://github.com/Eternadefi-com/eterna-agent-purchase-ui.git
cd eterna-agent-purchase-ui
git checkout hackathon/designer-agent-purchase
node server.mjs
```

Then open **http://localhost:3460**.

- Refresh the browser after each edit. There's no build step: files are served exactly as you write them.
- Stop the server with **Ctrl+C**.

A shared preview may also run from Brent's machine. Its URL is given separately, and it shows the engineering version.

## 3. Files you own (change freely)

| File | What it is |
|---|---|
| `public/styles/tokens.css` | **Start here.** Colours, fonts, radius, spacing. There are two themes: storefront (purple/pink) and film (black/gold, `data-theme="film"`). |
| `public/styles/components.css` | Layout and every component's styling. Mobile breakpoint at 900px. |
| `public/index.html` | Page shell, header, fonts. |
| `public/components/agent-identity.js` | **A. Agent identity**: who is asking; verified or unverified. |
| `public/components/purchase-request.js` | **B. Purchase**: product, seller, price, limits, the buy button. |
| `public/components/owner-authority.js` | **C. Owner authority**: the "signed once" limits and remaining budget. |
| `public/components/status-timeline.js` | **D. Timeline**: Requested → Authorized → Submitted → Settled → Verified → Unlocked. |
| `public/components/refusal.js` | **E. Refusal**: why Eterna said no, plus the evidence. |
| `public/components/storefront.js` | **Storefront** (`#/store`): the products agents can buy (real published offers). |
| `public/components/receipt.js` | **Receipt** (`#/receipt`): the verifiable record; every line links to the XRP Ledger. |
| `public/components/presentation.js` | **Present** (`#/present`): the judge walkthrough. Arrow keys move between slides. You own the slide order and look. |
| `public/app.js` | Page assembly and the state picker on the left. You can rearrange the layout here. |

Each component is a function that returns HTML. Change the markup, classes, wording and order however you like. **Keep the data fields each one shows**: they come from the backend.

## 4. Don't edit these; ask engineering

| File | Why |
|---|---|
| `public/lib/journey.js` | Turns the backend's report into the six steps and the refusal explanations. It's tested; a mistake here could show "unlocked" for a payment that isn't verified. |
| `server.mjs` | Preview server and the safe bridge to the backend. |
| `fixtures/*.json` | Real recorded evidence, rendered by the backend's own code. Never hand-edit it. |
| `test/*` | The safety tests (13 pass + 1 skip in your repo). Run them with `npm test`; they must stay green. |

**You can't break governance from here.** Authorization, limits, signing and payment happen in the Eterna backend, which isn't in this repository. This repository contains **no keys, no wallets and no payment code**.

## 5. See every state

Use the picker on the left:

| State | Pick | What you should see |
|---|---|---|
| **Approved, unlocked** | *Approved: Purchase 1–6* | All six steps ✓, ledger link, "Receipt anchored". Real Mainnet purchases from 2026-10-22. |
| **Refused** | *Refused: no existing authority / exceeds per-purchase limit / authorization expired / purchase count exhausted* | The red refusal card with the reason code, "Money moved: None", the receipt. Real Devnet refusals. |
| **Settled, not yet verified (locked)** | *In progress: Settled on the ledger, not yet independently verified* | Settled ✓, Verified pending, **Unlocked 🔒**. A design fixture. |
| **Pending / uncertain** | *In progress: Outcome uncertain* | The note "Eterna reconciles it from the ledger". A design fixture. |
| **Authorized, waiting** | *In progress: Authorized, waiting to execute* | Authorized ✓, next step pending. A design fixture. |
| **Live** (engineering machine only) | *Live: …* | Real offers from the Devnet test backend; "Try without authority" shows a real backend refusal. |

The **coloured label above the cards** always says what you're looking at:
- **RECORDED** (green): real evidence;
- **FIXTURE** (amber): illustrative only;
- **LIVE** (violet): live test data.

Please keep that label visible in any redesign. It's how we stay honest with judges.

**Design rules that come from the product, not the styling:**
- Never make a settled-but-unverified payment look delivered. The 🔒 state must read as "not yet".
- Label every network clearly: Mainnet means real money, Devnet doesn't.
- Never show a credential, token or key. The data doesn't contain any.
- Keep text contrast at 4.5:1 or better, and make every control reachable by keyboard.

## 6. Submit your work

1. Commit on `hackathon/designer-agent-purchase`:
   ```bash
   git add -A
   git commit -m "design: <what you changed>"
   git push
   ```
2. Open a **Pull Request** into `main` on GitHub. Add a screenshot or two, and note anything you'd like engineering to wire up.
3. **Review:** Claude, the engineering agent, checks the safety tests and the honesty rules above. **Brent approves and merges.**
4. **Into the hackathon build:** engineering pulls `main` into the Eterna hackathon branch (`hackathon/governed-a2a`) with `git subtree`. Your commits keep your name, and they're listed in the submission as designer contributions.

Push small and often. We'll merge as you go, so the demo always has your latest work.

## 7. For Brent: one-time setup (not for the designer)

- [ ] Create the private repo `Eternadefi-com/eterna-agent-purchase-ui`, empty with no README, and let Claude push to it. Either install `gh` and run `gh auth login`, or add the remote with a token.
- [ ] Invite the designer as a collaborator with **Write** access: GitHub → repo → Settings → Collaborators → add her **GitHub username**.
- [ ] Protect `main` (Settings → Branches → require a pull request) so nothing lands without review.
