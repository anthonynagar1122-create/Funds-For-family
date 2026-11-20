# 13 — Landing effects: decision record, specification, critique

## Decision (ideation)
Question: which motion effects go on the landing page?

| Option | What | Result |
|---|---|---|
| A. Port all | Tilt and spotlight on every card, magnetic on all buttons | Rejected: tilting text-dense cards slows reading |
| **B. Restrained** | Zoom on all cards; spotlight and tilt on the four step cards; magnetic on the two primary CTAs | **Chosen** |
| C. Reveal only | Keep the fade-in, no pointer effects | Rejected: no distinctive moment, and the proposal asked for more |

Why B: motion marks the four steps and the two actions a visitor needs. Text cards stay still.
Evidence that would change it: usability tests showing tilt helps recall of steps (keep), or that tilt distracts (remove tilt, keep zoom).

Rejected from the proposal: floating/orbiting cards, backdrop typography, parallax (infinite or decorative loops); glassmorphism and glow (conflict with Calm Ledger); insurance-style "financial product" cards (the app does not sell products).
Deferred: dark-mode effects, scroll-linked storytelling, effects on the app pages.

## Specification
| Effect | Target | Behaviour | Limit | Duration |
|---|---|---|---|---|
| Scroll zoom | `[data-zoom]` (feature cards, step cards, example card, calc) | Starts at 96% scale and 0 opacity; settles when 12% visible | scale ≥ 0.96 | 200 ms ease-out |
| Spotlight | `.step[data-spotlight]` | Soft radial highlight follows the pointer | colour only | 150 ms |
| Tilt | `.step[data-tilt]` | Rotates toward the pointer; flat on leave | ≤ 4° | 150 ms |
| Magnetic | `[data-magnetic]` (two primary CTAs) | Leans toward the pointer | ≤ 4 px | 150 ms |

Rules: transform and opacity only; durations are tokens (0/100/150/200/300 ms); no infinite animation; no pointer effects for reduced motion or touch; content visible without JavaScript.

Tests: `test/landing.e2e.test.js` (21 tests, including the effect checks). Full suite: 50 tests, 0 failures.

## Critique (rendered at 1440 px, reduced motion)
**Overall:** calm and trustworthy. The hero and interest example carry the page; the effects add emphasis without noise.

| Finding | Severity | Recommendation |
|---|---|---|
| FAQ block is centred at 760 px, while every other section left-aligns to the 1120 px grid | 🟡 Moderate | Align the FAQ to the main container, or make the narrow width a documented exception |
| Trust strip is text-only, weaker than the cards around it | 🟢 Minor | Keep it quiet on purpose; no change now |
| Final-CTA disclaimer is small on the brand green | 🟢 Minor | Check contrast of `brand-100` on `brand-600` before any change |
| Effects cannot be seen in a static render | 🟢 Minor | Review them in a screen recording before release |

**What works:** the three-line headline; four equal step cards; the worked interest example; one primary action per section.

**Priority:** 1. Align the FAQ grid. 2. Record a short screen capture of the step-card effects and check the tilt feels calm. 3. Re-test contrast on the final CTA.

## Open
- Usability test whether tilt helps or distracts (see docs/08-user-research-plan.md).
- HawkScan post-commit scan not run: `HAWK_API_KEY` is not set.
