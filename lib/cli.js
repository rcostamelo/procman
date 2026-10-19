'use strict';

const { NAME, EXIT_CODES } = require('./constants');
const client = require('./client');
const { normalizeStart } = require('./start-options');
const { loadEcosystem, looksLikeEcosystem } = require('./ecosystem');
const startupUnit = require('./startup');
const { table, uptime, statusLabel, cpuLabel } = require('./output');
const { formatBytes } = require('./monitor');

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

// ------------------------------------------------------------------ help ---

const HELP = `Usage: ${NAME} <command> [options]

Targets accepted by describe/stop/restart/reload/delete/logs/scale:
  an id (0), a name (web), "namespace:name" (staging:web), or a script path.

Process management
  start <file|config> [-- <args>]   start a script, or every app in an ecosystem file
  list                             list processes                        (--json)
  describe <name|id>               full details for one process
  stop     <name|id|all>           graceful stop, then SIGKILL
  restart  <name|id|all>           stop + start, keeping the options
  reload   <name|id|all>           zero-downtime reload (cluster mode)
  delete   <name|id|all>           stop and forget
  scale    <name|id> <n>           grow/shrink a cluster app (0 = one per CPU)
  logs     <name|id>               print and follow logs
  save | resurrect                 persist the list / replay it (used at boot)

Monitoring
  monit                            live view (q quit, c/m/n sort, up/down select)
                                   --interval <ms>  --sort <cpu|mem|name>

Daemon
  ping                             check that the daemon answers
  kill                             stop everything and shut the daemon down
  web [--port 9615] [--stop]       built-in dashboard (loopback only)
  startup [--install] [--user u]   generate (or install) the boot unit

start options
  -n, --name <name>                name shown in the list
      --namespace <ns>             group processes
      --cwd <path>                 working directory for the app
  -o, --output <path>              stdout log file
  -e, --error <path>               stderr log file
      --interpreter <path>         interpreter (default: current node)
  -i, --instances <n|max>          cluster instances (0 or max = one per CPU)
      --mode <fork|cluster>        execution mode (default: fork, or cluster with -i)
      --config                     treat the argument as an ecosystem file
      --env <name>                 ecosystem env_<name> overlay
      --restart-delay <ms>         delay before an automatic restart
      --max-restarts <n>           unstable restarts before giving up (default 16)
      --min-uptime <ms>            uptime that counts as stable   (default 1000)
      --kill-timeout <ms>          delay before SIGKILL           (default 1600)
      --listen-timeout <ms>        wait for "listening" on reload (default 4000)
      --no-autorestart             do not restart when the app exits
      --stop-exit-codes <a,b>      exit codes that must not trigger a restart
      --watch                      restart on file changes
      --watch-path <path>          what to watch (repeatable; default: the script)
      --ignore-watch <substr>      skip matching paths (repeatable)
      --cron <expr>                restart on a 5-field cron schedule
      --max-memory-restart <size>  restart above this RSS (e.g. 200M, 1G)
      --time                       prefix every log line with a timestamp
      --log-date-format <fmt>      pattern for --time (YYYY MM DD HH mm ss SSS)
      --no-merge-logs              one log file per instance (default: one per app)
      --log-rotate-size <size>     rotate a log file above this size (e.g. 10M)
      --log-rotate-keep <n>        rotated generations to keep      (default 5)
      --log-rotate-compress        gzip rotated files
      --wait-ready                 block until the app is ready (message or bound port)

list/describe/logs options
      --json                       machine-readable output
      --namespace <ns>             restrict to a namespace
  -f, --follow                     keep streaming (logs)
      --lines <n>                  how many lines to show (default 20)
      --out | --err                only one stream (logs)

Readiness: an app marks itself ready by sending a message before/while it
starts, e.g. \`if (process.send) process.send('ready')\`. Binding a TCP port
counts too. With --wait-ready, \`start\` (and \`reload\`) wait for either,
bounded by --listen-timeout.
`;

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

  if (flags.version || command === 'version') {
    process.stdout.write(`${NAME} ${require('../package.json').version}\n`);
    return EXIT_CODES.SUCCESS;
  }
  if (flags.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return flags.help || command === 'help' ? EXIT_CODES.SUCCESS : EXIT_CODES.ERROR;
  }

  try {
    switch (command) {
      case 'ping': return await ping();
      case 'start': return await start(positional[1], flags, passthrough);
      case 'list':
      case 'ls': return await list(flags);
      case 'describe':
      case 'desc': return await describe(positional[1], flags);
      case 'stop': return await simple('stop', positional[1], flags);
      case 'restart': return await simple('restart', positional[1], flags);
      case 'reload': return await simple('reload', positional[1], flags);
      case 'delete':
      case 'del': return await simple('delete', positional[1], flags);
      case 'scale': return await scale(positional[1], positional[2], flags);
      case 'logs': return await logs(positional[1], flags);
      case 'monit': return await monit(flags);
      case 'save': return await save();
      case 'resurrect': return await resurrect();
      case 'startup': return await startup(flags);
      case 'web': return await web(flags);
      case 'kill': return await kill();
      default:
        process.stderr.write(`${NAME}: unknown command "${command}"\n\n${HELP}`);
        return EXIT_CODES.ERROR;
    }
  } catch (err) {
    process.stderr.write(`${NAME}: ${err.message}\n`);
    return EXIT_CODES.ERROR;
  }
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
  if (!target) throw new Error('start requires a script or an ecosystem file');

  if (flags.config || looksLikeEcosystem(target)) {
    const apps = loadEcosystem(target, { env: flags.env, cwd: process.cwd() });
    const started = [];
    for (const app of apps) {
      const record = await client.call('start', normalizeStart(app, process.cwd()));
      started.push(record);
      printStarted(record);
    }
    process.stdout.write(`started ${started.length} app(s) from ${target}\n`);
    return EXIT_CODES.SUCCESS;
  }

  const record = await client.call('start', normalizeStart(startParamsFromFlags(target, flags, passthrough), process.cwd()));
  printStarted(record);
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

