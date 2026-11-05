// The V3 go-live switch (V3 production prep, 4 Nov 2026). ERICA_GO_LIVE on
// the service that serves bridge.js: off (default) keeps today's preview gate;
// on shows V3 on talenttransformation.com and hides V2's "Ask Erica" button.
// The My Talents app (?minimal=yes) stays on V2 either way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const goLive = require('../lib/goLive');
const { runBridge, BRIDGE_PATH } = require('./helpers/bridgeHarness');

const root = path.join(__dirname, '..');
const BRIDGE = fs.readFileSync(BRIDGE_PATH, 'utf8');
const ON = goLive.bridgeSource(BRIDGE, { ERICA_GO_LIVE: 'on' });
const tt = (search = '', pathname = '/') => ({ hostname: 'www.talenttransformation.com', search, pathname, href: 'https://www.talenttransformation.com' + pathname + search });

test('the flag: off unless 1/true/on/yes; bridge.js carries the marker exactly once; on keeps the file length', () => {
    for (const v of ['1', 'true', 'ON', ' yes ']) assert.equal(goLive.isOn({ ERICA_GO_LIVE: v }), true, v);
    for (const v of [undefined, '', '0', 'off', 'false', 'maybe']) assert.equal(goLive.isOn({ ERICA_GO_LIVE: v }), false, String(v));
    assert.equal(BRIDGE.split(goLive.MARKER).length - 1, 1);
    assert.equal(goLive.bridgeSource(BRIDGE, {}), BRIDGE, 'off: served unchanged');
    assert.equal(ON.length, BRIDGE.length);
    assert.match(ON, /var GO_LIVE = true; /);
    const buf = Buffer.from(BRIDGE);
    assert.ok(Buffer.isBuffer(goLive.bridgeSource(buf, { ERICA_GO_LIVE: 'on' })), 'a Buffer stays a Buffer');
    assert.equal(goLive.bridgeSource('no marker here', { ERICA_GO_LIVE: 'on' }), 'no marker here');
    assert.deepEqual(goLive.status('no marker here', { ERICA_GO_LIVE: 'on' }), { on: true, markerFound: false });
});

test('off (default): talenttransformation.com stays behind the preview gate, V2 untouched', () => {
    const closed = runBridge({ location: tt(), elements: ['askEricaMain'] });
    closed.advance(1000);
    assert.equal(closed.icon(), null, 'no V3 for a normal visitor');
    assert.equal(closed.byId('ct-bridge-hide-v2'), null, 'V2 not hidden');

    const preview = runBridge({ location: tt('?erica=preview') });
    preview.advance(1000);
    assert.ok(preview.icon(), 'preview still opens V3');
    assert.equal(preview.byId('ct-bridge-hide-v2'), null, 'preview does not hide V2 (as today)');
});

test('on: V3 on every talenttransformation.com page, and V2 Ask Erica hidden', () => {
    for (const loc of [tt(), tt('', '/journeys/my-journey'), { ...tt(), hostname: 'talenttransformation.com' }]) {
        const b = runBridge({ source: ON, location: loc });
        b.advance(1000);
        assert.ok(b.icon(), 'V3 shown at ' + loc.hostname + loc.pathname);
        const style = b.byId('ct-bridge-hide-v2');
        assert.ok(style, 'the hide rule is on the page');
        assert.match(style.textContent, /section:has\(button\[aria-label="askErica"\]\)/);
        assert.match(style.textContent, /#askEricaMain/);
        assert.equal(b.win.__ctBridgeStatus().liveHere, true);
    }
});

test('on: other sites keep their own rule (awav always on, V2 not hidden; anything else closed)', () => {
    const awav = runBridge({ source: ON });
    awav.advance(1000);
    assert.ok(awav.icon());
    assert.equal(awav.byId('ct-bridge-hide-v2'), null);
    assert.equal(awav.win.__ctBridgeStatus().liveHere, false);

    const other = runBridge({ source: ON, location: { hostname: 'evil-talenttransformation.com', search: '', pathname: '/', href: 'https://evil-talenttransformation.com/' } });
    other.advance(1000);
    assert.equal(other.icon(), null);
});

test('the My Talents app (?minimal=yes) stays on V2, on or off, for the rest of the tab; ?minimal=no clears it', () => {
    for (const source of [ON, BRIDGE]) {
        const app = runBridge({ source, location: tt('?minimal=yes&erica=preview') });
        app.advance(1000);
        assert.equal(app.icon(), null, 'no V3 in the app');
        assert.equal(app.byId('ct-bridge-hide-v2'), null, 'V2 stays visible in the app');
        assert.equal(app.session.get('ctAppView'), '1');
    }
    const nextPage = runBridge({ source: ON, location: tt('', '/report'), session: { ctAppView: '1' } });
    nextPage.advance(1000);
    assert.equal(nextPage.icon(), null, 'a later page in the same webview stays V2');

    const cleared = runBridge({ source: ON, location: tt('?minimal=no'), session: { ctAppView: '1' } });
    cleared.advance(1000);
    assert.ok(cleared.icon());
    assert.equal(cleared.session.has('ctAppView'), false);
});

function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], {
            cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); setTimeout(() => resolve({ child, out: () => out }), 100); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
const get = (port, route) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
});

test('HTTP: the server writes the flag into bridge.js (new ETag), reports it in /api/health and at startup', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-golive-'));
    const env = { SESSION_DATA_DIR: path.join(tmp, 's'), SESSION_PROMPTS_DIR: path.join(tmp, 'p'), AUDIT_DIR: path.join(tmp, 'a'), SESSION_SECRET: 'x' };
    const base = 24000 + Math.floor(Math.random() * 800);
    const off = await startServer(base, env);
    const on = await startServer(base + 1, { ...env, ERICA_GO_LIVE: 'on' });
    try {
        const a = await get(base, '/bridge.js');
        const b = await get(base + 1, '/bridge.js');
        assert.equal(a.status, 200); assert.equal(b.status, 200);
        assert.match(a.text, /var GO_LIVE = false;/);
        assert.match(b.text, /var GO_LIVE = true; /);
        assert.notEqual(a.headers.etag, b.headers.etag, 'browsers revalidate onto the new value');
        assert.equal(JSON.parse((await get(base, '/api/health')).text).goLive, false);
        assert.equal(JSON.parse((await get(base + 1, '/api/health')).text).goLive, true);
        assert.match(off.out(), /Go-live \(ERICA_GO_LIVE\): off/);
        assert.match(on.out(), /Go-live \(ERICA_GO_LIVE\): ON/);
    } finally {
        off.child.kill(); on.child.kill();
    }
});
