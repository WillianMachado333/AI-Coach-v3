// Every deploy stopped the old process with SIGTERM, Node died of the signal,
// npm logged "command failed / signal SIGTERM", and Railway emailed
// "Deployment crashed" (10 Nov 2026: production 18:55 and 19:06 UTC, staging
// 12:32, 12:35, 12:44), indistinguishable from a real crash. lib/shutdown.js
// closes the server on SIGTERM / SIGINT, lets open requests finish, and exits 0.
// (Windows has no POSIX signals, so the test emits the signal event in-process.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { installGracefulShutdown } = require('../lib/shutdown');

const quietLog = () => { const lines = []; return { lines, log: (...a) => lines.push(a.join(' ')) }; };
const get = (port, route) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: route, agent: false }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    }).on('error', (e) => resolve({ status: 'error:' + e.code }));
});

test('SIGTERM: the open request still gets its answer, new connections are refused, then exit(0)', async () => {
    let release;
    const slow = new Promise((r) => { release = r; });
    const server = http.createServer(async (req, res) => {
        if (req.url === '/slow') await slow;
        res.end('done ' + req.url);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const exits = []; const out = quietLog();
    const g = installGracefulShutdown(server, { graceMs: 5000, exit: (code) => exits.push(code), log: out });
    try {
        const inFlight = get(port, '/slow');
        await new Promise((r) => setTimeout(r, 50));
        process.emit('SIGTERM');
        await new Promise((r) => setTimeout(r, 50));
        assert.match((await get(port, '/new')).status, /^error:ECONNREFUSED$/, 'no new connections after SIGTERM');
        assert.deepEqual(exits, [], 'waits for the open request');
        release();
        assert.deepEqual(await inFlight, { status: 200, text: 'done /slow' }, 'the open request finished');
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(exits, [0], 'exit code 0: not a crash');
        assert.ok(out.lines.some((l) => /SIGTERM: stopping/.test(l)));
        assert.ok(out.lines.some((l) => /Stopped cleanly \(every open request finished\)/.test(l)));
        process.emit('SIGTERM');
        assert.deepEqual(exits, [0], 'a second signal does nothing more');
    } finally {
        g.uninstall();
        server.close();
    }
});

test('a request that never ends cannot hold the stop: after the grace, connections close and exit(0)', async () => {
    const server = http.createServer(() => { /* never answers */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const exits = []; const out = quietLog();
    const g = installGracefulShutdown(server, { graceMs: 200, exit: (code) => exits.push(code), log: out, signals: ['SIGINT'] });
    try {
        const hung = get(port, '/hang');
        await new Promise((r) => setTimeout(r, 50));
        process.emit('SIGINT');
        assert.match(String((await hung).status), /^error:/, 'the hung connection was closed');
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(exits, [0], 'exactly one exit(0)');
        assert.ok(out.lines.some((l) => /grace of 0s over/.test(l) || /grace of \ds over/.test(l)));
    } finally {
        g.uninstall();
        server.close();
    }
});

test('server.js installs it before listening', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(src, /const \{ installGracefulShutdown \} = require\('\.\/lib\/shutdown'\);/);
    assert.match(src, /installGracefulShutdown\(server, \{ graceMs: Number\(process\.env\.ERICA_SHUTDOWN_GRACE_MS\) \|\| 5000 \}\);\s*\n\s*server\.listen\(PORT/);
});
