'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const cluster = require('cluster');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const { STATUS, MODE, DEFAULTS } = require('./constants');
const { paths } = require('./paths');
const { LogStream } = require('./logs');
const { Watcher } = require('./watch');
const { CronRunner } = require('./cron');
const { Sampler, parseMemory } = require('./monitor');
const { treeKill } = require('./treekill');
const debug = require('./debug')('supervisor');

const CONTAINER = path.join(__dirname, 'container.js');

const isWindows = process.platform === 'win32';

/**
 * Owns the in-memory process table and every lifecycle transition.
 *
 * Design notes (kept intentionally close to the reference implementation so
 * the behavior is familiar):
 *  - fork-mode processes are spawned detached, in their own process group, so
 *    the whole tree can be signalled with process.kill(-pid)
 *  - cluster mode uses node:cluster, which makes THIS process the primary and
 *    gives us round-robin load balancing for free; those workers are children
 *    of the daemon, so their trees are killed by walking /proc
 *  - stdout/stderr are piped to the daemon, which writes them to files and
 *    republishes complete lines on the bus (that is what makes `logs` work)
 *  - one log file per application, shared by every instance, like the original
 *  - the restart policy lives in _onWorkerExit
 */
class Supervisor extends EventEmitter {
  constructor() {
    super();
    this.records = new Map();     // id -> record
    this.nextId = 0;
    this.beingKilled = false;
    this.clusterEntries = new Map(); // cluster worker id -> entry
    this.sampler = new Sampler();
    this.monitorTimer = null;
    this._installClusterListeners();
  }

  _installClusterListeners() {
    cluster.on('exit', (worker, code, signal) => {
      const entry = this.clusterEntries.get(worker.id);
      if (!entry) return;
      this.clusterEntries.delete(worker.id);
      this._onWorkerExit(entry.record, entry, code, signal);
    });
  }

  // ---------------------------------------------------------------- start --

  async start(opts) {
    if (this.beingKilled) {
      const err = new Error('the daemon is shutting down');
      err.code = 'SHUTTING_DOWN';
      throw err;
    }
    const record = this._buildRecord(opts);
    this.records.set(record.id, record);
    this._ensureLog(record, 0);
    this._fill(record);
    this._ensureWatcher(record);
    this._ensureCron(record);
    this._ensureMonitor();
    this._refreshStatus(record);
    // `--wait-ready` makes start block until every worker has announced itself
    // (either by calling listen(), or by sending 'ready' over IPC), so a script
    // can start an app and immediately use it.
    if (record.wait_ready && record.workers.length) {
      await Promise.all(record.workers.map((entry) => this._waitReady(entry, record.listen_timeout)));
      this._refreshStatus(record);
    }
    debug('started id=%d name=%s mode=%s instances=%d', record.id, record.name, record.mode, record.instances);
    return this.format(record);
  }

