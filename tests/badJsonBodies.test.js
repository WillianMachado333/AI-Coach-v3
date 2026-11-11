// NEW-1 (production retest, 10 Nov 2026): one POST with the JSON body `null`
// crashed the whole server process on /api/user-settings, /api/clipboard/block,
// /api/clipboard/distill and /api/navigator/infer. Anyone could take the
// service down, repeatedly. Every request body now goes through bodyObject()
// (non-object JSON counts as {}), and an error a handler does not catch is
// answered with a 500 instead of stopping the process.
//
// This test posts null, a number, an array, a string and {} to EVERY /api/
// route named in server.js, and checks the process is still serving after
// each one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

// Every /api/... route literal in server.js (prefixes included).
const ROUTES = [...new Set((serverSrc.match(/'\/api\/[a-z0-9/_-]+'/gi) || []).map((r) => r.slice(1, -1)))]
    .filter((r) => !/\/api\/(health|proxy\/(live|realtime))$/.test(r)); // health is the probe; the proxies relay SDP upstream
const BODIES = ['null', '5', '[]', '"x"', '{}'];

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], {
            cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = ''; let exited = null;
        child.on('exit', (code, signal) => { exited = { code, signal }; });
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out, exited: () => exited }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
const request = (port, method, route, body) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: body == null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(3000, () => { req.destroy(); resolve('timeout'); });
    req.on('error', (e) => resolve('error:' + e.code));
    if (body != null) req.write(body);
    req.end();
});

test('the route list is real (sanity)', () => {
    for (const r of ['/api/user-settings', '/api/clipboard/block', '/api/clipboard/distill', '/api/navigator/infer', '/api/erica-preparation'])
        assert.ok(ROUTES.includes(r), r);
    assert.ok(ROUTES.length >= 20, `${ROUTES.length} routes`);
});

test('HTTP: null, a number, an array, a string or {} as the body never stops the server, on any /api/ route', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-badjson-'));
    const port = await freePort();
    const server = await startServer(port, { SESSION_DATA_DIR: path.join(tmp, 's'), SESSION_PROMPTS_DIR: path.join(tmp, 'p'), AUDIT_DIR: path.join(tmp, 'a'),
        USER_SETTINGS_DIR: path.join(tmp, 'u'), CLIPBOARD_DATA_DIR: path.join(tmp, 'c'), SESSION_SECRET: 'x', ERICA_RATE_LIMIT_MAX: '100000' });
    try {
        const fiveHundreds = [];
        for (const route of ROUTES) {
            for (const body of BODIES) {
                const status = await request(port, 'POST', route, body);
                assert.equal(server.exited(), null, `the process stopped after POST ${route} with ${body}:\n${server.out().slice(-1500)}`);
                if (status === 500) fiveHundreds.push(`${route} ${body}`);
            }
            const health = await request(port, 'GET', '/api/health');
            assert.equal(health, 200, `still serving after ${route}`);
        }
        // The four endpoints that crashed answer cleanly now (no 500 either).
        for (const r of ['/api/user-settings', '/api/clipboard/block', '/api/clipboard/distill', '/api/navigator/infer']) {
            assert.ok(!fiveHundreds.some((x) => x.startsWith(r + ' null')), `${r} answers null without a 500`);
        }
        assert.doesNotMatch(server.out(), /🔴 (Request failed|Error after the response|Unhandled promise rejection)/, 'no handler needed the safety net for these bodies');
        const health = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
            let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(JSON.parse(t)));
        }));
        assert.equal(health.status, 'ok', 'bad bodies are clean refusals, not failures');
    } finally {
        server.child.kill();
    }
});

test('the safety net: an error a handler does not catch is a 500 with a red log line, not a dead process', () => {
    assert.match(serverSrc, /handleRequest\(req, res\)\.catch\(\(err\) => failRequest\(req, res, err\)\);/);
    assert.match(serverSrc, /const \{ guardRequest, failRequest \} = require\('\.\/lib\/requestGuard'\);/);
    assert.match(serverSrc, /guardRequest\(req, res\);\s*(?:if \(!enforceBodyLimit\(req, res\)\) return;\s*)?handleRequest\(req, res\)/, 'the body listeners are guarded too (lib/requestGuard.js)');
    assert.match(serverSrc, /function bodyObject\(text\) \{/);
    assert.doesNotMatch(serverSrc, /JSON\.parse\(body\)/, 'every request body goes through bodyObject');
});
