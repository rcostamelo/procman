'use strict';

const http = require('http');
const crypto = require('crypto');
const { readTail } = require('./logs');
const { NAME } = require('./constants');

/**
 * A small read-mostly dashboard that runs inside the daemon.
 *
 * It binds to 127.0.0.1 by default and has NO authentication, so it must never
 * be exposed beyond the loopback interface. Mutating actions are limited to the
 * things a process manager needs: restart, reload, stop, scale, delete.
 */
function createDashboard(supervisor, { port = 9615, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      route(req, res, url);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  function route(req, res, url) {
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      return sendHtml(res, PAGE);
    }
    if (pathname === '/api/processes') {
      return sendJson(res, 200, { processes: supervisor.list(), home: require('./paths').paths().home });
    }
    if (pathname === '/api/describe') {
      const id = Number(url.searchParams.get('id'));
      const record = supervisor.records.get(id);
      if (!record) return sendJson(res, 404, { error: `no process ${id}` });
      return sendJson(res, 200, supervisor.describe(id));
    }
    if (pathname === '/api/logs') {
      const id = Number(url.searchParams.get('id'));
      const record = supervisor.records.get(id);
      if (!record) return sendJson(res, 404, { error: `no process ${id}` });
      const lines = Number(url.searchParams.get('lines') || 50);
      const files = supervisor.logFiles(record);
      const perFile = files.length > 1 ? Math.max(1, Math.floor(lines / files.length)) : lines;
      const merged = [];
      for (const file of files) {
        for (const line of readTail(file.out, perFile)) merged.push({ which: 'out', slot: file.slot, line });
        for (const line of readTail(file.err, perFile)) merged.push({ which: 'err', slot: file.slot, line });
      }
      return sendJson(res, 200, { id, lines: merged });
    }
    if (pathname.startsWith('/api/action/')) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
      const parts = pathname.split('/');           // ['', 'api', 'action', id, action]
      const id = Number(parts[3]);
      const action = parts[4];
      if (!supervisor.records.has(id)) return sendJson(res, 404, { error: `no process ${id}` });
      const handlers = {
        restart: () => supervisor.restart(id),
        reload: () => supervisor.reload(id),
        stop: () => supervisor.stop(id),
        delete: () => supervisor.delete(id),
        scale: () => supervisor.scale(id, Number(url.searchParams.get('instances')))
      };
      const handler = handlers[action];
      if (!handler) return sendJson(res, 400, { error: `unknown action "${action}"` });
      return Promise.resolve()
        .then(handler)
        .then((result) => sendJson(res, 200, { ok: true, result }))
        .catch((err) => sendJson(res, 500, { error: err.message }));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function baseHeaders(extra) {
    return Object.assign({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    }, extra);
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, baseHeaders({
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload)
    }));
    res.end(payload);
  }

  function sendHtml(res, body) {
    // The page has one inline script, so it gets a fresh nonce instead of
    // 'unsafe-inline': a local, unauthenticated service should still refuse
    // to run injected scripts.
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = body.split('__NONCE__').join(nonce);
    res.writeHead(200, baseHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'content-security-policy':
        `default-src 'none'; connect-src 'self'; img-src 'self' data:; ` +
        `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'`
    }));
    res.end(html);
  }

  return {
    server,
    host,
    port,
    url: `http://${host}:${port}/`,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(`http://${host}:${port}/`));
    }),
    close: () => new Promise((resolve) => server.close(() => resolve(true)))
  };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${NAME} dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --fg:#1f2328; --muted:#656d76; --bg:#fff; --line:#d8dee4; --row:#f6f8fa;
    --ok:#1a7f37; --bad:#cf222e; --accent:#0969da; --bar:#54aeff;
  }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e6edf3; --muted:#8b949e; --bg:#0d1117; --line:#30363d; --row:#161b22;
            --ok:#3fb950; --bad:#f85149; --accent:#58a6ff; --bar:#1f6feb; }
  }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         margin: 0; padding: 20px; background: var(--bg); color: var(--fg); }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; }
  .sub { color: var(--muted); font-size: 12px; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  input[type=search], select { font: inherit; padding: 3px 6px; border: 1px solid var(--line);
         border-radius: 6px; background: var(--bg); color: var(--fg); }
  button { font: inherit; padding: 2px 8px; border: 1px solid var(--line); border-radius: 6px;
           background: var(--bg); color: var(--fg); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button:disabled { opacity: .45; cursor: progress; }
  button[aria-pressed=true] { border-color: var(--accent); color: var(--accent); }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 10px 5px 0; white-space: nowrap; }
  thead th { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line);
             cursor: pointer; user-select: none; }
  thead th.no-sort { cursor: default; }
  thead th[aria-sort]::after { content: attr(data-arrow); color: var(--accent); }
  tbody tr:nth-child(even) { background: var(--row); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.status.online { color: var(--ok); }
  td.status.errored { color: var(--bad); }
  td.status.stopped, td.status.launching { color: var(--muted); }
  .bar { display: inline-block; width: 44px; height: 8px; border-radius: 4px;
         background: var(--line); vertical-align: middle; margin-right: 6px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--bar); }
  .pid { color: var(--muted); }
  .port a { color: var(--accent); text-decoration: none; }
  .empty { padding: 24px 2px; color: var(--muted); }
  .err { margin-left: auto; color: var(--bad); }
  dialog { border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg);
           width: min(92vw, 110ch); }
  dialog::backdrop { background: rgba(0,0,0,.45); }
  pre { background: var(--row); border: 1px solid var(--line); border-radius: 6px; padding: 10px;
        overflow: auto; max-height: 55vh; margin: 8px 0; }
  pre .e { color: var(--bad); }
  .dlg-actions { display: flex; gap: 8px; align-items: center; }
  .grow { margin-left: auto; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0; }
  .kv dt { color: var(--muted); }
  code { background: var(--row); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<header>
  <h1>${NAME}</h1>
  <span class="sub" id="home"></span>
</header>
<div class="toolbar">
  <input type="search" id="filter" size="30" placeholder="filtrar nome, ns ou script" aria-label="filtrar">
  <select id="ns" aria-label="namespace"><option value="">todos os namespaces</option></select>
  <button type="button" id="pause" aria-pressed="false">pausar</button>
  <button type="button" id="refresh">atualizar</button>
  <span class="sub" id="stamp"></span>
  <span class="err" id="err" role="status" aria-live="polite"></span>
</div>
<div class="wrap">
<table>
  <thead><tr>
    <th data-sort="id">id</th><th data-sort="name">name</th><th data-sort="namespace">ns</th>
    <th data-sort="mode">mode</th><th data-sort="instances">inst</th><th data-sort="pid">pid</th>
    <th data-sort="port">port</th><th data-sort="status">status</th><th data-sort="cpu">cpu</th>
    <th data-sort="memory">mem</th><th data-sort="restarts">restarts</th><th data-sort="uptime_ms">uptime</th>
    <th class="no-sort">script</th><th class="no-sort"></th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
</div>
<p class="empty" id="empty" hidden>Sem processos. Suba um com <code>start app.js --name web</code>.</p>
<dialog id="logbox"><h3 id="logtitle"></h3><pre id="loglines"></pre>
  <div class="dlg-actions">
    <button type="button" id="follow" aria-pressed="true">seguindo</button>
    <button type="button" id="bottom">ir ao fim</button>
    <span class="grow"></span>
    <form method="dialog"><button>fechar</button></form>
  </div>
</dialog>
<dialog id="infobox"><h3 id="infotitle"></h3><dl class="kv" id="infobody"></dl>
  <div class="dlg-actions"><span class="grow"></span>
    <form method="dialog"><button>fechar</button></form></div>
</dialog>
<script nonce="__NONCE__">
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtBytes = (b) => b == null ? '-' : (b > 1073741824 ? (b / 1073741824).toFixed(1) + 'GB'
  : b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : b > 1024 ? (b / 1024).toFixed(1) + 'KB' : b + 'B');
const fmtUp = (ms) => {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? d + 'd' + h + 'h' : h ? h + 'h' + m + 'm' : m ? m + 'm' + (s % 60) + 's' : (s % 60) + 's';
};

const state = { rows: [], sort: 'id', dir: 1, paused: false };

function setErr(msg) { $('err').textContent = msg || ''; }

function visibleRows() {
  const q = $('filter').value.trim().toLowerCase();
  const ns = $('ns').value;
  return state.rows.filter((p) => {
    if (ns && p.namespace !== ns) return false;
    if (!q) return true;
    return (p.name + ' ' + p.namespace + ' ' + p.script).toLowerCase().includes(q);
  });
}

function sortedRows(rows) {
  const key = state.sort;
  return rows.slice().sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return (av > bv ? 1 : -1) * state.dir;
  });
}

