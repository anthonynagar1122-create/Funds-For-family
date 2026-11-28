(() => {
  'use strict';
  const esc = window.Format.esc;
  const inr = (c) => window.Money.formatInr(c);
  const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
  // memberSince arrives as YYYY-MM (IST).
  const monthYear = (ym) => {
    const m = /^(\d{4})-(\d{2})/.exec(String(ym ?? ''));
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // A photo only from an https address; otherwise initials.
  function avatarHtml(me) {
    if (typeof me.avatarUrl === 'string' && /^https:\/\//i.test(me.avatarUrl)) {
      return `<img class="avatar avatar-photo" src="${esc(me.avatarUrl)}" alt="${esc(me.name)}" width="64" height="64" referrerpolicy="no-referrer">`;
    }
    return window.Format.avatar(me);
  }

  // Every value goes through esc(); the message text is never treated as markup.
  function myHelpHtml(messages) {
    if (!messages) return '<p class="muted">Your messages could not be loaded.</p>';
    if (!messages.length) return '<p class="muted">No messages yet.</p>';
    return `<ul class="list">${messages.map((m) => `<li><p class="help-body">${esc(m.body)}</p>
      <p class="muted">${esc(day(m.createdAt))} <span class="badge${m.resolvedAt ? '' : ' badge-warn'}">${m.resolvedAt ? 'Resolved' : 'Waiting for a reply'}</span></p></li>`).join('')}</ul>`;
  }
  async function loadMyHelp() {
    let messages = null;
    try { messages = (await window.Api.get('/help/mine')).messages ?? []; } catch { messages = null; }
    const box = document.getElementById('my-help');
    if (box) box.innerHTML = myHelpHtml(messages);
  }

  function trustHtml(t) {
    if (!t) return '<p class="muted" id="trust-unavailable">Trust history could not be loaded.</p>';
    return `<ul class="list" id="trust-list">
      <li>Member since ${esc(monthYear(t.memberSince))}</li>
      <li>${esc(plural(t.repaidCount, 'request repaid', 'requests repaid'))}</li>
      <li>${esc(t.repaidOnTimeCount)} of those repaid by the agreed date</li>
      <li>Lent to ${esc(plural(t.lentToCount, 'request', 'requests'))}</li></ul>`;
  }

  async function render(root, ctx = {}) {
    const me = ctx.me;
    root.innerHTML = '<p class="muted" role="status">Loading…</p>';
    let trust = null;
    try { trust = (await window.Api.get(`/users/${encodeURIComponent(me.id)}`)).user.trust ?? null; } catch { trust = null; }

    root.innerHTML = `<h1 id="profile-heading" tabindex="-1">Profile</h1>
      <section aria-labelledby="who-h"><h2 id="who-h">Your details</h2>
        <div class="person" id="profile-who">${avatarHtml(me)}<span class="person-name" id="profile-name">${esc(me.name)}</span></div>
        <p class="muted">${esc(me.email)}</p>
        <form id="details-form" class="stack" novalidate>
          <label for="f-name">Name</label>
          <input id="f-name" type="text" autocomplete="name" maxlength="120" value="${esc(me.name)}">
          <label for="f-upi">UPI ID</label>
          <input id="f-upi" type="text" autocomplete="off" inputmode="email" value="${esc(me.upiId ?? '')}" placeholder="name@bank" aria-describedby="details-error">
          <p class="error" id="details-error" role="alert"></p>
          <button class="btn btn-primary" type="submit" id="details-save">Save details</button>
        </form>
      </section>
      <section aria-labelledby="trust-h"><h2 id="trust-h">Trust history</h2>${trustHtml(trust)}</section>
      <section aria-labelledby="stmt-h"><h2 id="stmt-h">Statement</h2>
        <p class="muted">Everything you have borrowed and lent, to print or save.</p>
        <a class="btn btn-secondary" id="statement-link" href="#/profile/statement">Open my statement</a></section>
      <section aria-labelledby="help-h"><h2 id="help-h">Get help</h2>
        <form id="help-form" class="stack" novalidate>
          <label for="f-help">How can we help?</label>
          <textarea id="f-help" maxlength="2000" aria-describedby="help-hint help-error"></textarea>
          <p class="hint" id="help-hint">At least 10 characters.</p>
          <p class="error" id="help-error" role="alert"></p>
          <button class="btn btn-primary" type="submit" id="help-send">Send message</button>
          <p class="muted" id="help-status" role="status"></p>
        </form>
        <h3 id="my-help-h">Your messages</h3>
        <div id="my-help" aria-labelledby="my-help-h"><p class="muted">Loading…</p></div>
      </section>
      <section aria-labelledby="del-h"><h2 id="del-h">Delete account</h2>
        <p>This removes your name, email and UPI ID and takes you out of everyone's circle. Past payments stay in other people's records under "Former member". It cannot be undone.</p>
        <form id="delete-form" class="stack" novalidate>
          <label for="f-delete">Type DELETE to confirm</label>
          <input id="f-delete" type="text" autocomplete="off" autocapitalize="characters" aria-describedby="delete-error">
          <p class="error" id="delete-error" role="alert"></p>
          <button class="btn btn-secondary" type="submit" id="delete-go" disabled>Delete my account</button>
        </form>
      </section>
      <section aria-labelledby="legal-h"><h2 id="legal-h">Terms and privacy</h2>
        <p><a id="terms-link" href="#/terms">Terms of use</a> · <a id="privacy-link" href="#/privacy">Privacy notice</a></p></section>
      <section aria-label="Sign out"><button class="btn btn-secondary" type="button" id="sign-out">Sign out</button></section>`;

    const $ = (s) => root.querySelector(s);

    $('#details-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('#details-error');
      const btn = $('#details-save');
      err.textContent = '';
      btn.disabled = true;
      try {
        const { user } = await window.Api.patch('/me', { name: $('#f-name').value, upiId: $('#f-upi').value });
        ctx.onUser?.(user);
        $('#profile-name').textContent = user.name;
        ctx.toast?.('Saved');
      } catch (e) { err.textContent = e.message; (e.field === 'name' ? $('#f-name') : $('#f-upi')).focus(); }
      finally { btn.disabled = false; }
    });

    // Email preference toggles are hidden until email reminders exist (P-48); the API route stays.

    loadMyHelp();
    $('#help-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('#help-error');
      const status = $('#help-status');
      const field = $('#f-help');
      err.textContent = ''; status.textContent = '';
      const body = field.value.trim();
      if (body.length < 10) { err.textContent = 'Please write at least 10 characters.'; field.focus(); return; }
      const btn = $('#help-send');
      btn.disabled = true;
      try {
        await window.Api.post('/help', { body });
        field.value = '';
        status.textContent = 'Thanks. We have your message and will get back to you.';
        await loadMyHelp();
      } catch (e) { err.textContent = e.message; field.focus(); }
      finally { btn.disabled = false; }
    });

    $('#f-delete').addEventListener('input', () => { $('#delete-go').disabled = $('#f-delete').value !== 'DELETE'; });
    $('#delete-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('#delete-error');
      const btn = $('#delete-go');
      err.textContent = '';
      if ($('#f-delete').value !== 'DELETE') return;
      btn.disabled = true;
      try { await window.Api.request('DELETE', '/me', { confirm: 'DELETE' }); }
      catch (e) { err.textContent = e.message; btn.disabled = false; return; }
      ctx.toast?.('Your account has been deleted');
      await ctx.signOut?.();
    });

    $('#sign-out').addEventListener('click', () => { ctx.signOut?.(); });
  }

  // ---- Statement ----
  function entryRows(entries) {
    return entries.map((e) => `<tr><td>${esc(day(e.createdAt))}</td><td>${esc(e.kind === 'repayment' ? 'Repayment' : 'Lent')}</td>
      <td class="num">${esc(inr(e.amountCents))}</td><td>${esc(e.status.replace('_', ' '))}</td><td>${esc(e.utr ?? '')}</td></tr>`).join('');
  }
  function tableFor(list, title, id, extra) {
    if (!list.length) return `<section aria-labelledby="${id}-h"><h2 id="${id}-h">${esc(title)}</h2><p class="empty">None yet.</p></section>`;
    return `<section aria-labelledby="${id}-h"><h2 id="${id}-h">${esc(title)}</h2>${list.map((r) => `
      <div class="stmt-item"><h3>${esc((r.purpose || '').slice(0, 120))}</h3>
        <p class="muted">Request ${esc(r.requestId)} · ${esc(r.status.replace('_', ' '))} · due ${esc(r.repaymentDate)} · ${esc(inr(r.principalCents))} · ${esc(extra(r))}</p>
        <table class="stmt-table"><thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">UTR</th></tr></thead>
        <tbody>${entryRows(r.entries)}</tbody></table></div>`).join('')}</section>`;
  }

  // A short plain-text copy for sharing.
  function summaryText(s) {
    const lines = [`Funds For Family statement for ${s.member.name}`, `As of ${day(s.generatedAt)}`, ''];
    lines.push('Requests I made:');
    if (!s.requests.length) lines.push('  none');
    for (const r of s.requests) lines.push(`  #${r.requestId} ${r.status.replace('_', ' ')}: asked ${inr(r.principalCents)}, raised ${inr(r.raisedCents)}, paid back ${inr(r.paidBackCents)}, due ${r.repaymentDate}`);
    lines.push('', 'Loans I made:');
    if (!s.loans.length) lines.push('  none');
    for (const r of s.loans) lines.push(`  #${r.requestId} ${r.status.replace('_', ' ')}: lent ${inr(r.myLentCents)}, repaid ${inr(r.myRepaidCents)}, still owed ${inr(r.myOwedCents)}`);
    return lines.join('\n');
  }

  async function renderStatement(root, ctx = {}) {
    root.innerHTML = '<p class="muted" role="status">Loading…</p>';
    const s = await window.Api.get('/me/statement');
    root.innerHTML = `<div class="no-print"><a href="#/profile" id="stmt-back">Back to profile</a></div>
      <h1 id="statement-heading" tabindex="-1">Statement</h1>
      <p class="muted">${esc(s.member.name)} · as of ${esc(day(s.generatedAt))}</p>
      <div class="row-actions no-print">
        <button class="btn btn-primary" type="button" id="stmt-print">Print or save as PDF</button>
        <button class="btn btn-secondary" type="button" id="stmt-share">Share summary</button></div>
      <p class="muted no-print" id="stmt-status" role="status"></p>
      <div id="stmt-body">${tableFor(s.requests, 'Requests I made', 'stmt-req', (r) => `raised ${inr(r.raisedCents)}, paid back ${inr(r.paidBackCents)}`)}
        ${tableFor(s.loans, 'Loans I made', 'stmt-loan', (r) => `lent ${inr(r.myLentCents)}, repaid ${inr(r.myRepaidCents)}, still owed ${inr(r.myOwedCents)}`)}</div>`;
    const status = root.querySelector('#stmt-status');
    root.querySelector('#stmt-print').addEventListener('click', () => window.print());
    root.querySelector('#stmt-share').addEventListener('click', async () => {
      const text = summaryText(s);
      status.textContent = '';
      try {
        if (navigator.share) { await navigator.share({ title: 'My Funds For Family statement', text }); return; }
        await navigator.clipboard.writeText(text);
        status.textContent = 'Summary copied';
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        status.textContent = 'Could not share or copy the summary.';
      }
    });
    ctx.afterRender?.();
  }

  window.ProfilePage = { render, renderStatement, summaryText };
})();
