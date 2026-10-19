'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { paths, ensureDirs } = require('./paths');
const protocol = require('./protocol');
const debug = require('./debug')('client');

const DAEMON_ENTRY = path.join(__dirname, 'daemon.js');

/** By default we give the daemon a generous budget before calling it dead. */
const PROBE_TIMEOUT = 5000;

class NotConnected extends Error {
  constructor(message) {
    super(message);
    this.code = 'NOT_CONNECTED';
  }
}

/**
 * One request per connection: connect, write a frame, read one frame, close.
 * All state lives in the daemon, never in the client.
 */
function send(socketPath, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(() => finish(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);

    socket.on('error', (err) => finish(err));
    socket.on('connect', () => {
      socket.write(protocol.encode({ id: Date.now(), method, params: params || {} }));
    });

    protocol.createDecoder(socket, (message) => {
      if (message.ok) return finish(null, message.result);
      const err = new Error(message.error && message.error.message);
      err.code = message.error && message.error.code;
      finish(err);
    }, (err) => finish(err));
  });
}

/**
 * Probe the endpoint before deciding anything.
 *
 * The important distinction is 'busy' vs 'dead': a daemon that fails to answer
 * within the timeout is NOT dead, and treating it as dead would let a second
 * daemon steal its socket and leave the first one unreachable forever.
 *
 *   'alive' - answered a ping
 *   'dead'  - no listener (ENOENT / ECONNREFUSED / connection reset)
 *   'busy'  - something is listening but did not answer in time
 */
async function probe(socketPath, timeoutMs = PROBE_TIMEOUT) {
  try {
    await send(socketPath, 'ping', {}, timeoutMs);
    return 'alive';
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') return 'dead';
    if (/timed out/.test(err.message)) return 'busy';
    debug('probe failed with %s (%s); treating as dead', err.code, err.message);
    return 'dead';
  }
}

async function isDaemonAlive(socketPath) {
  return (await probe(socketPath)) !== 'dead';
}

/** Spawn a detached daemon whose own output goes to daemon.log. */
function spawnDaemon(p) {
  ensureDirs(p);
  const logFd = fs.openSync(p.daemonLog, 'a');
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    cwd: p.home,
    windowsHide: true,
    env: Object.assign({}, process.env, { PROC_DAEMON: '1' }),
    stdio: ['ignore', logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  debug('spawned daemon pid=%s', child.pid);
}

/**
 * Make sure a daemon is reachable, starting one when needed.
 * Returns { started: boolean, socket, state }.
 */
async function connect(opts = {}) {
  const p = paths();
  const timeoutMs = opts.probeTimeoutMs || PROBE_TIMEOUT;

  const initial = await probe(p.socket, timeoutMs);
  if (initial !== 'dead') return { started: false, socket: p.socket, state: initial };

  // A stale socket file makes connect() fail in a confusing way: drop it.
  if (!p.isWindows && fs.existsSync(p.socket)) {
    try { fs.unlinkSync(p.socket); } catch (err) { debug('stale socket unlink failed: %s', err.message); }
  }

  spawnDaemon(p);

  const deadline = Date.now() + (opts.timeoutMs || 15000);
  while (Date.now() < deadline) {
    if (await probe(p.socket, 1500) === 'alive') return { started: true, socket: p.socket, state: 'alive' };
    await delay(100);
  }
  throw new NotConnected('daemon did not become ready; see ' + p.daemonLog);
}

/**
 * Send a request. With autoConnect (the default) a missing daemon is started.
 * Without it, a missing daemon surfaces as the original connection error.
 */
async function call(method, params, opts = {}) {
  const p = paths();
  const autoConnect = opts.autoConnect !== false;
  try {
    return await send(p.socket, method, params, opts.timeoutMs);
  } catch (err) {
    const transportGone = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
    if (!autoConnect || !transportGone) throw err;
    await connect(opts);
    return send(p.socket, method, params, opts.timeoutMs);
  }
}

/** Call only if a daemon is already running; otherwise throw NO_DAEMON. */
async function callIfRunning(method, params, opts = {}) {
  try {
    return await call(method, params, Object.assign({}, opts, { autoConnect: false }));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      const e = new Error('daemon is not running');
      e.code = 'NO_DAEMON';
      throw e;
    }
    throw err;
  }
}

/**
 * Open a long-lived connection and stream events.
 * Returns { socket, stop() }. `onEvent(kind, payload)` is called per event.
 */
function subscribe(params, onEvent, { onError } = {}) {
  const p = paths();
  const socket = net.connect(p.socket);
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    socket.destroy();
  };

  socket.on('error', (err) => {
    if (stopped) return;
    stopped = true;
    if (onError) onError(err);
  });
  socket.on('close', () => { stopped = true; });

  socket.on('connect', () => {
    socket.write(protocol.encode({ id: Date.now(), method: 'subscribe', params: params || {} }));
  });

  protocol.createDecoder(socket, (message) => {
    if (message.event) {
      if (onEvent) onEvent(message.event, message.payload);
      return;
    }
    if (message.ok === false && onError) {
      onError(Object.assign(new Error(message.error && message.error.message), { code: message.error && message.error.code }));
      stop();
    }
  }, (err) => { if (onError) onError(err); });

  return { socket, stop };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  connect, call, callIfRunning, send, probe, subscribe, isDaemonAlive, delay, NotConnected, DAEMON_ENTRY
};