function actionButtons(p) {
  const button = (act, label, title) =>
    '<button type="button" data-id="' + p.id + '" data-act="' + act +
    '" title="' + title + '">' + label + '</button>';
  let html = button('restart', 'restart', 'para e sobe de novo, mantendo as opções');
  html += button('stop', 'stop', 'parada graciosa, mantendo na lista');
  if (p.mode === 'cluster') {
    html += button('reload', 'reload', 'troca os workers um a um, sem downtime');
    html += button('scale', 'scale', 'muda o número de instâncias');
  }
  html += button('details', 'info', 'detalhes');
  html += button('logs', 'logs', 'ver as últimas linhas');
  html += button('delete', 'delete', 'para e esquece');
  return html;
}

function render() {
  const rows = sortedRows(visibleRows());
  $('empty').hidden = rows.length > 0;
  $('rows').innerHTML = rows.map((p) => {
    const cells = [];
    cells.push('<td class="num">' + p.id + '</td>');
    cells.push('<td>' + esc(p.name) + '</td>');
    cells.push('<td>' + esc(p.namespace) + '</td>');
    cells.push('<td>' + p.mode + '</td>');
    cells.push('<td class="num">' + p.instances + '</td>');
    cells.push('<td class="pid">' + (p.pid || '-') + '</td>');
    const ports = (p.ports || []).map((n) =>
      '<a href="http://127.0.0.1:' + n + '/" target="_blank" rel="noreferrer">' + n + '</a>').join(' ');
    cells.push('<td class="port">' + (ports || '-') + '</td>');
    cells.push('<td class="status ' + p.status + '">' + p.status + '</td>');
    cells.push('<td class="num">' + (p.cpu == null ? '-' : p.cpu.toFixed(1) + '%') + '</td>');
    let mem = fmtBytes(p.memory);
    if (p.max_memory_restart) {
      const pct = Math.min(100, (p.memory || 0) / p.max_memory_restart * 100);
      mem = '<span class="bar"><i style="width:' + pct.toFixed(0) + '%"></i></span>' + mem;
    }
    cells.push('<td class="num" title="' + (p.max_memory_restart ? 'limite ' + fmtBytes(p.max_memory_restart) : '') + '">' + mem + '</td>');
    cells.push('<td class="num">' + p.restarts + '</td>');
    cells.push('<td class="num">' + fmtUp(p.uptime_ms) + '</td>');
    cells.push('<td title="' + esc(p.script) + '">' + esc(p.script) + '</td>');
    cells.push('<td>' + actionButtons(p) + '</td>');
    return '<tr class="' + p.status + '">' + cells.join('') + '</tr>';
  }).join('');
}

