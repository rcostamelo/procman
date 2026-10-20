'use strict';
/**
 * The same box, on the first real command. This is the path that always works:
 * npm 12 blocks postinstall scripts by default, so the "you just installed
 * something" moment has to come from the CLI itself.
 *
 * Rules: only in a terminal, only once per state directory (.welcomed), never
 * for --json (it would corrupt the payload), and never when the user asked for
 * quiet (PROCMAN_NO_BANNER, CI, NO_COLOR only drops the colours).
 */

const fs = require('fs');
const path = require('path');
const { banner, hint } = require('./banner');
const { paths, ensureDirs } = require('./paths');

let handled = false;

function welcome(argv) {
  if (handled) return;
  handled = true;

  if (!process.stdout.isTTY) return;
  if (process.env.CI || process.env.PROCMAN_NO_BANNER) return;
  if (argv.includes('--json')) return;

  const p = paths();
  const marker = path.join(p.home, '.welcomed');
  if (fs.existsSync(marker)) return;

  try {
    ensureDirs(p);
    fs.writeFileSync(marker, '');
  } catch (err) {
    // Cannot remember that we showed it: better to stay quiet than to repeat.
    return;
  }

  const color = !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0';
  let version = '';
  try { version = require('../package.json').version; } catch (err) { /* still a box */ }

  process.stdout.write(banner({ version, color }) + '\n');
  process.stdout.write(hint({ color }) + '\n');
}

module.exports = { welcome };
