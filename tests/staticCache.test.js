const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { revalidationHeaders, isNotModified } = require('../lib/staticCache');

const root = path.join(__dirname, '..');

test('.html, .js and .css revalidate; media is left alone', () => {
    const mtime = new Date('2026-09-29T00:00:00Z');
    for (const ext of ['.html', '.js', '.css', '.JS']) {
        const headers = revalidationHeaders(ext, Buffer.from('x'), mtime);
        assert.equal(headers['Cache-Control'], 'no-cache', ext);
        assert.match(headers.ETag, /^"[A-Za-z0-9_-]+"$/, 'strong ETag (no W/ prefix)');
        assert.equal(headers['Last-Modified'], 'Tue, 29 Sep 2026 00:00:00 GMT');
    }
    for (const ext of ['.png', '.webm', '.mp4', '.json', '.gif']) assert.equal(revalidationHeaders(ext, Buffer.from('x'), mtime), null, ext);
});

test('the ETag follows the content, not the timestamp', () => {
    const a = revalidationHeaders('.js', Buffer.from('one'), new Date(1));
    const b = revalidationHeaders('.js', Buffer.from('one'), new Date(999999999999));
    const c = revalidationHeaders('.js', Buffer.from('two'), new Date(1));
    assert.equal(a.ETag, b.ETag);
    assert.notEqual(a.ETag, c.ETag);
});

test('If-None-Match: exact, list, weak, star; If-Modified-Since only without it', () => {
    const h = revalidationHeaders('.css', Buffer.from('body{}'), new Date('2026-09-29T00:00:00Z'));
    assert.equal(isNotModified({ 'if-none-match': h.ETag }, h), true);
    assert.equal(isNotModified({ 'if-none-match': `"other", ${h.ETag}` }, h), true);
    assert.equal(isNotModified({ 'if-none-match': `W/${h.ETag}` }, h), true);
    assert.equal(isNotModified({ 'if-none-match': '*' }, h), true);
    assert.equal(isNotModified({ 'if-none-match': '"stale"' }, h), false);
    assert.equal(isNotModified({}, h), false);
    assert.equal(isNotModified({ 'if-modified-since': 'Tue, 29 Sep 2026 00:00:00 GMT' }, h), true);
    assert.equal(isNotModified({ 'if-modified-since': 'Mon, 28 Sep 2026 00:00:00 GMT' }, h), false);
    // A stale ETag decides the answer; a fresh If-Modified-Since must not override it.
    assert.equal(isNotModified({ 'if-none-match': '"stale"', 'if-modified-since': 'Wed, 30 Sep 2026 00:00:00 GMT' }, h), false);
    assert.equal(isNotModified({ 'if-none-match': h.ETag }, null), false, 'no headers for the type: never 304');
});

// The real server, over a socket, the way a browser and the Wix embed meet it.
function startServer(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: root,
            env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (chunk) => {
            out += String(chunk);
            if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(child); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
    });
}

function request(port, urlPath, { method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('static responses carry the headers, and a matching If-None-Match gets a bodyless 304', async () => {
    const port = 18000 + Math.floor(Math.random() * 1000);
    const server = await startServer(port);
    try {
        for (const file of ['/index.html', '/app.js?v=1', '/styles.css', '/bridge.js']) {
            const first = await request(port, file);
            assert.equal(first.status, 200, file);
            assert.equal(first.headers['cache-control'], 'no-cache', file);
            assert.match(first.headers.etag, /^"[A-Za-z0-9_-]+"$/, file);
            assert.ok(first.headers['last-modified'], file);
            assert.ok(first.body.length > 0, file);

            const head = await request(port, file, { method: 'HEAD' });
            assert.equal(head.status, 200, `HEAD ${file}`);
            assert.equal(head.headers.etag, first.headers.etag, `HEAD ${file}`);

            const second = await request(port, file, { headers: { 'If-None-Match': first.headers.etag } });
            assert.equal(second.status, 304, file);
            assert.equal(second.body.length, 0, `${file} 304 has no body`);
            assert.equal(second.headers.etag, first.headers.etag, file);
            assert.equal(second.headers['cache-control'], 'no-cache', file);

            const stale = await request(port, file, { headers: { 'If-None-Match': '"stale"' } });
            assert.equal(stale.status, 200, `${file} with a stale ETag`);
        }
        const image = await request(port, '/companions/Erica-thumb.png');
        assert.equal(image.status, 200);
        assert.equal(image.headers['cache-control'], undefined, 'media is untouched');
        assert.equal(image.headers.etag, undefined);
    } finally {
        server.kill();
    }
});
