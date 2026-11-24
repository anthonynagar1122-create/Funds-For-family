(() => {
  'use strict';
  const esc = window.Format.esc;

  // Three screens: your details and the terms, who you are connected with, and the rules.
  // ctx: { me, root, onUser(user), go(hash), toast(msg) }
  function render(ctx) {
    const { root } = ctx;
    let step = 1;
    let user = ctx.me;
    // A later answer (PATCH, accept-terms) does not repeat inviterName, so keep what /me gave us.
    const inviterName = ctx.me.inviterName ?? null;
    const merge = (u) => { user = { ...u, inviterName }; ctx.onUser(user); };

    const shell = (n, body) => `<div class="welcome-card panel">
      <p class="muted" id="w-progress">Step ${n} of 3</p>${body}</div>`;

    function step1() {
      const termsDone = !!user.termsAcceptedAt;
      root.innerHTML = shell(1, `
        <h1 id="welcome-title" tabindex="-1">Welcome to Funds For Family</h1>
        <p class="lede">Let's check your details. This takes a minute.</p>
        <form id="w-step-1" class="form welcome-form" novalidate>
          <div class="field">
            <label for="w-name">Your name</label>
            <input id="w-name" name="name" type="text" autocomplete="name" maxlength="120" required value="${esc(user.name)}" aria-describedby="w-e-name">
            <p class="error" id="w-e-name" role="alert"></p>
          </div>
          <div class="field">
            <label for="w-upi">UPI ID (optional)</label>
            <input id="w-upi" name="upiId" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="name@bank" value="${esc(user.upiId ?? '')}" aria-describedby="w-h-upi w-e-upi">
            <p class="hint" id="w-h-upi">Add it so people can pay you in one tap. You can change it later in Profile.</p>
            <p class="error" id="w-e-upi" role="alert"></p>
          </div>
          <div class="field">
            <label class="check" for="w-terms">
              <input id="w-terms" name="terms" type="checkbox" ${termsDone ? 'checked' : ''} aria-describedby="w-e-form">
              <span>I agree to the rules on the last step, and I understand that no money moves through this app.</span>
            </label>
          </div>
          <p class="error" id="w-e-form" role="alert"></p>
          <button class="btn btn-primary" id="w-continue" type="submit" ${termsDone ? '' : 'disabled'}>Continue</button>
        </form>`);
      const form = root.querySelector('#w-step-1');
      const terms = root.querySelector('#w-terms');
      const cont = root.querySelector('#w-continue');
      terms.addEventListener('change', () => { cont.disabled = !terms.checked; });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!terms.checked) return;
        for (const id of ['w-e-name', 'w-e-upi', 'w-e-form']) root.querySelector(`#${id}`).textContent = '';
        root.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
        cont.disabled = true;
        const name = root.querySelector('#w-name').value.trim();
        const upi = root.querySelector('#w-upi').value.trim();
        const patch = { name };
        if (upi) patch.upiId = upi;
        try {
          merge((await window.Api.patch('/me', patch)).user);
          if (!user.termsAcceptedAt) merge((await window.Api.post('/me/accept-terms')).user);
        } catch (err) {
          const slot = { name: 'w-e-name', upiId: 'w-e-upi' }[err.field] || 'w-e-form';
          root.querySelector(`#${slot}`).textContent = err.message;
          const input = err.field === 'name' ? '#w-name' : err.field === 'upiId' ? '#w-upi' : null;
          if (input) { const el = root.querySelector(input); el.setAttribute('aria-invalid', 'true'); el.focus(); }
          cont.disabled = !terms.checked;
          return;
        }
        step = 2; draw();
      });
    }

    function step2() {
      const line = inviterName
        ? `<p class="lede" id="w-connected">You're connected with ${esc(inviterName)}.</p>`
        : '';
      root.innerHTML = shell(2, `
        <div id="w-step-2">
          <h1 id="welcome-title" tabindex="-1">You're in</h1>
          ${line}
          <p>Your circle is the people you trust enough to lend to or borrow from. A good next step is to invite one more person you know well.</p>
          <div class="row-actions">
            <a class="btn btn-secondary" id="w-invite" href="#/circle">Invite someone</a>
            <button class="btn btn-primary" id="w-next" type="button">Next</button>
          </div>
          <p class="hint">You can invite people any time from Circle.</p>
        </div>`);
      root.querySelector('#w-next').addEventListener('click', () => { step = 3; draw(); });
    }

    function step3() {
      root.innerHTML = shell(3, `
        <div id="w-step-3">
          <h1 id="welcome-title" tabindex="-1">How lending works here</h1>
          <ul class="rules">
            <li>Ask for up to ₹50,000 at a time.</li>
            <li>Repay within 12 months.</li>
            <li>No interest, ever. You pay back what you borrowed.</li>
            <li>Both sides confirm every payment. It counts once the person receiving it confirms.</li>
            <li>The app never holds money. Payments go straight between people by UPI.</li>
          </ul>
          <p class="error" id="w-e-form" role="alert"></p>
          <button class="btn btn-primary" id="w-finish" type="button">Finish</button>
        </div>`);
      const btn = root.querySelector('#w-finish');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { merge((await window.Api.post('/me/welcomed')).user); }
        catch (err) { root.querySelector('#w-e-form').textContent = err.message; btn.disabled = false; return; }
        ctx.go('#/home');
      });
    }

    function draw() {
      [step1, step2, step3][step - 1]();
      const h = root.querySelector('#welcome-title');
      if (h && step > 1) h.focus();
    }
    draw();
  }

  window.WelcomePage = { render };
})();
