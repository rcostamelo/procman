'use strict';

/**
 * The daemon: a long-lived process that owns the endpoint, the supervisor and
 * the event bus. It is deliberately the ONLY process that can start/stop
 * applications.
 *
 * Protocol: newline-delimited JSON, one request per connection.
 *   request  -> {"id":1,"method":"start","params":{...}}
 *   response -> {"id":1,"ok":true,"result":{...}}
 *   event    -> {"event":"log","payload":{...}}   (only after `subscribe`)
 *
 * Robustness rules that matter:
 *   - never unlink an endpoint we did not create; if the bind fails because
 *     someone else owns it, exit instead of stealing it
 *   - never remove a pid file that does not contain our own pid
 */

const net = require('net');
const fs = require('fs');
const { paths, ensureDirs } = require('./paths');
const protocol = require('./protocol');
const { Supervisor } = require('./supervisor');
const { readTail } = require('./logs');
const { createDashboard } = require('./dashboard');
const { EXIT_CODES } = require('./constants');
const debug = require('./debug')('daemon');

const p = paths();
ensureDirs(p);

const supervisor = new Supervisor();
let shuttingDown = false;
let dashboard = null;

process.title = `procman: daemon (${p.home})`;

// ----------------------------------------------------------- event fanout --

/** socket -> { ids: Set<number>|null, kinds: Set<string> } */
const subscribers = new Map();

const EVENT_KINDS = new Set(['log', 'state', 'watch', 'cron', 'overlimit']);

function fanout(kind, payload) {
  if (subscribers.size === 0) return;
  const frame = protocol.encode({ event: kind, payload });
  for (const [socket, filter] of subscribers) {
    if (!filter.kinds.has(kind)) continue;
    if (kind === 'log' && filter.ids && !filter.ids.has(payload.id)) continue;
    if (socket.destroyed) { subscribers.delete(socket); continue; }
    socket.write(frame);
  }
}

for (const kind of EVENT_KINDS) {
  supervisor.on(kind, (payload) => fanout(kind, payload));
}

// -------------------------------------------------------------- handlers ---

