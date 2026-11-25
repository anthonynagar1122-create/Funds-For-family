# 06 — Design system

Source of truth in code: `public/styles.css` (CSS custom properties). The same names should be used as Figma variables when a design file exists.

## Tokens
| Group | Token | Value | Use |
|---|---|---|---|
| Colour | `--color-brand-600` | `#1f6f5c` | Primary buttons, progress |
| Colour | `--color-brand-700` | `#185a4a` | Links, primary hover |
| Colour | `--color-brand-100` | `#e3f2ee` | Badges |
| Colour | `--color-ink-900` / `-700` / `-500` | `#14201c` / `#3b4a45` / `#5f6f69` | Text hierarchy |
| Colour | `--color-canvas` / `--color-surface` | `#f6f7f5` / `#ffffff` | Page / cards |
| Colour | `--color-border` | `#d9dfdc` | Dividers, inputs |
| Colour | `--color-danger-700` / `--color-success-700` | `#a4262c` / `#1d6b35` | Errors / funded states |
| Colour | `--color-focus` | `#0b57d0` | Focus ring (3:1 against surfaces) |
| Space | `--space-1` … `--space-8` | 4, 8, 12, 16, 24, 32 px | Spacing scale |
| Radius | `--radius-sm` / `-md` / `-lg` | 6 / 10 / 16 px | Inputs / cards / panels |
| Type | `--font-sans` | system UI stack | No webfont download |
| Elevation | `--shadow-1` | subtle 1px | Cards |

## Components
| Component | Variants | States | Notes |
|---|---|---|---|
| Button | primary, secondary, ghost | default, hover, focus-visible, disabled | Minimum 44px target height |
| Input / textarea / select | — | default, focus-visible, invalid (`aria-invalid`) | Label always visible; errors linked with `aria-describedby` |
| Badge | brand, warn, danger, ok | — | Status text is always present (never colour alone) |
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
