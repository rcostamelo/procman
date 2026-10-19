'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/**
 * Per-application log handling.
 *
 * Three things make this more than `createWriteStream`:
 *  - chunks are split into COMPLETE LINES, so `logs --follow` can print real
 *    lines and a timestamp prefix lands at the start of each line (prefixing raw
 *    chunks would put a timestamp in the middle of a line)
 *  - every finished line is also emitted on the bus, which is what the
 *    streaming subscribers in the daemon consume
 *  - files can be size-rotated (optionally gzipped) without losing writes that
 *    arrive while a rotation is in flight
 */

const TIME_TOKENS = /YYYY|YY|MM|DD|HH|mm|ss|SSS|ISO/g;

/** PM2-compatible default for `--time`. */
const DEFAULT_TIME_FORMAT = 'YYYY-MM-DD HH:mm:ss';

/** Token-based date formatting. Unknown tokens are left alone. */
function formatDate(ms, pattern = DEFAULT_TIME_FORMAT) {
  const d = new Date(ms);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const map = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    SSS: pad(d.getMilliseconds(), 3),
    ISO: d.toISOString()
  };
  return String(pattern).replace(TIME_TOKENS, (token) => map[token]);
}

/**
 * A file writer that rotates itself when it grows past `size`.
 *
 * Rotation happens between writes, never inside one: the current stream is
 * closed (which flushes it), the file is renamed to `<file>.<timestamp>`, an
 * optional gzip pass runs in the background, old generations are pruned, and a
 * fresh file is opened. Anything written while that is in flight is queued and
 * replayed, so no line is lost or split.
 */
class RotatingWriter {
  constructor(file, { size = null, keep = 5, compress = false } = {}) {
    this.file = file;
    this.size = size && size > 0 ? size : null;
    this.keep = keep > 0 ? keep : 5;
    this.compress = !!compress;
    this.queue = [];
    this.rotating = false;
    this.closed = false;
    this.stream = null;
    this.written = 0;
    this._open();
  }

  _open() {
    // Materialise the path before handing it to the stream: after a rotation
    // renames the old file there must be no window where the live log does not
    // exist (readers such as `logs`/the dashboard would see ENOENT).
    try { fs.closeSync(fs.openSync(this.file, 'a')); } catch (err) { /* best effort */ }
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.stream.on('error', () => { /* a failed log must never kill the app */ });
    this.written = this._statSize();
  }

  _statSize() {
    try { return fs.statSync(this.file).size; } catch (err) { return 0; }
  }

  write(text) {
    if (this.closed) return;
    if (this.rotating) { this.queue.push(text); return; }

    const bytes = Buffer.byteLength(text);
    // Rotate when the NEXT write would cross the limit; if the file is already
    // over it (left behind by a previous run), rotate before writing.
    if (this.size && this.written > 0 && this.written + bytes > this.size) {
      this.queue.push(text);
      this._rotate();
      return;
    }
    this.stream.write(text);
    this.written += bytes;
  }

  _rotate() {
    this.rotating = true;
    const target = this._rotateTarget();

    this.stream.end(() => {
      try { fs.renameSync(this.file, target); } catch (err) { /* nothing to rotate */ }
      if (this.compress) this._compress(target);
      this._prune();
      if (this.closed) { this.rotating = false; this.queue = []; return; }
      this._open();
      this.rotating = false;
      const pending = this.queue;
      this.queue = [];
      for (const item of pending) this.write(item);
    });
  }

  /**
   * A name that does not already exist. The stamp has second resolution, so a
   * burst of writes can rotate many times within one second; without the suffix
   * every one of those generations would overwrite the previous one.
   */
  _rotateTarget() {
    const stamp = formatDate(Date.now(), 'YYYY-MM-DDTHH-mm-ss');
    let target = `${this.file}.${stamp}`;
    let n = 0;
    while (fs.existsSync(target) || fs.existsSync(`${target}.gz`)) {
      n += 1;
      target = `${this.file}.${stamp}-${n}`;
    }
    return target;
  }

