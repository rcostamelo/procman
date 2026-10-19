'use strict';

/**
 * Hits a URL continuously and reports failures and the set of pids served.
 * Used to prove that `reload` really has no downtime.
 *   node scripts/hammer.js <url> <ms>
 */

const http = require('http');

const url = process.argv[2] || 'http://127.0.0.1:4711/health';
const duration = Number(process.argv[3] || 6000);

let ok = 0;
let failed = 0;
const pids = new Set();
const errors = new Set();
const start = Date.now();

function hit() {
  if (Date.now() - start > duration) return finish();
  const request = http.get(url, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        ok += 1;
        try { pids.add(JSON.parse(body).pid); } catch (err) { /* ignore */ }
      } else {
        failed += 1;
        errors.add(`status ${res.statusCode}`);
      }
      setImmediate(hit);
    });
  });
  request.on('error', (err) => {
    failed += 1;
    errors.add(err.code || err.message);
    setTimeout(hit, 20);
  });
  request.setTimeout(2000, () => request.destroy(new Error('timeout')));
}

function finish() {
  console.log(JSON.stringify({
    ok,
    failed,
    pids: [...pids],
    errors: [...errors]
  }));
}

hit();
