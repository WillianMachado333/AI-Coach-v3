// The request safety net (NEW-1, and the QA review of #77, 10 Nov 2026).
// Routes read their body in req.on('data'/'end') listeners, outside
// handleRequest's promise: a throw there (sync) or a rejection (async) used to
// stop the whole process. lib/requestGuard.js wraps those listeners, and
// failRequest handles a failure once: one red line, a 500 if nothing was sent,
// the route's late writes dropped, the rest of the body not read, and the
// failure counted (/api/health "degraded"). Review findings covered here:
//   A  a late write after the 500 (an upstream callback) must not stop the process
//   B  failures are counted and /api/health says "degraded"; an error after a
//      200 is not logged as "Request failed"
//   C  a failed request logs once and its route stops (no line per chunk)
//   D  listener bookkeeping: removeListener / once / pipe / events.once / finished
//   E  the real-server tests check the status, sync and async separately
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const events = require('node:events');
const { PassThrough, Writable, finished } = require('node:stream');
const { spawn } = require('node:child_process');
const { guardRequest, failRequest } = require('../lib/requestGuard');
const failureStats = require('../lib/failureStats');
const { createHealthPayload } = require('../lib/health');

const root = path.join(__dirname, '..');

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const post = (port, route, body, headers = {}) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
        let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 'error:' + e.code }));
    req.end(body);
});
const getJson = (port, route) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: route, agent: false }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    }).on('error', (e) => resolve({ status: 'error:' + e.code }));
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const recorder = () => { const lines = { error: [], warn: [] }; return { lines, log: { error: (...a) => lines.error.push(a.join(' ')), warn: (...a) => lines.warn.push(a.join(' ')), log() {} } }; };

// In-process server: if the guard failed, the throw would take this test
// process down, which node:test reports as a failure.
async function withGuardedServer(route, fn) {
    failureStats._reset();
    const rec = recorder();
    const server = http.createServer((req, res) => { guardRequest(req, res, { log: rec.log }); route(req, res); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { return await fn(server.address().port, rec.lines); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); failureStats._reset(); }
}

test('sync throw in an end listener: one 500, one red line, counted; the next request is served', async () => {
    await withGuardedServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { if (body === 'boom') throw new Error('sync boom'); res.end('ok:' + body); });
    }, async (port, lines) => {
        assert.deepEqual(await post(port, '/', 'boom'), { status: 500, text: '{"error":"internal error"}' });
        assert.equal(lines.error.length, 1);
        assert.match(lines.error[0], /🔴 Request failed → 500 \(process kept running\): POST \/: Error: sync boom/);
        assert.equal(failureStats.snapshot().requestFailed, 1);
        assert.deepEqual(await post(port, '/', 'fine'), { status: 200, text: 'ok:fine' });
    });
});

test('async rejection in an end listener: a 500, not an unhandled rejection', async () => {
    await withGuardedServer((req, res) => {
        req.on('data', () => {});
        req.on('end', async () => { await null; throw new Error('async boom'); });
    }, async (port, lines) => {
        assert.equal((await post(port, '/', '{}')).status, 500);
        assert.match(lines.error[0], /Request failed → 500 .*async boom/);
        assert.equal(failureStats.snapshot().requestFailed, 1);
    });
});

test('A: the route answers late (an upstream callback) after the 500: the late write is dropped, the process lives', async () => {
    let lateWrite = null;
    await withGuardedServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => {
            // An upstream call starts, then a bug throws in the same listener.
            setTimeout(() => {
                try { res.setHeader('X-Late', '1'); res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('late'); res.end('!'); lateWrite = 'no throw'; } catch (e) { lateWrite = 'threw ' + e.code; }
            }, 40);
            throw new Error('bug after the upstream call started');
        });
    }, async (port, lines) => {
        assert.deepEqual(await post(port, '/', 'x'), { status: 500, text: '{"error":"internal error"}' });
        await pause(120);
        assert.equal(lateWrite, 'no throw', 'writeHead / write / end after the 500 do nothing');
        assert.equal(lines.warn.filter((l) => /a write after the failure was dropped/.test(l)).length, 1, 'said once');
        assert.equal(lines.error.length, 1);
    });
});

test('B: an error AFTER a 200 is logged as such, not as "Request failed", and counted apart', async () => {
    await withGuardedServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => { res.end('answered'); });
        req.on('end', () => { throw new Error('late bug'); });
    }, async (port, lines) => {
        assert.deepEqual(await post(port, '/', 'x'), { status: 200, text: 'answered' });
        await pause(20);
        assert.equal(lines.error.length, 1);
        assert.match(lines.error[0], /🔴 Error after the response was sent \(200; process kept running\): POST \/: Error: late bug/);
        assert.doesNotMatch(lines.error[0], /Request failed/);
        const s = failureStats.snapshot();
        assert.equal(s.afterResponse, 1);
        assert.equal(s.requestFailed, 0);
    });
});

