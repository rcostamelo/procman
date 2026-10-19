'use strict';

const fs = require('fs');

/**
 * Resource sampling, Linux-first, with an honest fallback.
 *
 * `null` means "we do not know", never 0 — reporting 0% CPU for a busy process
 * is worse than reporting nothing, because it looks like real data.
 */

const HZ = 100; // USER_HZ on Linux is 100 for all practical purposes

/** "100M" / "1.5g" / 2048 -> bytes, or null when unparseable. */
function parseMemory(text) {
  if (text === null || text === undefined || text === false || text === '') return null;
  if (typeof text === 'number') return Number.isFinite(text) ? Math.round(text) : null;
  const match = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit];
  return Math.round(value * scale);
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

function readStatm(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/);
  } catch (err) {
    return null;
  }
}

function readStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field can contain spaces and parentheses: split after the last ')'
    const close = raw.lastIndexOf(')');
    if (close === -1) return null;
    const rest = raw.slice(close + 2).split(/\s+/);
    // rest[11] = utime, rest[12] = stime (fields 14 and 15 of the full line)
    return { utime: Number(rest[11]), stime: Number(rest[12]) };
  } catch (err) {
    return null;
  }
}

function readMemory(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  const statm = readStatm(pid);
  if (!statm) return null;
  const residentPages = parseInt(statm[1], 10);
  if (!Number.isFinite(residentPages)) return null;
  return residentPages * 4096;
}

/**
 * CPU needs two samples, so the sampler remembers the previous tick per pid.
 * Percentages are per-core (100% == one core saturated), like `top`.
 */
class Sampler {
  constructor() {
    this.previous = new Map(); // pid -> { ticks, at }
  }

  /** Returns { cpu, memory } where either may be null. */
  sample(pid) {
    if (!pid) return { cpu: null, memory: null };
    const memory = readMemory(pid);
    if (process.platform !== 'linux') return { cpu: null, memory };

    const stat = readStat(pid);
    if (!stat) {
      this.previous.delete(pid);
      return { cpu: null, memory };
    }
    const ticks = stat.utime + stat.stime;
    const at = Date.now();
    const before = this.previous.get(pid);
    this.previous.set(pid, { ticks, at });

    if (!before) return { cpu: null, memory };
    const deltaTicks = ticks - before.ticks;
    const deltaMs = at - before.at;
    if (deltaMs <= 0 || deltaTicks < 0) return { cpu: null, memory };
    const cpu = (deltaTicks / HZ) / (deltaMs / 1000) * 100;
    return { cpu: Number.isFinite(cpu) ? cpu : null, memory };
  }

  forget(pid) {
    this.previous.delete(pid);
  }
}

module.exports = { parseMemory, formatBytes, readMemory, Sampler, HZ };