function syncNamespaces() {
  const select = $('ns');
  const known = new Set(state.rows.map((p) => p.namespace));
  const shown = new Set(Array.from(select.options).map((o) => o.value).filter(Boolean));
  if (known.size === shown.size && Array.from(known).every((n) => shown.has(n))) return;
  const keep = select.value;
  select.innerHTML = '<option value="">todos os namespaces</option>' +
    Array.from(known).sort().map((n) => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
  if (known.has(keep)) select.value = keep;
}

async function refresh() {
  if (state.paused) return;
  try {
    const res = await fetch('/api/processes');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.rows = data.processes || [];
    $('home').textContent = data.home || '';
    $('stamp').textContent = 'atualizado ' + new Date().toLocaleTimeString();
    syncNamespaces();
    setErr('');
    render();
  } catch (err) {
    setErr('falha ao atualizar: ' + err.message);
  }
}

document.querySelectorAll('thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sort === key) state.dir = -state.dir;
    else { state.sort = key; state.dir = 1; }
    document.querySelectorAll('thead th[data-sort]').forEach((other) => {
      other.removeAttribute('aria-sort');
      other.dataset.arrow = '';
    });
    th.dataset.arrow = state.dir === 1 ? ' \\u25B2' : ' \\u25BC';
    th.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
    render();
  });
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = Number(button.dataset.id);
  const act = button.dataset.act;
  if (act === 'logs') return showLogs(id);
  if (act === 'details') return showDetails(id);

  let query = '';
  if (act === 'delete' && !confirm('remover o processo #' + id + '?')) return;
  if (act === 'scale') {
    const answer = prompt('instâncias (0 = uma por CPU):', '2');
    if (answer === null) return;
    query = '?instances=' + encodeURIComponent(answer);
  }

  button.disabled = true;
  try {
    const res = await fetch('/api/action/' + id + '/' + act + query, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
    setErr('');
  } catch (err) {
    setErr(act + ' falhou: ' + err.message);
  }
  button.disabled = false;
  refresh();
});