  /** gzip the rotated file in the background, then drop the plain one. */
  _compress(target) {
    fs.readFile(target, (readErr, buffer) => {
      if (readErr) return;
      zlib.gzip(buffer, (zipErr, zipped) => {
        if (zipErr) return;
        fs.writeFile(`${target}.gz`, zipped, (writeErr) => {
          if (writeErr) return;
          fs.unlink(target, () => { /* best effort */ });
          // Compression finished after the prune that followed the rename, so
          // the bound has to be re-applied now that the generation is whole.
          this._prune();
        });
      });
    });
  }

  /**
   * Keep the newest `keep` generations; timestamps sort chronologically.
   *
   * A generation counts once even though it can exist as both `<stamp>` (still
   * being compressed) and `<stamp>.gz`.
   */
  _prune() {
    const prefix = `${path.basename(this.file)}.`;
    const dir = path.dirname(this.file);
    let entries;
    try {
      entries = fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
    } catch (err) {
      return;
    }

    const generations = new Map();
    for (const name of entries.sort()) {
      const key = name.replace(/\.gz$/, '');
      if (!generations.has(key)) generations.set(key, []);
      generations.get(key).push(name);
    }

    const keys = [...generations.keys()];
    const excess = keys.slice(0, Math.max(0, keys.length - this.keep));
    for (const key of excess) {
      for (const name of generations.get(key)) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (err) { /* best effort */ }
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.rotating && this.stream && !this.stream.destroyed) {
      try { this.stream.end(); } catch (err) { /* ignore */ }
    }
  }
}

class LogStream {
  constructor({ id, name, outPath, errPath, time = false, dateFormat = null, bus = null, rotation = null }) {
    this.id = id;
    this.name = name;
    this.time = time;
    this.dateFormat = dateFormat || DEFAULT_TIME_FORMAT;
    this.bus = bus;
    this.writers = {
      out: new RotatingWriter(outPath, rotation || {}),
      err: new RotatingWriter(errPath, rotation || {})
    };
    this.partials = { out: '', err: '' };
    this.closed = false;
  }

  get outPath() { return this.writers.out.file; }
  get errPath() { return this.writers.err.file; }

  /** Write a raw chunk, splitting it into lines. */
  write(which, chunk) {
    if (this.closed) return;
    const text = this.partials[which] + chunk.toString('utf8');
    const lines = text.split('\n');
    this.partials[which] = lines.pop(); // trailing partial line stays buffered
    for (const raw of lines) this._emit(which, raw.replace(/\r$/, ''));
  }

  /** Flush a buffered partial line (called when the process exits). */
  flush(which) {
    if (this.closed) return;
    const rest = this.partials[which];
    if (rest) {
      this.partials[which] = '';
      this._emit(which, rest.replace(/\r$/, ''));
    }
  }

  _emit(which, line) {
    const at = Date.now();
    const prefix = this.time ? formatDate(at, this.dateFormat) + ' ' : '';
    const writer = this.writers[which];
    if (!this.closed && writer) writer.write(prefix + line + '\n');
    if (this.bus) {
      this.bus.emit('log', {
        id: this.id,
        name: this.name,
        which,
        line,
        at,
        // what the user actually sees in the file, timestamp included
        text: prefix + line
      });
    }
  }

  close() {
    if (this.closed) return;
    this.flush('out');
    this.flush('err');
    this.closed = true;
    for (const writer of Object.values(this.writers)) writer.close();
  }
}

/** Last `n` lines of a file, without loading the whole thing. */
function readTail(file, n = 20) {
  let stat;
  try { stat = fs.statSync(file); } catch (err) { return []; }
  if (stat.size === 0) return [];

  const maxBytes = 1024 * 1024; // 1 MiB is plenty for a tail
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }

  const lines = buffer.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing newline
  if (start > 0) lines.shift(); // the first line is probably cut in half
  return lines.slice(-n);
}

module.exports = { LogStream, RotatingWriter, readTail, formatDate, DEFAULT_TIME_FORMAT };
