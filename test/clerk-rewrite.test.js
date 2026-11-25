'use strict';
// The Clerk Frontend API proxy runs inside the Express function. Vercel only sends paths that have a rewrite to that
// function, so /__clerk must be rewritten the same way as /api, or every proxied Clerk request returns 404.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('vercel.json sends the Clerk proxy path to the server function, like /api', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const rewrites = config.rewrites || [];
  assert.ok(rewrites.some((r) => r.source === '/api/:path*' && r.destination === '/api/index'));
  assert.ok(rewrites.some((r) => r.source === '/__clerk/:path*' && r.destination === '/api/index'),
    'a /__clerk rewrite is required for the Clerk proxy');
});
