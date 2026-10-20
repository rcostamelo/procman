'use strict';

const fs = require('fs');
const path = require('path');
const { NAME, EXIT_CODES } = require('./constants');
const client = require('./client');
const { normalizeStart } = require('./start-options');
const { loadEcosystem, looksLikeEcosystem, findEcosystemFiles } = require('./ecosystem');
const { HELP, COMMANDS, manualFor } = require('./help');
const completion = require('./completion');
const startupUnit = require('./startup');
const { table, uptime, statusLabel, cpuLabel } = require('./output');
const { formatBytes } = require('./monitor');
const { welcome } = require('./welcome');

// --------------------------------------------------------------- options ---

const OPTIONS = [
  { long: 'name', short: 'n', key: 'name', type: 'value' },
  { long: 'cwd', key: 'cwd', type: 'value' },
  { long: 'output', short: 'o', key: 'output', type: 'value' },
  { long: 'error', short: 'e', key: 'error', type: 'value' },
  { long: 'interpreter', key: 'interpreter', type: 'value' },
  { long: 'instances', short: 'i', key: 'instances', type: 'value' },
  { long: 'mode', key: 'mode', type: 'value' },
  { long: 'namespace', key: 'namespace', type: 'value' },
  { long: 'env', key: 'env', type: 'value' },
  { long: 'config', key: 'config', type: 'bool' },
  { long: 'restart-delay', key: 'restartDelay', type: 'value' },
  { long: 'max-restarts', key: 'maxRestarts', type: 'value' },
  { long: 'min-uptime', key: 'minUptime', type: 'value' },
  { long: 'kill-timeout', key: 'killTimeout', type: 'value' },
  { long: 'listen-timeout', key: 'listenTimeout', type: 'value' },
  { long: 'stop-exit-codes', key: 'stopExitCodes', type: 'value' },
  { long: 'cron', key: 'cron', type: 'value' },
  { long: 'cron-restart', key: 'cron', type: 'value' },
  { long: 'max-memory-restart', key: 'maxMemoryRestart', type: 'value' },
  { long: 'watch', key: 'watch', type: 'bool' },
  { long: 'watch-path', key: 'watchPaths', type: 'value', multiple: true },
  { long: 'ignore-watch', key: 'ignoreWatch', type: 'value', multiple: true },
  { long: 'time', key: 'time', type: 'bool' },
  { long: 'log-date-format', key: 'dateFormat', type: 'value' },
  { long: 'merge-logs', key: 'mergeLogs', type: 'bool' },
  { long: 'log-rotate-size', key: 'logRotateSize', type: 'value' },
  { long: 'log-rotate-keep', key: 'logRotateKeep', type: 'value' },
  { long: 'log-rotate-compress', key: 'logRotateCompress', type: 'bool' },
  { long: 'wait-ready', key: 'waitReady', type: 'bool' },
  { long: 'interval', key: 'interval', type: 'value' },
  { long: 'sort', key: 'sort', type: 'value' },
  { long: 'autorestart', key: 'autorestart', type: 'bool' },
  { long: 'lines', key: 'lines', type: 'value' },
  { long: 'follow', short: 'f', key: 'follow', type: 'bool' },
  { long: 'out', key: 'which', type: 'const', value: 'out' },
  { long: 'err', key: 'which', type: 'const', value: 'err' },
  { long: 'port', key: 'port', type: 'value' },
  { long: 'host', key: 'host', type: 'value' },
  { long: 'install', key: 'install', type: 'bool' },
  { long: 'user', key: 'user', type: 'value' },
  { long: 'stop', key: 'stopWeb', type: 'bool' },
  { long: 'auth', key: 'auth', type: 'bool' },
  { long: 'password', key: 'password', type: 'value' },
  { long: 'all', short: 'a', key: 'all', type: 'bool' },
  { long: 'json', key: 'json', type: 'bool' },
  { long: 'help', short: 'h', key: 'help', type: 'bool' },
  { long: 'version', short: 'v', key: 'version', type: 'bool' }
];

const BY_LONG = new Map(OPTIONS.map((o) => [o.long, o]));
const BY_SHORT = new Map(OPTIONS.filter((o) => o.short).map((o) => [o.short, o]));