  _buildRecord(opts) {
    const script = path.resolve(opts.script);
    if (!fs.existsSync(script)) {
      const err = new Error(`Script not found: ${script}`);
      err.code = 'SCRIPT_NOT_FOUND';
      throw err;
    }

    const id = this.nextId++;
    const name = opts.name || path.basename(script).replace(/\.[^.]+$/, '');
    const p = paths();
    const base = `${id}-${sanitize(name)}`;

    let mode = opts.mode === MODE.CLUSTER ? MODE.CLUSTER : MODE.FORK;
    if (mode === MODE.CLUSTER && !/node(\.exe)?$/i.test(path.basename(opts.interpreter || process.execPath))) {
      // cluster mode only works with Node's own cluster module
      mode = MODE.FORK;
    }

    let instances = Number(opts.instances);
    if (!Number.isInteger(instances) || instances <= 0) {
      // 0 (or garbage) means "one per CPU", like the original
      instances = mode === MODE.CLUSTER ? (opts.instances === 0 ? os.cpus().length : DEFAULTS.INSTANCES) : 1;
    }
    if (mode === MODE.FORK) instances = 1;

    let cron = null;
    if (opts.cron) {
      const { CronSchedule } = require('./cron');
      new CronSchedule(opts.cron); // validate now, so `start` fails loudly
      cron = opts.cron;
    }

    const maxMemory = parseMemory(opts.maxMemoryRestart);

    return {
      id,
      name,
      namespace: opts.namespace || DEFAULTS.NAMESPACE,
      script,
      args: Array.isArray(opts.args) ? opts.args.map(String) : [],
      cwd: path.resolve(opts.cwd || process.cwd()),
      interpreter: opts.interpreter || process.execPath,
      env: opts.env || {},
      mode,
      instances,

      // restart policy
      min_uptime: int(opts.minUptime, DEFAULTS.MIN_UPTIME),
      max_restarts: int(opts.maxRestarts, DEFAULTS.MAX_RESTARTS),
      restart_delay: int(opts.restartDelay, DEFAULTS.RESTART_DELAY),
      kill_timeout: int(opts.killTimeout, DEFAULTS.KILL_TIMEOUT),
      listen_timeout: int(opts.listenTimeout, DEFAULTS.LISTEN_TIMEOUT),
      autorestart: opts.autorestart !== false,
      stop_exit_codes: (opts.stopExitCodes || []).map(Number),
      cron,
      max_memory_restart: maxMemory,
      watch: !!opts.watch,
      watchPaths: (opts.watchPaths && opts.watchPaths.length ? opts.watchPaths : [script]).map((w) => path.resolve(w)),
      ignoreWatch: opts.ignoreWatch || [],
      time: !!opts.time,
      dateFormat: opts.dateFormat || null,
      mergeLogs: opts.mergeLogs !== false,
      wait_ready: !!opts.waitReady,
      rotation: logRotation(opts),

      // runtime state
      workers: [],
      status: STATUS.LAUNCHING,
      restarts: 0,
      unstable_restarts: 0,
      exit_code: null,
      created_at: Date.now(),
      started_at: null,
      restartTimer: null,
      watcher: null,
      cronRunner: null,
      monit: { cpu: null, memory: null },
      lastLimitRestartAt: 0,
      logs: new Map(),          // key '*' when merged, otherwise the worker slot
      outPath: opts.output || path.join(p.logsDir, `${base}-out.log`),
      errPath: opts.error || path.join(p.logsDir, `${base}-err.log`),
      pidPath: path.join(p.pidsDir, `${base}.pid`)
    };
  }

  /** Bring the record up to its desired number of workers. */
  _fill(record) {
    if (!this.records.has(record.id) || this.beingKilled) return;
    if (record.mode === MODE.CLUSTER) {
      for (let slot = 0; slot < record.instances; slot++) {
        if (!record.workers.some((w) => w.slot === slot)) this._spawnOne(record, slot);
      }
    } else if (record.workers.length === 0) {
      this._spawnOne(record, 0);
    }
    if (!record.started_at) record.started_at = Date.now();
    this._refreshStatus(record);
  }

  _spawnOne(record, slot) {
    this._ensureLog(record, slot);
    if (record.mode === MODE.CLUSTER) return this._forkCluster(record, slot);
    return this._spawnFork(record, slot);
  }

  _appEnv(record, slot) {
    const p = paths();
    const files = this._logPaths(record, slot);
    return Object.assign(
      {},
      sanitizeEnv(record.env),
      {
        PROC_APP_ID: String(record.id),
        PROC_APP_NAME: record.name,
        PROC_NAMESPACE: record.namespace,
        PROC_MODE: record.mode,
        PROC_INSTANCE: String(slot),
        // The ecosystem convention most PM2 apps already read.
        NODE_APP_INSTANCE: String(slot),
        PROC_SCRIPT: record.script,
        PROC_ARGS: JSON.stringify(record.args),
        PROC_CWD: record.cwd,
        PROC_TITLE: `${record.name} (${record.mode})`,
        PROC_OUT: files.out,
        PROC_ERR: files.err,
        PROC_PIDFILE: record.pidPath,
        PROC_DAEMON_PID: String(process.pid),
        PROC_HOME: p.home
      }
    );
  }

  _spawnFork(record, slot) {
    const entry = { record, slot, kind: MODE.FORK, pid: 0, stopping: false, ready: false, started_at: Date.now(), node_version: null };
    let child;
    try {
      child = spawn(record.interpreter, [CONTAINER, record.script, ...record.args], {
        cwd: record.cwd,
        detached: true,               // own process group => tree kill works
        windowsHide: true,
        env: Object.assign({}, process.env, this._appEnv(record, slot)),
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });
    } catch (err) {
      this._failSpawn(record, err);
      return null;
    }
    entry.child = child;
    entry.pid = child.pid;
    this._attachEntry(record, entry, child.stdout, child.stderr);
    child.on('message', (msg) => this._onWorkerMessage(entry, msg));
    child.once('error', (err) => {
      this._log(record, entry, 'err', `[procman] spawn error: ${err.message}\n`);
      this._onWorkerExit(record, entry, 1, null);
    });
    child.once('exit', (code, signal) => this._onWorkerExit(record, entry, code, signal || null));
    this._registerEntry(record, entry);
    return entry;
  }

