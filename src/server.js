'use strict';
// Local entry point: `npm start` then open http://localhost:3000
try { require('node:process').loadEnvFile?.('.env'); } catch { /* no .env file */ }
const { buildProductionApp } = require('./services');
const port = Number(process.env.PORT || 3000);
buildProductionApp().listen(port, () => console.log(`Funds For Family on http://localhost:${port}`));
