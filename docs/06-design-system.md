# 06 — Design system

Source of truth in code: `public/styles.css` (CSS custom properties). The same names should be used as Figma variables when a design file exists.

## Tokens
Visual language adapted from the reference demo at routemaster-society-management.vercel.app: slate neutrals, an indigo-to-violet brand gradient, compact type, 16 px cards, uppercase status pills and a segmented navigation.

| Group | Token | Value | Use |
|---|---|---|---|
| Colour | `--color-brand-600` / `-700` | `#4f46e5` / `#4338ca` | Primary buttons, links, progress, brand tile |
| Colour | `--color-brand-50` / `-100` / `-200` / `-300` | `#eef2ff` / `#e0e7ff` / `#c7d2fe` / `#a5b4fc` | Callouts, text on gradient, card hover border |
| Colour | `--color-accent-700` | `#6d28d9` | End stop of `--gradient-brand` (135°, indigo-600 → violet-700) |
| Colour | `--color-ink-900` / `-700` / `-600` / `-500` / `-400` | slate `#0f172a` / `#334155` / `#475569` / `#64748b` / `#94a3b8` | Text hierarchy |
| Colour | `--color-canvas` / `--color-surface` / `--color-subtle` | `#f6f7fb` / `#ffffff` / `#f1f5f9` | Page / cards / segmented nav track |
| Colour | `--color-border` / `-strong` | `#e2e8f0` / `#cbd5e1` | Card borders / inputs |
| Colour | status pairs (`-100` background, `-700/-800` text) | rose, emerald, amber, sky | Badges: danger, ok, warn, neutral |
| Space | `--space-1` … `--space-8` | 4, 8, 12, 16, 20, 24, 32 px | Spacing scale |
| Radius | `--radius-sm` / `-md` / `-lg` / `-xl` | 8 / 12 / 16 / 24 px | Nav items / buttons, inputs / cards / hero panels |
| Type | `--font-sans` / `--font-mono` | `ui-sans-serif` system stack / `ui-monospace` | Body / card eyebrows ("REQUEST #12") |
| Elevation | `--shadow-1` / `--shadow-2` | slate, 1–3 px / 4–6 px | Cards at rest / on hover |

## Components
| Component | Variants | States | Notes |
|---|---|---|---|
| Button | primary, secondary, ghost | default, hover, focus-visible, disabled | Minimum 44px target height |
| Input / textarea / select | — | default, focus-visible, invalid (`aria-invalid`) | Label always visible; errors linked with `aria-describedby` |
| Badge | primary, neutral, warn, danger, ok | — | Uppercase bold pill; status text is always present (never colour alone) |
| Segmented nav | — | default, hover, current (`aria-current="page"`) | Slate track, white raised current item |
| Hero panel | — | — | `--gradient-brand`, 24 px radius, white text, translucent stat tiles |
| KPI tile / section card / callout | — | — | Uppercase label + large figure / grouped rows / indigo-tinted note |
| Card | — | default | Request summaries in the feed |
| Progress bar | — | `role="progressbar"` with values | Funding progress |
| Toast | — | visible / hidden, `aria-live="polite"` | Confirmations only |
| Form | — | valid / invalid | Field-level errors from the API `field` key |

## Accessibility baseline
- Skip link, landmark regions, `aria-live` for toasts.
- Focus moved to the main region on view change.
- `prefers-reduced-motion` disables transitions.
- Colour is never the only signal (badges carry text).

## Open items
- Dark mode tokens (not started).
- Figma library: no Figma file was provided. Once one exists, map each token and component to Figma variables and components, then add Code Connect mappings.
