# 01 — Idea

## One line
Funds For Family is a community web app where people in a trusted circle request small, purpose-checked
loans from family, friends and community members, and anyone can chip in any amount toward a request.

## Source
Taken from the handwritten notes dated 2026-11-20/26 ("Funds – For – Family", sections: Design,
Architecture, Idea, Specifications, Final Look, Integration, Data).

## The idea, in the author's words (condensed)
- Anyone can invite people from their group, or find people from their contact list, and build a
  network through **mutual followings**.
- Members see the requests coming from their **followings and followers**.
- It is like building a community of families: anyone can contribute a **custom amount** to the person
  who requests funds.
- A borrower requests a **total amount**, **purpose**, **repayment date**, and names a **trusted contact** who is kept informed. The trusted contact is not a guarantor and has no automatic repayment obligation.
- The **purpose must be verified completely through a team** before the request can be approved for
  borrowing.
- Only approved requests can receive money.
- Borrowers repay the members who funded the request. The app records transfers and confirmations; it does not move money. **Interest is currently disabled pending policy review.**

## Goals
1. Make it easy for a trusted circle to lend small amounts without a bank.
2. Help lenders make informed decisions with purpose verification, clear records and trusted-contact visibility.
3. Keep the rules transparent: principal, dates, transfers and confirmations are clear to every participant. No interest is active in v1.

## Non-goals (for the first version)
- Moving real money. Payments are recorded, not processed. A payment provider is a later integration.
- Credit scoring, KYC, or legal lending licences. These must be reviewed by a qualified adviser before
  launch in any jurisdiction.
- Native mobile apps. The first version is a responsive web app.

## Open questions (assumptions made in this scaffold are marked ⚠)
- **Interest policy: under review.** The former 12% per-year simple-interest proposal is unapproved and must remain disabled. No interest or late fee may be accrued or shown as payable until the owner approves a final policy after qualified legal/compliance review.
- ⚠ Verification: the notes say "verified through a team". The scaffold uses **2 distinct team
  approvals**, and a single rejection rejects the request.
- ⚠ Feed: the notes mention both "mutual followings" and "followings and followers". The scaffold shows
  requests from **users you follow or who follow you**. Change `FEED_MODE` in `src/rules.js` if mutual
  only is wanted.
- ⚠ Contributions: anyone signed in can contribute to an approved request, not only connections.
