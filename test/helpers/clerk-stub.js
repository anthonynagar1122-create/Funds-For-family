'use strict';
// Browser tests replace Clerk's CDN script with a small stub. The production page pins Clerk's script by hash
// (integrity), so the browser would reject a stub. This helper serves the real index.html with the hash swapped
// for the stub's hash. The production file is unchanged.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const sri = (body) => `sha384-${crypto.createHash('sha384').update(body).digest('base64')}`;

async function routeClerk(page, stub) {
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: stub }));
  await page.route((url) => url.pathname === '/app/' || url.pathname === '/app/index.html', async (route) => {
    const html = fs.readFileSync(path.join(PUBLIC, 'app', 'index.html'), 'utf8')
      .replace(/integrity="sha384-[^"]+"/, `integrity="${sri(stub)}"`);
    await route.fulfill({ contentType: 'text/html', body: html });
  });
}

module.exports = { routeClerk };
