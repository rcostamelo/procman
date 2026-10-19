'use strict';

const { STATUS } = require('./constants');

/** Plain-text table, no dependency. */
function table(rows, columns) {
  if (rows.length === 0) return '(no processes)\n';
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(c.get(r)).length))
  );
  const line = (cells) =>
    cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  const out = [];
  out.push(line(columns.map((c) => c.header)));
  out.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) out.push(line(columns.map((c) => c.get(row))));
  return out.join('\n') + '\n';
}

function uptime(ms) {
  if (!ms || ms < 0) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days) return `${days}d${hours}h`;
  if (hours) return `${hours}h${minutes}m`;
  if (minutes) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function statusLabel(status) {
  return status || 'unknown';
}

function cpuLabel(cpu) {
  if (cpu === null || cpu === undefined) return '-';
  return `${cpu.toFixed(1)}%`;
}

module.exports = { table, uptime, statusLabel, cpuLabel, STATUS };
