// The Coach Studio icons: the files exist and are what their names say, the
// real server serves them (200, image/*, a day's cache, 304), every page we
// own points at them, and MCP serverInfo carries them on the public origin.
//
// Why: with no favicon on our origin, anything that looked one up fell back
// to railway.app's (the Railway logo on the claude.ai connector, 2026-10-09).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const brandIcons = require('../lib/brandIcons');
const { resolvePublicPath, looksLikeProbe } = require('../lib/staticPath');
const { iconHeaders, isNotModified, ICON_MAX_AGE_S } = require('../lib/staticCache');

const root = path.join(__dirname, '..');
const ROOT_PROBES = ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png'];
const URLS = brandIcons.FILES.map((f) => '/' + f);

// Magic bytes, not just the extension (MCP clients sniff them).
function kindOf(buf) {
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) return 'ico';
    if (/^\s*<svg[\s>]/.test(buf.toString('utf8', 0, 200))) return 'svg';
    return 'unknown';
}
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
function icoFrames(buf) {
    const n = buf.readUInt16LE(4);
    return Array.from({ length: n }, (_, i) => {
        const e = 6 + 16 * i;
        const size = buf[e] || 256;
        const bytes = buf.readUInt32LE(e + 8);
        const offset = buf.readUInt32LE(e + 12);
        return { size, png: buf.subarray(offset, offset + bytes) };
    });
}

test('the icon files exist, are what their names say, at the sizes their names say, and stay small', () => {
    let total = 0;
    for (const rel of brandIcons.FILES) {
        const buf = fs.readFileSync(path.join(root, rel));
        total += buf.length;
        assert.equal(kindOf(buf), path.extname(rel).slice(1), rel);
        const m = rel.match(/-(\d+)\.png$/);
        if (m) assert.deepEqual(pngSize(buf), [Number(m[1]), Number(m[1])], rel);
    }
    assert.deepEqual(pngSize(fs.readFileSync(path.join(root, 'apple-touch-icon.png'))), [180, 180]);
    assert.deepEqual(pngSize(fs.readFileSync(path.join(root, 'studio-assets/coach-studio-app-icon.png'))), [512, 512]);
    const frames = icoFrames(fs.readFileSync(path.join(root, 'favicon.ico')));
    assert.deepEqual(frames.map((f) => f.size), [16, 32, 48]);
    for (const f of frames) {
        assert.equal(kindOf(f.png), 'png', `ico frame ${f.size}`);
        assert.deepEqual(pngSize(f.png), [f.size, f.size], `ico frame ${f.size}`);
    }
    assert.ok(total < 150 * 1024, `icons total ${total} B`);
});

test('every icon URL passes the static allowlist and is not taken for a probe', () => {
    for (const url of URLS) {
        assert.ok(resolvePublicPath(url, root), `${url} should be served`);
        assert.equal(looksLikeProbe(url), false, url);
    }
    for (const url of ROOT_PROBES) assert.ok(brandIcons.isBrandIcon(url.slice(1)), url);
    assert.equal(brandIcons.isBrandIcon('index.html'), false);
    assert.equal(brandIcons.isBrandIcon('companions/Erica-thumb.png'), false);
});

test('icons are cached for a day, then revalidated (never immutable: the names are fixed)', () => {
    const h = iconHeaders(Buffer.from('png'), new Date('2026-10-09T00:00:00Z'));
    assert.equal(ICON_MAX_AGE_S, 86400);
    assert.equal(h['Cache-Control'], 'public, max-age=86400');
    assert.match(h.ETag, /^"[A-Za-z0-9_-]+"$/);
    assert.equal(h['Last-Modified'], 'Fri, 09 Oct 2026 00:00:00 GMT');
    assert.equal(isNotModified({ 'if-none-match': h.ETag }, h), true);
});

test('the head links point at served icons; index.html carries them', () => {
    const hrefs = [...brandIcons.HEAD_LINKS.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']);
    for (const href of hrefs) assert.ok(resolvePublicPath(href, root), href);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
    assert.match(html, /<link rel="icon" href="\/favicon\.ico"/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
});

test('MCP icons: same-origin https on the public origin, PNG and SVG with sizes, no data: URIs', () => {
    const icons = brandIcons.mcpIcons('https://coach.example.com/');
    assert.deepEqual(icons.map((i) => [i.mimeType, i.sizes.join()]), [
        ['image/png', '48x48'], ['image/png', '96x96'], ['image/png', '192x192'], ['image/svg+xml', 'any'],
    ]);
    for (const icon of icons) {
        const u = new URL(icon.src);
        assert.equal(u.origin, 'https://coach.example.com', icon.src);
        assert.ok(brandIcons.isBrandIcon(u.pathname.slice(1)), `${icon.src} is one of the served files`);
    }
    assert.deepEqual(brandIcons.mcpIcons(''), []);
});

// ---- the real server --------------------------------------------------------

function startServer(port, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: root,
            env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
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
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):
${out}`)); });
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

test('the server: every icon 200 image/* with its bytes, a day of cache, 304 on revalidation; / and the Studio and OAuth pages link them', async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    const server = await startServer(port);
    try {
        for (const url of URLS) {
            const r = await request(port, url);
            assert.equal(r.status, 200, url);
            assert.match(r.headers['content-type'], /^image\//, url);
            assert.equal(r.headers['content-type'], { '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(url)], url);
            assert.ok(r.body.equals(fs.readFileSync(path.join(root, url.slice(1)))), `${url} bytes`);
            assert.equal(r.headers['cache-control'], 'public, max-age=86400', url);
            assert.match(r.headers.etag, /^"[A-Za-z0-9_-]+"$/, url);
            const again = await request(port, url, { headers: { 'If-None-Match': r.headers.etag } });
            assert.deepEqual([again.status, again.body.length], [304, 0], `${url} revalidates`);
        }
        const head = await request(port, '/favicon.ico', { method: 'HEAD' });
        assert.deepEqual([head.status, head.headers['content-type']], [200, 'image/x-icon']);
        // Other media keeps its old behaviour.
        assert.equal((await request(port, '/companions/Erica-thumb.png')).headers['cache-control'], undefined);

        // A resolver that reads the root page finds the icons there.
        const home = await request(port, '/');
        assert.equal(home.status, 200);
        assert.ok(home.body.toString('utf8').includes('<link rel="icon" href="/favicon.svg"'), '/ links the icons');
        // Coach Studio sign-in, and an OAuth page (the "Unknown app" error: no client).
        const login = (await request(port, '/admin/login')).body.toString('utf8');
        assert.ok(login.includes(brandIcons.HEAD_LINKS), 'Studio login links the icons');
        assert.ok(!login.includes('data:image/svg+xml'), 'no inline favicon left');
        const oauth = await request(port, '/oauth/authorize?client_id=nobody');
        assert.equal(oauth.status, 400);
        const oauthHtml = oauth.body.toString('utf8');
        assert.ok(oauthHtml.includes(brandIcons.HEAD_LINKS), 'OAuth pages link the icons');
        assert.match(oauthHtml, /<div[^>]*data-brand><img src="\/studio-assets\/coach-studio-96\.png"/, 'the mark heads the card');
    } finally {
        server.kill();
    }
});