function parse(argv) {
  const flags = { autorestart: true };
  const positional = [];
  let passthrough = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { passthrough = argv.slice(i + 1); break; }

    if (arg.startsWith('--no-')) {
      const spec = BY_LONG.get(arg.slice(5));
      if (!spec || spec.type !== 'bool') throw new Error(`unknown option "${arg}"`);
      flags[spec.key] = false;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      const spec = BY_LONG.get(name);
      if (!spec) throw new Error(`unknown option "--${name}"`);
      applyOption(flags, spec, inline, argv, () => argv[++i]);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const spec = BY_SHORT.get(arg.slice(1));
      if (!spec) throw new Error(`unknown option "${arg}"`);
      applyOption(flags, spec, undefined, argv, () => argv[++i]);
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional, passthrough };
}

function applyOption(flags, spec, inline, argv, takeNext) {
  if (spec.type === 'bool') {
    flags[spec.key] = inline === undefined ? true : inline !== 'false';
    return;
  }
  if (spec.type === 'const') {
    flags[spec.key] = spec.value;
    return;
  }
  const value = inline !== undefined ? inline : takeNext();
  if (value === undefined) throw new Error(`option "--${spec.long}" needs a value`);
  if (spec.multiple) {
    if (!Array.isArray(flags[spec.key])) flags[spec.key] = [];
    flags[spec.key].push(value);
  } else {
    flags[spec.key] = value;
  }
}

// ------------------------------------------------------------------- run ----

async function run(argv) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    process.stderr.write(`${NAME}: ${err.message}\n\n${HELP}`);
    return EXIT_CODES.ERROR;
  }

  const { flags, positional, passthrough } = parsed;
  const command = positional[0];

  // The install banner: once per user, on the first real command in a terminal.
  // Manuals and version already are "the interface", the TUI takes the screen,
  // and __complete is called on every TAB, so it must stay silent.
  const quiet = !command || flags.help || flags.version || command === 'help' ||
    command === 'version' || command === 'monit' || command.startsWith('__');
  if (!quiet) welcome(argv);

  if (flags.version || command === 'version') {
    process.stdout.write(`${NAME} ${require('../package.json').version}\n`);
    return EXIT_CODES.SUCCESS;
  }

  // `help`, `help <cmd>` and `<cmd> --help` all print a manual. The command
  // itself is never run when a manual was asked for.
  if (flags.help || command === 'help') {
    const wanted = command === 'help' ? positional[1] : command;
    if (wanted && !manualFor(wanted)) {
      process.stderr.write(`${NAME}: unknown command "${wanted}"\n\n${HELP}`);
      return EXIT_CODES.ERROR;
    }
    return writeManual(wanted || null) ? EXIT_CODES.SUCCESS : EXIT_CODES.ERROR;
  }
  if (!command) {
    writeManual(null);
    return EXIT_CODES.ERROR;
  }

  // Called by the shell completion scripts; must stay silent on any failure.
  if (command === '__complete') {
    return await complete(positional[1]);
  }

  try {
    switch (command) {
      case 'ping': return await ping();
      case 'start': return await start(positional[1], flags, passthrough);
      case 'list':
      case 'ls': return await list(flags);
      case 'status': return await list(flags, { summarize: true });
      case 'describe':
      case 'desc': return await describe(positional[1], flags);
      case 'stop': return await simple('stop', positional[1], flags);
      case 'restart': return await simple('restart', positional[1], flags);
      case 'reload': return await simple('reload', positional[1], flags);
      case 'delete':
      case 'del': return await simple('delete', positional[1], flags);
      case 'scale': return await scale(positional[1], positional[2], flags);
      case 'logs':
      case 'log': return await logs(positional[1], flags);
      case 'monit': return await monit(flags);
      case 'save': return await save();
      case 'resurrect': return await resurrect();
      case 'startup': return await startup(flags);
      case 'web': return await web(flags);
      case 'user': return await userCommand(positional.slice(1), flags);
      case 'completion': return await completionCommand(positional[1], flags);
      case 'kill': return await kill();
      default:
        process.stderr.write(`${NAME}: unknown command "${command}"\n\n${HELP}`);
        return EXIT_CODES.ERROR;
    }
  } catch (err) {
    // A missing argument is not a dead end: print the manual for that command.
    if (err.code === 'USAGE') return printUsageError(err);
    process.stderr.write(`${NAME}: ${err.message}\n`);
    return EXIT_CODES.ERROR;
  }
}

