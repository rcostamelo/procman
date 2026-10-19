'use strict';

/**
 * The single application wrapper, used by BOTH execution modes.
 *
 * The supervisor spawns THIS file instead of the user's script and passes the
 * real target through the environment. That indirection is what lets us:
 *   - keep fork and cluster mode consistent (cluster cannot take argv extras)
 *   - chdir before the app loads (cluster mode cannot take a per-app cwd)
 *   - report the node version over IPC before the app starts
 *   - fix require.main / process.mainModule so the app behaves as if it had
 *     been started directly (`node app.js`)
 *
 * Nothing here should be clever: the app must see a normal Node runtime.
 */

const path = require('path');
const url = require('url');

const script = process.env.PROC_SCRIPT;
if (!script) {
  console.error('[procman] PROC_SCRIPT is not set; refusing to start');
  process.exit(1);
}

// The working directory belongs to the app, not to the supervisor.
if (process.env.PROC_CWD) {
  try { process.chdir(process.env.PROC_CWD); } catch (err) {
    console.error(`[procman] cannot chdir to ${process.env.PROC_CWD}: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Rebuild argv so the app sees the command line it expects. In cluster mode
 * the real argv is `[node, container.js]`, which would confuse most apps.
 */
let args = [];
if (process.env.PROC_ARGS) {
  try {
    args = JSON.parse(process.env.PROC_ARGS);
    if (!Array.isArray(args)) args = [];
  } catch (err) {
    console.error('[procman] PROC_ARGS is not valid JSON; ignoring it');
  }
}
process.argv = [process.execPath, script, ...args];

try {
  process.title = process.env.PROC_TITLE || `node ${script}`;
} catch (err) {
  // process.title can reject long strings on some platforms; not fatal.
}

// Tell the supervisor which Node version runs the app (useful for `describe`).
if (process.connected && typeof process.send === 'function' && process.versions && process.versions.node) {
  try { process.send({ node_version: process.versions.node, pid: process.pid }); } catch (err) { /* channel closed */ }
}

/**
 * Report the TCP ports the app actually binds.
 *
 * Apps rarely tell us, but every TCP server in Node — http, https, net, and
 * therefore Express, Fastify, Koa and the Vite dev server — goes through
 * net.Server#listen. Wrapping that one method is enough to learn the real
 * port, including when the app asks for port 0 and the OS picks one.
 *
 * Best effort by design: if anything here fails the app must still start.
 */
function hookListeningPorts() {
  const net = require('net');
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function procmanListen() {
    if (!this.__procmanPortHook) {
      this.__procmanPortHook = true;
      this.on('listening', () => {
        try {
          const address = this.address();
          if (!address || typeof address !== 'object' || !address.port) return;
          if (!process.connected || typeof process.send !== 'function') return;
          process.send({ listening: { port: address.port, address: address.address, family: address.family } });
        } catch (err) {
          // Bookkeeping must never break the app.
        }
      });
    }
    return originalListen.apply(this, arguments);
  };
}

try {
  hookListeningPorts();
} catch (err) {
  // An app we cannot instrument still runs normally.
}

const isEsm = path.extname(script) === '.mjs';

if (isEsm) {
  // Dynamic import keeps ESM support without making this wrapper ESM.
  import(url.pathToFileURL(script)).catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
} else {
  require('module')._load(script, null, true);
}

// Best-effort: make the app believe it is the entry point.
try {
  process.mainModule = process.mainModule || {};
  process.mainModule.loaded = false;
  require.main = process.mainModule;
} catch (err) {
  // Some Node builds make these read-only; degrading silently is acceptable.
}
