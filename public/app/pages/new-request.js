(() => {
  'use strict';
  const esc = window.Format.esc;
  const ACTIVE = ['awaiting_contact', 'contact_declined', 'pending_verification', 'open', 'funded'];
  const CATEGORIES = [['education', 'Education'], ['medical', 'Medical'], ['home', 'Home'], ['family_event', 'Family event'],
    ['work', 'Work or business'], ['emergency', 'Emergency'], ['other', 'Other']];
  const MIN_PAISE = 10000; // Rs 100
  const MAX_PAISE = 5000000; // Rs 50,000 (the server stays authoritative)
  const PURPOSE_MIN = 20;
  const PURPOSE_MAX = 2000;
  const LIMIT_TEXT = '₹100 to ₹50,000';

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function dateRange() {
    const min = new Date(); min.setDate(min.getDate() + 1);
    const max = new Date(); max.setMonth(max.getMonth() + 12);
    return { min: iso(min), max: iso(max) };
  }

  // Returns { paise } or { error }. The typed text itself is what goes to the API.
  function checkAmount(text) {
    const parsed = window.Money.parseRupees(text);
    if (parsed.error) return { error: text.trim() === '' ? `Enter an amount, ${LIMIT_TEXT}` : `${parsed.error}. Amounts are ${LIMIT_TEXT}` };
    if (parsed.paise < MIN_PAISE || parsed.paise > MAX_PAISE) return { error: `Amounts are ${LIMIT_TEXT}` };
    return parsed;
  }

  function activeRequestHtml(r) {
    return `<h1 id="new-title" tabindex="-1">Request funds</h1>
      <div class="panel" id="active-request">
        <h2>You already have an active request</h2>
        <p>You can have one request at a time. Finish or withdraw it before starting another.</p>
        <p class="row-actions"><a class="btn btn-primary" href="#/request/${esc(r.id)}">Open my request</a></p>
      </div>`;
  }

  function contactHtml(users) {
    if (!users.length) {
      return `<div class="field" id="contact-empty"><p><strong>Connect with someone first.</strong></p>
        <p class="hint">Your trusted contact must be someone you follow who follows you back.</p>
        <p><a class="btn btn-ghost" href="#/circle">Go to Circle</a></p></div>`;
    }
    return `<div class="field">
      <label for="f-contact">Trusted contact</label>
      <select id="f-contact" name="trustedContactId" required aria-describedby="h-contact e-trustedContactId">
        <option value="">Choose a trusted contact</option>
        ${users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}
      </select>
      <p class="hint" id="h-contact">Someone you are mutually connected with. They help repay if you cannot.</p>
      <p class="error" id="e-trustedContactId" role="alert"></p>
    </div>`;
  }

  function formHtml(users) {
    const { min, max } = dateRange();
    return `<h1 id="new-title" tabindex="-1">Request funds</h1>
      <form id="new-form" class="form" novalidate>
        <div class="field">
          <label for="f-amount">Total amount (₹)</label>
          <input id="f-amount" name="amount" type="text" inputmode="decimal" autocomplete="off" required aria-describedby="h-amount amount-preview e-amount">
          <p class="hint" id="h-amount">${LIMIT_TEXT}</p>
          <p class="muted" id="amount-preview" aria-live="polite"></p>
          <p class="error" id="e-amount" role="alert"></p>
        </div>
        <div class="field">
          <label for="f-category">Category</label>
          <select id="f-category" name="category" required aria-describedby="e-category">
            <option value="">Choose a category</option>
            ${CATEGORIES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
          </select>
          <p class="error" id="e-category" role="alert"></p>
        </div>
        <div class="field">
          <label for="f-purpose">Purpose</label>
          <textarea id="f-purpose" name="purpose" rows="4" required aria-describedby="h-purpose purpose-count e-purpose"></textarea>
          <p class="hint" id="h-purpose">Be specific. A verification team will check it. ${PURPOSE_MIN} to ${PURPOSE_MAX.toLocaleString('en-IN')} characters.</p>
          <p class="muted" id="purpose-count" aria-live="off">0 of ${PURPOSE_MAX.toLocaleString('en-IN')}</p>
          <p class="error" id="e-purpose" role="alert"></p>
        </div>
        <div class="field">
          <label for="f-date">Repayment date</label>
          <input id="f-date" name="repaymentDate" type="date" required min="${min}" max="${max}" aria-describedby="h-date e-date">
          <p class="hint" id="h-date">Tomorrow or later, within the next 12 months.</p>
          <p class="error" id="e-date" role="alert"></p>
        </div>
        ${contactHtml(users)}
        <p class="error" id="e-form" role="alert"></p>
        <button class="btn btn-primary" type="submit"${users.length ? '' : ' disabled'}>Send request</button>
      </form>`;
  }

  const FIELD_IDS = { amount: 'f-amount', purpose: 'f-purpose', category: 'f-category', repaymentDate: 'f-date', trustedContactId: 'f-contact' };
  const ERR_IDS = { amount: 'e-amount', purpose: 'e-purpose', category: 'e-category', repaymentDate: 'e-date', trustedContactId: 'e-trustedContactId' };

  function setError(root, field, message) {
    const err = root.querySelector(`#${ERR_IDS[field]}`);
    const input = root.querySelector(`#${FIELD_IDS[field]}`);
    if (!err || !input) return false;
    err.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    return input;
  }

  function clearErrors(root) {
    root.querySelectorAll('.error').forEach((e) => { e.textContent = ''; });
    root.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
  }

  function validateAmountField(root) {
    const input = root.querySelector('#f-amount');
    const preview = root.querySelector('#amount-preview');
    const err = root.querySelector('#e-amount');
    const text = input.value.trim();
    err.textContent = ''; input.removeAttribute('aria-invalid'); preview.textContent = '';
    if (text === '') return true;
    const r = checkAmount(text);
    if (r.error) { setError(root, 'amount', r.error); return false; }
    preview.textContent = `You are asking for ${window.Money.formatInr(r.paise)}`;
    return true;
  }

  function wire(root, ctx) {
    const form = root.querySelector('#new-form');
    const amount = root.querySelector('#f-amount');
    const purpose = root.querySelector('#f-purpose');
    const count = root.querySelector('#purpose-count');
    const button = form.querySelector('button[type="submit"]');
    let sending = false;
    amount.addEventListener('blur', () => validateAmountField(root));
    purpose.addEventListener('input', () => { count.textContent = `${purpose.value.length} of ${PURPOSE_MAX.toLocaleString('en-IN')}`; });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (sending) return;
      clearErrors(root);
      const body = {
        amount: amount.value.trim(), purpose: purpose.value, category: form.querySelector('#f-category').value,
        repaymentDate: form.querySelector('#f-date').value, trustedContactId: Number(form.querySelector('#f-contact')?.value),
      };
      const problems = [];
      if (!validateAmountField(root) || body.amount === '') problems.push(['amount', body.amount === '' ? `Enter an amount, ${LIMIT_TEXT}` : null]);
      if (purpose.value.trim().length < PURPOSE_MIN) problems.push(['purpose', `Describe the purpose in at least ${PURPOSE_MIN} characters`]);
      else if (purpose.value.length > PURPOSE_MAX) problems.push(['purpose', `Keep the purpose under ${PURPOSE_MAX.toLocaleString('en-IN')} characters`]);
      if (!body.category) problems.push(['category', 'Choose a category']);
      if (!body.repaymentDate) problems.push(['repaymentDate', 'Choose a repayment date']);
      if (!body.trustedContactId) problems.push(['trustedContactId', 'Choose a trusted contact']);
      if (problems.length) {
        let first = null;
        for (const [f, m] of problems) { const i = m ? setError(root, f, m) : root.querySelector(`#${FIELD_IDS[f]}`); first = first || i; }
        first?.focus?.();
        return;
      }
      sending = true; button.disabled = true; button.textContent = 'Sending…';
      try {
        const { request } = await window.Api.post('/requests', body);
        ctx.toast?.('Request sent to your trusted contact');
        ctx.go(`#request/${request.id}`);
      } catch (err) {
        sending = false; button.disabled = false; button.textContent = 'Send request';
        const input = err.field && setError(root, err.field, err.message);
        if (input) input.focus(); else root.querySelector('#e-form').textContent = err.message;
      }
    });
  }

  async function render(root, ctx = {}) {
    root.innerHTML = '<p class="muted" role="status">Loading…</p>';
    // The server stays authoritative; if the overview cannot load, show the form and let the API decide.
    const home = await window.Api.get('/home').catch(() => ({ myRequests: [] }));
    const active = (home.myRequests || []).find((r) => ACTIVE.includes(r.status));
    if (active) { root.innerHTML = activeRequestHtml(active); return; }
    const { users } = await window.Api.get('/users');
    root.innerHTML = formHtml(users || []);
    wire(root, ctx);
  }

  window.NewRequestPage = { render, checkAmount };
})();
