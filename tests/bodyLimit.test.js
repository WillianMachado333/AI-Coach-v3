// Request body size limits (QA review of #77 and SEC-09, 10 Nov 2026).
// Most routes kept the whole body in a string with no limit (~560 MB on
// /api/session-log grew to ~512 MB), and the few with a limit cut the socket,
// so the client saw a reset instead of an answer. Now every request has a
// limit (lib/bodyLimit.js), and over it the client gets a 413 it can read;
// the route never sees the rest of the body.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { guardRequest } = require('../lib/requestGuard');
const { enforceBodyLimit, limitFor } = require('../lib/bodyLimit');
const failureStats = require('../lib/failureStats');

const root = path.join(__dirname, '..');
const KB = 1024; const MB = 1024 * KB;
const keepAlive = () => new http.Agent({ keepAlive: true });

function send(port, route, size, { chunked = false, agent = keepAlive() } = {}) {
    return new Promise((resolve) => {
        const headers = { 'Content-Type': 'application/json', ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': size }) };
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers, agent }, (res) => {
            let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { agent.destroy(); resolve({ status: res.statusCode, text: t }); });
        });
        req.on('error', (e) => { agent.destroy(); resolve({ status: 'error:' + e.code }); });
        const buf = Buffer.alloc(64 * KB, 120);
        let sent = 0;
        const pump = () => { while (sent < size) { const n = Math.min(buf.length, size - sent); sent += n; if (!req.write(n === buf.length ? buf : buf.subarray(0, n))) return req.once('drain', pump); } req.end(); };
        pump();
    });
}

async function withLimitedServer(route, fn) {
    const warns = [];
    const log = { warn: (...a) => warns.push(a.join(' ')), error() {}, log() {} };
    const server = http.createServer((req, res) => {
        guardRequest(req, res, { log });
        if (!enforceBodyLimit(req, res, { log })) return;
        route(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { return await fn(server.address().port, warns); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('the limits: the routes that had one keep it, everything else gets the default (5 MB, ERICA_MAX_BODY_BYTES)', () => {
    assert.equal(limitFor('/api/user-settings'), 8 * KB);
    assert.equal(limitFor('/api/navigator/infer'), 32 * KB);
    assert.equal(limitFor('/api/clipboard/block'), 96 * KB);
    assert.equal(limitFor('/api/clipboard/distill?x=1'), 96 * KB);
    assert.equal(limitFor('/api/admin/attachments'), 8 * MB);
    assert.equal(limitFor('/oauth/register'), 64 * KB);
    assert.equal(limitFor('/mcp'), 1 * MB);
    for (const r of ['/api/session-log', '/api/conversation-history-save', '/api/erica-preparation', '/admin/injected-data/safety-rules/upsert']) assert.equal(limitFor(r), 5 * MB, r);
    process.env.ERICA_MAX_BODY_BYTES = String(2 * MB);
    try { assert.equal(limitFor('/api/session-log'), 2 * MB); } finally { delete process.env.ERICA_MAX_BODY_BYTES; }
});

test('over the limit by Content-Length, or as it arrives (chunked): a 413 the client reads; the route never sees it; not a server failure', async () => {
    failureStats._reset();
    let routeSaw = 0;
    await withLimitedServer((req, res) => {
        req.on('data', (c) => { routeSaw += c.length; });
        req.on('end', () => res.end('ok'));
    }, async (port, warns) => {
        const declared = await send(port, '/api/user-settings', 20 * KB);
        assert.equal(declared.status, 413);
        assert.deepEqual(JSON.parse(declared.text), { error: 'Request body too large', limitBytes: 8 * KB });
        assert.equal(routeSaw, 0, 'refused before the route ran');
        const chunked = await send(port, '/api/user-settings', 200 * KB, { chunked: true });
        assert.equal(chunked.status, 413, 'chunked: refused as it arrives');
        assert.ok(routeSaw <= 8 * KB, `the route saw at most the limit (${routeSaw})`);
        assert.equal(warns.filter((w) => /413 POST \/api\/user-settings: body over the 8 KB limit/.test(w)).length, 2);
        assert.equal(failureStats.snapshot().requestFailed, 0, 'a 413 is the client\'s error, not a failure');
    });
    failureStats._reset();
});

test('a big body over the default is refused without growing in memory, and the client still reads the 413', async () => {
    await withLimitedServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => res.end('kept ' + body.length));
    }, async (port) => {
        const r = await send(port, '/api/session-log', 40 * MB, { chunked: true });
        assert.equal(r.status, 413);
    });
});

test('under the limit nothing changes, even for a route that starts listening late (the limit never starts the stream early)', async () => {
    await withLimitedServer((req, res) => {
        setTimeout(() => {
            let n = 0;
            req.on('data', (c) => { n += c.length; });
            req.on('end', () => res.end('got ' + n));
        }, 50);
    }, async (port) => {
        assert.deepEqual(await send(port, '/api/session-log', 300 * KB), { status: 200, text: 'got ' + 300 * KB });
        assert.deepEqual(await send(port, '/api/user-settings', 8 * KB), { status: 200, text: 'got ' + 8 * KB }, 'exactly the limit passes');
    });
});

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('HTTP, the real server: session-log over 5 MB and user-settings over 8 KB get a 413 (they used to grow or reset); health stays ok', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-limit-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', SESSION_SECRET: 'x', ERICA_RATE_LIMIT_MAX: '100000',
            SESSION_DATA_DIR: path.join(tmp, 's'), SESSION_PROMPTS_DIR: path.join(tmp, 'p'), AUDIT_DIR: path.join(tmp, 'a'),
            USER_SETTINGS_DIR: path.join(tmp, 'u'), CLIPBOARD_DATA_DIR: path.join(tmp, 'c') },
    });
    let out = '';
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
            const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(); } };
            child.stdout.on('data', onData); child.stderr.on('data', onData);
        });
        assert.equal((await send(port, '/api/session-log', 6 * MB, { chunked: true })).status, 413);
        assert.equal((await send(port, '/api/user-settings', 14 * KB)).status, 413);
        assert.equal((await send(port, '/api/navigator/infer', 215 * KB)).status, 413);
        const health = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
            let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(JSON.parse(t)));
        }));
        assert.equal(health.status, 'ok');
        assert.equal(out.split('\n').filter((l) => /⚠️ 413 POST/.test(l)).length, 3);
    } finally { child.kill(); }
});

test('server.js: the limit is checked after the guard and before routing', () => {
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(src, /guardRequest\(req, res\);\s*if \(!enforceBodyLimit\(req, res\)\) return;\s*handleRequest\(req, res\)/);
});
