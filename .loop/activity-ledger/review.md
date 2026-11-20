# Review: loop A (activity page), cycle 1

Reviewer: independent subagent (fresh context; spec + diff only). Verdict: APPROVE.

| Finding | Severity | Status |
|---|---|---|
| Null purpose would blank every group | NIT | Fixed: guarded with `r.purpose || ''` |
| API failure leaves the page silently blank | NIT | Fixed: shows an error message in each group |
| Roles rows show "· $0.00" | NIT | Fixed: amount hidden when zero |
| Test file not in the reviewed diff | NIT | Fixed: included in the commit |
| Server returns "received" repayments labelled as "my amount" | NIT (pre-existing, server side) | Open: outside this loop's scope; logged for a later loop |