const methods = {
  ping() {
    return {
      pong: true,
      pid: process.pid,
      version: require('../package.json').version,
      home: p.home,
      processes: supervisor.records.size
    };
  },

  start(params) {
    return supervisor.start(params);
  },

  list() {
    return supervisor.list();
  },

  describe(params) {
    return supervisor.describe(resolveOne(params.target, params.namespace, params.cwd));
  },

  async stop(params) {
    return act(params, (id) => supervisor.stop(id));
  },

  async restart(params) {
    return act(params, (id) => supervisor.restart(id));
  },

  async reload(params) {
    return act(params, (id) => supervisor.reload(id));
  },

  async delete(params) {
    return act(params, (id) => supervisor.delete(id));
  },

  scale(params) {
    return supervisor.scale(resolveOne(params.target, params.namespace, params.cwd), params.instances);
  },

  /**
   * Tail of the log files; `subscribe` handles the live case.
   *
   * `lines` is the budget for the WHOLE reply, split across per-instance files
   * when the app runs with `merge_logs: false` — otherwise N workers would
   * produce N× the requested output.
   */
  logs(params) {
    const id = resolveOne(params.target, params.namespace, params.cwd);
    const record = supervisor.records.get(id);
    const lines = params.lines === undefined ? 20 : Number(params.lines);
    const files = supervisor.logFiles(record);
    const perFile = files.length > 1 ? Math.max(1, Math.floor(lines / files.length)) : lines;

    const result = { id, name: record.name, lines: [] };
    for (const file of files) {
      if (params.which !== 'err') {
        for (const line of readTail(file.out, perFile)) result.lines.push({ id, slot: file.slot, which: 'out', line });
      }
      if (params.which !== 'out') {
        for (const line of readTail(file.err, perFile)) result.lines.push({ id, slot: file.slot, which: 'err', line });
      }
    }
    return result;
  },

  /** Persist the current list so `resurrect` can replay it. */
  save() {
    const dump = supervisor.dump();
    fs.writeFileSync(p.dumpFile, JSON.stringify(dump, null, 2));
    return { file: p.dumpFile, apps: dump.apps.length };
  },

  /**
   * Start everything from the dump file (a no-op when there is none).
   * Apps the daemon already knows are skipped, so resurrect is idempotent
   * instead of silently duplicating the list.
   */
  async resurrect() {
    if (!fs.existsSync(p.dumpFile)) return { file: p.dumpFile, apps: [], skipped: [], failed: [] };
    let dump;
    try {
      dump = JSON.parse(fs.readFileSync(p.dumpFile, 'utf8'));
    } catch (err) {
      const e = new Error(`cannot read ${p.dumpFile}: ${err.message}`);
      e.code = 'BAD_DUMP';
      throw e;
    }
    const started = [];
    const skipped = [];
    const failed = [];
    for (const app of dump.apps || []) {
      if (supervisor.resolve(app.name, app.namespace).length) {
        skipped.push(app.name);
        continue;
      }
      // `start` is async: awaiting it is what makes the returned records real
      // (instead of promises serialised as {}) and what turns a failure into a
      // reported `failed` entry instead of an unhandled rejection at boot.
      try { started.push(await supervisor.start(app)); }
      catch (err) {
        failed.push({ name: app.name, error: err.message });
        debug('resurrect %s failed: %s', app.name, err.message);
      }
    }
    return { file: p.dumpFile, apps: started, skipped, failed };
  },

  /** Everything, in one payload — used by the dashboard. */
  overview() {
    return { processes: supervisor.list(), home: p.home };
  },

  /** Start (or restart) the loopback-only dashboard. */
  async web(params) {
    const auth = params.auth === true ? 'on' : params.auth === false ? 'off' : 'auto';
    // Validate before tearing the current dashboard down: a bad flag should not
    // leave the user with no dashboard at all.
    if (auth === 'on') {
      const { Users } = require('./users');
      const count = new Users(require('./paths').paths().usersFile).count();
      if (count === 0) {
        throw new Error('--auth was requested but no users exist; create one with: procman user add <name>');
      }
    }
    if (dashboard) {
      await dashboard.close();
      dashboard = null;
    }
    const port = Number.isInteger(params.port) ? params.port : 9615;
    const host = params.host || '127.0.0.1';
    const outside = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
    const instance = createDashboard(supervisor, { port, host, auth });
    const url = await instance.listen();
    dashboard = instance;
    const users = instance.userCount();
    const protectedNow = auth === 'on' || (auth === 'auto' && users > 0);
    let warning = null;
    if (!protectedNow) {
      warning = outside
        ? `the dashboard has NO authentication and is bound to ${host}; anyone who can reach that address can stop your processes`
        : 'no users yet, so the dashboard needs no login (loopback only); create one with: procman user add <name>';
    } else if (outside) {
      warning = `the dashboard requires a login but is bound to ${host}; make sure the network path to it is trusted`;
    }
    debug('dashboard listening on %s (auth=%s, users=%d)', url, auth, users);
    return { url, host, port, auth, users, protected: protectedNow, warning };
  },

  async webStop() {
    if (!dashboard) return { stopped: false };
    await dashboard.close();
    dashboard = null;
    return { stopped: true };
  },

  webStatus() {
    return { running: !!dashboard, url: dashboard ? dashboard.url : null };
  },

  async killMe() {
    setImmediate(shutdown);
    return { success: true };
  }
};