  _forkCluster(record, slot) {
    cluster.setupPrimary({
      exec: CONTAINER,
      args: [],
      silent: true,        // gives us worker.process.stdout/stderr pipes
      windowsHide: true
    });

    let worker;
    try {
      worker = cluster.fork(this._appEnv(record, slot));
    } catch (err) {
      this._failSpawn(record, err);
      return null;
    }

    const entry = {
      record, slot, kind: MODE.CLUSTER, worker, pid: worker.process.pid,
      stopping: false, ready: false, started_at: Date.now(), node_version: null
    };
    this.clusterEntries.set(worker.id, entry);
    worker.on('listening', () => { entry.ready = true; });
    worker.on('message', (msg) => this._onWorkerMessage(entry, msg));
    this._attachEntry(record, entry, worker.process.stdout, worker.process.stderr);
    this._registerEntry(record, entry);
    return entry;
  }

  _attachEntry(record, entry, stdout, stderr) {
    if (stdout) stdout.on('data', (chunk) => this._log(record, entry, 'out', chunk));
    if (stderr) stderr.on('data', (chunk) => this._log(record, entry, 'err', chunk));
    entry.stdout = stdout;
    entry.stderr = stderr;
  }

  _registerEntry(record, entry) {
    record.workers.push(entry);
    this._writePidFile(record);
    this._refreshStatus(record);
    debug('id=%d slot=%d pid=%d up (mode=%s)', record.id, entry.slot, entry.pid, record.mode);
  }

  _onWorkerMessage(entry, msg) {
    if (!msg) return;
    if (typeof msg === 'object' && 'node_version' in msg) {
      entry.node_version = msg.node_version;
      return;
    }
    // The app can declare itself ready: `if (process.send) process.send('ready')`.
    // That is what `--wait-ready` and zero-downtime reload key off.
    if (msg === 'ready' || msg.ready === true) {
      entry.ready = true;
      if (entry.record) {
        entry.record.ready = true;
        this._emitState(entry.record);
      }
    }
  }

  _failSpawn(record, err) {
    this._log(record, null, 'err', `[procman] cannot start: ${err.message}\n`);
    record.status = STATUS.ERRORED;
    this._emitState(record);
  }

  // ----------------------------------------------------------------- exit --

  /**
   * Central restart policy. Mirrors the reference semantics:
   *  - explicit stop / autorestart=false / stop_exit_codes => do not restart
   *  - too many unstable restarts within min_uptime*max_restarts => errored
   */
  _onWorkerExit(record, entry, code, signal) {
    if (!record) return;
    const index = record.workers.indexOf(entry);
    if (index !== -1) record.workers.splice(index, 1);
    if (entry.stdout) entry.stdout.removeAllListeners();
    if (entry.stderr) entry.stderr.removeAllListeners();
    this.sampler.forget(entry.pid);
    this._writePidFile(record);

    if (entry.stopping || this.beingKilled || !this.records.has(record.id) || record.status === STATUS.STOPPING) {
      if (this.records.has(record.id) && record.workers.length === 0 && record.status === STATUS.STOPPING) {
        record.status = STATUS.STOPPED;
      }
      this._refreshStatus(record);
      return;
    }

    record.exit_code = code;

    const stopping =
      record.autorestart === false ||
      record.stop_exit_codes.includes(Number(code));

    const lifetime = Date.now() - entry.started_at;
    if (Date.now() - record.created_at < record.min_uptime * record.max_restarts && lifetime < record.min_uptime) {
      record.unstable_restarts += 1;
    }

    if (record.unstable_restarts >= record.max_restarts) {
      record.unstable_restarts = 0;
      record.created_at = null;
      record.status = STATUS.ERRORED;
      debug('id=%d exceeded max_restarts, marked errored', record.id);
      this._emitState(record);
      return;
    }

    if (stopping) {
      this._refreshStatus(record);
      return;
    }

    this._scheduleRestart(record);
  }

