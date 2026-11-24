# 12 — Card design: audit and system

Figma: https://www.figma.com/design/vtPi4HE7BoXpQHxUfDoa0g (page "Page 1", component set `Card`, token collection `Card tokens`)

## 1. Audit (measured in a headless browser, 375 and 1440 px)

| Finding | Before | Severity |
|---|---|---|
| Radius differed between card types | 10 px (feature, step) vs 16 px (example, calc) | Moderate |
| Padding differed without a reason | 24 px (step) vs 28 px (feature, example) | Moderate |
| Shadow only on one card | Example card only | Moderate |
| Body text size drifted | 13.6, 15.52 and 16 px across card types | Moderate |
| Title size drifted | 16.8, 19.2 and 13.6 px for the same role | Moderate |
| Trust titles in brand colour, other titles near-black | Inconsistent hierarchy | Moderate |
| Hero headline wrapped to five lines at 1440 px | Crowded first impression | Minor |
| Final-CTA paragraph at 14.4 px | Footnote size for a call to action | Minor |
| Contrast of text | Lowest pair 4.93:1 (muted caption on canvas), above AA 4.5:1 | Pass |
| Horizontal overflow at 375, 768, 1024, 1440 px | None | Pass |

After the fixes, all cards measure: radius 12 px, padding 28 px (24 px under 600 px), body 16 px, title 18 px, rest shadow on all, and the trust titles match the other card titles. The hero headline is three lines at 1440 px.

## 2. Card system

| Token | Value |
|---|---|
| Radius | 12 px |
| Padding | 28 px (24 px under 600 px) |
| Internal gap | 12 px |
| Grid gap | 24 px (16 px under 600 px) |
| Border | 1 px inside, `color/border` |
| Rest shadow | 0 1 2 at 6% ink |
| Elevated shadow | rest shadow plus 0 12 32 at 8% ink |
| Title | Inter Semi Bold 18 / 23.4 px, `color/ink-900` |
| Body | Inter Regular 16 / 24.8 px, `color/ink-700` |
| Kicker | 13 px, uppercase, tracking .06em, `color/ink-500` |

### Variants (Figma component set `Card`)
| Variant | Surface | Use |
|---|---|---|
| Default | `color/surface` (#ffffff) | Feature, step and trust-adjacent cards |
| Tinted | `color/canvas` (#f6f7f5) | Calculation panels |
| Elevated | `color/surface` with lifted shadow | The featured example card |

Colours are bound to the `Card tokens` variables (`color/surface`, `color/canvas`, `color/border`, `color/ink-900`, `color/ink-700`), so a palette change updates every card.

## 3. Motion and interaction
- Cards are not interactive by default and do not hover.
- A linked card (`a.card`) gets a border and shadow change over 150 ms, ease-out, with a 3 px focus ring.
- No motion on card content. (The landing page and its reveal rule were removed on 2026-11-24; see `docs/superpowers/specs/2026-11-24-task-focused-app-design.md`.)

## 4. Accessibility
- Titles are headings (h3) inside each card, in logical order.
- Body contrast is 9.3:1 on white (ink-700); captions are 5.3:1 (ink-500).
- Cards never rely on colour alone for meaning.

## 5. Open items
- Dark-mode card tokens are not defined yet.
- The Figma file has one component set. Icon and step-number variants are not in Figma yet; the step number is a code-only element.
