(() => {
  'use strict';
  // Static plain-English Terms and Privacy pages. No API calls, so they work signed out and offline.
  const DRAFT = `<p class="notice" id="legal-draft" role="note"><strong>Draft text.</strong> This page is a draft and has not yet been reviewed by a lawyer. It may change.</p>`;

  const TERMS = `<h1 id="legal-heading" tabindex="-1">Terms of use</h1>${DRAFT}
    <section aria-labelledby="t-what"><h2 id="t-what">What Funds For Family is</h2>
      <p>Funds For Family is a record of requests, verifications and repayments between people who know and trust each other. No money moves through the app. The app never holds, sends or guarantees money. Payments go straight between people, usually by UPI, and each side confirms them here.</p></section>
    <section aria-labelledby="t-rules"><h2 id="t-rules">The rules</h2>
      <ul>
        <li>Ask for up to ₹50,000 at a time and repay within 12 months.</li>
        <li>There is no interest. You pay back what you borrowed.</li>
        <li>A payment counts once the person receiving it confirms it.</li>
        <li>Be truthful about why you are asking. A small team checks each request before it is shown to your circle.</li>
      </ul></section>
    <section aria-labelledby="t-contact"><h2 id="t-contact">Trusted contact</h2>
      <p>A request names a trusted contact, a person who knows the borrower and agrees to be named. The trusted contact is not a guarantor and has no obligation to repay. Only the borrower owes the money.</p></section>
    <section aria-labelledby="t-account"><h2 id="t-account">Your account</h2>
      <p>Funds For Family is invite only. You can delete your account at any time from Profile → Delete account, unless money is still owed either way. See the <a href="#/privacy">privacy notice</a> for what happens to your details.</p></section>
    <section aria-labelledby="t-limits"><h2 id="t-limits">What we cannot do</h2>
      <p>We cannot collect a repayment for you or make anyone pay. The app is a shared record that helps people keep their word.</p></section>
    <p><a href="#/home" id="legal-back">Back to the app</a></p>`;

  const PRIVACY = `<h1 id="legal-heading" tabindex="-1">Privacy notice</h1>${DRAFT}
    <section aria-labelledby="p-collect"><h2 id="p-collect">What we keep</h2>
      <p>Your name, email address, optional UPI ID and photo from your sign-in, the requests you make, the payments you record, and the messages you send us for help.</p></section>
    <section aria-labelledby="p-see"><h2 id="p-see">Who can see what</h2>
      <ul>
        <li>People in your circle (you follow each other) can see your name and the approved requests you make.</li>
        <li>A lender and the borrower can see each other's UPI ID for that payment. Nobody else sees it.</li>
        <li>A trusted contact sees the request they are named on. A verifier sees the requests they check.</li>
        <li>The owner of the service can see accounts and requests to run it and to answer help messages.</li>
        <li>We do not sell your details and we do not show advertising.</li>
      </ul></section>
    <section aria-labelledby="p-long"><h2 id="p-long">How long we keep records</h2>
      <p>Requests and payment records are kept while the service runs, so both sides keep an accurate history. The saved view on your phone stays on your phone and is cleared when you sign out.</p></section>
    <section aria-labelledby="p-delete"><h2 id="p-delete">Deleting your account</h2>
      <p>Go to Profile → Delete account. We remove your name, email and UPI ID. Past payments stay in other people's records under "Former member". Deletion is blocked while money is owed either way.</p></section>
    <p>The <a href="#/terms">terms of use</a> explain the rules.</p>
    <p><a href="#/home" id="legal-back">Back to the app</a></p>`;

  function render(root, kind) {
    root.innerHTML = kind === 'privacy' ? PRIVACY : TERMS;
  }

  const api = { render, TERMS, PRIVACY };
  // Browser: window.LegalPage. Node: scripts/build-legal.js reads the same text to build the static /terms and /privacy pages.
  if (typeof window !== 'undefined') window.LegalPage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
