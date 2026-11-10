// NEW-3 (QA retest, 10 Nov 2026). The server keeps "this id was prepared from
// this address" in memory (#64, #74). Every deploy or restart forgets it, and
// so does a new address (Wi-Fi to mobile data), and until the page was
// reloaded the open coach got 403 on history, settings, notes, activity and
// its own search. Now:
//   - server: POST /api/erica-preparation { bindOnly: true } binds with the same
//     identity rules and rate limit and does none of the preparation's work;
//   - client: a "not prepared from this address" refusal makes one shared
//     bind-only preparation, and the refused call is sent again, once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

// ── Server: a real restart ────────────────────────────────────────────────
const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], {
            cwd: root, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function post(port, route, ip, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: {
            'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Forwarded-For': `${ip}, 10.0.0.1` } }, (res) => {
            let t = ''; res.on('data', (c) => { t += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json: j, text: t, headers: res.headers }); });
        });
        req.on('error', reject); req.end(data);
    });
}

test('HTTP: after a restart the binding is gone (403); one bind-only preparation brings it back, without doing a preparation', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-rebind-'));
    const env = {
        SESSION_DATA_DIR: path.join(tmp, 'sessions'), SESSION_PROMPTS_DIR: path.join(tmp, 'prompts'), CLIPBOARD_DATA_DIR: path.join(tmp, 'clip'),
        AUDIT_DIR: path.join(tmp, 'audit'), ACTIVITY_DATA_DIR: path.join(tmp, 'activity'), USER_SETTINGS_DIR: path.join(tmp, 'settings'),
        SESSION_SECRET: 'x', ERICA_REQUIRE_SIGNED_IDENTITY: '', OPENAI_API_KEY: '', CLEVERTAP_ACCOUNT_ID: '', CLEVERTAP_PASSCODE: '',
        ERICA_RATE_LIMIT_MAX: '1000', FAKE_WIX_PREP: '200',
    };
    const IP = '203.0.113.40';
    const children = [];
    try {
        // Before the deploy: the page prepared; settings and notes open.
        let port = await freePort();
        let srv = await startServer(port, env); children.push(srv.child);
        assert.equal((await post(port, '/api/erica-preparation', IP, { caller: 'web', userId: 'member-R' })).status, 200);
        assert.equal((await post(port, '/api/user-settings', IP, { userId: 'member-R' })).status, 200);
        srv.child.kill();

        // The deploy: a new process. The open page's next calls are refused (NEW-3).
        port = await freePort();
        srv = await startServer(port, env); children.push(srv.child);
        const refused = (r) => [r.status, r.json && r.json.reason];
        assert.deepEqual(refused(await post(port, '/api/user-settings', IP, { userId: 'member-R' })), [403, 'not_prepared_from_this_address']);
        assert.deepEqual(refused(await post(port, '/api/clipboard/block', IP, { objectId: 'ct-guest-R' })), [403, 'not_prepared_from_this_address']);

        // The coach repairs it: bind-only, for the member and the guest id.
        const wixCallsBefore = (srv.out().match(/\[fake-wix\] prep call/g) || []).length;
        const bind = await post(port, '/api/erica-preparation', IP, { caller: 'web', bindOnly: true, userId: 'member-R', objectId: 'ct-guest-R' });
        assert.equal(bind.status, 204);
        assert.equal(bind.text, '');
        assert.equal(bind.headers['x-session-id'], undefined, 'no new session');
        assert.equal((srv.out().match(/\[fake-wix\] prep call/g) || []).length, wixCallsBefore, 'no Wix preparation call');
        assert.match(srv.out(), /\/api\/erica-preparation - bind only \(userId \+ objectId\)/);
        assert.equal((await post(port, '/api/user-settings', IP, { userId: 'member-R' })).status, 200, 'settings open again');
        assert.equal((await post(port, '/api/clipboard/block', IP, { objectId: 'ct-guest-R' })).status, 200, 'the guest notes open again');

        // It binds only the address that asked: another address stays refused.
        assert.deepEqual(refused(await post(port, '/api/user-settings', '198.51.100.9', { userId: 'member-R' })), [403, 'not_prepared_from_this_address']);
    } finally {
        for (const c of children) c.kill();
    }
});

