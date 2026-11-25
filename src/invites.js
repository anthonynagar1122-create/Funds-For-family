'use strict';
// Invite tokens and states. Only the SHA-256 hex of a token is ever stored; the raw token exists in the
// inviter's one-time response and in the link they share.
const crypto = require('node:crypto');
const { todayIst } = require('./rules');

const INVITE_TTL_DAYS = 14;
const DEFAULT_MONTHLY_INVITES = 5;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** The first of the current IST month at 00:00 IST, as a UTC ISO string. */
function monthStartIst(now) {
  const firstOfMonth = `${todayIst(now).slice(0, 7)}-01`;
  return new Date(`${firstOfMonth}T00:00:00+05:30`).toISOString();
}

/** 'open' | 'accepted' | 'revoked' | 'superseded' | 'expired'. Expiry is judged against the injected clock. */
function inviteState(invite, now) {
  if (invite.acceptedAt) return 'accepted';
  if (invite.revokedAt) return 'revoked';
  if (invite.supersededAt) return 'superseded';
  if (new Date(invite.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'open';
}

module.exports = { newToken, hashToken, monthStartIst, inviteState, INVITE_TTL_DAYS, DEFAULT_MONTHLY_INVITES };