let logTimer = null;
let following = true;

async function showLogs(id) {
  const box = $('logbox');
  $('logtitle').textContent = 'logs #' + id;
  const draw = async () => {
    try {
      const res = await fetch('/api/logs?id=' + id + '&lines=200');
      const data = await res.json();
      const pre = $('loglines');
      pre.innerHTML = (data.lines || []).map((l) =>
        '<span class="' + (l.which === 'err' ? 'e' : '') + '">' +
        (l.which === 'err' ? 'ERR ' : 'OUT ') +
        (l.slot === null || l.slot === undefined ? '' : '[' + l.slot + '] ') +
        esc(l.line) + '</span>').join('\\n');
      if (following) pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      // Keep the last good view; the next tick retries.
    }
  };
  await draw();
  clearInterval(logTimer);
  logTimer = setInterval(draw, 1500);
  const stop = () => { clearInterval(logTimer); box.removeEventListener('close', stop); };
  box.addEventListener('close', stop);
  if (!box.open) box.showModal();
}

$('follow').addEventListener('click', () => {
  following = !following;
  $('follow').textContent = following ? 'seguindo' : 'pausado';
  $('follow').setAttribute('aria-pressed', String(following));
  if (following) $('loglines').scrollTop = $('loglines').scrollHeight;
});
$('bottom').addEventListener('click', () => {
  $('loglines').scrollTop = $('loglines').scrollHeight;
});

async function showDetails(id) {
  const res = await fetch('/api/describe?id=' + id);
  if (!res.ok) return setErr('info falhou: HTTP ' + res.status);
  const d = await res.json();
  const rows = [
    ['nome', d.name], ['namespace', d.namespace],
    ['modo', d.mode + (d.instances > 1 ? ' x' + d.instances : '')],
    ['status', d.status], ['pid', d.pid || '-'],
    ['portas', (d.ports && d.ports.length) ? d.ports.join(', ') : '-'],
    ['restarts', d.restarts], ['saiu com', d.exit_code === null ? '-' : d.exit_code],
    ['node', d.node_version || '-'], ['uptime', fmtUp(d.uptime_ms)],
    ['script', d.script], ['cwd', d.cwd], ['args', JSON.stringify(d.args)],
    ['env', (d.env_keys || []).join(', ') || '-'],
    ['log out', d.out_log], ['log err', d.err_log],
    ['limite mem', d.max_memory_restart ? fmtBytes(d.max_memory_restart) : '-'],
    ['watch', d.watch ? 'sim' : 'nao'], ['cron', d.cron || '-']
  ];
  $('infotitle').textContent = 'detalhes #' + id;
  $('infobody').innerHTML = rows
    .map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('');
  const box = $('infobox');
  if (!box.open) box.showModal();
}

$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pause').textContent = state.paused ? 'retomar' : 'pausar';
  $('pause').setAttribute('aria-pressed', String(state.paused));
  if (!state.paused) refresh();
});
$('refresh').addEventListener('click', refresh);
$('filter').addEventListener('input', render);
$('ns').addEventListener('change', render);

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
</script>
</body>
</html>
`;

module.exports = { createDashboard };