// ── Client: the coach repairs a refusal once ──────────────────────────────
function method(sig) {
    const at = src.indexOf(`    ${sig} {`) >= 0 ? src.indexOf(`    ${sig} {`) : src.indexOf(`    async ${sig} {`);
    assert.ok(at >= 0, 'method not found: ' + sig);
    const open = src.indexOf(') {', at) + 2;
    let depth = 0; let i = open;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
    const params = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const isAsync = src.slice(at, at + 12).includes('async ');
    // eslint-disable-next-line no-new-func
    return isAsync ? new Function(`return async function (${params}) {${src.slice(open + 1, i)}}`)() : new Function(params, src.slice(open + 1, i));
}
const resp = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, clone() { return resp(status, body); }, json: async () => body, text: async () => JSON.stringify(body) });
const NOT_PREPARED = () => resp(403, { error: 'Unauthorized', reason: 'not_prepared_from_this_address' });

/** routes: { '/api/x': [response, response, ...] } consumed in order, the last repeats. */
function fakeCoach({ userId = 'member-R', cleverTapId = null, routes = {} } = {}) {
    const calls = []; const warns = []; const logs = [];
    global.window = { __ttCleverTapId: cleverTapId, location: { search: '?caller=web' } };
    global.URLSearchParams = URLSearchParams;
    global.fetch = async (url, init) => {
        calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
        await new Promise((r) => setImmediate(r));
        const list = routes[url] || [resp(200)];
        return list.length > 1 ? list.shift() : list[0];
    };
    const app = { apiUrl: (p) => p, getUserIdFromURL: () => userId, getEmailFromURL: () => null, sleep: async () => {} };
    app._coachIdentity = method('_coachIdentity()').bind(app);
    app._notPreparedRefusal = method('_notPreparedRefusal(res, inBody = false)').bind(app);
    app._rebindPreparation = method('_rebindPreparation(sentAt)').bind(app);
    app._withRebind = method('_withRebind(send, { inBody = false } = {})').bind(app);
    app.memberFetch = method('memberFetch(url, options)').bind(app);
    app.fetchWithBackoff = method("fetchWithBackoff(url, options, { label = 'request', retries = 4 } = {})").bind(app);
    const ow = console.warn; const ol = console.log;
    console.warn = (...a) => warns.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' '));
    return { app, calls, warns, logs, restore: () => { console.warn = ow; console.log = ol; } };
}
const init = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('client: a refused settings call prepares again (bind only) and is sent once more', async () => {
    const { app, calls, logs, restore } = fakeCoach({ cleverTapId: 'ct-9', routes: { '/api/user-settings': [NOT_PREPARED(), resp(200, { scope: 'member' })], '/api/erica-preparation': [resp(204)] } });
    try {
        const r = await app.memberFetch('/api/user-settings', init({ userId: 'member-R' }));
        assert.equal(r.status, 200);
        assert.deepEqual(calls.map((c) => c.url), ['/api/user-settings', '/api/erica-preparation', '/api/user-settings']);
        assert.deepEqual(calls[1].body, { caller: 'web', bindOnly: true, userId: 'member-R', objectId: 'ct-9' });
        assert.ok(logs.some((l) => /Prepared again after a "not prepared from this address" refusal/.test(l)));
    } finally { restore(); }
});

test('client: refusals that arrive together share ONE bind-only preparation, and each call is sent again', async () => {
    const { app, calls, restore } = fakeCoach({ routes: {
        '/api/user-settings': [NOT_PREPARED(), resp(200)], '/api/clipboard/block': [NOT_PREPARED(), resp(200)], '/api/user-activity': [NOT_PREPARED(), resp(200)],
        '/api/erica-preparation': [resp(204)] } });
    try {
        const out = await Promise.all(['/api/user-settings', '/api/clipboard/block', '/api/user-activity'].map((u) => app.memberFetch(u, init({ userId: 'member-R' }))));
        assert.deepEqual(out.map((r) => r.status), [200, 200, 200]);
        assert.equal(calls.filter((c) => c.url === '/api/erica-preparation').length, 1, 'one preparation for three refusals');
        assert.equal(calls.length, 7);
    } finally { restore(); }
});

test('client: refused again right after preparing again → no loop: the call stays refused, and it says so', async () => {
    const { app, calls, warns, restore } = fakeCoach({ routes: { '/api/user-settings': [NOT_PREPARED()], '/api/erica-preparation': [resp(204)] } });
    try {
        assert.equal((await app.memberFetch('/api/user-settings', init({ userId: 'member-R' }))).status, 403);
        assert.equal((await app.memberFetch('/api/user-settings', init({ userId: 'member-R' }))).status, 403);
        assert.equal(calls.filter((c) => c.url === '/api/erica-preparation').length, 1, 'one re-preparation per minute at most');
        assert.equal(calls.filter((c) => c.url === '/api/user-settings').length, 3, 'the first call sent twice, the second once');
        assert.ok(warns.some((w) => /Still refused right after preparing again/.test(w)));
    } finally { restore(); }
});

