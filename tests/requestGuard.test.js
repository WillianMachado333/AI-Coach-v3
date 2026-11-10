// QA review of #77 (10 Nov 2026): handleRequest's .catch() only sees errors in
// the handler's own promise. A route reads its body in req.on('end', ...)
// callbacks, which run outside it, so a throw there (sync) or a rejection
// (async listener) still stopped the whole process. lib/requestGuard.js wraps
// a request's 'data' and 'end' listeners so those errors become a 500 with a
// red log line, and the process keeps serving.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { guardRequest } = require('../lib/requestGuard');

const root = path.join(__dirname, '..');

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const post = (port, route, body, headers = {}) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
        let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 'error:' + e.code }));
    req.end(body);
});
const get = (port, route) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: route }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); })
        .on('error', (e) => resolve('error:' + e.code));
});

// A small in-process server: if the guard failed, the throw would take this
// test process down, which node:test reports as a failure.
async function withGuardedServer(route, fn) {
    const errors = [];
    const server = http.createServer((req, res) => {
        guardRequest(req, (err) => {
            errors.push(err.message);
            if (!res.headersSent) res.writeHead(500);
            if (!res.writableEnded) res.end('internal error');
        });
        route(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { return await fn(server.address().port, errors); } finally { await new Promise((r) => server.close(r)); }
}

test('a sync throw in an end listener is a 500, and the next request is served', async () => {
    await withGuardedServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (body === 'boom') throw new Error('sync boom');
            res.end('ok:' + body);
        });
    }, async (port, errors) => {
        assert.deepEqual(await post(port, '/', 'boom'), { status: 500, text: 'internal error' });
        assert.deepEqual(errors, ['sync boom']);
        assert.deepEqual(await post(port, '/', 'fine'), { status: 200, text: 'ok:fine' });
    });
});

test('a rejection in an async end listener is a 500, not an unhandled rejection', async () => {
    await withGuardedServer((req, res) => {
        req.on('data', () => {});
        req.on('end', async () => { await null; throw new Error('async boom'); });
    }, async (port, errors) => {
        assert.deepEqual(await post(port, '/', '{}'), { status: 500, text: 'internal error' });
        assert.deepEqual(errors, ['async boom']);
    });
});

test('a throw in a data listener is a 500 too', async () => {
    await withGuardedServer((req, res) => {
        req.on('data', () => { throw new Error('data boom'); });
        req.on('end', () => { if (!res.writableEnded) res.end('ok'); });
    }, async (port, errors) => {
        assert.equal((await post(port, '/', 'x')).status, 500);
        assert.deepEqual(errors, ['data boom']);
    });
});

test('listeners keep their this and arguments; other events are left alone', () => {
    const req = new EventEmitter();
    const seen = [];
    guardRequest(req, (err) => seen.push('error:' + err.message));
    req.on('data', function (chunk) { seen.push(this === req ? 'this-ok' : 'this-wrong', chunk); });
    const onClose = () => seen.push('close');
    req.once('close', onClose);
    assert.ok(req.listeners('close').includes(onClose) || req.rawListeners('close').some((l) => l.listener === onClose), 'close listener is not wrapped');
    req.emit('data', 'chunk-1');
    req.emit('close');
    assert.deepEqual(seen, ['this-ok', 'chunk-1', 'close']);
});

test('server.js wires the guard into every request and logs unhandled rejections in red', () => {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(src, /const server = http\.createServer\(\(req, res\) => \{[\s\S]{0,300}?guardRequest\(req, \(err\) => failRequest\(req, res, err\)\);\s*handleRequest\(req, res\)\.catch\(\(err\) => failRequest\(req, res, err\)\);/);
    assert.match(src, /process\.on\('unhandledRejection', [\s\S]{0,200}?🔴 Unhandled promise rejection \(process kept running\)/);
});

test('HTTP, the real server: a throwing end listener (sync and async) no longer stops the process', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-guard-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), '-r', path.join(__dirname, 'helpers', 'throwInBodyListener.js'), 'server.js'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', SESSION_SECRET: 'x', ERICA_RATE_LIMIT_MAX: '100000',
            SESSION_DATA_DIR: path.join(tmp, 's'), SESSION_PROMPTS_DIR: path.join(tmp, 'p'), AUDIT_DIR: path.join(tmp, 'a'),
            USER_SETTINGS_DIR: path.join(tmp, 'u'), CLIPBOARD_DATA_DIR: path.join(tmp, 'c') },
    });
    let out = ''; let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
            const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(); } };
            child.stdout.on('data', onData); child.stderr.on('data', onData);
        });
        for (const mode of ['sync', 'async']) {
            await post(port, '/api/user-settings', '{}', { 'x-test-throw-in-end': mode });
            await new Promise((r) => setTimeout(r, 150));
            assert.equal(exited, null, `the process stopped after a ${mode} throw in an end listener:\n${out.slice(-1500)}`);
            assert.equal(await get(port, '/api/health'), 200, `still serving after the ${mode} throw`);
            assert.match(out, new RegExp(`🔴 Request failed \\(process kept running\\)[^\\n]*\\n?[\\s\\S]*?test: ${mode} throw in an end listener`));
        }
    } finally {
        child.kill();
    }
});
