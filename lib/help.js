'use strict';
/**
 * The text behind 'procman help', 'procman <command> --help' and the shell
 * completion. Kept in one place so the manuals, the global list and the
 * completion candidates cannot drift apart.
 */

const { NAME } = require('./constants');

const START_OPTIONS = `start options
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
      --wait-ready                 block until the app is ready (message or bound port)`;

const OUTPUT_OPTIONS = `list/describe/logs options
      --json                       machine-readable output
      --namespace <ns>             restrict to a namespace
  -f, --follow                     keep streaming until Ctrl-C (default on a terminal)
      --no-follow                  print the snapshot and exit
      --lines <n>                  how many lines to show (default 20)
      --out | --err                only one stream (logs)`;

// Same blocks without their title line, for manuals that already say "Options:".
const START_OPTIONS_LIST = START_OPTIONS.slice(START_OPTIONS.indexOf('\n') + 1);
const OUTPUT_OPTIONS_LIST = OUTPUT_OPTIONS.slice(OUTPUT_OPTIONS.indexOf('\n') + 1);

const TARGETS = `TARGETS
  an id (0), a name (web), "namespace:name" (staging:web), a script path, or
  'all' (stop/restart/reload/delete only). A bare name that matches nothing
  gives you the list of what does.`;

const HELP = `Usage: ${NAME} <command> [options]

Targets accepted by describe/stop/restart/reload/delete/logs/scale:
  an id (0), a name (web), "namespace:name" (staging:web), or a script path.

Process management
  start <file|config> [-- <args>]   start a script, or every app in an ecosystem file
  list | status                    list processes                        (--json)
  describe <name|id>               full details for one process
  stop     <name|id|all>           graceful stop, then SIGKILL
  restart  <name|id|all>           stop + start, keeping the options
  reload   <name|id|all>           zero-downtime reload (cluster mode)
  delete   <name|id|all>           stop and forget
  scale    <name|id> <n>           grow/shrink a cluster app (0 = one per CPU)
  log      [name|id]               tail logs, following until Ctrl-C (no name = every app)
  save | resurrect                 persist the list / replay it (used at boot)

Monitoring
  monit                            live view (q quit, c/m/n sort, up/down select)
                                   --interval <ms>  --sort <cpu|mem|name>

Daemon
  ping                             check that the daemon answers
  kill                             stop everything and shut the daemon down
  web [--port 9615] [--stop]       built-in dashboard (loopback only)
                                   --auth forces a login --no-auth turns it off
  user <list|add|passwd|rm> [name] dashboard accounts, stored in <home>/users.db
  startup [--install] [--user u]   generate (or install) the boot unit
  completion <bash|zsh>            print the tab-completion script  (--install)
  help [command]                   this list, or the manual for one command

Login: the dashboard asks for a password as soon as one user exists, so
\\\`procman user add <name>\\\` is all it takes to lock it down. Sessions are
HttpOnly + SameSite=Strict cookies; state-changing calls also require a
same-origin header, which a cross-site form cannot forge.

${START_OPTIONS}

${OUTPUT_OPTIONS}

Readiness: an app marks itself ready by sending a message before/while it
starts, e.g. \\\`if (process.send) process.send('ready')\\\`. Binding a TCP port
counts too. With --wait-ready, \\\`start\\\` (and \\\`reload\\\`) wait for either,
bounded by --listen-timeout.`;

