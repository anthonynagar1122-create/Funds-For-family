(() => {
  'use strict';
  // Escape every untrusted value before it goes into markup.
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // "Asha Rao" -> "AR", "Madonna" -> "M", "" -> "?"
  function initials(name) {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    const first = Array.from(parts[0])[0];
    const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : '';
    return (first + last).toUpperCase();
  }

  // A round avatar with the member's initials. The name is escaped; the colour comes from a fixed palette.
  function avatar(user) {
    const name = user?.name ?? '';
    let h = 0;
    for (const ch of String(user?.id ?? name)) h = (h * 31 + ch.charCodeAt(0)) % 5;
    return `<span class="avatar avatar-${h}" role="img" aria-label="${esc(name || 'Member')}">${esc(initials(name))}</span>`;
  }

  window.Format = { esc, initials, avatar };
})();
