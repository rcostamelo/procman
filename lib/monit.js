'use strict';

const readline = require('readline');
const { DEFAULTS, NAME, EXIT_CODES } = require('./constants');
const { formatBytes } = require('./monitor');
const { uptime, table } = require('./output');

/**
 * `procman monit` — a live view of the process table.
 *
 * Deliberately READ-ONLY: a monitor that can also kill things is a footgun in
 * the hands of someone who is just looking at a spike. Restart/stop/delete stay
 * in the CLI, where the target is explicit.
 *
 * Zero dependencies: ANSI escapes for the frame, `readline` for the keys, and
 * the same `list`/`logs` RPCs the CLI already uses. Rendering never clears the
 * whole screen (no flicker): it homes the cursor, rewrites each line, and clears
 * the tail.
 */

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const HISTORY = 16;
const LOG_PANE_MAX = 12;
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const REVERSE = '\x1b[7m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

class Monitor {
  constructor(client, { intervalMs = DEFAULTS.MONIT_INTERVAL, sort = 'cpu' } = {}) {
    this.client = client;
    this.intervalMs = Math.max(200, intervalMs);
    this.sort = ['cpu', 'mem', 'name', 'id'].includes(sort) ? sort : 'cpu';
    this.rows = [];
    this.history = new Map(); // id -> number[]
    this.selectedId = null;
    this.logLines = [];
    this.notice = null;
    this.stopped = false;
    this.timer = null;
    this.busy = false;
  }

  async run() {
    this._enterRawMode();
    try {
      await this._tick();
      this.timer = setInterval(() => { this._tick(); }, this.intervalMs);
      await new Promise((resolve) => { this._done = resolve; });
    } finally {
      clearInterval(this.timer);
      this._leaveRawMode();
    }
    return EXIT_CODES.SUCCESS;
  }

  // ------------------------------------------------------------- terminal ---

  _enterRawMode() {
    process.stdout.write('\x1b[?25l'); // hide the cursor
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    this.onKey = (str, key) => this._handleKey(str, key);
    process.stdin.on('keypress', this.onKey);
    this.onSigint = () => this.stop();
    process.on('SIGINT', this.onSigint);
    process.on('SIGTERM', this.onSigint);
  }

