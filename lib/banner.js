'use strict';
/**
 * The box shown on install (when the npm version still runs postinstall) and on
 * the first real command (always). Shared so the two can never drift apart.
 */

const W = 58; // inner width, between the two border characters

const UNICODE = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
// Legacy Windows consoles do not always render box drawing.
const ASCII = { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';

function banner({ version = '', color = false, ascii = process.platform === 'win32' } = {}) {
  const B = ascii ? ASCII : UNICODE;

  /** One row of the box. Segments are plain text; colour is applied after the pad. */
  const row = (segments) => {
    const plain = segments.map((s) => s.t).join('');
    const pad = ' '.repeat(Math.max(0, W - 2 - plain.length));
    const body = segments.map((s) => (s.c && color ? s.c + s.t + RESET : s.t)).join('');
    return `${B.v} ${body}${pad} ${B.v}`;
  };
  const line = (left, right) => left + B.h.repeat(W) + right;

  return [
    line(B.tl, B.tr),
    row([]),
    row([{ t: 'procman', c: BOLD + CYAN }, { t: version ? ' ' + version : '', c: DIM }]),
    row([{ t: 'a process manager with zero dependencies', c: DIM }]),
    row([]),
    row([{ t: 'start', c: GREEN }, { t: '  run an app and keep it alive' }]),
    row([{ t: 'list', c: GREEN }, { t: '   what is running: cpu, memory, restarts' }]),
    row([{ t: 'logs', c: GREEN }, { t: '   every app at once, one colour each' }]),
    row([{ t: 'save', c: GREEN }, { t: '   keep the current apps for the next boot' }]),
    row([]),
    row([{ t: 'docs', c: DIM }, { t: '  github.com/rcostamelo/procman' }]),
    row([{ t: 'npm ', c: DIM }, { t: '  npmjs.com/package/procmand' }]),
    row([]),
    line(B.bl, B.br)
  ].join('\n');
}

function hint({ color = false } = {}) {
  return color
    ? `  ${DIM}procman help${RESET} lists every command and option`
    : '  procman help lists every command and option';
}

module.exports = { banner, hint };
