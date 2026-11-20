'use strict';
// Vercel serverless entry: every /api/* request is served by the Express app.
const { buildProductionApp } = require('../src/services');
module.exports = buildProductionApp();
