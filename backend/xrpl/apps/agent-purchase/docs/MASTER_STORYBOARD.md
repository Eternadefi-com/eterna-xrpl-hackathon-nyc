# Master presentation and video system

There is one Eterna product demonstration, with one storyboard, one visual system and one motion system. Each sponsor demonstration is a **scenario file** that fills the same slots with that demo's evidence. We never rebuild the app or the video per sponsor.

Rose (a fictional CFO) is the only persona. The two scenarios:

| Scenario file | Network | Featured capability | Evidence |
|---|---|---|---|
| `public/scenarios/mainnet-purchase.json` | XRPL Mainnet | Governed agent payment (payment channel, signed once) | Rose's live purchase, verified: settled, 2 readers, product fingerprint |
| `public/scenarios/devnet-xls68.json` | XRPL Devnet | Sponsored Fees and Reserves (XLS-68) | The sponsored transaction, validated and re-read from the ledger |
| `public/scenarios/rose-unified-commerce.json` | XRPL Devnet | Built on XLS-68 + XLS-75, modelled on Mastercard AP4M (vouchers simulated) | Several parts, **each with its own status**: ledger parts VERIFIED from Devnet, vouchers SIMULATED (local simulator, not Mastercard), Mastercard network PENDING |

Judges may see only one version, so each one tells the whole story on its own.

## The storyboard (fixed order: `public/lib/master.js`)
| # | Chapter | Default | What it must do | Filled from |
|---|---|---|---|---|
| 1 | opening | 6 s | Who this is for; the one-line promise | `sponsor.name`, `messages.opening`, `capability.name` |
| 2 | problem | 10 s | Rose's business problem, in her world | `imagery.hero`, `scenario.problem`, narration |
| 3 | solution | 10 s | How Eterna governs it | `scenario.summary`, `capability.oneLiner`, `authority` terms |
| 4 | transaction | 14 s | The actual transaction, in the **real Eterna UI** | evidence: the storefront unlock (Mainnet) or the sponsorship card (Devnet) |
| 5 | proof | 10 s | Network, transaction hash, independent verification | evidence: hash, ledger, readers, fingerprint / sponsor fields, explorer URL |
| 6 | outcome | 6 s | What Rose got | `narration.outcome`, evidence time |
| 7 | closing | 6 s | Closing message, tryeterna.ai | `messages.closing` |

A scenario may lengthen a chapter (`durations`) to fit its narration. It never adds, removes or reorders chapters.

## What a scenario configures
- **Sponsor and audience:** `sponsor`.
- **Purchasing scenario:** `scenario`.
- **Rose's imagery:** `imagery.hero`, a file in `public/assets/scenarios/<id>/`. Until it exists, a labelled placeholder shows.
- **Featured capability:** `capability`.
- **Network label:** `network.label`.
- **Transaction and proof:** `evidence`, a reference only. Hashes are never typed in.
- **Narration:** `narration`, one entry per chapter. It becomes on-screen captions and the `.srt` for the voiceover.
- **Opening and closing messages:** `messages`.

## Evidence honesty (`public/lib/evidence.js`, engineering-owned)
Every frame shows the network and the evidence status:
- **VERIFIED:** the scenario's own live transaction, proven by the record.
- **REHEARSAL:** a real, verified, earlier transaction (e.g. the 2026-10-22 Mainnet purchases). It is never passed off as the live run.
- **PENDING:** no transaction yet. No hash is shown.
- **Unified mission:** shows **each part's own status** (VERIFIED / SIMULATED / PENDING). The headline says "ledger VERIFIED · vouchers SIMULATED", never a blanket VERIFIED. The final cut needs every required ledger part VERIFIED and the reports unlocked.

The capture script refuses a final cut unless the evidence is VERIFIED. The live presenter view and the video read the same records.

## Visual and motion system (designer-owned)
- **Look:** `public/styles/show.css` plus `tokens.css` (the same tokens as the app), and `public/components/show-scene.js` (one renderer per chapter).
- **One frame:** 16:9, or 9:16 with `aspect=9x16`. All sizes are container units, so the presenter view equals the 1920×1080 or 1080×1920 video.
- **Motion is a function of time.** Elements carry `--in` (0 to 1) from `reveal()`. The shared rhythm is `MOTION` in `lib/master.js`: enter 700 ms, 450 ms between items. **Don't use CSS animations or transitions in the show**, because frames are captured one at a time.
- **The real app components appear in chapter 4**, such as the product unlock. Restyle them in the app and the show follows.

## Run it
- **Presenter:** `http://localhost:3460/show.html?s=mainnet-purchase`. → / space / click advances; ← goes back. Each chapter animates in, then holds.
- **The live Mainnet run** (engineering machine, observe mode): `http://localhost:3462/show.html?s=mainnet-purchase`. Evidence refreshes every 2.5 s.
- **Rehearsal autoplay:** add `&autoplay=1`. Vertical: `&aspect=9x16`. No captions: `&captions=0`. Gold film theme: `&theme=film`.
- **Video** (needs Node ≥ 22, Chrome and ffmpeg):
  `node scripts/capture-show.mjs --scenario mainnet-purchase [--aspect 9x16] [--draft]`

  It writes `out/<scenario>-<aspect>.mp4` (30 fps, H.264), `.srt` (narration timed to chapters) and `.json` (evidence status, transaction hash, chapter times).
