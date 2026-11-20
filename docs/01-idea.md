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
- A borrower requests: **total amount**, **purpose**, **repayment date**, and a **nominee** who will
  repay if the borrower does not.
- The **purpose must be verified completely through a team** before the request can be approved for
  borrowing.
- Only approved requests can receive money.
- On the **due date** the money is returned to the families who funded it. **Interest starts after the
  due date.**

## Goals
1. Make it easy for a trusted circle to lend small amounts without a bank.
2. Protect lenders with purpose verification and a named nominee.
3. Keep the rules transparent: amounts, dates and interest are computed the same way for everyone.

## Non-goals (for the first version)
- Moving real money. Payments are recorded, not processed. A payment provider is a later integration.
- Credit scoring, KYC, or legal lending licences. These must be reviewed by a qualified adviser before
  launch in any jurisdiction.
- Native mobile apps. The first version is a responsive web app.

## Open questions (assumptions made in this scaffold are marked ⚠)
- ⚠ Interest rate: not stated in the notes. The scaffold uses a configurable **12% per year, simple,
  accruing daily after the due date**.
- ⚠ Verification: the notes say "verified through a team". The scaffold uses **2 distinct team
  approvals**, and a single rejection rejects the request.
- ⚠ Feed: the notes mention both "mutual followings" and "followings and followers". The scaffold shows
  requests from **users you follow or who follow you**. Change `FEED_MODE` in `src/rules.js` if mutual
  only is wanted.
- ⚠ Contributions: anyone signed in can contribute to an approved request, not only connections.
