'use strict';

const fs = require('fs');

/**
 * Kill a process and its descendants.
 *
 * Fork-mode children are spawned detached, so a single `process.kill(-pid)`
 * already covers the whole group. Cluster workers are NOT detached (cluster
 * owns them), so for those we have to find the descendants ourselves.
 *
 * Linux only: we read /proc. Elsewhere this degrades to killing just the pid.
 */

function buildParentMap() {
  const parents = new Map(); // ppid -> [pid]
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (err) {
    return parents;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch (err) {
      continue; // process vanished between readdir and read
    }
    const close = stat.lastIndexOf(')');
    if (close === -1) continue;
    const ppid = Number(stat.slice(close + 2).split(/\s+/)[1]);
    if (!Number.isFinite(ppid)) continue;
    if (!parents.has(ppid)) parents.set(ppid, []);
    parents.get(ppid).push(Number(name));
  }
  return parents;
}

/** Depth-first list of descendants, deepest first (safe kill order). */
function descendants(pid) {
  if (process.platform !== 'linux') return [];
  const parents = buildParentMap();
  const out = [];
  const walk = (current) => {
    for (const child of parents.get(current) || []) {
      walk(child);
      out.push(child);
    }
  };
  walk(pid);
  return out;
}

function treeKill(pid, signal) {
  if (!pid) return [];
  const killed = [];
  for (const child of descendants(pid)) {
    try { process.kill(child, signal); killed.push(child); } catch (err) { /* gone */ }
  }
  try { process.kill(pid, signal); killed.push(pid); } catch (err) { /* gone */ }
  return killed;
}

module.exports = { treeKill, descendants };