/** `procman: <why>\n\n<the manual for that command>` on stderr. */
function printUsageError(err) {
  const manual = err.command ? manualFor(err.command) : null;
  process.stderr.write(`${NAME}: ${err.message}\n`);
  process.stderr.write(manual ? `\n${manual}\n` : `\n${HELP}`);
  return EXIT_CODES.ERROR;
}

function writeManual(name) {
  const manual = name ? manualFor(name) : HELP;
  if (!manual) {
    process.stderr.write(`${NAME}: unknown command "${name}"\n\n${HELP}`);
    return false;
  }
  process.stdout.write(manual.endsWith('\n') ? manual : `${manual}\n`);
  return true;
}

async function ping() {
  const started = Date.now();
  const result = await client.call('ping');
  process.stdout.write(
    `pong from daemon pid ${result.pid} (${NAME} ${result.version}) in ${Date.now() - started}ms\n` +
    `home: ${result.home}\nprocesses: ${result.processes}\n`
  );
  return EXIT_CODES.SUCCESS;
}

// ------------------------------------------------------------------ start ---

function startParamsFromFlags(target, flags, passthrough) {
  let instances = flags.instances;
  if (instances !== undefined) {
    instances = String(instances).toLowerCase() === 'max' ? 0 : Number(instances);
  }
  // `-i N` implies cluster mode unless the user said otherwise, like the original
  let mode = flags.mode;
  if (!mode && instances !== undefined) mode = 'cluster';

  const params = {
    script: target,
    args: passthrough || [],
    name: flags.name,
    namespace: flags.namespace,
    cwd: flags.cwd,
    output: flags.output,
    error: flags.error,
    interpreter: flags.interpreter,
    instances,
    mode,
    restartDelay: flags.restartDelay,
    maxRestarts: flags.maxRestarts,
    minUptime: flags.minUptime,
    killTimeout: flags.killTimeout,
    listenTimeout: flags.listenTimeout,
    autorestart: flags.autorestart,
    stopExitCodes: flags.stopExitCodes ? String(flags.stopExitCodes).split(',').map((s) => s.trim()) : undefined,
    watch: flags.watch,
    watchPaths: flags.watchPaths,
    ignoreWatch: flags.ignoreWatch,
    cron: flags.cron,
    maxMemoryRestart: flags.maxMemoryRestart,
    time: flags.time,
    dateFormat: flags.dateFormat,
    mergeLogs: flags.mergeLogs,
    logRotateSize: flags.logRotateSize,
    logRotateKeep: flags.logRotateKeep,
    logRotateCompress: flags.logRotateCompress,
    waitReady: flags.waitReady
  };
  for (const key of Object.keys(params)) {
    if (params[key] === undefined) delete params[key];
  }
  return params;
}

async function start(target, flags, passthrough) {
  if (!target) throw usageError('start', ecosystemHint() || 'start requires a script or an ecosystem file');

  if (flags.config || looksLikeEcosystem(target)) {
    const apps = loadEcosystem(target, { env: flags.env, cwd: process.cwd() });
    const started = [];
    for (const app of apps) {
      const record = await client.call('start', normalizeStart(app, process.cwd()));
      started.push(record);
      printStarted(record);
    }
    process.stdout.write(`started ${started.length} app(s) from ${target}\n`);
    hint(`${NAME} logs <name> -f follows it · ${NAME} web opens the dashboard · ${NAME} save keeps it for boot`);
    return EXIT_CODES.SUCCESS;
  }

  const record = await client.call('start', normalizeStart(startParamsFromFlags(target, flags, passthrough), process.cwd()));
  printStarted(record);
  hint(`${NAME} logs ${record.name} -f follows it · ${record.ports && record.ports.length ? `port ${record.ports[0]} is bound · ` : ''}${NAME} describe ${record.name} has everything`);
  return EXIT_CODES.SUCCESS;
}