test('client: other refusals, and a coach with no id, never trigger a preparation', async () => {
    const other = fakeCoach({ routes: { '/api/user-settings': [resp(403, { error: 'Unauthorized', reason: 'something_else' })], '/api/clipboard/block': [resp(401, { error: 'identity refused' })] } });
    try {
        assert.equal((await other.app.memberFetch('/api/user-settings', init({}))).status, 403);
        assert.equal((await other.app.memberFetch('/api/clipboard/block', init({}))).status, 401);
        assert.equal(other.calls.filter((c) => c.url === '/api/erica-preparation').length, 0);
    } finally { other.restore(); }
    const anon = fakeCoach({ userId: null, routes: { '/api/user-settings': [NOT_PREPARED()] } });
    try {
        assert.equal((await anon.app.memberFetch('/api/user-settings', init({}))).status, 403);
        assert.equal(anon.calls.filter((c) => c.url === '/api/erica-preparation').length, 0, 'nothing to bind');
    } finally { anon.restore(); }
});

test("client: search_knowledge 'all' answered without the person's store (userDataRefused in the body) is repaired too; a normal 200 is not read", async () => {
    const { app, calls, restore } = fakeCoach({ routes: {
        '/api/knowledge-search': [resp(200, { chunks: [], userDataRefused: 'not_prepared_from_this_address' }), resp(200, { chunks: [{ text: 'mine' }] })],
        '/api/erica-preparation': [resp(204)] } });
    try {
        const r = await app._withRebind(() => fetch('/api/knowledge-search', init({ scope: 'all', userId: 'member-R' })), { inBody: true });
        assert.deepEqual((await r.json()).chunks, [{ text: 'mine' }]);
        assert.deepEqual(calls.map((c) => c.url), ['/api/knowledge-search', '/api/erica-preparation', '/api/knowledge-search']);
        // Without inBody a 200 is returned as is.
        const plain = await app.memberFetch('/api/user-settings', init({ userId: 'member-R' }));
        assert.equal(plain.status, 200);
        assert.equal(calls.length, 4);
    } finally { restore(); }
});

test('client: history save and fetch (fetchWithBackoff) are repaired the same way', async () => {
    const { app, calls, restore } = fakeCoach({ routes: { '/api/conversation-history-save': [NOT_PREPARED(), resp(200)], '/api/erica-preparation': [resp(204)] } });
    try {
        const r = await app.fetchWithBackoff('/api/conversation-history-save', init({ userId: 'member-R', text: '[]' }), { label: 'history save', retries: 2 });
        assert.equal(r.status, 200);
        assert.deepEqual(calls.map((c) => c.url), ['/api/conversation-history-save', '/api/erica-preparation', '/api/conversation-history-save']);
    } finally { restore(); }
});

test('the bind-only preparation binds the same identity the refused calls send (_coachIdentity)', () => {
    const body = src.slice(src.indexOf('    _rebindPreparation(sentAt) {'), src.indexOf('    async _withRebind('));
    assert.match(body, /const ident = this\._coachIdentity\(\);/);
    assert.match(body, /bindOnly: true,\s*\.\.\.ident/);
    assert.ok(src.includes("let ident = this._coachIdentity();") && src.includes("this.memberFetch(this.apiUrl('/api/user-settings'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ident) })"), 'settings send _coachIdentity too');
});

test('wiring: every call for the person\'s own data goes through the repair', () => {
    assert.match(src, /const res = await this\._withRebind\(\(\) => fetch\(url, options\)\);/, 'fetchWithBackoff (history fetch/save)');
    assert.match(src, /this\.memberFetch\(this\.apiUrl\('\/api\/user-activity'\)/);
    assert.match(src, /this\.memberFetch\(this\.apiUrl\('\/api\/clipboard\/block'\)/);
    assert.match(src, /st\.inFlight = true;\s*this\.memberFetch\(url,/, 'clipboard distill');
    assert.equal((src.match(/this\.memberFetch\(this\.apiUrl\('\/api\/user-settings'\)/g) || []).length, 2, 'settings load and save');
    assert.match(src, /this\._withRebind\(\(\) => this\._fetchWithTimeout\(searchUrl,[\s\S]{0,300}?'search_knowledge'\), \{ inBody: true \}\)/);
    assert.doesNotMatch(src, /[^.\w]fetch\(this\.apiUrl\('\/api\/(user-settings|user-activity|clipboard\/block)'\)/, 'no plain fetch left for member data');
});
