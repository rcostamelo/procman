'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Ecosystem files: the declarative way to start several apps at once.
 *
 * Supported inputs (PM2-compatible shapes):
 *   - `ecosystem.config.js` / `.cjs` exporting `{ apps: [...] }` or an array
 *   - a plain `.json` file with either shape
 * YAML is NOT supported on purpose: parsing it correctly needs a real parser,
 * and a half-working one would be worse than a clear error.
 *
 * Keys accept both the snake_case used by the original ecosystem format and
 * camelCase, so files written for PM2 usually work unchanged.
 */

function loadEcosystem(file, { env = null, cwd = process.cwd() } = {}) {
  const absolute = path.resolve(cwd, file);
  if (!fs.existsSync(absolute)) {
    const err = new Error(`ecosystem file not found: ${absolute}`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  const ext = path.extname(absolute).toLowerCase();
  let raw;
  if (ext === '.json') {
    raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } else if (ext === '.js' || ext === '.cjs') {
    raw = require(absolute);
    if (raw && raw.__esModule && raw.default) raw = raw.default;
  } else if (ext === '.yaml' || ext === '.yml') {
    const err = new Error('YAML ecosystem files are not supported; use .js or .json');
    err.code = 'UNSUPPORTED';
    throw err;
  } else {
    const err = new Error(`unsupported ecosystem file: ${absolute}`);
    err.code = 'UNSUPPORTED';
    throw err;
  }

  const apps = Array.isArray(raw) ? raw : (raw && raw.apps) || [];
  if (!Array.isArray(apps) || apps.length === 0) {
    const err = new Error(`${absolute} does not declare any apps`);
    err.code = 'INVALID';
    throw err;
  }

  const baseDir = path.dirname(absolute);
  return apps.map((app) => normalizeApp(app, baseDir, env));
}

/** Map one ecosystem entry onto the supervisor's start options. */
function normalizeApp(app, baseDir, envName) {
  if (!app || typeof app !== 'object') {
    throw Object.assign(new Error('each app must be an object'), { code: 'INVALID' });
  }

  const get = (...keys) => {
    for (const key of keys) {
      if (app[key] !== undefined) return app[key];
    }
    return undefined;
  };

  if (!app.script) {
    const err = new Error(`app "${app.name || '(unnamed)'}" has no script`);
    err.code = 'INVALID';
    throw err;
  }

  // env, then env_<NAME> on top, exactly like the original
  let env = Object.assign({}, app.env || {});
  for (const candidate of [envName, process.env.NODE_ENV]) {
    if (candidate && app[`env_${candidate}`]) env = Object.assign(env, app[`env_${candidate}`]);
  }

  const execMode = String(get('exec_mode', 'execMode', 'mode') || 'fork').toLowerCase();
  const instancesRaw = get('instances', 'i');

  // Everything relative in an entry is relative to the app's cwd, which itself
  // defaults to the ecosystem file's directory (same rule as the original).
  // Resolving `script` against `baseDir` instead would break the very common
  // `{ cwd: './backend', script: 'src/server.js' }` layout.
  const cwd = path.resolve(baseDir, get('cwd') || baseDir);

  return {
    name: app.name,
    namespace: get('namespace'),
    script: path.resolve(cwd, app.script),
    args: normalizeArgs(app.args),
    cwd,
    interpreter: get('interpreter', 'exec_interpreter', 'execInterpreter'),
    env,
    mode: execMode === 'cluster' ? 'cluster' : 'fork',
    instances: instancesRaw === undefined ? undefined
      : (typeof instancesRaw === 'string' && /^max$/i.test(instancesRaw.trim()) ? 'max' : Number(instancesRaw)),
    minUptime: get('min_uptime', 'minUptime'),
    maxRestarts: get('max_restarts', 'maxRestarts'),
    restartDelay: get('restart_delay', 'restartDelay'),
    killTimeout: get('kill_timeout', 'killTimeout'),
    listenTimeout: get('listen_timeout', 'listenTimeout', 'listenTimeoutMs'),
    autorestart: get('autorestart'),
    stopExitCodes: get('stop_exit_codes', 'stopExitCodes'),
    watch: get('watch'),
    watchPaths: resolvePaths(get('watch_paths', 'watchPaths'), cwd),
    ignoreWatch: normalizeArgs(get('ignore_watch', 'ignoreWatch')),
    cron: get('cron', 'cron_restart', 'cronRestart'),
    maxMemoryRestart: get('max_memory_restart', 'maxMemoryRestart'),
    time: get('time') === undefined ? undefined : asBool(get('time')),
    dateFormat: get('log_date_format', 'logDateFormat', 'dateFormat'),
    mergeLogs: get('merge_logs', 'mergeLogs') === undefined ? undefined : asBool(get('merge_logs', 'mergeLogs')),
    logRotateSize: get('log_rotate_size', 'logRotateSize'),
    logRotateKeep: get('log_rotate_keep', 'logRotateKeep'),
    logRotateCompress: get('log_rotate_compress', 'logRotateCompress') === undefined
      ? undefined
      : asBool(get('log_rotate_compress', 'logRotateCompress')),
    waitReady: get('wait_ready', 'waitReady') === undefined ? undefined : asBool(get('wait_ready', 'waitReady')),
    output: resolvePath(get('out_file', 'output', 'outFile'), cwd),
    error: resolvePath(get('error_file', 'error', 'errorFile'), cwd)
  };
}

/**
 * Resolve relative paths in an entry against the app's cwd. `ignore_watch` is
 * deliberately left alone: those entries are matched as substrings of an
 * absolute path (e.g. "node_modules"), not as paths.
 */
function resolvePath(value, cwd) {
  return value ? path.resolve(cwd, value) : undefined;
}

function resolvePaths(value, cwd) {
  const list = normalizeArgs(value);
  return list === undefined ? undefined : list.map((entry) => path.resolve(cwd, entry));
}

/** Ecosystem files use both booleans and the strings "true"/"false". */
function asBool(value) {
  if (typeof value === 'string') return !['false', '0', 'no', 'off', ''].includes(value.toLowerCase());
  return Boolean(value);
}

function normalizeArgs(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.trim() ? value.trim().split(/\s+/) : [];
  return undefined;
}

/** Does this path look like an ecosystem file rather than a plain script? */
function looksLikeEcosystem(file) {
  return /\.config\.(js|cjs|json)$/i.test(file) || /\.(ya?ml)$/i.test(file);
}

/** ecosystem.config.js, ecosystem.procman.config.mjs, ... — the usual names. */
const ECOSYSTEM_NAME = /^ecosystem[\w.-]*\.config\.(js|cjs|mjs|json)$/i;

/**
 * Ecosystem files in `dir` and its ancestors, closest first. Used to answer
 * "you are standing right next to the file you probably meant".
 */
function findEcosystemFiles(dir, { limit = 6 } = {}) {
  const found = [];
  let current = path.resolve(dir);
  for (let depth = 0; depth <= limit; depth++) {
    let entries = [];
    try { entries = fs.readdirSync(current); } catch (err) { break; }
    for (const entry of entries.sort()) {
      if (ECOSYSTEM_NAME.test(entry) && fs.statSync(path.join(current, entry)).isFile()) {
        found.push(path.join(current, entry));
      }
    }
    if (found.length) break; // the closest directory that has one wins
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

module.exports = { loadEcosystem, normalizeApp, looksLikeEcosystem, findEcosystemFiles };
