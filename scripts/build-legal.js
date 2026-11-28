'use strict';
// Builds the static /terms and /privacy pages from the single source of legal text, public/app/pages/legal.js
// (the same text the app shows at #/terms and #/privacy). Run after editing that file: node scripts/build-legal.js
const fs = require('node:fs');
const path = require('node:path');
const legal = require('../public/app/pages/legal.js');

const SITE = 'https://funds-for-family.vercel.app';
const PUBLIC = path.join(__dirname, '..', 'public');
const META = {
  terms: { title: 'Terms of use | Funds For Family', desc: 'The plain-English rules for using Funds For Family. Draft text, pending lawyer review.', other: 'privacy' },
  privacy: { title: 'Privacy notice | Funds For Family', desc: 'What Funds For Family keeps, who can see it, and how to delete your account. Draft text, pending lawyer review.', other: 'terms' },
};

/** In-app hash links become real URLs, and the "back to the app" link leaves the static page. */
function toStatic(body) {
  return body
    .replace(/href="#\/terms"/g, 'href="/terms/"')
    .replace(/href="#\/privacy"/g, 'href="/privacy/"')
    .replace(/<p><a href="#\/home" id="legal-back">Back to the app<\/a><\/p>/, '<p><a href="/app/" id="legal-back">Open the app</a> &middot; <a href="/">Back to the home page</a></p>');
}

function renderStaticPage(kind) {
  const m = META[kind];
  const body = toStatic(kind === 'privacy' ? legal.PRIVACY : legal.TERMS);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${m.title}</title>
  <meta name="description" content="${m.desc}">
  <meta name="theme-color" content="#1f6f5c">
  <link rel="canonical" href="${SITE}/${kind}/">
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/landing.css">
</head>
<body class="landing">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="container header-row">
      <a class="brand-link" href="/" aria-label="Funds For Family home"><span>Funds For Family</span></a>
      <a class="btn btn-secondary btn-sm" href="/app/">Sign in</a>
    </div>
  </header>
  <main id="main" tabindex="-1">
    <div class="container narrow" id="legal">${body}</div>
  </main>
  <footer class="site-footer">
    <div class="container footer-row">
      <p class="muted small">&copy; Funds For Family. Built for trusted circles.</p>
      <nav aria-label="Footer" class="site-nav small">
        <a href="/">Home</a>
        <a href="/terms/">Terms</a>
        <a href="/privacy/">Privacy</a>
      </nav>
    </div>
  </footer>
</body>
</html>
`;
}

function build() {
  for (const kind of Object.keys(META)) {
    fs.mkdirSync(path.join(PUBLIC, kind), { recursive: true });
    fs.writeFileSync(path.join(PUBLIC, kind, 'index.html'), renderStaticPage(kind));
  }
}

if (require.main === module) { build(); console.log('built public/terms and public/privacy'); }
module.exports = { renderStaticPage, build };
