'use strict';
// Local entry point: `npm start` then open http://localhost:3000
try { require('node:process').loadEnvFile?.('.env'); } catch { /* no .env file */ }
const { buildProductionApp } = require('./services');
const config = require('./config');
const problems = [...config.validateServerConfig(process.env), ...config.isolationProblems(process.env)];
if (problems.length) {
  console.error('Configuration incomplete. Fix these and restart:');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
const port = Number(process.env.PORT || 3000);
buildProductionApp().listen(port, () => console.log(`Funds For Family on http://localhost:${port}`));