function resolveOne(target, namespace, cwd) {
  const ids = supervisor.resolve(target, namespace, cwd);
  if (!ids.length) {
    const err = new Error(`no process matches "${target}"`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (ids.length > 1) {
    const err = new Error(`"${target}" matches ${ids.length} processes; be more specific`);
    err.code = 'AMBIGUOUS';
    throw err;
  }
  return ids[0];
}

async function act(params, fn) {
  const ids = supervisor.resolve(params.target, params.namespace, params.cwd);
  if (!ids.length) {
    const err = new Error(`no process matches "${params.target}"`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const results = [];
  for (const id of ids) results.push(await fn(id));
  return results;
}

// ---------------------------------------------------------------- serving --

const server = net.createServer((socket) => {
  socket.on('error', (err) => debug('socket error: %s', err.message));
  socket.on('close', () => subscribers.delete(socket));

  protocol.createDecoder(socket, async (request) => {
    const id = request && request.id;
    const method = request && request.method;

    // Subscriptions keep the connection open and turn it into an event stream.
    if (method === 'subscribe') {
      const params = request.params || {};
      const ids = params.target ? supervisor.resolve(params.target, params.namespace, params.cwd) : null;
      if (params.target && (!ids || !ids.length)) {
        socket.write(protocol.encode(protocol.fail(id, `no process matches "${params.target}"`, 'NOT_FOUND')));
        return;
      }
      subscribers.set(socket, {
        ids: ids ? new Set(ids) : null,
        kinds: new Set(params.kinds && params.kinds.length ? params.kinds : ['log', 'state'])
      });
      socket.write(protocol.encode(protocol.ok(id, { subscribed: true, ids })));
      debug('subscriber added (%d total)', subscribers.size);
      return;
    }

    try {
      const handler = methods[method];
      if (!handler) throw Object.assign(new Error(`unknown method "${method}"`), { code: 'UNKNOWN_METHOD' });
      const result = await handler(request.params || {});
      socket.write(protocol.encode(protocol.ok(id, result)));
    } catch (err) {
      debug('method %s failed: %s', method, err.message);
      socket.write(protocol.encode(protocol.fail(id, err.message, err.code)));
    }
  }, (err) => debug('%s', err.message));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another daemon already owns this endpoint. Do not fight over it and do
    // not touch its pid file: just leave quietly, the client will talk to it.
    console.error(`[procman] ${p.socket} is already owned by another daemon; exiting`);
    process.exit(EXIT_CODES.SUCCESS);
  }
  console.error('[procman] daemon server error:', err.stack || err.message);
  process.exit(EXIT_CODES.ERROR);
});

server.listen(p.socket, () => {
  try { fs.chmodSync(p.socket, 0o775); } catch (err) { debug('chmod failed: %s', err.message); }
  try {
    fs.writeFileSync(p.pidFile, String(process.pid));
    debug('daemon listening on %s pid=%d', p.socket, process.pid);
  } catch (err) {
    console.error('[procman] cannot write pid file:', err.message);
  }
});

// --------------------------------------------------------------- shutdown --

function isOurPidFile() {
  try {
    return Number(fs.readFileSync(p.pidFile, 'utf8').trim()) === process.pid;
  } catch (err) {
    return false;
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  debug('shutting down');
  try {
    await supervisor.stopAll();
  } catch (err) {
    console.error('[procman] error while stopping processes:', err.message);
  }
  for (const socket of subscribers.keys()) {
    try { socket.destroy(); } catch (err) { /* ignore */ }
  }
  subscribers.clear();
  if (dashboard) {
    try { await dashboard.close(); } catch (err) { /* ignore */ }
    dashboard = null;
  }
  server.close(() => {
    try { if (!p.isWindows) fs.unlinkSync(p.socket); } catch (err) { /* ignore */ }
    try { if (isOurPidFile()) fs.unlinkSync(p.pidFile); } catch (err) { /* ignore */ }
    process.exit(EXIT_CODES.SUCCESS);
  });
  // Hard stop if the event loop refuses to drain. unref() so it never keeps us
  // alive on its own: another handle must be holding us up.
  setTimeout(() => {
    debug('shutdown: forcing exit');
    process.exit(EXIT_CODES.SUCCESS);
  }, 5000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
  process.on(sig, () => { debug('received %s', sig); shutdown(); });
}

process.on('uncaughtException', (err) => {
  console.error('[procman] daemon uncaught exception:', err.stack || err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('[procman] daemon unhandled rejection:', err && err.stack ? err.stack : err);
});

debug('daemon starting pid=%d', process.pid);
