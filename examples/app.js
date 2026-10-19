'use strict';

/**
 * Example long-running app used by the smoke test.
 *   node examples/app.js --label alpha
 * Reads PORT from the environment (0 = random), prints a heartbeat, and
 * shuts down cleanly on SIGINT.
 */

const http = require('http');

const args = process.argv.slice(2);
const labelIndex = args.indexOf('--label');
const label = labelIndex !== -1 ? args[labelIndex + 1] : 'app';
const port = Number(process.env.PORT || 0);

const server = http.createServer((req, res) => {
  res.end(`ok from ${label}\n`);
});

server.listen(port, () => {
  const address = server.address();
  console.log(`[${label}] listening on ${address.port} pid=${process.pid}`);
});

const heartbeat = setInterval(() => {
  console.log(`[${label}] alive ${new Date().toISOString()}`);
}, 500);
heartbeat.unref();

function shutdown(signal) {
  console.log(`[${label}] received ${signal}, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
