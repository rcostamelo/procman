'use strict';

/**
 * End-to-end smoke test.
 *
 * Runs the real CLI and the real daemon against a throwaway PROCMAN_HOME, and
 * asserts behaviour that is easy to get wrong: restart policy, tree killing,
 * zero-downtime reload, log streaming, dump/restore and the "no leftover
 * process" guarantee.
 *
 *   node scripts/smoke.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'procman.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'procman-smoke-'));
const WATCHDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'procman-watch-'));
const env = Object.assign({}, process.env, { PROCMAN_HOME: HOME });

let passed = 0;
let failed = 0;
const startedPids = new Set();
let daemonPid = null;

// ------------------------------------------------------------------ helpers --

function ok(msg) { passed += 1; console.log(`  ok   ${msg}`); }
function bad(msg, detail) { failed += 1; console.log(`  FAIL ${msg}${detail ? ' :: ' + detail : ''}`); }
function check(msg, condition, detail) { condition ? ok(msg) : bad(msg, detail); }
function section(title) { console.log(`\n# ${title}`); }

/**
 * Run the CLI and capture BOTH streams, whatever the exit code. `spawnSync` (not
 * `execFileSync`) because the latter only exposes stderr when the command fails,
 * and some assertions are about warnings printed on a successful run.
 */
function cli(args, opts = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env,
    encoding: 'utf8',
    cwd: opts.cwd || ROOT
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status === null ? 1 : result.status
  };
}
function list() { return JSON.parse(cli(['list', '--json']).stdout); }
function find(name) { return list().find((p) => p.name === name); }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) { ok(desc); return true; }
    await sleep(100);
  }
  bad(desc, 'timed out');
  return false;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    // agent:false — no keep-alive pool: a dashboard restarted on the same port
    // would otherwise hand us a socket the previous server already closed.
    const request = http.get(url, { agent: false, headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    request.on('error', (err) => { err.url = url; reject(err); });
    request.setTimeout(2000, () => request.destroy(new Error(`timeout on ${url}`)));
  });
}