test('B: a write after the end (response "error" with no listener) no longer stops the process', async () => {
    await withGuardedServer((req, res) => {
        req.resume();
        req.on('end', () => { res.end('one'); res.write('two'); });
    }, async (port, lines) => {
        assert.equal((await post(port, '/', 'x')).status, 200);
        await pause(30);
        assert.equal(failureStats.snapshot().afterResponse, 1);
        assert.match(lines.error[0], /Error after the response was sent .*write after end/i);
    });
});

test('C: a data listener that throws on every chunk: ONE red line, the route\'s end never runs, the body stops being read', async () => {
    let routeEnded = false;
    await withGuardedServer((req, res) => {
        req.on('data', () => { throw new Error('chunk bug'); });
        req.on('end', () => { routeEnded = true; res.end('should not happen'); });
    }, async (port, lines) => {
        const big = 'x'.repeat(4 * 1024 * 1024); // many chunks
        const r = await post(port, '/', big);
        assert.ok(r.status === 500 || String(r.status).startsWith('error:'), `500 or a closed socket, got ${r.status}`);
        await pause(50);
        assert.equal(lines.error.length, 1, 'one line for one request, not one per chunk');
        assert.equal(routeEnded, false, 'the failed request\'s route stops');
        assert.equal(failureStats.snapshot().requestFailed, 1);
    });
});

test('C: once a request failed, its other body listeners do not run', async () => {
    const ran = [];
    await withGuardedServer((req, res) => {
        req.on('data', () => {});
        req.on('end', () => { ran.push('first'); throw new Error('first end listener bug'); });
        req.on('end', () => { ran.push('second'); res.end('second answer'); });
    }, async (port) => {
        assert.equal((await post(port, '/', 'x')).status, 500);
        await pause(20);
        assert.deepEqual(ran, ['first'], 'the route stopped at the failure');
    });
});

test('B: /api/health payload turns "degraded" after a failure and back to "ok" after the window', () => {
    failureStats._reset();
    let t = 1_000_000;
    failureStats._setNow(() => t);
    try {
        assert.equal(createHealthPayload({ failures: failureStats.snapshot() }).status, 'ok');
        failureStats.note('unhandledRejection');
        const p = createHealthPayload({ failures: failureStats.snapshot() });
        assert.equal(p.status, 'degraded');
        assert.equal(p.failures.unhandledRejection, 1);
        assert.equal(p.failures.last.kind, 'unhandledRejection');
        t += 15 * 60 * 1000 + 1;
        const later = createHealthPayload({ failures: failureStats.snapshot() });
        assert.equal(later.status, 'ok', 'recovered after the window');
        assert.equal(later.failures.unhandledRejection, 1, 'the count stays');
    } finally { failureStats._setNow(null); failureStats._reset(); }
});

// ── D: listener bookkeeping on a guarded stream ────────────────────────────
function guardedStream() {
    const req = new PassThrough();
    req.method = 'POST'; req.url = '/';
    const res = new events.EventEmitter();
    res.headersSent = false; res.writableEnded = false; res.writableFinished = true;
    res.writeHead = () => { res.headersSent = true; }; res.end = () => { res.writableEnded = true; };
    const errors = [];
    const log = { error: (...a) => errors.push(a.join(' ')), warn() {}, log() {} };
    guardRequest(req, res, { log });
    return { req, res, errors, log };
}

test('D: removeListener / off with the original function removes it (on, once, prependListener, prependOnceListener)', () => {
    const { req } = guardedStream();
    for (const add of ['on', 'once', 'prependListener', 'prependOnceListener']) {
        const fn = () => {};
        req[add]('data', fn);
        assert.equal(req.listenerCount('data'), 1, add);
        assert.deepEqual(req.listeners('data'), [fn], `${add}: listeners() shows the original`);
        req.off('data', fn);
        assert.equal(req.listenerCount('data'), 0, `${add}: removed by the original function`);
    }
});

test('D: once fires once and removes itself; an async rejection in it reaches the guard once', async () => {
    failureStats._reset();
    const { req, errors } = guardedStream();
    let calls = 0;
    req.once('end', async () => { calls++; throw new Error('once async boom'); });
    req.emit('end'); req.emit('end');
    await pause(10);
    assert.equal(calls, 1);
    assert.equal(req.listenerCount('end'), 0, 'removed itself');
    assert.equal(errors.length, 1, 'one failure, not two');
    failureStats._reset();
});

test('D: pipe/unpipe, stream.finished and events.once leave no listeners behind', async () => {
    const { req } = guardedStream();
    const before = { data: req.listenerCount('data'), end: req.listenerCount('end') };
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    req.pipe(sink);
    req.unpipe(sink);
    assert.equal(req.listenerCount('data'), before.data, 'unpipe removed its data listener');
    const cleanup = finished(req, () => {});
    cleanup();
    assert.equal(req.listenerCount('end'), before.end, 'finished() cleanup removed its end listener');
    const waiting = events.once(req, 'end');
    req.resume();
    req.end();
    await waiting;
    assert.equal(req.listenerCount('end'), before.end, 'events.once removed its listener');
});

