'use strict';

const http = require('http');
const { readTail } = require('./logs');
const { NAME } = require('./constants');

/**
 * A small read-mostly dashboard that runs inside the daemon.
 *
 * It binds to 127.0.0.1 by default and has NO authentication, so it must never
 * be exposed beyond the loopback interface. Mutating actions are limited to
 * the things a process manager needs: restart, reload, stop.
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
      const [, , , idText, action] = pathname.split('/');
      const id = Number(idText);
      if (!supervisor.records.has(id)) return sendJson(res, 404, { error: `no process ${id}` });
      const actions = { restart: 'restart', reload: 'reload', stop: 'stop' };
      const method = actions[action];
      if (!method) return sendJson(res, 400, { error: `unknown action "${action}"` });
      return Promise.resolve(supervisor[method](id))
        .then((result) => sendJson(res, 200, { ok: true, result }))
        .catch((err) => sendJson(res, 500, { error: err.message }));
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  function sendHtml(res, body) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
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
<title>${NAME} dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { opacity: .6; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 10px 4px 0; white-space: nowrap; }
  th { border-bottom: 1px solid rgba(128,128,128,.5); font-weight: 600; }
  tr.online td.status { color: #1a7f37; } tr.errored td.status { color: #cf222e; }
  tr.stopped td.status, tr['waiting restart'] td.status { opacity: .65; }
  button { font: inherit; margin-right: 4px; }
  pre { background: rgba(128,128,128,.12); padding: 10px; overflow: auto; max-height: 320px; }
  dialog { border: 1px solid rgba(128,128,128,.5); border-radius: 6px; max-width: 80ch; }
</style>
</head>
<body>
<h1>${NAME}</h1>
<div class="sub" id="home"></div>
<table>
  <thead><tr>
    <th>id</th><th>name</th><th>ns</th><th>mode</th><th>inst</th><th>pid</th>
    <th>status</th><th>cpu</th><th>mem</th><th>restarts</th><th>uptime</th><th></th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
<dialog id="logbox"><h3 id="logtitle"></h3><pre id="loglines"></pre>
  <form method="dialog"><button>close</button></form></dialog>
<script>
const fmtBytes = (b) => b == null ? '-' : (b > 1073741824 ? (b/1073741824).toFixed(1)+'GB'
  : b > 1048576 ? (b/1048576).toFixed(1)+'MB' : b > 1024 ? (b/1024).toFixed(1)+'KB' : b+'B');
const fmtUp = (ms) => { if (!ms) return '-'; const s = Math.floor(ms/1000);
  const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60);
  return d ? d+'d'+h+'h' : h ? h+'h'+m+'m' : m ? m+'m'+(s%60)+'s' : (s%60)+'s'; };

async function refresh() {
  const data = await (await fetch('/api/processes')).json();
  document.getElementById('home').textContent = data.home;
  document.getElementById('rows').innerHTML = data.processes.map((p) => \`
    <tr class="\${p.status}">
      <td>\${p.id}</td><td>\${p.name}</td><td>\${p.namespace}</td><td>\${p.mode}</td>
      <td>\${p.instances}</td><td>\${p.pid || '-'}</td><td class="status">\${p.status}</td>
      <td>\${p.cpu == null ? '-' : p.cpu.toFixed(1)+'%'}</td><td>\${fmtBytes(p.memory)}</td>
      <td>\${p.restarts}</td><td>\${fmtUp(p.uptime_ms)}</td>
      <td>
        <button data-id="\${p.id}" data-act="restart">restart</button>
        \${p.mode === 'cluster' ? '<button data-id="'+p.id+'" data-act="reload">reload</button>' : ''}
        <button data-id="\${p.id}" data-act="stop">stop</button>
        <button data-id="\${p.id}" data-act="logs">logs</button>
      </td>
    </tr>\`).join('');
}

document.addEventListener('click', async (event) => {
  const id = event.target.dataset && event.target.dataset.id;
  if (!id) return;
  const act = event.target.dataset.act;
  if (act === 'logs') return showLogs(Number(id));
  await fetch('/api/action/' + id + '/' + act, { method: 'POST' });
  refresh();
});

let logTimer = null;
async function showLogs(id) {
  const box = document.getElementById('logbox');
  document.getElementById('logtitle').textContent = 'logs #' + id;
  box.showModal();
  const render = async () => {
    const data = await (await fetch('/api/logs?id=' + id + '&lines=80')).json();
    document.getElementById('loglines').textContent =
      (data.lines || []).map((l) => (l.which === 'err' ? 'ERR ' : 'OUT ') + (l.slot == null ? '' : '[' + l.slot + '] ') + l.line).join('\\n');
  };
  await render();
  clearInterval(logTimer);
  logTimer = setInterval(render, 2000);
  box.addEventListener('close', () => clearInterval(logTimer), { once: true });
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;

module.exports = { createDashboard };