function post(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = opts.body || '';
    const headers = Object.assign({}, opts.headers || {});
    if (payload) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const request = http.request(url, { method: 'POST', headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

/** Sequential+concurrent load, used to look for an outage during reload. */
function hammer(url, durationMs, concurrency = 4) {
  return new Promise((resolve) => {
    const result = { ok: 0, refused: 0, reset: 0, other: 0, pids: new Set() };
    const deadline = Date.now() + durationMs;
    const worker = () => {
      if (Date.now() > deadline) return done();
      get(url).then((res) => {
        result.ok += 1;
        try { result.pids.add(JSON.parse(res.body).pid); } catch (err) { /* ignore */ }
        setImmediate(worker);
      }).catch((err) => {
        if (err.code === 'ECONNREFUSED') result.refused += 1;
        else if (err.code === 'ECONNRESET' || err.code === 'EPIPE') result.reset += 1;
        else result.other += 1;
        setTimeout(worker, 10);
      });
    };
    let remaining = concurrency;
    const done = () => { if (--remaining === 0) resolve(result); };
    for (let i = 0; i < concurrency; i++) worker();
  });
}

// --------------------------------------------------------------------- main --

(async () => {
  console.log(`# procman smoke test\n# home: ${HOME}`);

  // ======================================================= daemon lifecycle ==
  section('daemon lifecycle');
  const ping = cli(['ping']);
  check('ping starts the daemon and answers', /pong from daemon pid \d+/.test(ping.stdout), ping.stdout + ping.stderr);
  check('socket file exists', fs.existsSync(path.join(HOME, 'daemon.sock')));
  check('daemon pid file exists', fs.existsSync(path.join(HOME, 'daemon.pid')));
  daemonPid = Number(fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8'));
  check('second ping reuses the running daemon', cli(['ping']).stdout.includes(`pid ${daemonPid}`));

  // ================================================================ fork mode ==
  section('fork mode: start / list / describe / logs');
  const started = cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'web', '--', '--label', 'alpha']);
  check('start reports the new process', /started web \(id 0, fork/.test(started.stdout), started.stdout + started.stderr);

  let web = find('web');
  check('list shows it online with 1 instance', !!web && web.status === 'online' && web.instances === 1, JSON.stringify(web));
  check('app process is alive', !!web && alive(web.pid));
  check('a fresh process has 0 restarts', !!web && web.restarts === 0, web && `restarts=${web.restarts}`);
  startedPids.add(web.pid);

  await waitFor('the app writes to its stdout log', () =>
    fs.readFileSync(web.out_log, 'utf8').includes('[alpha] listening'));

  const described = JSON.parse(cli(['describe', 'web']).stdout);
  check('describe resolves by name and reports argv', described.id === web.id &&
    described.args.join(' ') === '--label alpha' && described.script.endsWith('app.js'), JSON.stringify(described.args));
  check('describe reports the app node version over IPC', described.node_version === process.versions.node, String(described.node_version));

  const tailed = cli(['logs', 'web', '--lines', '2']);
  check('logs prints the last lines with the app name', tailed.stdout.includes('web | '), tailed.stdout);

  // ========================================================= automatic restart =
  section('automatic restart');
  const firstPid = find('web').pid;
  process.kill(firstPid, 'SIGKILL');
  if (await waitFor('a killed app is brought back', () => {
    const current = find('web');
    return current && current.status === 'online' && current.pid !== firstPid && current.pid !== 0;
  })) {
    web = find('web');
    startedPids.add(web.pid);
    check('the restart counter went up', web.restarts >= 1, `restarts=${web.restarts}`);
    check('the replacement is alive', alive(web.pid));
  }

  // ============================================ explicit restart / stop / delete
  section('restart / stop / delete');
  const unrestarted = find('web').unstable_restarts;
  const before = find('web').pid;
  cli(['restart', 'web']);
  check('restart changes the pid', find('web').pid !== before);
  check('an explicit restart is not counted as unstable', find('web').unstable_restarts === 0, `unstable=${find('web').unstable_restarts}`);
  startedPids.add(find('web').pid);

  const doomedPid = find('web').pid;
  cli(['stop', 'web']);
  check('stop kills the process', !alive(doomedPid));
  await waitFor('a stopped process stays stopped (no auto-restart)', async () => {
    await sleep(600);
    const current = find('web');
    return current && current.status === 'stopped' && current.pid === 0;
  });
  check('delete removes it from the table', cli(['delete', 'web']).status === 0 && !find('web'));

  // ================================================== argv / cwd / autorestart =
  section('argv, cwd and --no-autorestart');
  cli(['start', path.join(ROOT, 'examples', 'args.js'), '--name', 'args', '--no-autorestart', '--cwd', HOME, '--', '--flag', 'value']);
  const argsRecord = find('args');
  await waitFor('an app with --no-autorestart stays stopped after exiting', async () => {
    const current = find('args');
    return current && (current.status === 'stopped' || current.status === 'errored');
  });
  check('a stopped-by-exit app is not counted as errored', find('args').status === 'stopped', find('args').status);
  const argsOut = fs.readFileSync(argsRecord.out_log, 'utf8');
  check('args are passed through', argsOut.includes('"--flag"') && argsOut.includes('"value"'), argsOut);
  check('--cwd is honoured', argsOut.includes(`"cwd": "${HOME}"`), argsOut);
  check('PROC_APP_NAME is injected', argsOut.includes('"proc_app_name": "args"'), argsOut);
  cli(['delete', 'args']);

  // ============================================================ relative paths =
  section('relative paths resolve against the caller');
  cli(['start', 'examples/app.js', '--name', 'rel'], { cwd: ROOT });
  const rel = find('rel');
  check('relative script is stored as an absolute path', !!rel && rel.script === path.join(ROOT, 'examples', 'app.js'), rel && rel.script);
  check('its cwd defaults to the caller cwd', !!rel && rel.cwd === ROOT, rel && rel.cwd);
  // Regression: the daemon runs with cwd = the state home, so a relative target
  // must be resolved against the CALLER's directory, not the daemon's.
  check('a process can also be targeted by script path', (() => {
    try { return JSON.parse(cli(['describe', 'examples/app.js'], { cwd: ROOT }).stdout).id === rel.id; }
    catch (err) { return false; }
  })(), cli(['describe', 'examples/app.js'], { cwd: ROOT }).stderr);
  startedPids.add(rel.pid);
  cli(['delete', 'rel']);

  // ============================================================== restart budget
  section('restart budget -> errored');
  cli(['start', path.join(ROOT, 'examples', 'crash.js'), '--name', 'crasher',
    '--max-restarts', '3', '--min-uptime', '300', '--restart-delay', '50']);
  await waitFor('a crash-looping app ends up errored instead of looping forever', () => {
    const current = find('crasher');
    return current && current.status === 'errored';
  }, 15000);
  check('an errored app keeps no pid', find('crasher').pid === 0, String(find('crasher').pid));
  cli(['delete', 'crasher']);

  // ================================================================= tree kill ==
  section('stopping kills the whole process tree');
  cli(['start', path.join(ROOT, 'examples', 'spawner.js'), '--name', 'spawner']);
  await waitFor('the spawner logs its child pid', () =>
    fs.readFileSync(find('spawner').out_log, 'utf8').includes('child pid='));
  const childPid = Number(/child pid=(\d+)/.exec(fs.readFileSync(find('spawner').out_log, 'utf8'))[1]);
  const spawnerPid = find('spawner').pid;
  cli(['stop', 'spawner']);
  await waitFor('both the parent and its child are gone', () => !alive(spawnerPid) && !alive(childPid));
  cli(['delete', 'spawner']);

  // ============================================================== cluster mode ==
  section('cluster mode');
  const apiPort = await freePort();
  cli(['start', path.join(ROOT, 'examples', 'http.js'), '--name', 'api', '-i', '3', '--', '--port', String(apiPort)]);
  const api = find('api');
  check('-i implies cluster mode with 3 instances', !!api && api.mode === 'cluster' && api.instances === 3, JSON.stringify(api && { mode: api.mode, instances: api.instances }));
  check('every instance has its own pid', api.pids.length === 3, JSON.stringify(api.pids));
  api.pids.forEach((pid) => startedPids.add(pid));

  // Port discovery: the container wraps net.Server#listen, so each instance
  // reports the port it really bound. Cluster shares one listener, so the three
  // reports must collapse into a single port.
  await waitFor('the bound port is discovered from the app itself', () => {
    const row = find('api');
    return Array.isArray(row.ports) && row.ports.length === 1 && row.ports[0] === apiPort;
  });
  check('three instances sharing one port are reported once', JSON.stringify(find('api').ports) === JSON.stringify([apiPort]), JSON.stringify(find('api').ports));
  check('describe exposes the bound port', JSON.parse(cli(['describe', 'api']).stdout).ports.includes(apiPort));
  const apiTable = cli(['list']).stdout;
  check('the table renders the port in its own column', apiTable.includes('port') && apiTable.includes(String(apiPort)), apiTable.split('\n').slice(0, 3).join(' | '));

  // --instances max is documented as "one per CPU" and used to fall back to a
  // single worker instead.
  cli(['start', path.join(ROOT, 'examples', 'http.js'), '--name', 'maxed', '-i', 'max', '--', '--port', String(await freePort())]);
  const maxed = find('maxed');
  check('--instances max really means one worker per CPU',
    maxed.mode === 'cluster' && maxed.instances === os.cpus().length,
    JSON.stringify({ mode: maxed.mode, instances: maxed.instances, cpus: os.cpus().length }));
  maxed.pids.forEach((pid) => startedPids.add(pid));
  cli(['delete', 'maxed']);

  const rr = await hammer(`http://127.0.0.1:${apiPort}/health`, 600, 6);
  check('the load balancer spreads connections across all 3 instances', rr.pids.size === 3, `pids=${[...rr.pids].join(',')}`);

  await waitFor('cluster workers announce themselves in the log', () =>
    fs.readFileSync(find('api').out_log, 'utf8').split('\n').filter((l) => l.includes('listening')).length >= 3);

  section('reload has no outage');
  const beforeReloadPids = find('api').pids;
  const load = hammer(`http://127.0.0.1:${apiPort}/health`, 5000, 4);
  await sleep(600);
  cli(['reload', 'api']);
  await sleep(600);
  cli(['reload', 'api']);
  const loadResult = await load;
  check('no connection was ever refused during two reloads (no outage)', loadResult.refused === 0, `refused=${loadResult.refused}`);
  check('the old workers were replaced', find('api').pids.every((pid) => !beforeReloadPids.includes(pid)));
  console.log(`  info reload kept serving: ${loadResult.ok} ok, ${loadResult.reset} resets (in-flight connections on retiring workers), pids seen: ${loadResult.pids.size}`);
  check('reload did not change the instance count', find('api').instances === 3, String(find('api').instances));
  find('api').pids.forEach((pid) => startedPids.add(pid));

  cli(['scale', 'api', '1']);
  await waitFor('scale down retires the extra workers', () => find('api').instances === 1);
  cli(['scale', 'api', '2']);
  await waitFor('scale up adds workers back', () => find('api').instances === 2, 6000);
  find('api').pids.forEach((pid) => startedPids.add(pid));

  // A port is owned by a live process: a stopped app must stop advertising it,
  // and a restart must rediscover it.
  cli(['stop', 'api']);
  await waitFor('a stopped app advertises no port', () => {
    const row = find('api');
    return row.status === 'stopped' && row.ports.length === 0 && row.port === null;
  });
  cli(['restart', 'api']);
  await waitFor('restart rediscovers the port of every instance', () => {
    const row = find('api');
    return row.status === 'online' && row.instances === 2 && JSON.stringify(row.ports) === JSON.stringify([apiPort]);
  });
  find('api').pids.forEach((pid) => startedPids.add(pid));
  cli(['delete', 'api']);

  // ==================================================================== watch ==
  section('watch');
  const watched = path.join(WATCHDIR, 'watched.js');
  fs.copyFileSync(path.join(ROOT, 'examples', 'app.js'), watched);
  cli(['start', watched, '--name', 'watcher', '--watch', '--watch-path', WATCHDIR, '--restart-delay', '50']);
  const watchBefore = find('watcher').restarts;
  await sleep(800);
  fs.writeFileSync(watched, fs.readFileSync(watched, 'utf8') + '\n// touched\n');
  await waitFor('a file change restarts the app', () => find('watcher').restarts > watchBefore, 12000);
  check('restarts went up exactly once for one edit', find('watcher').restarts === watchBefore + 1, `before=${watchBefore} after=${find('watcher').restarts}`);
  startedPids.add(find('watcher').pid);
  cli(['delete', 'watcher']);

  // ========================================================= memory limit ======
  section('--max-memory-restart');
  cli(['start', path.join(ROOT, 'examples', 'memory.js'), '--name', 'hog', '--max-memory-restart', '80M']);
  const hog = JSON.parse(cli(['describe', 'hog']).stdout);
  check('the limit is stored in bytes', hog.max_memory_restart === 80 * 1024 * 1024, String(hog.max_memory_restart));
  await waitFor('going over the limit triggers a restart', () => find('hog').restarts >= 1, 12000);
  await sleep(1500);
  check('the limit restart is throttled, not a restart storm', find('hog').restarts <= 2, `restarts=${find('hog').restarts}`);
  startedPids.add(find('hog').pid);
  cli(['delete', 'hog']);

  // ============================================================= cron parser ===
  section('cron');
  const { CronSchedule, CronRunner } = require(path.join(ROOT, 'lib', 'cron.js'));
  check('a valid 5-field expression parses', new CronSchedule('*/5 1-3 * * 1').matches(new Date(2026, 0, 5, 1, 10)));
  check('a non-matching minute is rejected', !new CronSchedule('*/5 1-3 * * 1').matches(new Date(2026, 0, 5, 1, 12)));
  let threw = false;
  try { new CronSchedule('* * *'); } catch (err) { threw = true; }
  check('a 3-field expression is rejected loudly', threw);
  threw = false;
  try { new CronSchedule('* * * * MON'); } catch (err) { threw = true; }
  check('a named weekday is rejected instead of mis-scheduled', threw);
  const fixed = new Date(2026, 0, 5, 12, 30);
  let fires = 0;
  new CronRunner('* * * * *', () => { fires += 1; }, { intervalMs: 5, now: () => fixed }).start();
  await sleep(60);
  check('the runner fires once per matching minute', fires === 1, `fires=${fires}`);
  check('an invalid cron makes start fail with a clear message',
    /must have 5 fields/.test(cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'badcron', '--cron', 'nope']).stderr));

  // ============================================================ save/resurrect =
  section('save / resurrect');
  cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'keep']);
  const saved = cli(['save']);
  check('save writes the dump file', saved.status === 0 && fs.existsSync(path.join(HOME, 'dump.json')), saved.stdout + saved.stderr);
  startedPids.add(find('keep').pid);
  cli(['kill']);
  await waitFor('kill really stops the daemon before returning', () => !alive(daemonPid));
  const resurrected = cli(['resurrect']);
  check('resurrect restarts the saved apps', /resurrected 1 app/.test(resurrected.stdout), resurrected.stdout + resurrected.stderr);
  check('resurrect reports the record it started, with name/id/pid',
    /started keep \(id \d+, fork, pid \d+\)/.test(resurrected.stdout), resurrected.stdout);
  check('resurrect prints no undefined fields', !/undefined/.test(resurrected.stdout), resurrected.stdout);
  await waitFor('the resurrected app is online', () => {
    const current = find('keep');
    return current && current.status === 'online' && current.pid !== 0;
  });
  startedPids.add(find('keep').pid);
  const again = cli(['resurrect']);
  check('resurrect is idempotent (skips what is already running)',
    /skipped \(already running\): keep/.test(again.stdout), again.stdout);
  check('resurrect did not duplicate the app', list().filter((p) => p.name === 'keep').length === 1);
  cli(['delete', 'keep']);

  // ================================================================ ecosystem ==
  section('ecosystem file');
  const ecoPort = await freePort();
  const ecoMaxPort = await freePort();
  const ecoFile = path.join(HOME, 'ecosystem.config.js');
  // `eco-nested` exercises the common `{ cwd: './x', script: 'server.js' }`
  // layout: the script must resolve against the app cwd, not the config file.
  const ecoNested = path.join(HOME, 'nested');
  fs.mkdirSync(ecoNested, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'examples', 'app.js'), path.join(ecoNested, 'server.js'));
  fs.writeFileSync(ecoFile, `module.exports = { apps: [
    { name: 'eco-web', script: ${JSON.stringify(path.join(ROOT, 'examples', 'app.js'))}, args: '--label eco' },
    { name: 'eco-api', script: ${JSON.stringify(path.join(ROOT, 'examples', 'http.js'))},
      exec_mode: 'cluster', instances: 2, args: ['--port', '${ecoPort}'], namespace: 'eco' },
    { name: 'eco-max', script: ${JSON.stringify(path.join(ROOT, 'examples', 'http.js'))},
      exec_mode: 'cluster', instances: 'max', args: ['--port', '${ecoMaxPort}'], namespace: 'eco' },
    { name: 'eco-nested', cwd: './nested', script: 'server.js' }
  ] };`);
  const ecoStart = cli(['start', ecoFile]);
  check('starting an ecosystem file starts every app', /started 4 app/.test(ecoStart.stdout), ecoStart.stdout + ecoStart.stderr);
  await waitFor('apps from the ecosystem file are online', () => {
    const a = find('eco-web');
    const b = find('eco-api');
    const c = find('eco-nested');
    return a && a.status === 'online' && b && b.status === 'online' && b.instances === 2 && c && c.status === 'online';
  });
  find('eco-web').pids.forEach((pid) => startedPids.add(pid));
  find('eco-api').pids.forEach((pid) => startedPids.add(pid));
  find('eco-max').pids.forEach((pid) => startedPids.add(pid));
  find('eco-nested').pids.forEach((pid) => startedPids.add(pid));
  check("an ecosystem instances: 'max' means one worker per CPU",
    find('eco-max').mode === 'cluster' && find('eco-max').instances === os.cpus().length,
    JSON.stringify({ instances: find('eco-max').instances, cpus: os.cpus().length }));
  check('a relative script resolves against the app cwd, not the config file',
    find('eco-nested').cwd === ecoNested, JSON.stringify({ cwd: find('eco-nested').cwd, expected: ecoNested }));
  await waitFor('a relative cwd is honoured and its app really serves', () => (find('eco-nested').ports || []).length === 1);
  check('exec_mode cluster is honoured', find('eco-api').mode === 'cluster');
  check('the namespace is applied', find('eco-api').namespace === 'eco');
  check('list --namespace filters', JSON.parse(cli(['list', '--json', '--namespace', 'eco']).stdout).length === 2);
  check('the ecosystem app actually answers on its port',
    (await get(`http://127.0.0.1:${ecoPort}/health`)).status === 200);
  cli(['delete', 'all']);
  check('delete all empties the table', list().length === 0);

  // =================================================================== startup =
  section('startup unit generation');
  const unit = cli(['startup']);
  check('a systemd unit is generated for linux', /\[Unit\]/.test(unit.stdout) && /ExecStart=.*resurrect/.test(unit.stdout), unit.stdout.slice(0, 120));
  check('the unit points at the configured home', unit.stdout.includes(`PROCMAN_HOME=${HOME}`), HOME);
  const installAttempt = cli(['startup', '--install']);
  check('installing without permission fails cleanly instead of crashing',
    installAttempt.status === 0 && /(NOT installed|installed)/.test(installAttempt.stdout), installAttempt.stdout.slice(-160));

  // ================================================================= dashboard =
  section('dashboard');
  const webPort = await freePort();
  cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'dash']);
  await waitFor('the port is discovered even when the app asks for a random one', () => {
    const row = find('dash');
    return Array.isArray(row.ports) && row.ports.length === 1 && row.ports[0] > 0;
  });
  const webStart = cli(['web', '--port', String(webPort)]);
  check('the dashboard starts on the requested port', webStart.stdout.includes(`127.0.0.1:${webPort}`), webStart.stdout + webStart.stderr);
  const apiPayload = JSON.parse((await get(`http://127.0.0.1:${webPort}/api/processes`)).body);
  check('the api lists processes', apiPayload.processes.length === 1 && apiPayload.processes[0].name === 'dash', JSON.stringify(apiPayload.processes));
  check('the api exposes the bound port', JSON.stringify(apiPayload.processes[0].ports) === JSON.stringify(find('dash').ports), JSON.stringify(apiPayload.processes[0].ports));
  const dashPage = await get(`http://127.0.0.1:${webPort}/`);
  check('the html page is served', dashPage.body.includes('<table>'));
  check('the page has a port column', dashPage.body.includes('data-sort="port"'));
  check('the page ships a nonce-based CSP and no-store',
    /script-src 'nonce-[^']+'/.test(dashPage.headers['content-security-policy'] || '') &&
    /<script nonce="[^"]+">/.test(dashPage.body) &&
    dashPage.headers['cache-control'] === 'no-store',
    JSON.stringify({ csp: dashPage.headers['content-security-policy'], cache: dashPage.headers['cache-control'] }));
  const dashPidBefore = find('dash').pid;
  check('the restart action works', (await post(`http://127.0.0.1:${webPort}/api/action/${find('dash').id}/restart`,
    { headers: { 'x-procman': '1' } })).status === 200);
  check('a write without the same-origin header is refused',
    (await post(`http://127.0.0.1:${webPort}/api/action/${find('dash').id}/stop`)).status === 403);
  check('the action really restarted the process', find('dash').pid !== dashPidBefore);
  startedPids.add(find('dash').pid);
  check('the page warns that there are no users yet',
    (await get(`http://127.0.0.1:${webPort}/`)).body.includes('sem usuários cadastrados'));
  cli(['web', '--stop']);
  check('the dashboard can be stopped', cli(['web', '--stop']).stdout.includes('not running'));
  cli(['delete', 'dash']);

  // ================================================================ status ====
  section('status');
  cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'statused']);
  const statusOut = cli(['status']);
  check('status prints the same table as list',
    statusOut.stdout.includes('statused') && statusOut.stdout.includes('uptime'), statusOut.stdout);
  check('status adds a one-line summary', /app\(s\): \d+ online/.test(statusOut.stdout), statusOut.stdout);
  check('status --json is still machine readable',
    JSON.parse(cli(['status', '--json']).stdout).some((p) => p.name === 'statused'));
  cli(['delete', 'statused']);

  // ========================================================= users (sqlite) ===
  section('users');
  const usersFile = path.join(HOME, 'users.db');
  check('no user database until a user exists', !fs.existsSync(usersFile));

  const addUser = cli(['user', 'add', 'smokeadmin', '--password', 'smoke-password-1']);
  check('user add creates an account', addUser.status === 0 && /created/.test(addUser.stdout), addUser.stdout + addUser.stderr);
  check('the user database appears in the state directory', fs.existsSync(usersFile));
  check('the user database is private (0600)',
    (fs.statSync(usersFile).mode & 0o077) === 0, (fs.statSync(usersFile).mode & 0o777).toString(8));

  const userList = cli(['user', 'list']);
  check('user list shows the account', userList.stdout.includes('smokeadmin'), userList.stdout);
  check('user list never prints the hash', !/scrypt\$/.test(userList.stdout + userList.stderr), userList.stdout);
  check('user list --json is machine readable',
    JSON.parse(cli(['user', 'list', '--json']).stdout)[0].name === 'smokeadmin');
  check('a short password is refused',
    cli(['user', 'add', 'weakling', '--password', 'short']).status === 1);
  check('a duplicated name is refused',
    cli(['user', 'add', 'smokeadmin', '--password', 'other-password-1']).status === 1);
  check('an unknown user cannot be removed', cli(['user', 'rm', 'ghost']).status === 1);
  check('an unknown user cannot be listed either', cli(['user', 'list']).stdout.includes('smokeadmin'));

  // ======================================================= dashboard auth ====
  section('dashboard auth');
  const authPort = await freePort();
  cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'guarded']);
  await waitFor('the guarded app is up', () => Boolean(find('guarded')) && find('guarded').status === 'online');

  const guardedWeb = cli(['web', '--port', String(authPort)]);
  check('web reports that the login is required now', /auth: on \(1 user\)/.test(guardedWeb.stdout), guardedWeb.stdout + guardedWeb.stderr);

  const anonPage = await get(`http://127.0.0.1:${authPort}/`);
  check('an anonymous browser is redirected to /login',
    anonPage.status === 302 && /^\/login\?next=/.test(anonPage.headers.location || ''), JSON.stringify([anonPage.status, anonPage.headers.location]));
  check('the api refuses an anonymous caller with 401',
    (await get(`http://127.0.0.1:${authPort}/api/processes`)).status === 401);
  check('the login page is served with its own CSP',
    (await get(`http://127.0.0.1:${authPort}/login`)).body.includes('procman · entrar'));

  const guardedId = find('guarded').id;
  const anonWrite = await post(`http://127.0.0.1:${authPort}/api/action/${guardedId}/stop`);
  check('a write with neither session nor header is refused',
    anonWrite.status === 401 || anonWrite.status === 403, String(anonWrite.status));

  const wrongLogin = await post(`http://127.0.0.1:${authPort}/login`, { body: 'name=smokeadmin&password=nope-nope-nope' });
  check('a wrong password is refused', wrongLogin.status === 401 && /inválidos/.test(wrongLogin.body), `${wrongLogin.status} ${wrongLogin.body.slice(0, 80)}`);
  check('a wrong password hands out no cookie', !wrongLogin.headers['set-cookie']);

  const login = await post(`http://127.0.0.1:${authPort}/login`, { body: 'name=smokeadmin&password=smoke-password-1' });
  const cookieHeader = (login.headers['set-cookie'] || [''])[0];
  const cookie = cookieHeader.split(';')[0];
  check('a correct password logs in with a redirect', login.status === 302 && login.headers.location === '/', `${login.status} ${login.headers.location}`);
  check('the session cookie is HttpOnly and SameSite=Strict',
    /HttpOnly/.test(cookieHeader) && /SameSite=Strict/.test(cookieHeader), cookieHeader);
  check('the session cookie carries an expiry', /Max-Age=\d+/.test(cookieHeader), cookieHeader);

  check('the api answers an authenticated caller',
    (await get(`http://127.0.0.1:${authPort}/api/processes`, { headers: { cookie } })).status === 200);
  check('the page shows who is logged in',
    (await get(`http://127.0.0.1:${authPort}/`, { headers: { cookie } })).body.includes('smokeadmin'));

  check('an authenticated write without the header is still refused',
    (await post(`http://127.0.0.1:${authPort}/api/action/${guardedId}/stop`, { headers: { cookie } })).status === 403);
  const guardedPid = find('guarded').pid;
  check('an authenticated, same-origin write works',
    (await post(`http://127.0.0.1:${authPort}/api/action/${guardedId}/restart`,
      { headers: { cookie, 'x-procman': '1' } })).status === 200);
  check('that write really restarted the app', find('guarded').pid !== guardedPid);
  startedPids.add(find('guarded').pid);

  let throttled = null;
  for (let i = 0; i < 6; i++) {
    throttled = await post(`http://127.0.0.1:${authPort}/login`, { body: 'name=smokeadmin&password=still-wrong' });
  }
  check('repeated failures are rate limited', throttled.status === 429, String(throttled.status));
  check('the correct password is refused while locked out',
    (await post(`http://127.0.0.1:${authPort}/login`, { body: 'name=smokeadmin&password=smoke-password-1' })).status === 429);

  const logout = await post(`http://127.0.0.1:${authPort}/logout`, { headers: { cookie } });
  check('logout redirects and clears the cookie',
    logout.status === 302 && /Max-Age=0/.test((logout.headers['set-cookie'] || [''])[0]), JSON.stringify(logout.headers['set-cookie']));
  check('the old session stops working',
    (await get(`http://127.0.0.1:${authPort}/api/processes`, { headers: { cookie } })).status === 401);

  cli(['web', '--stop']);
  check('removing the last user is reported', /no users left/.test(cli(['user', 'rm', 'smokeadmin']).stdout));
  check('--auth without any user fails loudly', cli(['web', '--port', String(authPort), '--auth']).status === 1);
  const reopened = cli(['web', '--port', String(authPort)]);
  check('the dashboard opens again once no user is left', /auth: off \(no users\)/.test(reopened.stdout), reopened.stdout);
  check('it answers without a session again', (await get(`http://127.0.0.1:${authPort}/`)).status === 200);
  cli(['web', '--stop']);
  cli(['delete', 'guarded']);

  // ============================================================== log follow ==
  section('logs --follow');
  cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'follower', '--', '--label', 'stream']);
  const follow = spawn(process.execPath, [CLI, 'logs', 'follower', '--lines', '1', '--follow'], { env });
  let followOut = '';
  follow.stdout.on('data', (chunk) => { followOut += chunk; });
  await sleep(2500);
  follow.kill('SIGINT');
  await sleep(400);
  const streamedLines = followOut.split('\n').filter((l) => l.startsWith('follower | '));
  check('the follow stream delivers live lines', streamedLines.length >= 2, `got ${streamedLines.length} lines`);
  check('the following client exits on SIGINT', follow.exitCode !== null || follow.killed);
  startedPids.add(find('follower').pid);
  cli(['delete', 'follower']);

  // ============================================================ log rotation ==
  section('log rotation');
  const { formatDate } = require(path.join(ROOT, 'lib', 'logs.js'));
  const stampAt = new Date(2026, 0, 5, 13, 4, 9, 42).getTime();
  check('--log-date-format expands every token',
    formatDate(stampAt, 'YYYY-MM-DD HH:mm:ss.SSS') === '2026-01-05 13:04:09.042',
    formatDate(stampAt, 'YYYY-MM-DD HH:mm:ss.SSS'));

  cli(['start', path.join(ROOT, 'examples', 'chatty.js'), '--name', 'rotor',
    '--log-rotate-size', '4K', '--log-rotate-keep', '20', '--', '--count', '600']);
  const rotorOut = find('rotor').out_log;
  const rotorDir = path.dirname(rotorOut);
  const rotorPrefix = path.basename(rotorOut) + '.';
  const generations = () => fs.readdirSync(rotorDir).filter((f) => f.startsWith(rotorPrefix));
  await waitFor('the burst crosses the size limit and a generation appears', () => generations().length > 0, 25000);
  await sleep(800); // the burst and its rotations settle asynchronously

  const readIfPresent = (file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch (err) { return ''; }
  };
  const everything = [rotorOut, ...generations().map((f) => path.join(rotorDir, f))]
    .map(readIfPresent).join('');
  const seen = new Set(everything.match(/line \d{4}/g) || []);
  check('rotation loses no line (all 600 survive across generations)', seen.size === 600, `saw ${seen.size} distinct lines`);
  const liveSize = (() => { try { return fs.statSync(rotorOut).size; } catch (err) { return -1; } })();
  check('the live file is a fresh one, not one giant file', liveSize >= 0 && liveSize < 3 * 4096, String(liveSize));
  const rotorPids = find('rotor').pids;
  rotorPids.forEach((pid) => startedPids.add(pid));
  cli(['delete', 'rotor']);

  cli(['start', path.join(ROOT, 'examples', 'chatty.js'), '--name', 'rotor2',
    '--log-rotate-size', '4K', '--log-rotate-keep', '2', '--log-rotate-compress', '--', '--count', '600']);
  const rotor2Out = find('rotor2').out_log;
  const rotor2Prefix = path.basename(rotor2Out) + '.';
  const rotor2Dir = path.dirname(rotor2Out);
  await waitFor('compressed generations appear', () =>
    fs.readdirSync(rotor2Dir).some((f) => f.startsWith(rotor2Prefix) && f.endsWith('.gz')), 25000);
  const kept = fs.readdirSync(rotor2Dir).filter((f) => f.startsWith(rotor2Prefix));
  check('--log-rotate-keep bounds the number of generations', kept.length <= 2, kept.join(','));
  const zipped = kept.find((f) => f.endsWith('.gz'));
  const gunzipped = zlib.gunzipSync(fs.readFileSync(path.join(rotor2Dir, zipped))).toString('utf8');
  check('a compressed generation is real gzip and readable', gunzipped.includes('line '), gunzipped.slice(0, 40));
  check('the plain file is removed after compression', !fs.existsSync(path.join(rotor2Dir, zipped.replace(/\.gz$/, ''))));
  find('rotor2').pids.forEach((pid) => startedPids.add(pid));
  cli(['delete', 'rotor2']);

  // ====================================================== timestamps/readiness =
  section('--time/--log-date-format and --wait-ready');
  cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'stamped',
    '--time', '--log-date-format', 'YYYY/MM/DD-HH:mm:ss.SSS']);
  await waitFor('lines carry the requested timestamp format', () =>
    /\d{4}\/\d{2}\/\d{2}-\d{2}:\d{2}:\d{2}\.\d{3} \[app\] listening/.test(fs.readFileSync(find('stamped').out_log, 'utf8')));
  startedPids.add(find('stamped').pid);
  cli(['delete', 'stamped']);

  const warmStarted = Date.now();
  cli(['start', path.join(ROOT, 'examples', 'ready.js'), '--name', 'warm',
    '--wait-ready', '--listen-timeout', '5000', '--', '--delay', '900']);
  const warmWaited = Date.now() - warmStarted;
  check('start --wait-ready blocks until the app signals ready', warmWaited >= 800, `${warmWaited}ms`);
  check('readiness is reported by describe', JSON.parse(cli(['describe', 'warm']).stdout).ready === true);
  startedPids.add(find('warm').pid);
  cli(['delete', 'warm']);

  const neverStarted = Date.now();
  cli(['start', path.join(ROOT, 'examples', 'ready.js'), '--name', 'never',
    '--wait-ready', '--listen-timeout', '600', '--', '--never']);
  const neverWaited = Date.now() - neverStarted;
  check('a missing ready signal is bounded by --listen-timeout', neverWaited >= 550 && neverWaited < 5000, `${neverWaited}ms`);
  check('the app is online even though it never signalled', find('never').status === 'online', JSON.stringify(find('never')));
  const neverRow = find('never');
  check('an app that binds no port reports none', Array.isArray(neverRow.ports) && neverRow.ports.length === 0 && neverRow.port === null, JSON.stringify({ port: neverRow.port, ports: neverRow.ports }));
  startedPids.add(find('never').pid);
  cli(['delete', 'never']);

  // ==================================================== per-instance log files =
  section('--no-merge-logs');
  cli(['start', path.join(ROOT, 'examples', 'chatty.js'), '--name', 'split', '-i', '2',
    '--no-merge-logs', '--', '--count', '5']);
  await waitFor('the split-log cluster is online', () => {
    const r = find('split');
    return r && r.status === 'online' && r.instances === 2;
  });
  const splitRecord = JSON.parse(cli(['describe', 'split']).stdout);
  check('describe lists one log file per instance', splitRecord.log_files.length === 2, JSON.stringify(splitRecord.log_files));
  await waitFor('each instance writes only to its own file', () => splitRecord.log_files.every((f) => {
    const text = fs.existsSync(f.out) ? fs.readFileSync(f.out, 'utf8') : '';
    return text.includes(`instance ${f.slot} `) && !text.includes(`instance ${1 - f.slot} `);
  }), 15000);
  const splitLogs = cli(['logs', 'split', '--lines', '20']);
  check('logs tags each line with its instance slot',
    /split \| \[0\] /.test(splitLogs.stdout) && /split \| \[1\] /.test(splitLogs.stdout), splitLogs.stdout);
  find('split').pids.forEach((pid) => startedPids.add(pid));
  cli(['delete', 'split']);

  // ==================================================================== monit ==
  section('monit');
  cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'observed']);
  await waitFor('the observed app reports its port', () => (find('observed').ports || []).length === 1);
  const snapshot = cli(['monit']);
  check('monit prints one snapshot when stdout is not a tty',
    snapshot.status === 0 && /observed/.test(snapshot.stdout) && /status/.test(snapshot.stdout), snapshot.stdout.slice(0, 120) + snapshot.stderr);
  check('monit says so when it cannot draw the live view', /not a tty/.test(snapshot.stderr), snapshot.stderr);
  check('the snapshot shows the port it bound',
    /port/.test(snapshot.stdout) && snapshot.stdout.includes(String(find('observed').port)), snapshot.stdout.split('\n').slice(0, 2).join(' | '));
  startedPids.add(find('observed').pid);
  cli(['delete', 'observed']);

  // =========================================================== error handling =
  section('error handling');
  const livePid = Number(fs.readFileSync(path.join(HOME, 'daemon.pid'), 'utf8'));
  check('an unknown command exits non-zero', cli(['frobnicate']).status !== 0);
  check('an unknown option is rejected', /unknown option/.test(cli(['list', '--nope']).stderr));
  check('stopping a nonexistent app fails cleanly', /no process matches/.test(cli(['stop', 'nope']).stderr));
  check('a nonexistent script fails cleanly', /Script not found/.test(cli(['start', './does-not-exist.js']).stderr));
  check('failed commands did not replace the daemon', cli(['ping']).stdout.includes(`pid ${livePid}`));

  // ================================================================ cleanliness =
  section('cleanliness');
  cli(['start', path.join(ROOT, 'examples', 'app.js'), '--name', 'final']);
  startedPids.add(find('final').pid);
  const allPids = [...startedPids];
  cli(['kill']);
  await waitFor('the daemon is gone', () => !alive(daemonPid));
  await waitFor('every application it started is gone too', () => allPids.every((pid) => !alive(pid)));
  check('the socket file was removed', !fs.existsSync(path.join(HOME, 'daemon.sock')));
  check('the pid file was removed', !fs.existsSync(path.join(HOME, 'daemon.pid')));
  check('list works (and prints nothing) with no daemon', cli(['list', '--json']).stdout.trim() === '[]');
  check('stop does not resurrect a daemon', /daemon is not running/.test(cli(['stop', 'x']).stderr));
  check('no daemon was started by read-only commands', !fs.existsSync(path.join(HOME, 'daemon.sock')));

  // ------------------------------------------------------------------- result -
  console.log(`\n# ${passed} passed, ${failed} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(WATCHDIR, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('smoke test crashed:', err);
  try {
    console.error('--- daemon.log ---');
    console.error(fs.readFileSync(path.join(HOME, 'daemon.log'), 'utf8').slice(-4000) || '(empty)');
  } catch (ignored) { /* no log */ }
  console.error(`(${passed} passed, ${failed} failed before the crash)`);
  process.exit(1);
});
