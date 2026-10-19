'use strict';

/**
 * Example app that logs a burst of numbered lines and then idles.
 * Used by the smoke test to exercise log rotation without generating real
 * traffic, and to make "which instance logged this?" visible for cluster mode.
 *
 *   node examples/chatty.js --count 400
 */

const args = process.argv.slice(2);
const countIndex = args.indexOf('--count');
const count = countIndex !== -1 ? Number(args[countIndex + 1]) : 400;

const burst = process.env.CHATTY_BURST === '0' ? 0 : count;
for (let i = 0; i < burst; i++) {
  console.log(`instance ${process.env.NODE_APP_INSTANCE || 0} line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`);
}

setInterval(() => {}, 1000); // stay alive so the app is not restart-looped
