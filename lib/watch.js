'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_WATCH_IGNORE, DEFAULTS } = require('./constants');

/**
 * File watching with zero dependencies.
 *
 * Node's fs.watch gained recursive support on Linux in Node 20, which is what
 * makes this viable without chokidar. Recursive watching has real limits: on
 * some platforms/editors the events are coarse (a single rename for a whole
 * subtree). That is fine here — the only action is "restart the app".
 */
class Watcher {
  constructor(paths, onTrigger, { debounce = DEFAULTS.WATCH_DEBOUNCE, ignore = [] } = {}) {
    this.paths = [...new Set(paths.map((p) => path.resolve(p)))];
    this.onTrigger = onTrigger;
    this.debounce = debounce;
    this.ignore = [...DEFAULT_WATCH_IGNORE, ...ignore];
    this.watchers = [];
    this.timer = null;
    this.changed = new Set();
  }

  start() {
    for (const target of this.paths) {
      let stat;
      try { stat = fs.statSync(target); } catch (err) { continue; }
      // Watch the file's directory: watching a single file stops working when
      // editors replace it (write + rename), which is the common case.
      const dir = stat.isDirectory() ? target : path.dirname(target);
      try {
        const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
          const changed = filename ? path.join(dir, filename.toString()) : dir;
          if (this._ignored(changed)) return;
          this.changed.add(changed);
          this._schedule();
        });
        watcher.on('error', () => { /* a dead watcher must not kill the daemon */ });
        this.watchers.push(watcher);
      } catch (err) {
        // Not fatal: the app keeps running, it just will not auto-restart.
      }
    }
    return this;
  }

  _ignored(changed) {
    const absolute = path.resolve(changed);
    return this.ignore.some((pattern) => absolute.includes(pattern)) || changed.endsWith('.log');
  }

  _schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const changed = [...this.changed];
      this.changed.clear();
      this.onTrigger(changed);
    }, this.debounce);
    if (this.timer.unref) this.timer.unref();
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const watcher of this.watchers) {
      try { watcher.close(); } catch (err) { /* ignore */ }
    }
    this.watchers = [];
  }
}

module.exports = { Watcher };
