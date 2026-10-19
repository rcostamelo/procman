'use strict';

/**
 * Every user-visible name lives here so a rename is a one-line change.
 * (package.json "bin" must be renamed too, plus the README.)
 */
const NAME = 'procman';

const ENV_PREFIX = NAME.toUpperCase(); // PROCMAN_HOME, PROCMAN_DEBUG, ...

/** Process states. Kept small on purpose. */
const STATUS = {
  ONLINE: 'online',
  STOPPED: 'stopped',
  STOPPING: 'stopping',
  LAUNCHING: 'launching',
  WAITING_RESTART: 'waiting restart',
  ERRORED: 'errored'
};

const MODE = {
  FORK: 'fork',
  CLUSTER: 'cluster'
};

/** Defaults, named so the CLI and the API can share them. */
const DEFAULTS = {
  INSTANCES: 1,
  NAMESPACE: 'default',
  MIN_UPTIME: 1000,            // ms a process must live to count as "stable"
  MAX_RESTARTS: 16,            // unstable restarts before giving up
  RESTART_DELAY: 0,            // ms before an automatic restart
  KILL_TIMEOUT: 1600,          // ms between graceful signal and SIGKILL
  KILL_SIGNAL: 'SIGINT',       // graceful signal (SIGINT matches the reference)
  KILL_RETRY_TIME: 100,        // ms polling interval while waiting for death
  LISTEN_TIMEOUT: 4000,        // ms to wait for a worker to announce `listening`
  MONITOR_INTERVAL: 1000,      // ms between resource samples
  WATCH_DEBOUNCE: 300,         // ms to coalesce filesystem events
  BACKOFF_STEP: 100,           // ms added per unstable restart
  BACKOFF_MAX: 5000,           // ms ceiling for the backoff delay
  AUTORESTART: true,
  RESTART_CRON: null,
  MAX_MEMORY_RESTART: null,    // bytes, or null
  TIME_PREFIX: false,          // prefix each log line with a timestamp
  LOG_ROTATE_KEEP: 5,          // rotated generations to keep, when rotating
  MONIT_INTERVAL: 1000         // ms between `monit` screen refreshes
};

const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1
};

/**
 * Paths/dirs that are almost never worth watching. Matching is
 * case-sensitive substring on the absolute path, which is enough for the
 * common offenders and stays predictable.
 */
const DEFAULT_WATCH_IGNORE = ['node_modules', '/.git/', '/.svn/', '/.hg/'];

module.exports = { NAME, ENV_PREFIX, STATUS, MODE, DEFAULTS, EXIT_CODES, DEFAULT_WATCH_IGNORE };
