'use strict';

/**
 * Programmatic API. Everything goes through the daemon; the caller never
 * spawns application processes directly.
 *
 *   const procman = require('procman');
 *   await procman.connect();                  // starts a daemon if needed
 *   await procman.start({ script: './server.js', instances: 4, mode: 'cluster' });
 *   console.log(await procman.list());
 *   procman.killDaemon();
 *
 * Which methods may start a daemon, and which require one that already runs,
 * intentionally mirrors the CLI: only `connect`, `start`, `ping`, `resurrect`
 * and `dashboard` bring a supervisor up. Reads and stops never leave an idle
 * supervisor behind; they reject with `err.code === 'NO_DAEMON'` instead.
 */

const client = require('./lib/client');
const { paths } = require('./lib/paths');
const { normalizeStart } = require('./lib/start-options');
const { loadEcosystem } = require('./lib/ecosystem');

class API {
  constructor(opts = {}) {
    this.opts = opts;
  }

  /** Make sure a daemon is up (starts one when needed). */
  connect() {
    return client.connect(this.opts);
  }

  disconnect() {
    return true; // one request per connection: there is nothing to close
  }

  get home() { return paths().home; }
  get dumpFile() { return paths().dumpFile; }

  get socket() { return paths().socket; }

  // --- process management (needs a running daemon) -------------------------

  list() { return client.callIfRunning('list', {}); }
  describe(target, namespace) { return this._on(target, 'describe', namespace); }
  stop(target, namespace) { return this._on(target, 'stop', namespace); }
  restart(target, namespace) { return this._on(target, 'restart', namespace); }
  reload(target, namespace) { return this._on(target, 'reload', namespace); }
  delete(target, namespace) { return this._on(target, 'delete', namespace); }
  scale(target, instances) { return client.callIfRunning('scale', { target, instances, cwd: process.cwd() }); }
  logs(target, opts = {}) { return client.callIfRunning('logs', Object.assign({ target, cwd: process.cwd() }, opts)); }
  overview() { return client.callIfRunning('overview', {}); }

  // Targets can be an id, a name, "namespace:name" or a script path. The cwd
  // travels along so a relative path resolves against the CALLER's directory.
  _on(target, method, namespace) {
    return client.callIfRunning(method, { target, namespace, cwd: process.cwd() });
  }

  // --- process management (may start a daemon) -----------------------------

  /** Start one application. Relative paths resolve against the caller's cwd. */
  start(opts) { return client.call('start', normalizeStart(opts, process.cwd())); }
  ping() { return client.call('ping'); }

  /** Start every app declared in an ecosystem file, in order. */
  async startEcosystem(file, opts = {}) {
    const apps = loadEcosystem(file, { env: opts.env, cwd: opts.cwd || process.cwd() });
    const started = [];
    for (const app of apps) started.push(await this.start(app));
    return started;
  }

  // --- persistence and extras ---------------------------------------------

  save() { return client.callIfRunning('save'); }

  /** Replay the saved list; a no-op when there is nothing saved. */
  resurrect() { return client.call('resurrect'); }

  dashboard(opts = {}) { return client.call('web', opts); }
  stopDashboard() { return client.callIfRunning('webStop'); }

  /** Stream events from the daemon. Returns { socket, stop() }. */
  subscribe(params, onEvent, opts) {
    return client.subscribe(params, onEvent, opts);
  }

  /** Stop the daemon and everything it runs; resolves to success:false when down. */
  async killDaemon() {
    try {
      return await client.callIfRunning('killMe');
    } catch (err) {
      if (err.code === 'NO_DAEMON') return { success: false, reason: 'daemon is not running' };
      throw err;
    }
  }
}

module.exports = new API();
module.exports.API = API;
module.exports.client = client;