  _scheduleRestart(record) {
    if (record.restartTimer) return;
    const backoff = record.unstable_restarts > 0
      ? Math.min(DEFAULTS.BACKOFF_STEP * record.unstable_restarts, DEFAULTS.BACKOFF_MAX)
      : 0;
    const delay = Math.max(record.restart_delay || 0, backoff);
    record.status = STATUS.WAITING_RESTART;
    this._emitState(record);
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null;
      record.restarts += 1;   // one restart event, however many workers it brings back
      this._fill(record);
    }, delay);
    if (record.restartTimer.unref) record.restartTimer.unref();
  }

  // ----------------------------------------------------------------- stop --

  async stop(id) {
    const record = this._require(id);
    await this._stopRecord(record);
    return this.format(record);
  }

  async _stopRecord(record) {
    clearTimeout(record.restartTimer);
    record.restartTimer = null;
    record.status = STATUS.STOPPING;
    this._emitState(record);
    for (const entry of [...record.workers]) await this._killEntry(record, entry);
    record.workers = [];
    this._writePidFile(record);
    record.exit_code = 0;
    record.status = STATUS.STOPPED;
    this._emitState(record);
  }

  async _killEntry(record, entry) {
    entry.stopping = true;
    if (!entry.pid) {
      this._forgetEntry(record, entry);
      return;
    }

    // Cluster workers get the graceful path first: disconnect() removes the
    // worker from the round-robin pool, so the primary stops handing it NEW
    // connections while the ones already accepted finish. Signalling directly
    // would reset connections that were just routed to it.
    if (entry.kind === MODE.CLUSTER && entry.worker && typeof entry.worker.disconnect === 'function' && !entry.worker.isDead()) {
      try {
        const maybe = entry.worker.disconnect();
        if (maybe && typeof maybe.catch === 'function') maybe.catch(() => {});
      } catch (err) {
        debug('disconnect failed for pid=%d: %s', entry.pid, err.message);
      }
      if (await this._waitForDeath(entry.pid, record.kill_timeout)) {
        this._forgetEntry(record, entry);
        return;
      }
    }

    this._signalEntry(entry, DEFAULTS.KILL_SIGNAL);
    if (!await this._waitForDeath(entry.pid, record.kill_timeout)) {
      debug('pid=%d still alive after %dms, sending SIGKILL', entry.pid, record.kill_timeout);
      this._signalEntry(entry, 'SIGKILL');
      await this._waitForDeath(entry.pid, 2000);
    }
    this._forgetEntry(record, entry);
  }

  _forgetEntry(record, entry) {
    const index = record.workers.indexOf(entry);
    if (index !== -1) record.workers.splice(index, 1);
    if (entry.worker && this.clusterEntries.has(entry.worker.id)) {
      this.clusterEntries.delete(entry.worker.id);
    }
  }

  _signalEntry(entry, signal) {
    if (!entry.pid) return;
    if (entry.kind === MODE.FORK && !isWindows) {
      // negative pid == process group: covers detached children
      try { process.kill(-entry.pid, signal); return; } catch (err) { /* fall through */ }
    }
    treeKill(entry.pid, signal);
  }

  _waitForDeath(pid, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (!alive(pid)) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        const timer = setTimeout(tick, DEFAULTS.KILL_RETRY_TIME);
        if (timer.unref) timer.unref();
      };
      tick();
    });
  }

  async restart(id) {
    const record = this._require(id);
    await this._stopRecord(record);
    record.restarts += 1;
    record.unstable_restarts = 0;
    record.created_at = Date.now();
    record.started_at = Date.now();
    this._fill(record);
    return this.format(record);
  }

  /**
   * Zero-downtime reload for cluster mode: start a replacement first, wait for
   * it to be accepting connections, then retire the old worker. Fork mode has
   * nothing to overlap with, so it degrades to restart.
   */
  async reload(id) {
    const record = this._require(id);
    if (record.mode !== MODE.CLUSTER || record.instances <= 1) return this.restart(id);

    const slots = record.workers.map((w) => w.slot);
    for (const slot of slots) {
      const old = record.workers.find((w) => w.slot === slot);
      const fresh = this._spawnOne(record, slot);
      if (fresh) await this._waitReady(fresh, record.listen_timeout);
      if (old) await this._killEntry(record, old);
      record.restarts += 1;
      this._refreshStatus(record);
    }
    return this.format(record);
  }

  /**
   * Wait until a worker is ready, or give up after `timeoutMs`.
   *
   * Two readiness signals, because they mean different things:
   *  - `listening` (cluster): the app is accepting connections
   *  - a `ready` message (either mode): the app said so itself
   * A worker that exits while we wait resolves false immediately.
   */
  _waitReady(entry, timeoutMs) {
    return new Promise((resolve) => {
      if (entry.ready) return resolve(true);
      const target = entry.worker || entry.child;
      if (!target || typeof target.on !== 'function') return resolve(true);

      let settled = false;
      const timer = setTimeout(() => finish(false), timeoutMs);
      if (timer.unref) timer.unref();

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.removeListener('listening', onReady);
        target.removeListener('message', onMessage);
        target.removeListener('exit', onExit);
        resolve(value);
      };
      const onReady = () => finish(true);
      const onMessage = (msg) => { if (msg === 'ready' || (msg && msg.ready === true)) finish(true); };
      const onExit = () => finish(false);

      target.on('listening', onReady);
      target.on('message', onMessage);
      target.on('exit', onExit);
    });
  }

  /** Grow or shrink a cluster app. */
  scale(id, instances) {
    const record = this._require(id);
    if (record.mode !== MODE.CLUSTER) {
      const err = new Error(`${record.name} is not in cluster mode`);
      err.code = 'NOT_CLUSTER';
      throw err;
    }
    const target = instances === 0 ? os.cpus().length : int(instances, record.instances);
    if (target < 1) throw new Error('instances must be >= 1 (or 0 for "one per CPU")');
    record.instances = target;
    this._fill(record);
    // retire the extra slots
    for (const entry of [...record.workers]) {
      if (entry.slot >= target) this._killEntry(record, entry);
    }
    this._refreshStatus(record);
    return this.format(record);
  }

  async delete(id) {
    const record = this._require(id);
    await this._stopRecord(record);
    this._teardownExtras(record);
    for (const log of record.logs.values()) log.close();
    record.logs.clear();
    this.records.delete(record.id);
    if (this.records.size === 0) this.nextId = 0;
    return { id, name: record.name, deleted: true };
  }

  async stopAll() {
    this.beingKilled = true;
    const results = [];
    for (const id of [...this.records.keys()]) {
      try { results.push(await this.stop(id)); }
      catch (err) { debug('stopAll id=%d failed: %s', id, err.message); }
    }
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    return results;
  }

  // -------------------------------------------------------------- extras ----

  /** Log file paths for one slot (or for the single merged file). */
  _logPaths(record, slot) {
    if (record.mergeLogs) return { out: record.outPath, err: record.errPath };
    return { out: withSlot(record.outPath, slot), err: withSlot(record.errPath, slot) };
  }

  /**
   * One LogStream per app when logs are merged (the default), or one per worker
   * slot when `merge_logs: false` — the only way to tell N cluster workers
   * apart in a file.
   */
  _ensureLog(record, slot = 0) {
    const key = record.mergeLogs ? '*' : slot;
    const existing = record.logs.get(key);
    if (existing && !existing.closed) return existing;

    const files = this._logPaths(record, slot);
    const log = new LogStream({
      id: record.id,
      name: record.name,
      outPath: files.out,
      errPath: files.err,
      time: record.time,
      dateFormat: record.dateFormat,
      bus: this,
      rotation: record.rotation
    });
    record.logs.set(key, log);
    return log;
  }

  _log(record, entry, which, chunk) {
    this._ensureLog(record, entry ? entry.slot : 0).write(which, chunk);
  }

  /** Where this app's logs live — used by `logs` and the dashboard. */
  logFiles(record) {
    if (record.mergeLogs) {
      return [{ slot: null, out: record.outPath, err: record.errPath }];
    }
    return [...record.logs.keys()]
      .sort((a, b) => a - b)
      .map((slot) => ({ slot, out: withSlot(record.outPath, slot), err: withSlot(record.errPath, slot) }));
  }

  _ensureWatcher(record) {
    if (!record.watch || record.watcher) return;
    record.watcher = new Watcher(record.watchPaths, (changed) => {
      this.emit('watch', { id: record.id, name: record.name, changed });
      debug('id=%d watch triggered by %s', record.id, changed.slice(0, 3).join(', '));
      if (record.mode === MODE.CLUSTER) this.reload(record.id).catch((err) => debug('watch reload failed: %s', err.message));
      else this.restart(record.id).catch((err) => debug('watch restart failed: %s', err.message));
    }, { ignore: record.ignoreWatch }).start();
  }

  _ensureCron(record) {
    if (!record.cron || record.cronRunner) return;
    record.cronRunner = new CronRunner(record.cron, () => {
      this.emit('cron', { id: record.id, name: record.name, cron: record.cron });
      debug('id=%d cron %s fired', record.id, record.cron);
      if (record.mode === MODE.CLUSTER) this.reload(record.id).catch((err) => debug('cron reload failed: %s', err.message));
      else this.restart(record.id).catch((err) => debug('cron restart failed: %s', err.message));
    }).start();
  }

  _teardownExtras(record) {
    if (record.watcher) { record.watcher.close(); record.watcher = null; }
    if (record.cronRunner) { record.cronRunner.stop(); record.cronRunner = null; }
  }

  _writePidFile(record) {
    try {
      if (record.workers.length === 0) {
        if (fs.existsSync(record.pidPath)) fs.unlinkSync(record.pidPath);
        return;
      }
      fs.writeFileSync(record.pidPath, record.workers.map((w) => w.pid).join('\n') + '\n');
    } catch (err) {
      debug('pid file write failed: %s', err.message);
    }
  }

  // ------------------------------------------------------------- monitor ---

  _ensureMonitor() {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => this._monitorTick(), DEFAULTS.MONITOR_INTERVAL);
    if (this.monitorTimer.unref) this.monitorTimer.unref();
  }

  _monitorTick() {
    for (const record of this.records.values()) {
      let memory = 0;
      let cpu = null;
      for (const entry of record.workers) {
        const sample = this.sampler.sample(entry.pid);
        if (typeof sample.memory === 'number') memory += sample.memory;
        if (sample.cpu !== null) cpu = (cpu || 0) + sample.cpu;
      }
      record.monit = {
        cpu: record.workers.length ? cpu : null,
        memory: record.workers.length ? memory : null
      };

      const limit = record.max_memory_restart;
      if (limit && record.workers.length && memory > limit && Date.now() - record.lastLimitRestartAt > 10000) {
        record.lastLimitRestartAt = Date.now();
        this.emit('overlimit', { id: record.id, name: record.name, memory, limit });
        debug('id=%d over memory limit (%d > %d), restarting', record.id, memory, limit);
        const action = record.mode === MODE.CLUSTER ? this.reload(record.id) : this.restart(record.id);
        action.catch((err) => debug('limit restart failed: %s', err.message));
      }
    }
  }

  // --------------------------------------------------------------- views ---

  _refreshStatus(record) {
    const previous = record.status;
    if (record.workers.length > 0) record.status = STATUS.ONLINE;
    else if (record.status !== STATUS.ERRORED && record.status !== STATUS.STOPPING && record.status !== STATUS.WAITING_RESTART) {
      record.status = STATUS.STOPPED;
    }
    if (previous !== record.status || record.workers.length) this._emitState(record);
  }

  _emitState(record) {
    this.emit('state', this.format(record));
  }

  list() {
    return [...this.records.values()].map((r) => this.format(r));
  }

  format(record) {
    const online = record.workers.filter((w) => !w.stopping);
    const pids = online.map((w) => w.pid);
    const files = this.logFiles(record);
    return {
      id: record.id,
      name: record.name,
      namespace: record.namespace,
      mode: record.mode,
      instances: online.length,
      pids,
      // `pid` stays a single scalar for the table: a number when there is one
      // worker, a comma-joined string for the rest, 0 when none are running.
      pid: pids.length === 0 ? 0 : (pids.length === 1 ? pids[0] : pids.join(',')),
      status: record.status,
      restarts: record.restarts,
      unstable_restarts: record.unstable_restarts,
      exit_code: record.exit_code,
      uptime_ms: record.status === STATUS.ONLINE && record.started_at ? Date.now() - record.started_at : 0,
      cpu: record.monit.cpu,
      memory: record.monit.memory,
      max_memory_restart: record.max_memory_restart,
      watch: record.watch,
      cron: record.cron,
      autorestart: record.autorestart,
      script: record.script,
      cwd: record.cwd,
      ready: !!record.ready,
      merge_logs: record.mergeLogs,
      // `out_log`/`err_log` are the paths to show the user; `log_files` is the
      // authoritative list (it has one entry per instance with merge_logs off).
      out_log: files[0].out,
      err_log: files[0].err,
      log_files: files
    };
  }

  describe(id) {
    const record = this._require(id);
    return Object.assign(this.format(record), {
      args: record.args,
      interpreter: record.interpreter,
      node_version: record.workers.map((w) => w.node_version).find(Boolean) || null,
      min_uptime: record.min_uptime,
      max_restarts: record.max_restarts,
      restart_delay: record.restart_delay,
      kill_timeout: record.kill_timeout,
      listen_timeout: record.listen_timeout,
      stop_exit_codes: record.stop_exit_codes,
      created_at: record.created_at,
      watch_paths: record.watchPaths,
      ignore_watch: record.ignoreWatch,
      time_prefix: record.time,
      log_date_format: record.dateFormat,
      log_rotate: record.rotation,
      merge_logs: record.mergeLogs,
      wait_ready: record.wait_ready,
      env_keys: Object.keys(record.env),
      log_file: { out: record.outPath, err: record.errPath },
      log_files: this.logFiles(record)
    });
  }

  // ------------------------------------------------------------- resolve ---

  /**
   * Resolve "all", a numeric id, a name, "namespace:name", or a script path to
   * a list of ids.
   *
   * `cwd` is the CALLER's working directory: the daemon runs with cwd = the
   * state home, so resolving a relative path against its own cwd would never
   * match what the user typed.
   */
  resolve(target, namespace, cwd) {
    const all = [...this.records.values()];
    const scoped = namespace ? all.filter((r) => r.namespace === namespace) : all;

    if (target === undefined || target === null) return [];
    if (target === 'all') return scoped.map((r) => r.id);

    if (typeof target === 'string' && target.includes(':')) {
      const [ns, name] = target.split(':', 2);
      return all.filter((r) => r.namespace === ns && r.name === name).map((r) => r.id);
    }

    const asNumber = Number(target);
    if (Number.isInteger(asNumber) && this.records.has(asNumber)) return [asNumber];

    const byName = scoped.filter((r) => r.name === target).map((r) => r.id);
    if (byName.length) return byName;

    const asPath = path.resolve(cwd || process.cwd(), String(target));
    return scoped.filter((r) => r.script === asPath).map((r) => r.id);
  }

  _require(id) {
    const record = this.records.get(id);
    if (!record) {
      const err = new Error(`process ${id} not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return record;
  }

  // -------------------------------------------------------- dump/restore ---

  /** Serializable snapshot of everything needed to bring the list back. */
  dump() {
    return {
      created_at: Date.now(),
      apps: [...this.records.values()].map((record) => ({
        name: record.name,
        namespace: record.namespace,
        script: record.script,
        args: record.args,
        cwd: record.cwd,
        interpreter: record.interpreter,
        env: record.env,
        mode: record.mode,
        instances: record.instances,
        minUptime: record.min_uptime,
        maxRestarts: record.max_restarts,
        restartDelay: record.restart_delay,
        killTimeout: record.kill_timeout,
        listenTimeout: record.listen_timeout,
        autorestart: record.autorestart,
        stopExitCodes: record.stop_exit_codes,
        watch: record.watch,
        watchPaths: record.watchPaths,
        ignoreWatch: record.ignoreWatch,
        cron: record.cron,
        maxMemoryRestart: record.max_memory_restart,
        time: record.time,
        dateFormat: record.dateFormat,
        mergeLogs: record.mergeLogs,
        waitReady: record.wait_ready,
        logRotateSize: record.rotation ? record.rotation.size : null,
        logRotateKeep: record.rotation ? record.rotation.keep : null,
        logRotateCompress: record.rotation ? record.rotation.compress : false,
        output: record.outPath,
        error: record.errPath
      }))
    };
  }
}

// ------------------------------------------------------------------ utils --

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function withSlot(file, slot) {
  return /\.log$/.test(file) ? file.replace(/\.log$/, `-${slot}.log`) : `${file}-${slot}`;
}

/** Rotation is opt-in; without a size there is nothing to rotate. */
function logRotation(opts) {
  const size = parseMemory(opts.logRotateSize);
  if (!size || size <= 0) return null;
  return {
    size,
    keep: int(opts.logRotateKeep, DEFAULTS.LOG_ROTATE_KEEP),
    compress: !!opts.logRotateCompress
  };
}

function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
}

function int(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** child_process and cluster.fork want strings; drop undefined/null. */
function sanitizeEnv(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

module.exports = { Supervisor, alive, sanitizeEnv, CONTAINER };