  _leaveRawMode() {
    process.stdin.removeListener('keypress', this.onKey);
    process.off('SIGINT', this.onSigint);
    process.off('SIGTERM', this.onSigint);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${RESET}\x1b[J\x1b[?25h`); // reset, clear tail, show cursor
  }

  _handleKey(str, key = {}) {
    const name = key.name;
    if (name === 'q' || (key.ctrl && name === 'c')) return this.stop();
    if (name === 'c') return void (this.sort = 'cpu');
    if (name === 'm') return void (this.sort = 'mem');
    if (name === 'n') return void (this.sort = 'name');
    if (name === 'i') return void (this.sort = 'id');
    const index = this._sorted().findIndex((r) => r.id === this.selectedId);
    if (name === 'down' || name === 'j') return this._select(index + 1);
    if (name === 'up' || name === 'k') return this._select(index - 1);
  }

  _select(index) {
    const rows = this._sorted();
    if (rows.length === 0) return;
    const bounded = Math.min(Math.max(index, 0), rows.length - 1);
    this.selectedId = rows[bounded].id;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this._done) this._done();
  }

  // ---------------------------------------------------------------- data ---

  async _tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const rows = await this.client.callIfRunning('list');
      this.rows = rows;
      for (const row of rows) {
        const series = this.history.get(row.id) || [];
        series.push(row.cpu === null || row.cpu === undefined ? 0 : row.cpu);
        while (series.length > HISTORY) series.shift();
        this.history.set(row.id, series);
      }
      for (const id of [...this.history.keys()]) {
        if (!rows.some((r) => r.id === id)) this.history.delete(id);
      }
      if (this.selectedId === null && rows.length) this.selectedId = rows[0].id;
      if (this.selectedId !== null && !rows.some((r) => r.id === this.selectedId)) this.selectedId = null;
      await this._loadLogs();
      this.notice = null;
    } catch (err) {
      this.notice = err.code === 'NO_DAEMON'
        ? 'daemon is gone — press q to exit'
        : `${err.message} — press q to exit`;
    } finally {
      this.busy = false;
    }
    this.render();
  }

  async _loadLogs() {
    if (this.selectedId === null) {
      this.logLines = [];
      return;
    }
    const result = await this.client.callIfRunning('logs', { target: this.selectedId, lines: LOG_PANE_MAX });
    this.logLines = result.lines.map((entry) => {
      const slot = entry.slot === undefined || entry.slot === null ? '' : `[${entry.slot}] `;
      return `${entry.which === 'err' ? 'ERR ' : ''}${slot}${entry.line}`;
    });
  }

  _sorted() {
    const rows = [...this.rows];
    const cpu = (r) => (r.cpu === null || r.cpu === undefined ? -1 : r.cpu);
    const mem = (r) => (r.memory === null || r.memory === undefined ? -1 : r.memory);
    if (this.sort === 'cpu') rows.sort((a, b) => cpu(b) - cpu(a) || a.name.localeCompare(b.name));
    else if (this.sort === 'mem') rows.sort((a, b) => mem(b) - mem(a) || a.name.localeCompare(b.name));
    else if (this.sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    else rows.sort((a, b) => a.id - b.id);
    return rows;
  }

  // -------------------------------------------------------------- render ---

  render() {
    const width = Math.max(60, process.stdout.columns || 100);
    const height = Math.max(12, process.stdout.rows || 24);
    const rows = this._sorted();
    const cols = this._columns(width);
    const lines = [];

    lines.push(this._header(width));
    lines.push('');
    lines.push(this._tableHeader(cols));

    const selectedIndex = rows.findIndex((r) => r.id === this.selectedId);
    for (let i = 0; i < rows.length; i++) {
      lines.push(this._row(rows[i], i === selectedIndex, cols, width));
    }
    if (rows.length === 0) lines.push(`${DIM}  (no processes)${RESET}`);

    // Give the log pane whatever vertical space is left, within reason.
    const used = lines.length + 3; // + log header, footer, spare
    const paneHeight = Math.min(LOG_PANE_MAX, Math.max(3, height - used));
    lines.push('');
    lines.push(this._logHeader(width));
    for (const line of this.logLines.slice(-paneHeight)) {
      lines.push(`${DIM}  ${clip(line, width - 4)}${RESET}`);
    }

    const footer = this.notice
      ? `  ${RED}${clip(this.notice, width - 4)}${RESET}`
      : `  ${DIM}${clip('q quit   c/m/n/i sort by cpu/mem/name/id   up/down select', width - 4)}${RESET}`;

    const frame = lines.slice(0, height - 1).map((line) => `${line}\x1b[K`).join('\n');
    process.stdout.write(`\x1b[H${frame}\n${footer}\x1b[K\x1b[J`);
  }

  _header(width) {
    const online = this.rows.filter((r) => r.status === 'online');
    const totalCpu = online.reduce((sum, r) => sum + (r.cpu || 0), 0);
    const totalMem = online.reduce((sum, r) => sum + (r.memory || 0), 0);
    const right = `${this.rows.length} process(es)   ` +
      `cpu ${totalCpu.toFixed(1)}%   mem ${formatBytes(totalMem)}   ` +
      `sort: ${this.sort}   ${new Date().toLocaleTimeString()}`;
    const tag = `${BOLD}${NAME} monit${RESET}`;
    // Escapes are invisible, so the plain text is what gets measured/clipped.
    return `  ${tag}${DIM}  ${clip(right, Math.max(10, width - 17))}${RESET}`;
  }

  /**
   * Columns are shed (never truncated mid-value) as the terminal narrows, so
   * the live view stays readable on an 80-column pty as well as a wide one.
   */
  _columns(width) {
    const budget = width - 2; // the two spaces of indent
    const specs = [
      { key: 'id', header: 'id', w: 3, get: (r) => r.id },
      { key: 'name', header: 'name', w: 16, get: (r) => r.name },
      { key: 'ns', header: 'ns', w: 10, get: (r) => r.namespace },
      { key: 'mode', header: 'mode', w: 7, get: (r) => r.mode },
      { key: 'inst', header: 'inst', w: 4, align: 'right', get: (r) => r.instances },
      { key: 'pid', header: 'pid', w: 20, get: (r) => (r.pid ? String(r.pid) : '-') },
      { key: 'port', header: 'port', w: 7, align: 'right', get: (r) => (r.port == null ? '-' : String(r.port)) },
      { key: 'status', header: 'status', w: 14, status: true, get: (r) => r.status },
      {
        key: 'cpu',
        header: 'cpu',
        w: 6,
        align: 'right',
        get: (r) => (r.cpu === null || r.cpu === undefined ? '-' : `${r.cpu.toFixed(1)}%`)
      },
      { key: 'mem', header: 'mem', w: 8, align: 'right', get: (r) => formatBytes(r.memory) },
      { key: 'restarts', header: 'restarts', w: 8, align: 'right', get: (r) => r.restarts },
      { key: 'uptime', header: 'uptime', w: 7, align: 'right', get: (r) => uptime(r.uptime_ms) },
      { key: 'history', header: 'history', w: HISTORY, get: (r) => this._spark(this.history.get(r.id) || []) }
    ];

    // Cheapest detail goes first, so a narrow terminal keeps the essentials.
    const plan = [
      { drop: 'history' },
      { set: 'pid', w: 12 },
      { drop: 'ns' },
      { set: 'name', w: 14 },
      { set: 'pid', w: 8 },
      { set: 'name', w: 11 },
      { drop: 'restarts' },
      { drop: 'port' },
      { drop: 'mode' },
      { set: 'status', w: 10 },
      { drop: 'uptime' }
    ];

    const dropped = new Set();
    const build = () => specs.filter((spec) => !dropped.has(spec.key));
    const total = (cols) => cols.reduce((sum, col) => sum + col.w, 0) + Math.max(0, cols.length - 1);

    let cols = build();
    for (const step of plan) {
      if (total(cols) <= budget) break;
      if (step.drop) dropped.add(step.drop);
      if (step.set) specs.find((spec) => spec.key === step.set).w = step.w;
      cols = build();
    }
    return cols;
  }

  static _cell(col, row) {
    const value = col.get(row);
    const text = clip(value === null || value === undefined ? '' : String(value), col.w);
    return col.align === 'right' ? text.padStart(col.w) : text.padEnd(col.w);
  }

  _tableHeader(cols) {
    const cells = cols.map((col) => (col.align === 'right' ? col.header.padStart(col.w) : col.header.padEnd(col.w)));
    return `${DIM}  ${cells.join(' ')}${RESET}`;
  }

  _row(row, selected, cols, width) {
    const color = row.status === 'online' ? GREEN : row.status === 'errored' ? RED : YELLOW;
    const cells = cols.map((col) => {
      const cell = Monitor._cell(col, row);
      // Colours go on LAST: an escape inside the row would cancel the reverse
      // video of a selected line halfway through it.
      return col.status && !selected ? `${color}${cell}${RESET}` : cell;
    });
    const line = clipVisible(`  ${cells.join(' ')}`, width);
    return selected ? `${REVERSE}${line}${RESET}` : line;
  }

  _spark(series) {
    if (!series.length) return '';
    const max = Math.max(...series, 1);
    return series
      .slice(-HISTORY)
      .map((value) => SPARK[Math.min(SPARK.length - 1, Math.round((value / max) * (SPARK.length - 1)))])
      .join('');
  }

  _logHeader() {
    if (this.selectedId === null) return `  ${DIM}logs: select a process to follow its output${RESET}`;
    const row = this.rows.find((r) => r.id === this.selectedId);
    const label = row ? `${row.name} (id ${row.id})` : `id ${this.selectedId}`;
    const files = row && row.log_files ? `  ${row.log_files.map((f) => f.out).join(' ')}` : '';
    return `  ${BOLD}logs: ${label}${RESET}${DIM}${clip(files, 60)}${RESET}`;
  }
}

// ------------------------------------------------------------------ helpers --

function clip(text, width) {
  const clean = String(text ?? '');
  if (clean.length <= width) return clean;
  return clean.slice(0, Math.max(0, width - 1)) + '…';
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Visible width of a string that may carry SGR escapes. */
function visibleLength(text) {
  return String(text ?? '').replace(ANSI_PATTERN, '').length;
}

/**
 * Clip to `width` VISIBLE characters.
 *
 * Plain `clip()` would count the escape sequences of a coloured cell as
 * content, so a coloured row would silently lose real characters and grow a
 * spurious ellipsis.
 */
function clipVisible(text, width) {
  const value = String(text ?? '');
  if (visibleLength(value) <= width) return value;

  let out = '';
  let visible = 0;
  for (let i = 0; i < value.length;) {
    const match = /^\x1b\[[0-9;]*m/.exec(value.slice(i));
    if (match) {
      out += match[0];
      i += match[0].length;
      continue;
    }
    if (visible >= width - 1) break;
    out += value[i];
    visible += 1;
    i += 1;
  }
  return `${out}…${RESET}`; // the trailing reset also closes any open colour
}

/** Non-interactive fallback: print one snapshot and leave. */
function plainSnapshot(rows) {
  return table(rows.map((r) => Object.assign({}, r, {
    statusText: r.status,
    uptimeText: uptime(r.uptime_ms),
    memoryText: formatBytes(r.memory),
    cpuText: r.cpu === null || r.cpu === undefined ? '-' : `${r.cpu.toFixed(1)}%`
  })), [
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
    { header: 'uptime', get: (r) => r.uptimeText }
  ]);
}

async function runMonit(client, opts = {}) {
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  try {
    // A monitor must never bring a daemon up just to look at nothing.
    await client.callIfRunning('ping');
  } catch (err) {
    if (err.code === 'NO_DAEMON') {
      process.stderr.write(`${NAME}: daemon is not running\n`);
      return EXIT_CODES.ERROR;
    }
    throw err;
  }

  if (!interactive) {
    const rows = await client.callIfRunning('list');
    process.stdout.write(plainSnapshot(rows));
    process.stderr.write(`${NAME}: not a tty, printed one snapshot\n`);
    return EXIT_CODES.SUCCESS;
  }

  return new Monitor(client, opts).run();
}

module.exports = { runMonit, Monitor, plainSnapshot };
