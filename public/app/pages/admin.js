(() => {
  'use strict';
  // Owner admin page. The server enforces who may call /api/admin/*; this page is only shown to admins.
  // Every value from the API goes through esc() in markup or textContent. Results and errors are shown as text in #admin-status.
  const esc = window.Format.esc;
  const inr = (c) => window.Money.formatInr(c);
  const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const TABS = [
    { id: 'members', label: 'Members' }, { id: 'invites', label: 'Invites' }, { id: 'help', label: 'Help' },
    { id: 'stuck', label: 'Stuck' }, { id: 'gaps', label: 'Gaps' }, { id: 'stats', label: 'Stats' },
  ];
  const STATE_LABEL = { open: 'Open', accepted: 'Accepted', revoked: 'Revoked', expired: 'Expired', superseded: 'Replaced by a newer invite' };

  async function render(root) {
    root.innerHTML = `<h1 id="admin-heading" tabindex="-1">Admin</h1>
      <div role="tablist" aria-label="Admin sections" class="admin-tabs" id="admin-tabs">${TABS.map((t, i) =>
        `<button type="button" role="tab" class="btn btn-secondary admin-tab" id="admin-tab-${t.id}" data-tab="${t.id}" aria-controls="admin-panel" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(t.label)}</button>`).join('')}</div>
      <p class="muted" id="admin-status" role="status" aria-live="polite"></p>
      <div id="admin-panel" role="tabpanel" aria-labelledby="admin-tab-members" tabindex="-1"></div>`;
    const $ = (s) => root.querySelector(s);
    const panel = $('#admin-panel');
    const statusEl = $('#admin-status');
    const say = (text) => { statusEl.textContent = text; };
    let tab = 'members';
    let data = null; // the rows of the open tab
    let token = 0;   // ignores a slow response for a tab the owner has already left

    const settle = (h2) => { panel.querySelector(h2)?.focus(); };
    const heading = (text) => `<h2 id="admin-panel-h" tabindex="-1">${esc(text)}</h2>`;
    const empty = (text) => `<p class="muted">${esc(text)}</p>`;

    const views = {
      members: () => `${heading('Members')}${data.length ? `<ul class="list">${data.map((m) => `<li>
        <p><strong>${esc(m.name)}</strong> <span class="muted">${esc(m.email)}</span></p>
        <p class="muted">${esc(plural(m.invitesThisMonth, 'invite', 'invites'))} this month. Limit: ${m.inviteLimit === null ? 'default (5)' : esc(m.inviteLimit)}.
          ${m.isVerifier ? '<span class="badge badge-ok">Verifier</span>' : ''}</p>
        <button type="button" class="btn btn-secondary" data-act="verifier" data-id="${esc(m.id)}" data-on="${m.isVerifier ? 'false' : 'true'}"
          aria-label="${esc(m.isVerifier ? `Remove ${m.name} as a verifier` : `Make ${m.name} a verifier`)}">${m.isVerifier ? 'Remove verifier' : 'Make verifier'}</button>
        <div class="stack">
          <label for="limit-${esc(m.id)}">Invite limit for ${esc(m.name)}</label>
          <input id="limit-${esc(m.id)}" type="number" inputmode="numeric" min="0" max="50" step="1" value="${m.inviteLimit === null ? '' : esc(m.inviteLimit)}" placeholder="Default (5)">
          <button type="button" class="btn btn-primary" data-act="limit" data-id="${esc(m.id)}" aria-label="${esc(`Save invite limit for ${m.name}`)}">Save</button>
        </div></li>`).join('')}</ul>` : empty('No members yet.')}`,

      invites: () => `${heading('Invites')}${data.length ? `<ul class="list">${data.map((i) => `<li>
        <p><strong>${esc(i.email)}</strong></p>
        <p class="muted">Invited by ${esc(i.inviterName)} on ${esc(day(i.createdAt))}. <span class="badge${i.state === 'open' ? '' : ' badge-warn'}">${esc(STATE_LABEL[i.state] ?? i.state)}</span></p>
        ${i.state === 'open' ? `<button type="button" class="btn btn-secondary" data-act="revoke" data-id="${esc(i.id)}" aria-label="${esc(`Revoke invite for ${i.email}`)}">Revoke</button>` : ''}
        </li>`).join('')}</ul>` : empty('No invites yet.')}`,

      help: () => `${heading('Help')}${data.length ? `<ul class="list">${data.map((m) => `<li>
        <p><strong>${esc(m.name)}</strong> <span class="muted">${esc(m.email ?? '')}</span></p>
        <p class="help-body">${esc(m.body)}</p>
        <p class="muted">${esc(day(m.createdAt))}</p>
        <button type="button" class="btn btn-secondary" data-act="resolve" data-id="${esc(m.id)}" aria-label="${esc(`Mark message from ${m.name} resolved`)}">Mark resolved</button>
        </li>`).join('')}</ul>` : empty('No messages waiting.')}`,

      stuck: () => `${heading('Stuck')}<p class="muted">Payments still waiting after 7 days. Settle one only after you have checked with both people.</p>
        ${data.length ? `<ul class="list">${data.map((e) => {
          const name = `${e.kind} ${e.id}`;
          return `<li>
            <p><strong>${esc(inr(e.amountCents))}</strong> from ${esc(e.payerName)} to ${esc(e.receiverName)} <span class="muted">(request ${esc(e.requestId)})</span></p>
            <p class="muted">${esc(e.kind === 'repayment' ? 'Repayment' : 'Contribution')}, ${e.status === 'not_received' ? 'marked not received' : 'marked sent'}, waiting ${esc(plural(e.daysWaiting, 'day', 'days'))}.</p>
            ${e.isYours ? '<p class="muted">You are part of this payment, so someone else must settle it.</p>' : `<div class="stack">
              <label for="note-${esc(e.kind)}-${esc(e.id)}">Note for ${esc(name)}</label>
              <textarea id="note-${esc(e.kind)}-${esc(e.id)}" maxlength="500" rows="2"></textarea>
              <button type="button" class="btn btn-primary" data-act="settle" data-do="confirm" data-kind="${esc(e.kind)}" data-id="${esc(e.id)}" aria-label="${esc(`Confirm ${name} as received`)}">Confirm received</button>
              <button type="button" class="btn btn-secondary" data-act="settle" data-do="remove" data-kind="${esc(e.kind)}" data-id="${esc(e.id)}" aria-label="${esc(`Remove ${name}`)}">Remove entry</button>
            </div>`}</li>`;
        }).join('')}</ul>` : empty('Nothing is stuck.')}`,

      gaps: () => `${heading('Gaps')}${data.length ? `<ul class="list">${data.map((g) => `<li>
        <p><strong>${esc(g.borrowerName)}</strong> <span class="muted">(request ${esc(g.requestId)})</span></p>
        <p>${esc(g.purpose)}</p>
        <p class="muted">${esc(g.eligibleVerifiers)} of ${esc(g.needed)} verifiers available. Make another member a verifier on the Members tab.</p>
        </li>`).join('')}</ul>` : empty('Every request waiting for verification has enough verifiers.')}`,

      stats: () => `${heading('Stats')}<dl class="stats">
        <div><dt>Invites sent</dt><dd id="stat-sent">${esc(data.invitesSent)}</dd></div>
        <div><dt>Invites accepted</dt><dd id="stat-accepted">${esc(data.invitesAccepted)}</dd></div>
        <div><dt>Accepted members who made or funded a request</dt><dd id="stat-acted">${esc(data.acceptedWhoMadeOrFunded)}</dd></div></dl>`,
    };

    const LOADERS = {
      members: async () => (await window.Api.get('/admin/members')).members ?? [],
      invites: async () => (await window.Api.get('/admin/invites')).invites ?? [],
      help: async () => ((await window.Api.get('/admin/help-messages')).messages ?? []).filter((m) => !m.resolvedAt),
      stuck: async () => (await window.Api.get('/admin/stuck')).entries ?? [],
      gaps: async () => (await window.Api.get('/admin/verification-gaps')).requests ?? [],
      stats: async () => window.Api.get('/admin/stats'),
    };

    function paint(focus) { panel.innerHTML = views[tab](); if (focus) settle('#admin-panel-h'); }

    async function openTab(id, { keepStatus = false } = {}) {
      tab = id;
      const mine = ++token;
      for (const b of root.querySelectorAll('[role="tab"]')) {
        const on = b.dataset.tab === id;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      panel.setAttribute('aria-labelledby', `admin-tab-${id}`);
      if (!keepStatus) say('');
      panel.innerHTML = '<p class="muted">Loading…</p>';
      try {
        const rows = await LOADERS[id]();
        if (mine !== token) return;
        data = rows;
        paint(false);
      } catch (e) {
        if (mine !== token) return;
        data = null;
        panel.innerHTML = '';
        say(`Could not load ${TABS.find((t) => t.id === id).label.toLowerCase()}. ${e.message}`);
      }
    }

    const run = async (btn, fn) => {
      btn.disabled = true;
      try { await fn(); } catch (e) { say(`That did not work. ${e.message}`); } finally { btn.disabled = false; }
    };

    const ACTIONS = {
      async verifier(btn) {
        const id = Number(btn.dataset.id);
        const on = btn.dataset.on === 'true';
        const { member } = await window.Api.post(`/admin/members/${encodeURIComponent(id)}/verifier`, { on });
        const row = data.find((m) => m.id === id);
        if (row) row.isVerifier = member.isVerifier;
        paint(true);
        say(`${row?.name ?? member.name} is ${member.isVerifier ? 'now' : 'no longer'} a verifier.`);
      },
      async limit(btn) {
        const id = Number(btn.dataset.id);
        const row = data.find((m) => m.id === id);
        const raw = panel.querySelector(`#limit-${id}`).value.trim();
        const limit = raw === '' ? null : Number(raw);
        if (limit !== null && !(Number.isInteger(limit) && limit >= 0 && limit <= 50)) {
          say('The invite limit must be a whole number from 0 to 50, or empty for the default.');
          return;
        }
        const { member } = await window.Api.post(`/admin/members/${encodeURIComponent(id)}/invite-limit`, { limit });
        if (row) row.inviteLimit = member.inviteLimit;
        paint(true);
        say(limit === null ? `Invite limit for ${row?.name ?? member.name} reset to the default.` : `Invite limit for ${row?.name ?? member.name} saved: ${limit}.`);
      },
      async revoke(btn) {
        const id = Number(btn.dataset.id);
        const row = data.find((i) => i.id === id);
        await window.Api.delete(`/admin/invites/${encodeURIComponent(id)}`);
        if (row) row.state = 'revoked';
        paint(true);
        say(`Invite for ${row?.email ?? 'this person'} revoked.`);
      },
      async resolve(btn) {
        const id = Number(btn.dataset.id);
        await window.Api.post(`/admin/help-messages/${encodeURIComponent(id)}/resolve`);
        data = data.filter((m) => m.id !== id);
        paint(true);
        say('Marked as resolved.');
      },
      async settle(btn) {
        const id = Number(btn.dataset.id);
        const kind = btn.dataset.kind;
        const action = btn.dataset.do;
        const note = panel.querySelector(`#note-${kind}-${id}`).value.trim();
        if (note.length < 5 || note.length > 500) { say('Write a note of 5 to 500 characters first.'); panel.querySelector(`#note-${kind}-${id}`).focus(); return; }
        await window.Api.post(`/admin/${kind === 'repayment' ? 'repayments' : 'contributions'}/${encodeURIComponent(id)}/settle`, { action, note });
        data = data.filter((e) => !(e.kind === kind && e.id === id));
        paint(true);
        say(`${kind === 'repayment' ? 'Repayment' : 'Contribution'} ${id} ${action === 'confirm' ? 'confirmed' : 'removed'}.`);
      },
    };

    root.addEventListener('click', (ev) => {
      const tabBtn = ev.target.closest('[role="tab"]');
      if (tabBtn) { openTab(tabBtn.dataset.tab); return; }
      const btn = ev.target.closest('button[data-act]');
      if (btn && ACTIONS[btn.dataset.act]) run(btn, () => ACTIONS[btn.dataset.act](btn));
    });
    $('#admin-tabs').addEventListener('keydown', (ev) => {
      const i = TABS.findIndex((t) => t.id === tab);
      const next = ev.key === 'ArrowRight' ? (i + 1) % TABS.length : ev.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
      if (next < 0) return;
      ev.preventDefault();
      openTab(TABS[next].id);
      root.querySelector(`#admin-tab-${TABS[next].id}`).focus();
    });

    await openTab('members');
  }

  window.AdminPage = { render };
})();