test('failRequest twice for one request: one line, one count, one answer', () => {
    failureStats._reset();
    const { req, res, errors, log } = guardedStream();
    failRequest(req, res, new Error('first'), { log });
    failRequest(req, res, new Error('second'), { log });
    assert.equal(errors.length, 1);
    assert.equal(failureStats.snapshot().requestFailed, 1);
    failureStats._reset();
});

// ── E: the real server.js ─────────────────────────────────────────────────
async function startRealServer() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-guard-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), '-r', path.join(__dirname, 'helpers', 'throwInBodyListener.js'), 'server.js'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', SESSION_SECRET: 'x', ERICA_RATE_LIMIT_MAX: '100000', FAKE_WIX_PREP: '200',
            SESSION_DATA_DIR: path.join(tmp, 's'), SESSION_PROMPTS_DIR: path.join(tmp, 'p'), AUDIT_DIR: path.join(tmp, 'a'),
            USER_SETTINGS_DIR: path.join(tmp, 'u'), CLIPBOARD_DATA_DIR: path.join(tmp, 'c') },
    });
    let out = ''; let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData);
    });
    return { port, child, out: () => out, exited: () => exited };
}
const linesOf = (out, re) => out.split('\n').filter((l) => re.test(l));

for (const mode of ['sync', 'async']) {
    test(`HTTP, the real server, ${mode}: a throwing end listener on the preparation (which answers later, from an upstream call) gets a 500; the late answer is dropped; health says degraded`, async () => {
        const srv = await startRealServer();
        try {
            const r = await post(srv.port, '/api/erica-preparation', JSON.stringify({ caller: 'web' }), { 'x-test-throw-in-end': mode });
            assert.equal(r.status, 500, `the client gets the 500 (${srv.out().slice(-800)})`);
            await pause(400); // the fake Wix answers; the route's own response comes too late
            assert.equal(srv.exited(), null, `the process stopped:\n${srv.out().slice(-1500)}`);
            const failed = linesOf(srv.out(), new RegExp(`Request failed → 500 \\(process kept running\\): POST /api/erica-preparation: Error: test: ${mode} throw in an end listener`));
            assert.equal(failed.length, 1, 'one red line, on the same line as its own error');
            assert.equal(linesOf(srv.out(), /\/api\/erica-preparation: a write after the failure was dropped/).length, 1, 'the route\'s late answer was dropped (A)');
            const health = await getJson(srv.port, '/api/health');
            assert.equal(health.status, 200);
            assert.equal(health.json.status, 'degraded');
            assert.equal(health.json.failures.requestFailed, 1);
            assert.equal(health.json.failures.unhandledRejection, 0, `${mode}: caught by the guard, not by the last line of defence`);
        } finally { srv.child.kill(); }
    });
}

test('HTTP, the real server: an error after the route answered is "after the response", not "Request failed"', async () => {
    const srv = await startRealServer();
    try {
        const r = await post(srv.port, '/api/user-settings', '{}', { 'x-test-throw-in-end': 'sync' });
        assert.ok(r.status !== 500, `the route answered first (${r.status})`);
        await pause(100);
        assert.equal(srv.exited(), null);
        assert.equal(linesOf(srv.out(), /Error after the response was sent \(\d{3}; process kept running\): POST \/api\/user-settings: Error: test: sync throw/).length, 1);
        assert.equal(linesOf(srv.out(), /Request failed → 500/).length, 0);
        const health = await getJson(srv.port, '/api/health');
        assert.equal(health.json.failures.afterResponse, 1);
    } finally { srv.child.kill(); }
});

test('HTTP, the real server (C): a data listener that throws on every chunk of a 4 MB body: one red line, the process lives', async () => {
    const srv = await startRealServer();
    try {
        const r = await post(srv.port, '/api/session-log', 'x'.repeat(4 * 1024 * 1024), { 'x-test-throw-in-end': 'data' }); // under the 5 MB body limit
        assert.ok(r.status === 500 || String(r.status).startsWith('error:'), `500 or a closed socket, got ${r.status}`);
        await pause(200);
        assert.equal(srv.exited(), null);
        assert.equal(linesOf(srv.out(), /test: throw in a data listener/).length, 1, 'one line, not one per chunk');
        assert.equal((await getJson(srv.port, '/api/health')).status, 200);
    } finally { srv.child.kill(); }
});

test('server.js wires the guard, the counters and the health payload', () => {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(src, /const server = http\.createServer\(\(req, res\) => \{\s*guardRequest\(req, res\);\s*(?:if \(!enforceBodyLimit\(req, res\)\) return;\s*)?handleRequest\(req, res\)\.catch\(\(err\) => failRequest\(req, res, err\)\);/);
    assert.match(src, /process\.on\('unhandledRejection', \(reason\) => \{\s*failureStats\.note\('unhandledRejection'\);/);
    assert.match(src, /createHealthPayload\(\{ failures: failureStats\.snapshot\(\) \}\)/);
});
