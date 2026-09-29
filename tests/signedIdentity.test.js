// Signed identity from the Wix host (#28): token verification, the policy
// per mode, and — over a real socket with ERICA_REQUIRE_SIGNED_IDENTITY=on —
// that a person's raw id no longer opens their history or clipboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const SECRET = 'test-secret-' + 'x'.repeat(32);
process.env.WIX_IDENTITY_SECRET = SECRET;
delete process.env.ERICA_REQUIRE_SIGNED_IDENTITY;
const ident = require('../lib/signedIdentity');
const root = path.join(__dirname, '..');
const NOW = Math.floor(Date.now() / 1000);

test('a minted token verifies; any change to it does not', () => {
    const t = ident.mint({ uid: 'member-A', iat: NOW });
    assert.deepEqual({ ...ident.verify(t, { now: NOW }), iat: undefined, exp: undefined }, { ok: true, uid: 'member-A', iat: undefined, exp: undefined });
    const [v, p, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), uid: 'member-B' })).toString('base64url');
    assert.equal(ident.verify(`${v}.${forged}.${sig}`, { now: NOW }).reason, 'bad_signature', 'someone else inside a real signature');
    assert.equal(ident.verify(`${v}.${p}.${sig.slice(0, -2)}AA`, { now: NOW }).reason, 'bad_signature');
    assert.equal(ident.verify(t, { key: 'another-secret', now: NOW }).reason, 'bad_signature');
    assert.equal(ident.verify(t, { now: NOW + 301 + 61 }).reason, 'expired');
    assert.equal(ident.verify(ident.mint({ uid: 'A', iat: NOW + 3600 }), { now: NOW }).reason, 'issued_in_future');
    assert.equal(ident.verify(ident.mint({ uid: 'A', iat: NOW, ttl: 3600 }), { now: NOW }).reason, 'lifetime_too_long');
    assert.equal(ident.verify(ident.mint({ uid: 'A', iat: NOW, aud: 'pims' }), { now: NOW }).reason, 'wrong_audience');
    assert.equal(ident.verify(ident.mint({ uid: '', iat: NOW }), { now: NOW }).reason, 'no_subject');
    assert.equal(ident.verify('v1.garbage', { now: NOW }).reason, 'malformed');
    assert.equal(ident.verify('eyJhbGciOiJIUzI1NiJ9.e30.x', { now: NOW }).reason, 'malformed');
    assert.equal(ident.verify(t, { key: '', now: NOW }).reason, 'no_secret_configured');
});

function fakeReq(headers = {}) { return { headers, socket: { remoteAddress: '203.0.113.9' } }; }

test('policy: a valid token is the only source of a signed-in identity; an invalid one is refused and audited once a minute', () => {
    const audits = []; const audit = { append: (e) => audits.push(e) };
    const good = ident.mint({ uid: 'member-A' });
    const r = ident.resolve(fakeReq({ 'x-erica-identity': good }), { userId: 'member-B', objectId: 'ct-1' }, { endpoint: 'x', audit });
    assert.deepEqual([r.ok, r.userId, r.objectId, r.source], [true, 'member-A', 'ct-1', 'signed'], 'the body userId is ignored');
    const bad = good.slice(0, -3) + 'AAA';
    const refused = ident.resolve(fakeReq({ 'x-erica-identity': bad }), { userId: 'member-A' }, { endpoint: 'history', audit });
    assert.deepEqual([refused.ok, refused.status, refused.reason], [false, 401, 'bad_signature']);
    ident.resolve(fakeReq({ 'x-erica-identity': bad }), { userId: 'member-A' }, { endpoint: 'history', audit });
    assert.equal(audits.length, 1, 'rate-limited: one line per ip+reason+endpoint per minute');
    assert.equal(audits[0].action, 'identity.rejected');
    assert.equal(audits[0].meta.reason, 'bad_signature');
    assert.match(audits[0].meta.ipHash, /^[0-9a-f]{12}$/, 'ip is hashed, never stored raw');
    // No token, flag off: today's behaviour, labelled.
    assert.equal(ident.resolve(fakeReq(), { userId: 'member-A' }).source, 'unsigned');
    // No token, flag on: no signed-in identity; a guest id stays (unsigned).
    process.env.ERICA_REQUIRE_SIGNED_IDENTITY = 'on';
    try {
        const g = ident.resolve(fakeReq(), { userId: 'member-A', email: 'a@x.com', objectId: 'ct-9' });
        assert.deepEqual([g.userId, g.email, g.objectId, g.source], [null, null, 'ct-9', 'guest']);
        assert.equal(ident.resolve(fakeReq(), { userId: 'member-A' }, { trustLoose: true }).source, 'admin-simulator');
    } finally {
        delete process.env.ERICA_REQUIRE_SIGNED_IDENTITY;
    }
    // A token arrives but this server has no secret: flag off → loud fallback, not a lockout.
    const saved = process.env.WIX_IDENTITY_SECRET; delete process.env.WIX_IDENTITY_SECRET;
    try { assert.equal(ident.resolve(fakeReq({ 'x-erica-identity': good }), { userId: 'member-A' }).source, 'unsigned'); }
    finally { process.env.WIX_IDENTITY_SECRET = saved; }
});