async function list(flags) {
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
  return EXIT_CODES.SUCCESS;
}

async function describe(target, flags) {
  if (!target) throw new Error('describe requires a name or id');
  // cwd travels with the request: the daemon resolves a script-path target
  // against the caller's directory, not against its own state home.
  const record = await client.callIfRunning('describe', { target, namespace: flags.namespace, cwd: process.cwd() });
  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  return EXIT_CODES.SUCCESS;
}

async function simple(method, target, flags) {
  if (!target) throw new Error(`${method} requires a name, id, or "all"`);
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
  if (!target || instances === undefined) throw new Error('scale requires a target and an instance count');
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
function formatLogLine(name, entry) {
  const slot = entry.slot === undefined || entry.slot === null ? '' : `[${entry.slot}] `;
  const stream = entry.which === 'err' ? 'ERR ' : '';
  const text = entry.text === undefined ? entry.line : entry.text;
  return `${name} | ${slot}${stream}${text}\n`;
}

async function logs(target, flags) {
  if (!target) throw new Error('logs requires a name or id');
  const lines = flags.lines === undefined ? 20 : Number(flags.lines);
  const params = { target, namespace: flags.namespace, cwd: process.cwd(), lines, which: flags.which };

  const initial = await client.callIfRunning('logs', params);
  if (flags.json && !flags.follow) {
    process.stdout.write(JSON.stringify(initial, null, 2) + '\n');
    return EXIT_CODES.SUCCESS;
  }
  for (const entry of initial.lines) process.stdout.write(formatLogLine(initial.name, entry));

  if (!flags.follow) return EXIT_CODES.SUCCESS;

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
    host: flags.host
  });
  process.stdout.write(`dashboard on ${result.url}\n`);
  if (result.warning) process.stderr.write(`${NAME}: ${result.warning}\n`);
  return EXIT_CODES.SUCCESS;
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
