(() => {
  'use strict';
  const esc = window.Format.esc;
  const STATE = { open: 'Open', accepted: 'Accepted', revoked: 'Revoked', expired: 'Expired', superseded: 'Superseded' };

  const person = (u, action) => `<li class="person">${window.Format.avatar(u)}<span class="person-name">${esc(u.name)}</span>${action || ''}</li>`;
  function group(title, id, users, action, emptyText) {
    return `<section aria-labelledby="${id}-h"><h2 id="${id}-h">${esc(title)} (${users.length})</h2>
      ${users.length ? `<ul class="list" id="${id}">${users.map((u) => person(u, action ? action(u) : '')).join('')}</ul>` : `<p class="empty">${esc(emptyText)}</p>`}</section>`;
  }

  function listsHtml({ following, followers, mutual }) {
    const mutualIds = new Set(mutual.map((u) => u.id));
    const followingIds = new Set(following.map((u) => u.id));
    const followingOnly = following.filter((u) => !mutualIds.has(u.id));
    const followersOnly = followers.filter((u) => !mutualIds.has(u.id) && !followingIds.has(u.id));
    const followBack = (u) => `<button class="btn btn-secondary" type="button" data-follow-back="${esc(u.id)}" aria-label="Follow back ${esc(u.name)}">Follow back</button>`;
    return group('Mutual', 'circle-mutual', mutual, null, 'No mutual connections yet. You see requests only from people you follow and who follow you.')
      + group('Following only', 'circle-following', followingOnly, null, 'Nobody here. These are people you follow who have not followed you back.')
      + group('Followers only', 'circle-followers', followersOnly, followBack, 'Nobody here. These are people who follow you and wait for you to follow back.');
  }

  function invitesHtml(list) {
    if (!list.length) return '<p class="empty">You have not invited anyone yet.</p>';
    return `<ul class="list" id="my-invites">${list.map((i) => `<li class="person"><span class="person-name">${esc(i.email)}</span>
      <span class="badge">${esc(STATE[i.state] ?? i.state)}</span>
      ${i.state === 'open' ? `<button class="btn btn-ghost" type="button" data-revoke="${esc(i.id)}" aria-label="Revoke invite for ${esc(i.email)}">Revoke</button>` : ''}</li>`).join('')}</ul>`;
  }

  const left = (n) => `${n} ${n === 1 ? 'invite' : 'invites'} left this month`;

  async function render(root, ctx = {}) {
    root.innerHTML = '<p class="muted" role="status">Loading…</p>';
    const [conn, inv] = await Promise.all([window.Api.get('/connections'), window.Api.get('/invites')]);
    root.innerHTML = `<h1 id="circle-title" tabindex="-1">Circle</h1>
      <div id="circle-lists"></div>
      <section aria-labelledby="invite-h"><h2 id="invite-h">Invite someone</h2>
        <form id="invite-form" class="stack" novalidate>
          <label for="f-invite">Email address to invite</label>
          <input id="f-invite" type="email" autocomplete="off" required aria-describedby="invite-error">
          <p class="error" id="invite-error" role="alert"></p>
          <button class="btn btn-primary" type="submit" id="invite-submit">Create invite</button>
        </form>
        <div id="invite-result" aria-live="polite"></div>
      </section>
      <section aria-labelledby="mine-h"><h2 id="mine-h">My invites</h2><div id="my-invites-box"></div></section>`;
    const $ = (s) => root.querySelector(s);
    $('#circle-lists').innerHTML = listsHtml(conn);
    $('#my-invites-box').innerHTML = invitesHtml(inv.invites || []);

    const reloadInvites = async () => { $('#my-invites-box').innerHTML = invitesHtml((await window.Api.get('/invites')).invites || []); };

    $('#circle-lists').addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-follow-back]');
      if (!b) return;
      b.disabled = true;
      try {
        await window.Api.post('/follows', { userId: Number(b.dataset.followBack) });
        ctx.toast?.('Following');
        $('#circle-lists').innerHTML = listsHtml(await window.Api.get('/connections'));
      } catch (err) { b.disabled = false; ctx.toast?.(err.message); }
    });

    $('#my-invites-box').addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-revoke]');
      if (!b) return;
      b.disabled = true;
      try { await window.Api.delete(`/invites/${encodeURIComponent(b.dataset.revoke)}`); await reloadInvites(); }
      catch (err) { b.disabled = false; ctx.toast?.(err.message); }
    });

    $('#invite-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const input = $('#f-invite');
      const err = $('#invite-error');
      const btn = $('#invite-submit');
      err.textContent = '';
      $('#invite-result').innerHTML = '';
      const email = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter a valid email address'; input.focus(); return; }
      btn.disabled = true;
      try {
        const out = await window.Api.post('/invites', { email });
        // The link lives only in this closure and in the share buttons. It is not printed, stored, or put in the URL.
        const link = out.link;
        $('#invite-result').innerHTML = `<div class="card" id="invite-card"><p>Invite created for ${esc(email)}. Share it now; the link is shown only once.</p>
          <p id="invites-left">${esc(left(out.remainingThisMonth))}</p>
          <div class="row-actions"><a class="btn btn-primary" id="wa-share" href="${esc(out.whatsappUrl)}" target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>
          <button class="btn btn-secondary" type="button" id="copy-link">Copy link</button></div>
          <p class="muted" id="copy-status" role="status"></p></div>`;
        $('#copy-link').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(link); $('#copy-status').textContent = 'Link copied'; }
          catch { $('#copy-status').textContent = 'Could not copy. Use WhatsApp instead.'; }
        });
        input.value = '';
        await reloadInvites();
      } catch (e) {
        err.textContent = e.message;
        input.focus();
      } finally { btn.disabled = false; }
    });
  }

  window.CirclePage = { render };
})();
