# 09 — Figma design-to-code and generation

Status: **blocked on a Figma file**. No Figma URL or file key was provided, so no design context could be pulled and no screens were generated in Figma.

## To proceed
1. Share the target Figma file URL (or create one with the Figma tooling).
2. Confirm the design system library to use (or let us publish the tokens from `docs/06-design-system.md` as variables).
3. Then: `get_design_context` per screen → implement in `public/` → verify against screenshots → Code Connect mapping.

## Plan once unblocked
- Screens: sign-in, feed, request form, request detail (with verify/fund/repay states), people, invites.
- Generate screens from the running UI with `generate_figma_design` as a visual reference, then rebuild with design-system instances so they stay editable.
