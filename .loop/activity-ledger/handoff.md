# Handoff: activity ledger page (loop A)

Branch: claude/gifted-thompson-e3onnq (feature branch; no PR opened, none requested)

Changes: public/app.js, public/app/index.html, test/activity-page.e2e.test.js, .loop/activity-ledger/*

PR (optional, when you want one):
```bash
gh pr create --base main --head claude/gifted-thompson-e3onnq --title "Activity ledger page (loop A)" --body "Adds a My activity page over GET /api/activity: four groups, empty states, row links to request detail, no email shown. Verified with mocked-Clerk browser tests (4) and the full suite (136 passing). See .loop/activity-ledger/."
```

Exit criteria:
1. Four groups and empty states: MET (browser test)
2. Row links to request detail: MET (browser test)
3. No email shown: MET (browser test, activity page only)
4. Stranger sees no rows: MET by the existing API test `stranger sees no rows`

Not verified: signed-in session with real Clerk and real database (needs keys; see docs/pilot-ledger.md).
