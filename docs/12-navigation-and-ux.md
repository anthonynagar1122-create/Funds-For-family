# Funds For Family — Navigation & Product Experience

## Product promise

Make trusted-circle borrowing and lending understandable at a glance. The interface should explain what needs attention, what money is recorded, who must act next, and what is already settled.

## Recommended primary navigation

### Member workspace

1. **Home** — one-screen summary and next best action.
2. **Discover** — requests from the member's permitted network; filters for open, nearing deadline and recently funded.
3. **My requests** — borrowing requests grouped by Draft/Waiting for contact/Verification/Open/Funded/Overdue/Repaid.
4. **My lending** — requests the member has funded, amount sent, amount confirmed, amount repaid and amount still owed.
5. **Activity** — a chronological personal ledger: contributions sent, receipts confirmed, repayments made/received, verification actions and invite events.
6. **My circle** — following/followers, mutual connections, invitations and trusted-contact eligibility.
7. **Help** — support messages and resolution status.
8. **Profile & settings** — verified identity, UPI details, email preferences, privacy, terms and sign-out.

### Admin / verifier workspace

Keep this separate from member navigation and show it only when the server confirms the role.

- **Verification queue** — pending requests, evidence/context, independent decisions and reason capture.
- **Member administration** — invite controls, verifier assignments, account support and role changes.
- **Support inbox** — unresolved first, with owner and resolution audit.
- **Audit & operations** — security events, failed jobs, delivery status and operational exceptions.

## Home screen hierarchy

1. Greeting + account status.
2. **Action required** panel: accept trusted-contact request, verify a purpose, confirm money received, confirm repayment received, or complete profile.
3. Financial snapshot: borrowed, lent, repayments pending confirmation, confirmed received and outstanding by lender.
4. Your active requests with lifecycle and next action.
5. Recent activity (last five items).
6. Circle activity / invite someone.

Do not present a single “balance” as if Funds For Family holds money. This app records transfers between members; it is not a wallet or bank account.

## Request detail page

Use one consistent timeline:
- Request created
- Trusted contact accepted
- Verification decisions
- Open for funding
- Contribution sent / confirmed / not received
- Funded
- Repayment sent / confirmed per lender
- Repaid

Keep each lender's position separate. Show requested amount, sent-but-unconfirmed amount, confirmed raised amount, remaining amount and repayment due date with plain-language explanations.

## UX rules

- One primary action per screen; destructive or irreversible actions are secondary and confirmed.
- Distinguish **sent** from **confirmed** everywhere.
- Distinguish **request status** from **payment-entry status**.
- Never imply a transfer was made by the app or that the app guarantees repayment.
- Use INR and integer paise internally; display rounded/precise values consistently.
- Use plain-language empty states with one helpful next step.
- On mobile, use a compact bottom navigation for Home, Discover, Requests, Activity and Circle; place Help and Profile under the account menu.
- Keep labels short, avoid repeated banners, and reserve warning colours for real exceptions.
- Provide accessible labels, keyboard navigation, visible focus, reduced-motion support and 44px minimum touch targets.

## Suggested phased implementation

- Phase A: navigation labels, role-aware nav, clear empty states and action-required summary.
- Phase B: per-lender financial summary, transaction timeline and statement exports.
- Phase C: admin/verifier workspace and support inbox usability.
- Phase D: accessibility, mobile and visual regression testing.
