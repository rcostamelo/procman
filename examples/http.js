'use strict';

/**
 * Example HTTP app for cluster mode. Every instance listens on the SAME port
 * (that is the point: node:cluster makes one listener shared by all workers and
 * distributes connections round-robin).
 *
 *   node examples/http.js --port 3000
 */

const http = require('http');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = Number(portIndex !== -1 ? args[portIndex + 1] : (process.env.PORT || 0));

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, pid: process.pid }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ pid: process.pid, instance: process.env.PROC_INSTANCE, url: req.url }));
});

server.listen(port, () => {
  console.log(`[http] pid=${process.pid} instance=${process.env.PROC_INSTANCE} listening on ${server.address().port}`);
});

function shutdown(signal) {
  console.log(`[http] pid=${process.pid} received ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
