// The app's own text (.html/.js/.css) goes out gzipped when the browser takes
// it (V3 production prep, 4 Nov 2026): nothing compressed it, so app.js left
// at 647 KB and bridge.js, on every site page view, at 49 KB. Media is left
// alone. The gzip copy has its own ETag; both say Vary: Accept-Encoding.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { negotiate, acceptsGzip, revalidationHeaders } = require('../lib/staticCache');

const root = path.join(__dirname, '..');

test('acceptsGzip: gzip or *, unless q=0', () => {
    for (const v of ['gzip', 'gzip, deflate, br', 'br;q=1.0, gzip;q=0.8', '*']) assert.equal(acceptsGzip({ 'accept-encoding': v }), true, v);
    for (const v of [undefined, '', 'br', 'identity', 'gzip;q=0', 'deflate']) assert.equal(acceptsGzip({ 'accept-encoding': v }), false, String(v));
});

test('negotiate: our text over 1 KB is gzipped with its own ETag; small files, media and clients without gzip get the file', () => {
    const big = Buffer.from('x'.repeat(5000));
    const h = revalidationHeaders('.js', big, new Date(0));
    const gz = negotiate({ 'accept-encoding': 'gzip' }, h, big);
    assert.equal(gz.headers['Content-Encoding'], 'gzip');
    assert.equal(gz.headers.Vary, 'Accept-Encoding');
    assert.equal(gz.headers.ETag, h.ETag.replace(/"$/, '-gz"'));
    assert.equal(zlib.gunzipSync(gz.body).toString(), big.toString());
    const plain = negotiate({}, h, big);
    assert.equal(plain.body, big);
    assert.equal(plain.headers.Vary, 'Accept-Encoding');
    assert.equal(plain.headers['Content-Encoding'], undefined);
    const small = Buffer.from('tiny');
    assert.equal(negotiate({ 'accept-encoding': 'gzip' }, revalidationHeaders('.js', small, null), small).body, small);
    assert.deepEqual(negotiate({ 'accept-encoding': 'gzip' }, null, big), { headers: null, body: big }, 'media: untouched');
});

function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], {
            cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(child); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
const get = (port, route, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
});

test('HTTP: bridge.js and app.js gzipped on request; a revalidation with the gzip ETag is a 304; plain clients unchanged', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-gzip-'));
    const port = 24900 + Math.floor(Math.random() * 90);
    const server = await startServer(port, { SESSION_DATA_DIR: path.join(tmp, 's'), SESSION_PROMPTS_DIR: path.join(tmp, 'p'), AUDIT_DIR: path.join(tmp, 'a'), SESSION_SECRET: 'x' });
    try {
        for (const file of ['/bridge.js', '/app.js']) {
            const raw = fs.readFileSync(path.join(root, file));
            const gz = await get(port, file, { 'Accept-Encoding': 'gzip, deflate, br' });
            assert.equal(gz.status, 200);
            assert.equal(gz.headers['content-encoding'], 'gzip', file);
            assert.ok(gz.body.length < raw.length / 2, `${file}: ${gz.body.length} bytes on the wire for ${raw.length}`);
            assert.equal(zlib.gunzipSync(gz.body).length, raw.length);
            const again = await get(port, file, { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.headers.etag });
            assert.equal(again.status, 304, 'revalidation with the gzip ETag');
            assert.equal(again.headers['content-encoding'], undefined);
            const plain = await get(port, file);
            assert.equal(plain.headers['content-encoding'], undefined);
            assert.equal(plain.body.length, raw.length);
            assert.notEqual(plain.headers.etag, gz.headers.etag);
        }
        const video = await get(port, '/companions/idle/84p/Erica.webm', { 'Accept-Encoding': 'gzip' });
        assert.equal(video.headers['content-encoding'], undefined, 'media is not recompressed');
    } finally {
        server.kill();
    }
});