test('client identity.js: the header goes only to this app\'s own /api/, tokens are shape-checked, the parent must be trusted', () => {
    const idc = require('../identity.js');
    const self = 'https://web-staging-2c7ff.up.railway.app';
    assert.equal(idc.shouldAttach('/api/erica-preparation', self), true);
    assert.equal(idc.shouldAttach(self + '/api/clipboard/block', self), true);
    assert.equal(idc.shouldAttach('/index.html', self), false);
    assert.equal(idc.shouldAttach('https://api.openai.com/v1/realtime', self), false, 'never to a third party');
    assert.equal(idc.shouldAttach('https://evil.example/api/x', self), false);
    assert.equal(idc.setToken('not-a-token', 'x'), false);
    assert.equal(idc.setToken(ident.mint({ uid: 'm' }), 'host'), true);
    assert.equal(idc.isTrustedOrigin('https://www.talenttransformation.com', self), true);
    assert.equal(idc.isTrustedOrigin('https://talenttransformation.com.evil.example', self), false);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.ok(html.indexOf('src="identity.js') > 0 && html.indexOf('src="identity.js') < html.indexOf('src="app.js'), 'installed before the app makes any request');
    assert.ok(html.indexOf('src="identity.js') < html.indexOf('src="stateManager.js'), 'first of the local scripts');
});

// --- A real server with the flag on ---
function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function request(port, urlPath, { method = 'POST', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === null ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const t = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json: j, text: t }); });
        });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
}

test('HTTP, ERICA_REQUIRE_SIGNED_IDENTITY=on: A\'s raw id opens nothing; A\'s token opens A\'s clipboard; forged/expired tokens get 401 + an audit line; /api/debug/user needs an admin', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-identity-'));
    const dirs = { SESSION_DATA_DIR: path.join(tmp, 'sessions'), SESSION_PROMPTS_DIR: path.join(tmp, 'prompts'), CLIPBOARD_DATA_DIR: path.join(tmp, 'clipboard'), AUDIT_DIR: path.join(tmp, 'audit'), ACTIVITY_DATA_DIR: path.join(tmp, 'activity') };
    fs.mkdirSync(dirs.CLIPBOARD_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(dirs.CLIPBOARD_DATA_DIR, 'user-member-A.json'), JSON.stringify({
        v: 1, key: 'user-member-A', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastVisitAt: null, lastCursor: null, writes: [],
        items: [{ id: 'i1', kind: 'goal', text: "A's private goal", status: 'active', firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), source: {}, by: 'distill' }],
    }));
    const port = 21000 + Math.floor(Math.random() * 900);
    const { child: server, out } = await startServer(port, { ...dirs, WIX_IDENTITY_SECRET: SECRET, ERICA_REQUIRE_SIGNED_IDENTITY: 'on', SESSION_SECRET: 'x' });
    try {
        for (let i = 0; i < 40 && !/Identity:/.test(out()); i++) await new Promise((r) => setTimeout(r, 100));
        assert.match(out(), /Identity: signed tokens verified; unsigned userId\/email REFUSED/);
        const good = ident.mint({ uid: 'member-A' });
        const H = (t) => ({ 'X-Erica-Identity': t });
        // Raw id, no token: nothing.
        assert.equal((await request(port, '/api/clipboard/block', { body: { userId: 'member-A' } })).json.text, '');
        assert.equal((await request(port, '/api/conversation-history-fetch', { body: { userId: 'member-A' } })).status, 401);
        assert.equal((await request(port, '/api/conversation-history-save', { body: { userId: 'member-A', text: '[]' } })).status, 401);
        // A's token: A's clipboard — whatever userId the body claims.
        const own = await request(port, '/api/clipboard/block', { headers: H(good), body: { userId: 'member-B' } });
        assert.match(own.json.text, /A's private goal/);
        // Forged and expired tokens: 401.
        const forged = good.slice(0, -4) + 'AAAA';
        const r1 = await request(port, '/api/conversation-history-fetch', { headers: H(forged), body: { userId: 'member-A' } });
        assert.deepEqual([r1.status, r1.json.reason], [401, 'bad_signature']);
        const expired = ident.mint({ uid: 'member-A', iat: NOW - 4000, ttl: 300 });
        const r2 = await request(port, '/api/clipboard/block', { headers: H(expired), body: {} });
        assert.deepEqual([r2.status, r2.json.reason], [401, 'expired']);
        const r3 = await request(port, '/api/erica-preparation', { headers: H(forged), body: { caller: 'web' } });
        assert.equal(r3.status, 401, 'preparation (psychometric data) refuses a forged token');
        // The valid token passes the gate (upstream Wix is unreachable in a test; anything but 401).
        assert.notEqual((await request(port, '/api/conversation-history-fetch', { headers: H(good), body: {} })).status, 401);
        // Studio-only diagnostic.
        assert.equal((await request(port, '/api/debug/user?userId=member-A', { method: 'GET' })).status, 401);
        // Audit lines, with reasons and a hashed ip.
        const auditLines = fs.readFileSync(path.join(dirs.AUDIT_DIR, 'audit.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const rejected = auditLines.filter((l) => l.action === 'identity.rejected');
        assert.deepEqual(rejected.map((l) => l.meta.reason).sort(), ['bad_signature', 'bad_signature', 'expired']);
        assert.ok(rejected.every((l) => /^[0-9a-f]{12}$/.test(l.meta.ipHash)));
    } finally {
        server.kill();
    }
});

test('server → Wix HTTP functions carry the bearer when ERICA_WIX_API_SECRET is set (the Wix side can then require it)', () => {
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(server, /const wixAuthHeader = \(\) => \(process\.env\.ERICA_WIX_API_SECRET \? \{ Authorization: 'Bearer ' \+ process\.env\.ERICA_WIX_API_SECRET \} : \{\}\);/);
    assert.equal((server.match(/headers: \{\s*\.\.\.wixAuthHeader\(\),/g) || []).length, 3, 'preparation, history save, history fetch');
});