/** One manual per command; aliases are resolved by manualFor(). */
const COMMAND_HELP = {
  start: `Usage: ${NAME} start <file|ecosystem> [options] [-- <app args>]

Starts a script, or every app of an ecosystem file (JS with apps: [...] , or
JSON). Options given here win over the ones inside the file. Everything after
'--' goes to the app as argv.

Paths: the script (and --cwd, --output, --error, --watch-path) resolve against
the directory you called from. Inside an ecosystem file, per-app paths resolve
against that app's own cwd, which is relative to the file — so
{ cwd: './backend', script: 'src/server.js' } means <config>/backend/src/server.js.

Examples:
  ${NAME} start server.js --name api
  ${NAME} start server.js --name api -i max -- --port 3000
  ${NAME} start ecosystem.config.js --env production
  ${NAME} start worker.js --cron "0 3 * * *" --no-autorestart
  ${NAME} start vite.js -n web --watch --ignore-watch node_modules

Options:
${START_OPTIONS_LIST}`,

  list: `Usage: ${NAME} list | ${NAME} status [--json] [--namespace <ns>]

One row per app: id, name, namespace, mode, instances, pid, the port it bound
(discovered from the app itself), status, cpu, memory, restarts, uptime, script.
'status' prints the same table plus a one-line summary; 'list' is the plain
table. Both take --json.

Reading never starts a daemon: with none running you get an empty table.

Examples:
  ${NAME} list
  ${NAME} status
  ${NAME} list --namespace ouvidoria
  ${NAME} list --json | jq '.[] | select(.status != "online")'

Options:
${OUTPUT_OPTIONS_LIST}`,

  describe: `Usage: ${NAME} describe <name|id> [--json]

Everything about one app, as JSON: pids and ports, mode/instances, cwd, args,
env keys, log files, memory limit, watch and cron settings, exit code, node
version, restart count. 'desc' is the same command.

Examples:
  ${NAME} describe api
  ${NAME} describe 0 | jq .ports

${TARGETS}`,

  stop: `Usage: ${NAME} stop <name|id|all> [--namespace <ns>]

Graceful stop: SIGINT first, then the kill_timeout window, then SIGTERM/SIGKILL. The app stays in the list (stopped) and stays in the dump, so resurrect brings it back.

Examples:
  ${NAME} stop web
  ${NAME} stop "ouvidoria:backend"
  ${NAME} stop all

${TARGETS}`,

  restart: `Usage: ${NAME} restart <name|id|all> [--namespace <ns>]

Stop and start again, keeping every option (args, env, cwd, instances). A stop caused by a restart does not consume the restart budget, so an app in a restart loop is not turned errored by you.

Examples:
  ${NAME} restart web
  ${NAME} restart "ouvidoria:backend"
  ${NAME} restart all

${TARGETS}`,

  reload: `Usage: ${NAME} reload <name|id|all> [--namespace <ns>]

Zero-downtime reload for cluster apps: workers are replaced one by one, the listener is handed over, and in-flight connections finish. New options are picked up; fork apps are just restarted. Use --listen-timeout to bound the wait for the new worker to report ready.

Examples:
  ${NAME} reload web
  ${NAME} reload "ouvidoria:backend"
  ${NAME} reload all

${TARGETS}`,

  delete: `Usage: ${NAME} delete <name|id|all> [--namespace <ns>]

Stops the app and forgets it: gone from the list and from the dump, logs on disk are kept. 'del' is the same command.

Examples:
  ${NAME} delete web
  ${NAME} delete "ouvidoria:backend"
  ${NAME} delete all

${TARGETS}`,

  scale: `Usage: ${NAME} scale <name|id> <n>

Grows or shrinks a cluster app to n workers, adding or retiring them one at a
time. 0 means one worker per CPU (same as 'max'). A fork app has nowhere to
scale to: the count stays 1.

Examples:
  ${NAME} scale api 4
  ${NAME} scale api 0      # one per CPU
  ${NAME} scale api 1      # back to a single worker

${TARGETS}`,

  logs: `Usage: ${NAME} logs [name|id] [--lines <n>] [--follow|--no-follow] [--out|--err]

Prints the last lines and, on a terminal, keeps streaming until Ctrl-C — the
same feel as 'pm2 logs'. When stdout is a pipe or a file it prints the snapshot
and exits, so redirections and scripts never hang; --follow forces streaming
even there, --no-follow forces the snapshot.

With no name it shows EVERY app at once: each line is prefixed with the app it
came from, and each app gets its own colour, so a busy stack stays readable.

'log' is a synonym. Colours only appear on a terminal; piping or redirecting
gives the bare text (FORCE_COLOR=1 asks for colours anyway, NO_COLOR=1 refuses).

Cluster: with merge_logs (the default) the workers share one file, so a tailed
line cannot be attributed to a worker — but live lines are, and each worker gets
its own colour. With --no-merge-logs every instance has its own file and the slot
is printed as [n], in the tail and live alike.

stdout and stderr are merged in time order; --out or --err select one stream.

Examples:
  ${NAME} logs
  ${NAME} logs api
  ${NAME} logs api --lines 200
  ${NAME} logs --err

Options:
${OUTPUT_OPTIONS_LIST}`,

  monit: `Usage: ${NAME} monit [--interval <ms>] [--sort <cpu|mem|name>]

Live table in the terminal: q quits, c/m/n/i sort by cpu, memory, name or id,
the arrow keys select a row, and the panel below follows the selected app's log.

Read-only on purpose: nothing here stops or restarts anything. When stdout is
not a terminal it prints one snapshot and exits, which is what you want in a
pipe or a script.

Examples:
  ${NAME} monit
  ${NAME} monit --interval 500 --sort mem
  ${NAME} monit > snapshot.txt`,

  save: `Usage: ${NAME} save | ${NAME} resurrect

'save' writes the current list to <home>/dump.json; 'resurrect' starts
everything in it that is not running yet (same name plus script = the same app),
so it is safe to call twice. 'startup --install' wires resurrect into the boot
unit, and this is also what 'kill' + 'resurrect' round-trip around an upgrade.

Examples:
  ${NAME} save
  ${NAME} kill && ${NAME} resurrect`,

  ping: `Usage: ${NAME} ping

Asks the daemon to answer, and prints its pid, version and state directory. It
starts the daemon if none is running — the cheapest way to check where procman
thinks it lives.`,

  kill: `Usage: ${NAME} kill

Stops every managed app and shuts the daemon down, waiting for it to actually
die before returning (so the next command in a script cannot talk to a daemon
on its way out). The list is not erased: 'save' was not called, but the state
file keeps the last dump, so 'resurrect' brings it back.

Examples:
  ${NAME} kill
  ${NAME} kill && ${NAME} resurrect`,

  web: `Usage: ${NAME} web [--port <n>] [--host <ip>] [--auth|--no-auth] [--stop]

Serves the dashboard, loopback by default. As soon as one user exists it asks
for a login; --auth forces the login (and fails if there is no user), --no-auth
turns it off. Binding outside loopback prints a warning. --stop shuts it down.

Examples:
  ${NAME} web
  ${NAME} web --port 9615
  ${NAME} user add admin && ${NAME} web --auth
  ${NAME} web --stop`,

  user: `Usage: ${NAME} user <list|add|passwd|rm> [name] [--password <pw>]

Dashboard accounts, stored in <home>/users.db (SQLite, from Node itself).
Passwords are hashed with scrypt and never printed; 'list' shows only name,
created at, last login and active sessions. Passwords come from --password, from
stdin when piped, or from a hidden prompt.

Examples:
  ${NAME} user add admin
  echo "s3cret-pass" | ${NAME} user add ci
  ${NAME} user list
  ${NAME} user passwd admin
  ${NAME} user rm admin
  ${NAME} user rm --all

Requires node:sqlite (Node >= 23.4, or 22.5+ with --experimental-sqlite).`,

  startup: `Usage: ${NAME} startup [--install] [--user <u>]

Prints (or with --install, writes) the boot unit that runs 'procman resurrect'
at login: a systemd user unit on Linux, a launchd plist on macOS. --user picks
the account for a system-wide install (Linux, needs root).

Examples:
  ${NAME} startup
  ${NAME} startup --install`,

  completion: `Usage: ${NAME} completion <bash|zsh> [--install]

Prints the tab-completion script. It completes commands, options, and live app
names (including namespace:name), plus ecosystem files and dashboard users where
they make sense. --install appends a marked block to your shell rc (~/.bashrc,
~/.zshrc) instead of printing, and is idempotent.

Examples:
  ${NAME} completion bash
  eval "$(${NAME} completion bash)"
  ${NAME} completion zsh --install
  source ~/.bashrc`,

  help: `Usage: ${NAME} help [command]

With no argument, the command list. With a command, its manual — the same text
as '<command> --help'. 'ls', 'status', 'desc' and 'del' resolve to their base
command.

Examples:
  ${NAME} help
  ${NAME} help start
  ${NAME} start --help`,

};

const ALIASES = {
  ls: 'list', status: 'list', desc: 'describe', del: 'delete', log: 'logs',
  remove: 'user', 'user-list': 'user'
};

/** Everything that is a valid first word, aliases included. */
const COMMANDS = [
  'start', 'list', 'ls', 'status', 'describe', 'desc', 'stop', 'restart',
  'reload', 'delete', 'del', 'scale', 'logs', 'log', 'monit', 'save', 'resurrect',
  'ping', 'kill', 'web', 'user', 'startup', 'completion', 'help', 'version'
];

function manualFor(name) {
  if (!name) return HELP;
  const key = ALIASES[name] || name;
  return COMMAND_HELP[key] || null;
}

module.exports = { HELP, COMMAND_HELP, COMMANDS, ALIASES, manualFor };
