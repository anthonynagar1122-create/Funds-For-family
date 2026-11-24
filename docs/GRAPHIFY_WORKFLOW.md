# Graphify Repository Workflow

This repository is part of the RouteMaster / NagarIndustries project portfolio.

## Code intelligence
Use Graphify as the primary code-graph assistant when this repository is enabled and indexed in the Graphify workspace. Before relying on graph output, check that its indexed `commitSha` matches the GitHub checkout/HEAD. If it does not match, or coverage is partial, inspect the current source files before making changes.

## Standard exploration workflow
1. Ask Graphify a focused natural-language question about the behavior or feature.
2. Use symbol and file graph results to understand definitions, callers, dependencies, and linked tests.
3. Before changing a symbol, inspect its impact fanout and relevant repository decisions.
4. Run the linked tests, then the repository's full relevant test/build checks.
5. Review the diff and record durable architectural decisions in Graphify workspace memory.
6. Commit source changes and durable project documentation to this repository; a Graphify memory note alone is not a Git commit.

## Safety and quality rules
- Treat graph output as a map of indexed code, not proof of runtime correctness.
- Verify stale, missing, or partial graph findings against current source.
- Preserve existing business rules, data contracts, security controls, and migration history.
- Never commit secrets, credentials, production personal data, or generated build artifacts.
- Do not claim a test passed unless it was actually run and its result observed.

## Project-specific focus
Funds For Family is a trusted-circle, purpose-checked community lending application. Prioritize borrower and lender authorization, purpose verification, nominee and repayment workflows, transparent due-date and late-interest rules, auditability, and protection of financial and personal data. Verify all financial calculations and access-control policies with tests.
