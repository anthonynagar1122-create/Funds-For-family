# Task-focused app: design

Date: 2026-11-24 · Status: approved in conversation (owner chose option A, then asked Claude to make the remaining calls and implement).

## Intent
When a member opens Funds For Family they should land on the jobs they came to do: request funds, verify a request, contribute, record a repayment, check where they stand. Marketing copy, explanation cards and extra text are removed.

## Goals
- `/` is the app. Signed-out visitors see one short sign-in screen.
- A signed-in member's first screen is **Home: "Needs you now"**: four action tiles (Request funds, Verify, Fund, Repay) with counts, then one list of items waiting on them, most urgent first, each with its single action button.
- Verifiers can find requests awaiting verification (new `GET /api/verification-queue`). Today nothing lists them.
- The request page shows status, numbers and only the action the viewer can take.
- A manual GitHub Actions job regenerates visual baselines on the CI runner and commits them.

## Non-goals
- No change to lending rules, interest, verification thresholds or the data model.
- No search-engine presence (the owner chose A: members arrive by invitation).

## Anti-goals
- Hiding a task behind extra clicks, or adding explanatory text back to the work screens.

## Approaches considered
- **A (chosen): site opens straight into the app.** All seven marketing sections, their CSS/JS, the motion prototype and their tests are deleted. Whole site is `noindex`; robots.txt disallows everything; sitemap removed.
- B: keep one short public page. Rejected: the owner expects invited members, not search traffic.

## Decisions (Claude's calls, stated to the owner)
- People stays in the main menu: Home · Fund · My activity · People. "Request funds" is a Home tile and stays reachable at `#new`.
- Tile counts and the Home list come from `/api/feed` (Fund), `/api/activity` (Repay: funded or overdue requests where I am borrower or nominee) and `/api/verification-queue` (Verify, verifiers only). The queue excludes requests the viewer borrowed, is nominee on, or already decided.
- `/app/` becomes a tiny redirect to `/` that keeps the hash, so existing links (`/app/#new`, invite links) still work.
- The landing-page Content-Security-Policy on `/` is removed: `/` now runs Clerk from its CDN, as `/app/` always did without a CSP. Recorded as a known gap to close with a Clerk-compatible policy.
- Visual regression now covers the signed-out screen of `/`.

## Left to the builder
Copy wording within the one-line limit, tile icons, ordering ties in the Home list.
