'use strict';

/**
 * A small 5-field cron matcher, enough for restarts.
 *
 *   ┌───────── minute        (0-59)
 *   │ ┌─────── hour          (0-23)
 *   │ │ ┌───── day of month  (1-31)
 *   │ │ │ ┌─── month         (1-12)
 *   │ │ │ │ ┌─ day of week   (0-6, 0 = Sunday)
 *   * * * * *
 *
 * Supported per field: `*`, `a`, `a-b`, `* /n`, `a-b/n`, and comma lists.
 * Names (MON, JAN) and 6-field (seconds) expressions are NOT supported; the
 * parser reports that instead of silently mis-scheduling.
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 }
];

function parseField(spec, field) {
  if (spec === '*') return null; // null means "any"
  const allowed = new Set();
  for (const part of spec.split(',')) {
    if (!part) throw new Error(`${field.name}: empty term in "${spec}"`);
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${field.name}: bad step in "${part}"`);

    let lo;
    let hi;
    if (range === '*') {
      lo = field.min;
      hi = field.max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`${field.name}: bad range in "${part}"`);
      lo = a; hi = b;
    } else {
      const value = Number(range);
      if (!Number.isInteger(value)) throw new Error(`${field.name}: bad value in "${part}"`);
      lo = value;
      hi = stepText === undefined ? value : field.max;
    }
    if (lo < field.min || hi > field.max || lo > hi) throw new Error(`${field.name}: out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

class CronSchedule {
  constructor(expression) {
    this.expression = String(expression).trim();
    const parts = this.expression.split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`cron "${this.expression}" must have 5 fields (seconds are not supported)`);
    }
    if (/[a-zA-Z]/.test(this.expression)) {
      throw new Error(`cron "${this.expression}": names are not supported, use numbers`);
    }
    this.fields = parts.map((spec, i) => parseField(spec, FIELDS[i]));
  }

  /** Does this schedule fire at the given minute? */
  matches(date) {
    const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
    return this.fields.every((allowed, i) => allowed === null || allowed.has(values[i]));
  }
}

/**
 * Calls `onFire` at most once per matching minute.
 * A ticker is simpler and far more predictable than computing the next date.
 */
class CronRunner {
  constructor(expression, onFire, { intervalMs = 20000, now = () => new Date() } = {}) {
    this.schedule = new CronSchedule(expression);
    this.onFire = onFire;
    this.intervalMs = intervalMs;
    this.now = now;
    this.lastFiredMinute = null;
    this.timer = null;
  }

  start() {
    const tick = () => {
      const date = this.now();
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
      if (key !== this.lastFiredMinute && this.schedule.matches(date)) {
        this.lastFiredMinute = key;
        this.onFire();
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { CronSchedule, CronRunner };
