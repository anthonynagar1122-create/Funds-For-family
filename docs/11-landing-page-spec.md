# 11 — Landing page specification

Status: specification and implementation for the public landing page at `/`. The product app moved to `/app/`.

## 1. Product and surface assumptions
- **Product:** Funds For Family, a community lending app where members request small, purpose-checked loans and their network funds them.
- **Surface:** public landing page, first impression for prospective borrowers, lenders and verifiers.
- **Audience:** families and friends who already trust each other, plus people who will be asked for money and need to understand the rules before saying yes.
- **Trust level:** high stakes (real money). Visual language must feel calm, factual and accountable, never promotional or urgent.
- **Primary job:** understand how the trust mechanics work and start a request or sign in.
- **Not in scope:** payment processing, pricing (no paid tier yet), blog, testimonials (none exist yet; do not invent them).

## 2. Design direction
**Calm ledger.** Quiet off-white canvas, one brand green, generous whitespace, plain-language headlines, and numbers shown exactly as the product computes them. Trust is shown through clarity and specifics (the interest rule, the two-approval rule, the nominee), not through stock photography or gradients.

Rejected alternatives:
- Fintech gradient hero with floating cards: reads as a bank marketing site and overstates the product's certainty.
- Charity or crowdfunding style with emotional imagery: invites pressure to fund and conflicts with the verification-first purpose.

## 3. Information architecture and section order
| # | Section | Purpose | Primary action |
|---|---|---|---|
| 1 | Header | Brand, anchors, sign-in | Sign in |
| 2 | Hero | Say what it is and who it protects | Start a request |
| 3 | Trust strip | Three facts: verified purpose, named nominee, no hidden interest | — |
| 4 | How it works | Four steps: request, verify, fund, repay | — |
| 5 | Interest example | Worked example using the real rule | — |
| 6 | Built for trust | Feature detail: network, verification, nominee, records | — |
| 7 | FAQ | Address the questions a prospective lender will ask | — |
| 8 | Final call to action | Repeat the primary action | Start a request |
| 9 | Footer | Legal line, app link, contact placeholder | — |

## 4. Content rules
- Headlines state outcomes in plain language, under 12 words.
- Every number is produced by the product rules (`src/rules.js`). Current example: $1,000.00 principal, 10 days late at 12% a year = $3.29 interest.
- Disclaimer required near any money claim: "Funds For Family records and verifies requests. It does not move money or give financial advice."
- No invented statistics, testimonials, user counts or logos.

## 5. Visual tokens (from `docs/06-design-system.md`, extended)
| Token | Value | Use |
|---|---|---|
| `--color-brand-600` | `#1f6f5c` | Primary button, key figures |
| `--color-brand-700` | `#185a4a` | Hover, links |
| `--color-ink-900` | `#14201c` | Headings, body |
| `--color-ink-700` | `#3b4a45` | Secondary body (contrast ≥ 7:1 on canvas) |
| `--color-ink-500` | `#5f6f69` | Captions only (≥ 4.5:1 on canvas) |
| `--color-canvas` | `#f6f7f5` | Page background |
| `--color-surface` | `#ffffff` | Cards, header |
| `--color-border` | `#d9dfdc` | Dividers |
| Type scale | 16 body / 18 lead / 40–56 hero / 28 h2 / 20 h3 (fluid via clamp) | |
| Font | System UI stack | No webfont downloads |
| Radius | 6 / 10 / 16 px | |
| Spacing | 4-px scale: 4, 8, 12, 16, 24, 32, 48, 64, 96 | Section padding 64 (mobile 48) |
| Max width | 1120 px content, 65ch for prose | |

## 6. Motion
Uses only the duration tokens in `vectorlab-ux-skills:motion`: 100, 150, 200, 300 ms.

| Element | Motion | Duration | Easing |
|---|---|---|---|
| Section reveal on scroll | opacity 0→1, translateY 8px→0 | 200 ms | ease-out `cubic-bezier(0.16, 1, 0.3, 1)` |
| Hero entrance on load | same as reveal, staggered 0/100 ms | 200 ms | ease-out |
| Button hover | background colour change | 150 ms | ease-out |
| FAQ open | native `<details>`; no animation (keeps reading stable) | — | — |
| Focus ring | none (instant) | — | — |

Rules:
- Only `opacity` and `transform` animate.
- No looping animation, no bounce, no scale on hover.
- `prefers-reduced-motion: reduce` disables reveal movement and transitions. Content is visible at all times.
- Without JavaScript, all content is visible. Reveal is added by a class set from JavaScript, and content only hides after JS runs.

## 7. Responsive behaviour
Checked widths: 375, 768, 1024, 1440 CSS px.
- **375:** single column; hero headline 32 px; CTAs full width; header collapses to brand + Sign in (anchors move to a wrapped row).
- **768:** two-column trust strip; steps in a 2×2 grid.
- **1024:** hero in two columns (copy left, interest example card right); steps in a 4-column row.
- **1440:** content capped at 1120 px, no horizontal scroll.

## 8. Accessibility
- One `h1` (hero), `h2` per section, logical order.
- `<header>`, `<nav aria-label="Primary">`, `<main>`, `<section aria-labelledby>`, `<footer>`.
- Skip link to `#main`.
- All interactive targets ≥ 44 px high.
- Contrast: body ≥ 7:1, secondary ≥ 4.5:1, focus ring `--color-focus` 3px with 2px offset.
- The FAQ uses native `<details>` and `<summary>`, which are keyboard operable.
- Decorative SVG icons are `aria-hidden="true"`. The page uses no emoji as interface icons.
- Language set to `en`; no text is in images.

## 9. Anti-patterns to avoid
- Gradient or glass hero, floating mock-up cards, stock photography of families or money.
- Urgency copy ("fund now", countdowns) or pressure to lend.
- Fake testimonials, user counts, or security badges.
- Animated counters or looping background motion.
- Hidden or small disclaimers.

## 10. Acceptance checklist
- [ ] Landing page at `/`; app at `/app/`; sign-in CTAs point to `/app/`.
- [ ] One `h1`; sections in the order of section 3.
- [ ] Interest example matches `src/rules.js` ($1,000, 10 days late → $3.29).
- [ ] Disclaimer present in the hero or trust area and footer.
- [ ] No horizontal scroll at 375, 768, 1024 and 1440 px (verified with a headless browser).
- [ ] All content visible with JavaScript disabled.
- [ ] `prefers-reduced-motion` honoured; no animation loops.
- [ ] Keyboard: skip link, header links, all buttons and FAQ reachable; focus visible.
- [ ] Contrast of body and secondary text meets the targets above.
