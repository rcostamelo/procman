'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { readTail } = require('./logs');
const { NAME } = require('./constants');
const { paths } = require('./paths');

const COOKIE = 'procman_sess';
const MAX_BODY = 8 * 1024;

/**
 * A small read-mostly dashboard that runs inside the daemon.
 *
 * It binds to 127.0.0.1 by default. Authentication is a three-way switch:
 *   'auto'  require a login as soon as one user exists (the default)
 *   'on'    always require a login
 *   'off'   never require one (loopback only — prints a warning)
 *
 * Users live in a SQLite file next to the rest of the state, so the CLI can add
 * or remove them while the dashboard keeps running. Mutating actions are limited
 * to the things a process manager needs: restart, reload, stop, scale, delete.
 */
function createDashboard(supervisor, { port = 9615, host = '127.0.0.1', auth = 'auto' } = {}) {
  const usersFile = paths().usersFile;
  let store = null;
  let storeError = null;

  /** Opened lazily: a dashboard with no users should not create the database. */
  function users() {
    if (storeError) return null;
    if (!store) {
      try {
        store = new (require('./users').Users)(usersFile);
      } catch (err) {
        storeError = err;
        return null;
      }
    }
    return store;
  }

  function authRequired() {
    if (auth === 'off') return false;
    if (auth === 'on') return true;
    if (!fs.existsSync(usersFile)) return false;
    const db = users();
    return Boolean(db && db.count() > 0);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    Promise.resolve()
      .then(() => route(req, res, url))
      .catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
        else res.end();
      });
  });

  function route(req, res, url) {
    const pathname = url.pathname;
    const required = authRequired();

    if (pathname === '/login') {
      if (req.method === 'GET') return sendLogin(res, url.searchParams.get('next'));
      if (req.method === 'POST') return handleLogin(req, res);
      return sendJson(res, 405, { error: 'use GET or POST' });
    }
    if (pathname === '/logout') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
      return handleLogout(req, res);
    }

    // Everything below needs a session (when auth is on) and, for anything that
    // changes state, proof that the request came from our own page.
    let user = null;
    if (required) {
      const db = users();
      if (!db) {
        return sendJson(res, 500, {
          error: `authentication is enabled but users cannot be read: ${storeError ? storeError.message : 'unknown error'}`
        });
      }
      user = db.sessionUser(cookies(req)[COOKIE]);
      if (!user) {
        if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'authentication required' });
        return redirect(res, `/login?next=${encodeURIComponent(pathname)}`);
      }
    }

    if (pathname === '/' || pathname === '/index.html') {
      return sendHtml(res, PAGE, pageVars(user, required));
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
      // A cross-origin page can POST a simple form here, cookies or not. A
      // custom header cannot be set by a form and forces a CORS preflight that
      // we never answer, so requiring it makes the endpoint same-origin only.
      if (req.headers['x-procman'] !== '1') {
        return sendJson(res, 403, { error: 'missing X-Procman header' });
      }
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

  function sendHtml(res, body, vars = {}) {
    // The page has one inline script, so it gets a fresh nonce instead of
    // 'unsafe-inline': even a local service should refuse to run injected
    // scripts. The other placeholders carry server-rendered values.
    const nonce = crypto.randomBytes(16).toString('base64');
    const html = body
      .split('__NONCE__').join(nonce)
      .split('__USERBLOCK__').join(vars.userBlock || '')
      .split('__AUTHNOTE__').join(vars.authNote || '')
      .split('__NEXT__').join(escapeHtml(vars.next || '/'))
      .split('__ERROR__').join(vars.error ? `<p class="login-err">${escapeHtml(vars.error)}</p>` : '');
    res.writeHead(200, baseHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'content-security-policy':
        `default-src 'none'; connect-src 'self'; img-src 'self' data:; ` +
        `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; ` +
        `form-action 'self'`
    }));
    res.end(html);
  }

  function redirect(res, location, extraHeaders = {}) {
    res.writeHead(302, baseHeaders(Object.assign({ location }, extraHeaders)));
    res.end();
  }

  function sendLogin(res, next, { error, status = 200 } = {}) {
    const html = LOGIN_PAGE;
    const nonce = crypto.randomBytes(16).toString('base64');
    const page = html
      .split('__NONCE__').join(nonce)
      .split('__NEXT__').join(escapeHtml(safeNext(next)))
      .split('__ERROR__').join(error ? `<p class="login-err">${escapeHtml(error)}</p>` : '');
    res.writeHead(status, baseHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(page),
      'content-security-policy':
        `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'`
    }));
    res.end(page);
  }

  function handleLogin(req, res) {
    return readBody(req).then((body) => {
      const form = new URLSearchParams(body);
      const name = form.get('name') || '';
      const password = form.get('password') || '';
      const next = safeNext(form.get('next'));
      const db = users();
      if (!db) {
        return sendLogin(res, next, {
          status: 500,
          error: `users cannot be read: ${storeError ? storeError.message : 'unknown error'}`
        });
      }
      const result = db.verify(name, password);
      if (!result.ok) {
        if (result.locked) {
          const seconds = Math.max(1, Math.ceil((result.until - Date.now()) / 1000));
          return sendLogin(res, next, { status: 429, error: `muitas tentativas — tente de novo em ${seconds}s` });
        }
        return sendLogin(res, next, { status: 401, error: 'usuário ou senha inválidos' });
      }
      const session = db.createSession(result.name);
      const secure = /^https/i.test(req.headers['x-forwarded-proto'] || '') ? '; Secure' : '';
      redirect(res, next, {
        'set-cookie': `${COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; ` +
          `Max-Age=${Math.floor((session.expires_at - Date.now()) / 1000)}${secure}`
      });
    });
  }

  function handleLogout(req, res) {
    const db = users();
    if (db) db.destroySession(cookies(req)[COOKIE]);
    redirect(res, '/login', {
      'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
    });
  }

  function pageVars(user, required) {
    const userBlock = user
      ? `<form method="post" action="/logout" class="who"><span class="sub">${escapeHtml(user)}</span>` +
        `<button type="submit">sair</button></form>`
      : '';
    let authNote = '';
    if (!required && auth !== 'on') {
      authNote = auth === 'off'
        ? '<p class="note warn">login desligado (<code>--no-auth</code>): qualquer um que alcance esta porta pode gerenciar os processos.</p>'
        : '<p class="note warn">sem usuários cadastrados: qualquer um que alcance esta porta pode gerenciar os processos. ' +
          'Crie um com <code>procman user add admin</code>.</p>';
    }
    return { userBlock, authNote };
  }

  return {
    server,
    host,
    port,
    auth,
    url: `http://${host}:${port}/`,
    userCount: () => (fs.existsSync(usersFile) && users() ? users().count() : 0),
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(`http://${host}:${port}/`));
    }),
    close: () => new Promise((resolve) => server.close(() => {
      if (store) { store.close(); store = null; }
      resolve(true);
    }))
  };
}

function cookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Only local paths: an open redirect would be a gift to a phishing page. */
function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

/** A bounded body read: nobody gets to fill the daemon's memory over HTTP. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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
  .note { margin: 10px 0; padding: 8px 10px; border: 1px solid var(--line); border-left: 3px solid var(--accent);
          border-radius: 6px; color: var(--muted); }
  .note.warn { border-left-color: #d29922; }
  .who { margin-left: auto; display: flex; gap: 8px; align-items: center; }
</style>
</head>
<body>
<header>
  <h1>${NAME}</h1>
  <span class="sub" id="home"></span>
  __USERBLOCK__
</header>
__AUTHNOTE__
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

/** Every call goes through here: it marks the request as ours (a cross-origin
 *  form cannot set a header) and bounces to the login page when the session is
 *  gone. */
async function api(path, opts) {
  const init = Object.assign({}, opts);
  init.headers = Object.assign({ 'X-Procman': '1' }, init.headers);
  const res = await fetch(path, init);
  if (res.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname);
    throw new Error('sessão expirada');
  }
  return res;
}

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
    const res = await api('/api/processes');
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
    const res = await api('/api/action/' + id + '/' + act + query, { method: 'POST' });
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
      const res = await api('/api/logs?id=' + id + '&lines=200');
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
  const res = await api('/api/describe?id=' + id);
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

const LOGIN_PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${NAME} · entrar</title>
<style>
  :root { color-scheme: light dark;
          --fg:#1f2328; --muted:#656d76; --bg:#fff; --line:#d8dee4; --row:#f6f8fa;
          --accent:#0969da; --bad:#cf222e; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e6edf3; --muted:#8b949e; --bg:#0d1117; --line:#30363d; --row:#161b22;
            --accent:#58a6ff; --bad:#f85149; }
  }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
         margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); }
  form { background: var(--row); border: 1px solid var(--line); border-radius: 10px; padding: 22px; width: min(92vw, 340px); }
  h1 { font-size: 15px; margin: 0 0 14px; }
  label { display: block; color: var(--muted); margin-bottom: 4px; }
  input { font: inherit; width: 100%; padding: 6px 8px; margin-bottom: 12px; border: 1px solid var(--line);
          border-radius: 6px; background: var(--bg); color: var(--fg); }
  button { font: inherit; width: 100%; padding: 7px; border: 1px solid var(--line); border-radius: 6px;
           background: var(--bg); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  .login-err { color: var(--bad); margin: 0 0 12px; }
  .hint { color: var(--muted); margin: 12px 0 0; font-size: 12px; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>${NAME} · entrar</h1>
  __ERROR__
  <label for="name">usuário</label>
  <input id="name" name="name" autocomplete="username" autofocus required>
  <label for="password">senha</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <input type="hidden" name="next" value="__NEXT__">
  <button type="submit">entrar</button>
  <p class="hint">sem conta ainda? rode <code>procman user add &lt;nome&gt;</code>.</p>
</form>
</body>
</html>
`;

