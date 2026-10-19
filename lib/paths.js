'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { NAME, ENV_PREFIX } = require('./constants');

/**
 * Resolve the state directory. Mirrors the reference layout:
 *   <home>/daemon.sock   IPC endpoint (unix socket / named pipe)
 *   <home>/daemon.pid    daemon pid file
 *   <home>/daemon.log    daemon's own stdout/stderr
 *   <home>/dump.json     saved process list (save/resurrect)
 *   <home>/logs/         per-application logs
 *   <home>/pids/         per-application pid files
 */
function resolveHome() {
  const fromEnv = process.env[`${ENV_PREFIX}_HOME`];
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), `.${NAME}`);
}

function paths() {
  const home = resolveHome();
  const isWindows = process.platform === 'win32';
  return {
    name: NAME,
    home,
    socket: isWindows ? `\\\\.\\pipe\\${NAME}.sock` : path.join(home, 'daemon.sock'),
    pidFile: path.join(home, 'daemon.pid'),
    daemonLog: path.join(home, 'daemon.log'),
    dumpFile: path.join(home, 'dump.json'),
    logsDir: path.join(home, 'logs'),
    pidsDir: path.join(home, 'pids'),
    isWindows
  };
}

function ensureDirs(p) {
  for (const dir of [p.home, p.logsDir, p.pidsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
}

module.exports = { paths, ensureDirs };
