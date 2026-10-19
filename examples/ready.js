'use strict';

/**
 * Example app that announces readiness the way procman expects:
 * once it has warmed up, it sends a 'ready' message over IPC.
 *
 *   node examples/ready.js --delay 800     # warm up, then signal
 *   node examples/ready.js --never         # stay up, never signal
 *
 * Used by the smoke test to exercise `start --wait-ready`.
 */

const args = process.argv.slice(2);
const delayIndex = args.indexOf('--delay');
const delay = delayIndex !== -1 ? Number(args[delayIndex + 1]) : 800;
const never = args.includes('--never');

setInterval(() => {}, 1000); // stay alive

if (never) {
  console.log('warming up, will never signal readiness');
} else {
  setTimeout(() => {
    console.log(`warmed up after ${delay}ms`);
    if (process.send) process.send('ready');
  }, delay);
}