function printStarted(record) {
  const how = record.mode === 'cluster' ? `cluster x${record.instances}` : 'fork';
  process.stdout.write(`started ${record.name} (id ${record.id}, ${how}, pid ${record.pid})\n`);
  process.stdout.write(`  out: ${record.out_log}\n  err: ${record.err_log}\n`);
  // Present when the app already reported a bound port (e.g. with --wait-ready).
  if (record.port != null) process.stdout.write(`  port: ${record.port}\n`);
}

// ------------------------------------------------------------------- list ---

async function list(flags, { summarize = false } = {}) {
  let rows;
  try {
    rows = await client.callIfRunning('list');
  } catch (err) {
    if (err.code === 'NO_DAEMON') rows = [];
    else throw err;
  }
  if (flags.namespace) rows = rows.filter((r) => r.namespace === flags.namespace);

  if (flags.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return EXIT_CODES.SUCCESS;
  }

  const rendered = rows.map((r) => Object.assign({}, r, {
    statusText: statusLabel(r.status),
    uptimeText: uptime(r.uptime_ms),
    memoryText: formatBytes(r.memory),
    cpuText: cpuLabel(r.cpu)
  }));
  process.stdout.write(table(rendered, [
    { header: 'id', get: (r) => r.id },
    { header: 'name', get: (r) => r.name },
    { header: 'ns', get: (r) => r.namespace },
    { header: 'mode', get: (r) => r.mode },
    { header: 'inst', get: (r) => r.instances },
    { header: 'pid', get: (r) => r.pid || '-' },
    { header: 'port', get: (r) => (r.port == null ? '-' : r.port) },
    { header: 'status', get: (r) => r.statusText },
    { header: 'cpu', get: (r) => r.cpuText },
    { header: 'mem', get: (r) => r.memoryText },
    { header: 'restarts', get: (r) => r.restarts },
    { header: 'uptime', get: (r) => r.uptimeText },
    { header: 'script', get: (r) => r.script }
  ]));
  if (summarize) process.stdout.write(`\n${statusSummary(rows)}\n`);
  hint(`${NAME} logs <name> follows one app · ${NAME} monit is the live view · ${NAME} help <command> explains any command`,
    { enabled: rows.length > 0 });
  return EXIT_CODES.SUCCESS;
}

/** One line under the `status` table: how many apps are in each state. */
function statusSummary(rows) {
  if (!rows.length) return 'no processes';
  const by = new Map();
  for (const r of rows) {
    const status = r.status || 'unknown';
    by.set(status, (by.get(status) || 0) + 1);
  }
  const parts = [...by.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([status, n]) => `${n} ${status}`);
  return `${rows.length} app(s): ${parts.join(', ')}`;
}

async function describe(target, flags) {
  if (!target) throw usageError('describe', 'describe requires a name or id');
  // cwd travels with the request: the daemon resolves a script-path target
  // against the caller's directory, not against its own state home.
  const record = await client.callIfRunning('describe', { target, namespace: flags.namespace, cwd: process.cwd() });
  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  return EXIT_CODES.SUCCESS;
}

async function simple(method, target, flags) {
  if (!target) throw usageError(method, `${method} requires a name, id, or "all"`);
  const params = { target, namespace: flags.namespace, cwd: process.cwd() };
  if (method === 'scale') params.instances = flags.instances;
  const results = await client.callIfRunning(method, params);
  const list = Array.isArray(results) ? results : [results];
  for (const r of list) {
    if (r && r.deleted) process.stdout.write(`deleted ${r.name} (id ${r.id})\n`);
    else if (r) process.stdout.write(`${method}: ${r.name} (id ${r.id}) -> ${statusLabel(r.status)}${r.mode === 'cluster' ? ` x${r.instances}` : ''}\n`);
  }
  return EXIT_CODES.SUCCESS;
}

async function scale(target, instances, flags) {
  if (!target || instances === undefined) throw usageError('scale', 'scale requires a target and an instance count');
  const value = String(instances).toLowerCase() === 'max' ? 0 : Number(instances);
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid instance count "${instances}"`);
  const record = await client.callIfRunning('scale', { target, namespace: flags.namespace, cwd: process.cwd(), instances: value });
  process.stdout.write(`scaled ${record.name} to ${record.instances} instance(s)\n`);
  return EXIT_CODES.SUCCESS;
}

// ------------------------------------------------------------------- logs ---

/**
 * One log line, as the user sees it in the file. `text` (when the daemon
 * supplies it) already carries the `--time` prefix; `slot` is only set when the
 * app logs per instance.
 */
/**
 * One colour per app — and, when the slot is known, one per worker, so a
 * 4-worker cluster reads as four different streams. Colours are only used on a
 * terminal: piping stays byte-for-byte plain, which is what scripts want.
 */
const LOG_PALETTE = [36, 33, 35, 32, 34, 31, 96, 93, 95, 92, 94, 91];
const ANSI_RESET = '\x1b[0m';

function colorEnabled() {
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') return false;
  if (process.env.FORCE_COLOR === '0' || process.env.FORCE_COLOR === 'false') return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function colorIndex(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash;
}

function formatLogLine(name, entry, color = colorEnabled()) {
  const label = `${name || '?'} | ${entry.slot === undefined || entry.slot === null ? '' : `[${entry.slot}] `}`;
  const text = entry.text === undefined ? entry.line : entry.text;
  const plainMarker = entry.which === 'err' ? 'ERR ' : '';
  if (!color) return `${label}${plainMarker}${text}\n`;
  const colorCode = LOG_PALETTE[(colorIndex(String(name)) + (entry.slot || 0)) % LOG_PALETTE.length];
  const marker = entry.which === 'err' ? `\x1b[31mERR${ANSI_RESET} ` : '';
  return `\x1b[${colorCode}m${label}${ANSI_RESET}${marker}${text}\n`;
}

/**
 * `logs [name|id]` — tail one app, or every app at once (`pm2 logs` style: no
 * name means all of them, each line tagged and coloured by app).
 */
async function logs(target, flags) {
  const lines = flags.lines === undefined ? 20 : Number(flags.lines);
  // Like `pm2 logs`: on a terminal it keeps streaming until Ctrl-C. Piped or
  // redirected output is a snapshot instead, so `> file` and scripts never hang.
  const follow = flags.follow !== undefined
    ? flags.follow
    : (Boolean(process.stdout.isTTY) && !flags.json);
  const params = { target, namespace: flags.namespace, cwd: process.cwd(), lines, which: flags.which };

  const initial = await client.callIfRunning('logs', params);
  if (flags.json && !follow) {
    process.stdout.write(JSON.stringify(initial, null, 2) + '\n');
    return EXIT_CODES.SUCCESS;
  }
  for (const entry of initial.lines) process.stdout.write(formatLogLine(entry.name || initial.name, entry));

  if (!follow) {
    if (!initial.lines.length && lines > 0) {
      process.stderr.write(initial.all
        ? `${NAME}: nothing to show — no app has written a line yet\n`
        : `${NAME}: ${initial.name} has not written anything yet\n`);
    }
    return EXIT_CODES.SUCCESS;
  }

  const subscription = client.subscribe({ target, namespace: flags.namespace, cwd: process.cwd(), kinds: ['log'] }, (kind, payload) => {
    if (kind === 'log' && (!flags.which || flags.which === payload.which)) {
      process.stdout.write(formatLogLine(payload.name, payload));
    }
  }, {
    onError: (err) => process.stderr.write(`${NAME}: ${err.message}\n`)
  });

  await new Promise((resolve) => {
    const done = () => { subscription.stop(); resolve(); };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    subscription.socket.once('close', () => resolve());
  });
  return EXIT_CODES.SUCCESS;
}

// ------------------------------------------------------------------ monit ---

async function monit(flags) {
  const interval = flags.interval === undefined ? undefined : Number(flags.interval);
  if (interval !== undefined && (!Number.isFinite(interval) || interval < 200)) {
    throw new Error('--interval must be a number >= 200 (milliseconds)');
  }
  const { runMonit } = require('./monit');
  return runMonit(client, { intervalMs: interval, sort: flags.sort });
}

// ------------------------------------------------------------------- boot ---

async function save() {
  const result = await client.callIfRunning('save');
  process.stdout.write(`saved ${result.apps} app(s) to ${result.file}\n`);
  return EXIT_CODES.SUCCESS;
}

async function resurrect() {
  const result = await client.call('resurrect');
  for (const record of result.apps) printStarted(record);
  process.stdout.write(`resurrected ${result.apps.length} app(s) from ${result.file}\n`);
  if (result.skipped && result.skipped.length) {
    process.stdout.write(`skipped (already running): ${result.skipped.join(', ')}\n`);
  }
  for (const failure of result.failed || []) {
    process.stderr.write(`${NAME}: ${failure.name}: ${failure.error}\n`);
  }
  return (result.failed && result.failed.length) ? EXIT_CODES.ERROR : EXIT_CODES.SUCCESS;
}

async function startup(flags) {
  const result = flags.install ? startupUnit.install({ user: flags.user }) : startupUnit.generate({ user: flags.user });
  if (!result.content) {
    process.stderr.write(`${NAME}: ${result.message}\n`);
    return EXIT_CODES.ERROR;
  }
  process.stdout.write(result.content);
  process.stdout.write(`\n# target: ${result.file}\n`);
  for (const command of result.commands) process.stdout.write(`#   ${command}\n`);
  if (flags.install) {
    process.stdout.write(result.installed
      ? `# installed ${result.file}\n`
      : `# NOT installed: ${result.error}\n`);
  }
  return EXIT_CODES.SUCCESS;
}

async function web(flags) {
  if (flags.stopWeb) {
    const result = await client.callIfRunning('webStop');
    process.stdout.write(result.stopped ? 'dashboard stopped\n' : 'dashboard was not running\n');
    return EXIT_CODES.SUCCESS;
  }
  const result = await client.call('web', {
    port: flags.port === undefined ? undefined : Number(flags.port),
    host: flags.host,
    auth: flags.auth
  });
  const guard = result.protected
    ? `auth: on (${result.users} user${result.users === 1 ? '' : 's'})`
    : result.auth === 'off'
      ? 'auth: off (--no-auth)'
      : 'auth: off (no users)';
  process.stdout.write(`dashboard on ${result.url} — ${guard}\n`);
  if (result.warning) process.stderr.write(`${NAME}: ${result.warning}\n`);
  return EXIT_CODES.SUCCESS;
}

/**
 * `procman user` — the accounts the dashboard accepts.
 *
 * Passwords are read from --password, from stdin when piped, or from a hidden
 * prompt, in that order of precedence. The store is opened directly: the CLI
 * does not need the daemon to be up to add a user, and the dashboard notices on
 * its next request.
 */
async function userCommand(args, flags) {
  const sub = args[0] || 'list';
  const name = args[1];

  if (sub === 'help' || flags.help) {
    process.stdout.write(USER_HELP);
    return EXIT_CODES.SUCCESS;
  }

  const { Users } = require('./users');
  const { usersFile } = require('./paths').paths();
  let users;
  try {
    users = new Users(usersFile);
  } catch (err) {
    process.stderr.write(`${NAME}: ${err.message}\n`);
    return EXIT_CODES.ERROR;
  }

  try {
    switch (sub) {
      case 'list':
      case 'ls': {
        const rows = users.list();
        if (flags.json) {
          process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
          return EXIT_CODES.SUCCESS;
        }
        if (!rows.length) {
          process.stdout.write(`no users yet — create one with: ${NAME} user add <name>\n`);
          return EXIT_CODES.SUCCESS;
        }
        process.stdout.write(table(rows, [
          { header: 'name', get: (r) => r.name },
          { header: 'created', get: (r) => new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') },
          { header: 'last login', get: (r) => (r.last_login ? new Date(r.last_login).toISOString().slice(0, 19).replace('T', ' ') : '-') },
          { header: 'sessions', get: (r) => r.sessions }
        ]));
        return EXIT_CODES.SUCCESS;
      }
      case 'add': {
        if (!name) throw usageError('user', `user add needs a name`);
        const password = await askPassword(flags, { confirm: true });
        users.add(name, password);
        process.stdout.write(`user "${name}" created (${users.count()} total); the dashboard now requires a login\n`);
        return EXIT_CODES.SUCCESS;
      }
      case 'passwd':
      case 'password': {
        if (!name) throw usageError('user', 'user passwd needs a name');
        const password = await askPassword(flags, { confirm: true });
        users.setPassword(name, password);
        process.stdout.write(`password updated for "${name}"; existing sessions were dropped\n`);
        return EXIT_CODES.SUCCESS;
      }
      case 'rm':
      case 'remove':
      case 'delete':
      case 'del': {
        if (flags.all) {
          let removed = 0;
          for (const row of users.list()) { users.remove(row.name); removed++; }
          process.stdout.write(`removed ${removed} user(s); the dashboard no longer requires a login\n`);
          return EXIT_CODES.SUCCESS;
        }
        if (!name) throw usageError('user', 'user rm needs a name (or --all)');
        users.remove(name);
        process.stdout.write(`user "${name}" removed (${users.count()} left)\n`);
        if (users.count() === 0) {
          process.stdout.write(`no users left — the dashboard will stop asking for a login\n`);
        }
        return EXIT_CODES.SUCCESS;
      }
      default:
        throw usageError('user', `unknown subcommand "${sub}" — use list, add, passwd or rm`);
    }
  } catch (err) {
    if (err.code === 'ABORTED') {
      process.stderr.write('aborted\n');
      return EXIT_CODES.ERROR;
    }
    if (err.code === 'USAGE') return printUsageError(err);
    process.stderr.write(`${NAME}: ${err.message}\n`);
    return EXIT_CODES.ERROR;
  } finally {
    users.close();
  }
}

/** Marks a "you did not tell me enough" error so run() can print the manual. */
function usageError(command, message) {
  const err = new Error(message);
  err.code = 'USAGE';
  err.command = command;
  return err;
}

async function askPassword(flags, { confirm }) {
  if (flags.password !== undefined) {
    if (typeof flags.password !== 'string') throw new Error('--password needs a value');
    return flags.password;
  }
  if (!process.stdin.isTTY) {
    // Piped input (`echo s3nha | procman user add bob`) is read whole.
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (!password) throw new Error('no password on stdin');
    return password;
  }
  const first = await promptHidden('password: ');
  if (confirm) {
    const again = await promptHidden('repeat password: ');
    if (first !== again) throw new Error('passwords do not match');
  }
  return first;
}

/** Reads a line with the echo off, so the password never lands on the screen. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buffer = '';
    const finish = (err, value) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(null, buffer);
        if (ch === '\u0003') {                       // Ctrl-C
          const err = new Error('aborted');
          err.code = 'ABORTED';
          return finish(err);
        }
        if (ch === '\u007f' || ch === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const USER_HELP = `Usage: ${NAME} user <command> [name] [options]

  list                    list users (default)                     (--json)
  add <name>              create a user; the dashboard then requires a login
  passwd <name>           change a password (drops that user's sessions)
  rm <name>               delete a user            (--all removes every one)

Passwords come from --password <pw>, from stdin when piped, or from a hidden
prompt. Users are stored (hashed with scrypt) in <home>/users.db — SQLite from
Node itself, so the tool keeps its empty dependency list.
`;

/**
 * `procman completion` — prints the tab-completion script, or installs it.
 *
 * The script itself is dumb: all the knowledge stays here, behind
 * `procman __complete`, so a new release never leaves a stale copy in someone's
 * shell rc.
 */
async function completionCommand(shell, flags) {
  if (flags.install) {
    const result = completion.install(shell);
    if (result.changed) {
      process.stdout.write(
        `tab-completion installed for ${result.shell} in ${result.rc}\n` +
        `  ${result.line}\n` +
        `open a new shell (or: source ${result.rc}) and try: ${NAME} <TAB>\n`
      );
    } else {
      process.stdout.write(`tab-completion was already installed for ${result.shell} in ${result.rc}\n`);
    }
    return EXIT_CODES.SUCCESS;
  }
  const wanted = shell || completion.detectShell();
  if (!wanted) throw usageError('completion', 'completion needs a shell: bash or zsh');
  process.stdout.write(completion.scriptFor(wanted) + '\n');
  return EXIT_CODES.SUCCESS;
}

/** The candidate list behind every TAB press. Silent on any failure. */
async function complete(kind) {
  try {
    let words = [];
    switch (kind) {
      case 'commands': words = COMMANDS; break;
      case 'options': words = optionWords(); break;
      case 'targets': words = await targetWords(); break;
      case 'namespaces': words = await namespaceWords(); break;
      case 'users': words = userWords(); break;
      case 'ecosystems': words = ecosystemWords(); break;
      default: words = [];
    }
    if (words.length) process.stdout.write(words.join('\n') + '\n');
  } catch (err) {
    // A completion helper must never print a stack trace into the prompt.
  }
  return EXIT_CODES.SUCCESS;
}

function optionWords() {
  const out = [];
  for (const spec of OPTIONS) {
    out.push(`--${spec.long}`);
    if (spec.short) out.push(`-${spec.short}`);
    // bool options can be negated on the command line: --no-autorestart, ...
    if (spec.type === 'bool' && NO_OPTIONS.has(spec.long)) out.push(`--no-${spec.long}`);
  }
  return out;
}

/** The bool options that read naturally as --no-<x> (see the manual's list). */
const NO_OPTIONS = new Set([
  'autorestart', 'merge-logs', 'time', 'watch', 'log-rotate-compress', 'wait-ready', 'follow'
]);

function liveRows() {
  try {
    return client.callIfRunning('list');
  } catch (err) {
    return Promise.resolve([]);
  }
}

async function targetWords() {
  const rows = await liveRows();
  const out = [];
  for (const row of rows) {
    out.push(row.name);
    out.push(String(row.id));
    if (row.namespace && row.namespace !== 'default') out.push(`${row.namespace}:${row.name}`);
  }
  out.push('all');
  return [...new Set(out)];
}

async function namespaceWords() {
  const rows = await liveRows();
  const out = new Set(['default']);
  for (const row of rows) if (row.namespace) out.add(row.namespace);
  return [...out];
}

function userWords() {
  try {
    const { usersFile } = require('./paths').paths();
    if (!fs.existsSync(usersFile)) return [];
    const { Users } = require('./users');
    const store = new Users(usersFile);
    try { return store.list().map((row) => row.name); } finally { store.close(); }
  } catch (err) {
    return [];
  }
}

function ecosystemWords() {
  const cwd = process.cwd();
  return findEcosystemFiles(cwd).map((file) => path.relative(cwd, file) || file);
}

/** "you are standing next to the file you probably meant" */
function ecosystemHint() {
  const cwd = process.cwd();
  const found = findEcosystemFiles(cwd);
  if (!found.length) return null;
  const rel = path.relative(cwd, found[0]) || found[0];
  return `start requires a script or an ecosystem file — found one here: ${rel}\n` +
    `  try: ${NAME} start ${rel.includes(' ') ? `"${rel}"` : rel}`;
}

/**
 * A dim "what now" line after an interactive command. Silent when stdout is a
 * pipe, a file, --json, or NO_COLOR is set, so scripts stay byte-identical.
 */
function hint(text, { enabled = true } = {}) {
  if (!enabled || !process.stdout.isTTY) return;
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') return;
  process.stdout.write(`\n\x1b[2m→ ${text}\x1b[0m\n`);
}

async function kill() {
  try {
    await client.callIfRunning('killMe');
  } catch (err) {
    if (err.code === 'NO_DAEMON') {
      process.stdout.write('daemon is not running\n');
      return EXIT_CODES.SUCCESS;
    }
    throw err;
  }
  // The reply is sent before the shutdown finishes, because stopping every app
  // can take up to kill_timeout. Wait for the endpoint to actually die so the
  // next command in a script cannot reach a daemon that is on its way out.
  const { socket } = require('./paths').paths();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await client.probe(socket, 300) === 'dead') break;
    await client.delay(100);
  }
  process.stdout.write('daemon stopped and all applications stopped\n');
  return EXIT_CODES.SUCCESS;
}

module.exports = { run, parse };
