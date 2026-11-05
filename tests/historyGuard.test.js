// Preparation + history guard (port of V2 ac93495): a per-IP rate limit on
// /api/erica-preparation and /api/conversation-history-*, and an unsigned
// userId's history only from the IP that prepared it. Anyone holding a
// member id could otherwise read or overwrite that person's conversations.
// A Wix-signed identity (#28) proves the user, so it skips the binding.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHistoryGuard, fromEnv, DEFAULTS } = require('../lib/historyGuard');

const SECRET = 'test-secret-' + 'h'.repeat(32);
process.env.WIX_IDENTITY_SECRET = SECRET;
delete process.env.ERICA_REQUIRE_SIGNED_IDENTITY;
const ident = require('../lib/signedIdentity');
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clock(start = 1_000_000) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    return now;
}

// --- The module, on a fake clock ---

test('binding: a userId is bound to the IP that prepared it, for the window, and to nothing else', () => {
    const now = clock();
    const g = createHistoryGuard({ bindingTtlMs: 1000, now });
    g.bind('198.51.100.1', 'member-A');
    assert.equal(g.isBound('198.51.100.1', 'member-A'), true);
    assert.equal(g.isBound('198.51.100.2', 'member-A'), false, 'another IP');
    assert.equal(g.isBound('198.51.100.1', 'member-B'), false, 'another userId');
    assert.equal(g.isBound('198.51.100.1', ''), false);
    assert.equal(g.isBound('198.51.100.1', null), false);
    g.bind('198.51.100.1', '');
    assert.equal(g.stats().bindings, 1, 'an empty userId binds nothing');
    now.advance(1000);
    assert.equal(g.isBound('198.51.100.1', 'member-A'), true, 'still inside the window at its last millisecond');
    now.advance(1);
    assert.equal(g.isBound('198.51.100.1', 'member-A'), false, 'expired');
    assert.equal(g.admit('198.51.100.1', 'member-A'), false);
    assert.equal(g.stats().bindings, 0, 'a refused admit drops the expired entry');
});

test('binding: each history call that passes renews the window, so an open coach keeps saving past it', () => {
    const now = clock();
    const g = createHistoryGuard({ bindingTtlMs: 1000, now });
    g.bind('ip-1', 'member-A');
    for (let i = 0; i < 5; i++) {
        now.advance(900);
        assert.equal(g.admit('ip-1', 'member-A'), true, `save ${i + 1}, ${(i + 1) * 900} ms after the preparation`);
    }
    now.advance(1001);
    assert.equal(g.admit('ip-1', 'member-A'), false, 'idle past the window: refused');
    g.bind('ip-1', 'member-A');
    assert.equal(g.admit('ip-1', 'member-A'), true, 'a new preparation binds again');
});

test('rate limit: N requests per window per IP; the next is refused, the first refusal says so once; the window resets', () => {
    const now = clock();
    const g = createHistoryGuard({ rateLimitMax: 3, rateWindowMs: 60000, now });
    assert.deepEqual([1, 2, 3].map(() => g.hit('ip-1').ok), [true, true, true]);
    const r4 = g.hit('ip-1');
    assert.deepEqual([r4.ok, r4.first, r4.count, r4.limit], [false, true, 4, 3]);
    assert.equal(r4.resetInMs, 60000);
    const r5 = g.hit('ip-1');
    assert.deepEqual([r5.ok, r5.first], [false, false], 'logged once per window, not per hit');
    assert.equal(g.hit('ip-2').ok, true, 'another IP has its own budget');
    now.advance(59999);
    assert.equal(g.hit('ip-1').ok, false, 'same window');
    now.advance(1);
    const fresh = g.hit('ip-1');
    assert.deepEqual([fresh.ok, fresh.count], [true, 1], 'new window');
    assert.equal(g.hit('').ok, true, 'no address: one shared "unknown" bucket, never a crash');
});

test('pruning: expired entries go on the next write once a rate window has passed; never sooner', () => {
    const now = clock();
    const g = createHistoryGuard({ rateLimitMax: 5, rateWindowMs: 1000, bindingTtlMs: 5000, now });
    for (let i = 0; i < 50; i++) { g.hit(`ip-${i}`); g.bind(`ip-${i}`, `member-${i}`); }
    assert.deepEqual(g.stats(), { rates: 50, bindings: 50 });
    now.advance(999);
    g.hit('ip-x');
    assert.deepEqual(g.stats(), { rates: 51, bindings: 50 }, 'no sweep inside the window');
    now.advance(1);
    g.hit('ip-y');
    assert.deepEqual(g.stats(), { rates: 2, bindings: 50 }, 'the 50 expired rate entries went (ip-x, 1 ms old, and ip-y stay); bindings still live');
    now.advance(5001);
    g.bind('ip-z', 'member-z');
    assert.deepEqual(g.stats(), { rates: 0, bindings: 1 }, 'everything expired went; the new binding stays');
});

test('memory cap: over maxEntries the oldest entry goes; a renewed binding counts as new', () => {
    const now = clock();
    const g = createHistoryGuard({ maxEntries: 3, now });
    g.bind('ip', 'u1'); g.bind('ip', 'u2'); g.bind('ip', 'u3');
    assert.equal(g.admit('ip', 'u1'), true, 'u1 renewed → newest');
    g.bind('ip', 'u4');
    assert.equal(g.stats().bindings, 3);
    assert.equal(g.isBound('ip', 'u2'), false, 'the oldest (u2) went');
    assert.deepEqual(['u1', 'u3', 'u4'].map((u) => g.isBound('ip', u)), [true, true, true]);
    for (let i = 0; i < 10; i++) g.hit(`flood-${i}`);
    assert.equal(g.stats().rates, 3, 'a flood of addresses cannot grow the rate map past the cap');
});

test('config from env: ERICA_RATE_LIMIT_MAX and ERICA_HISTORY_BINDING_TTL_MS; missing or invalid → the V2 defaults', () => {
    assert.deepEqual([DEFAULTS.rateLimitMax, DEFAULTS.rateWindowMs, DEFAULTS.bindingTtlMs], [30, 60000, 30 * 60000]);
    const g = fromEnv({ ERICA_RATE_LIMIT_MAX: '7', ERICA_HISTORY_BINDING_TTL_MS: '1500' });
    assert.deepEqual([g.config.rateLimitMax, g.config.bindingTtlMs], [7, 1500]);
    for (const bad of [{}, { ERICA_RATE_LIMIT_MAX: '0', ERICA_HISTORY_BINDING_TTL_MS: '-1' }, { ERICA_RATE_LIMIT_MAX: 'abc', ERICA_HISTORY_BINDING_TTL_MS: '' }]) {
        const d = fromEnv(bad);
        assert.deepEqual([d.config.rateLimitMax, d.config.bindingTtlMs], [30, 30 * 60000], JSON.stringify(bad));
    }
});

// --- A real server (fake Wix), clients told apart by X-Forwarded-For ---

function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], {
            cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}

function request(port, route, { ip, method = 'POST', body = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === null ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: {
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
            ...(ip ? { 'X-Forwarded-For': `${ip}, 10.0.0.1` } : {}), ...headers } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const t = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json: j, text: t }); });
        });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
}

const wixHistoryCalls = (out) => (out().match(/\[fake-wix\] ericaConversationHistory(Fetch|Save)/g) || []).length;

test('HTTP: history only for a userId prepared from the same IP (unsigned); a signed identity needs no preparation; over the limit → 429', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-histguard-'));
    const dirs = { SESSION_DATA_DIR: path.join(tmp, 'sessions'), SESSION_PROMPTS_DIR: path.join(tmp, 'prompts'), CLIPBOARD_DATA_DIR: path.join(tmp, 'clipboard'),
        AUDIT_DIR: path.join(tmp, 'audit'), ACTIVITY_DATA_DIR: path.join(tmp, 'activity'), INJECTED_DATA_DIR: path.join(tmp, 'injected') };
    const port = 26000 + Math.floor(Math.random() * 900);
    const TTL = 1500;
    const { child: server, out } = await startServer(port, { ...dirs, SESSION_SECRET: 'x', FAKE_WIX_PREP: '200',
        WIX_IDENTITY_SECRET: SECRET, ERICA_RATE_LIMIT_MAX: '6', ERICA_HISTORY_BINDING_TTL_MS: String(TTL) });
    try {
        for (let i = 0; i < 40 && !/History guard:/.test(out()); i++) await sleep(50);
        assert.match(out(), /History guard: 6 req\/60s per IP on preparation \+ history .* 2s window/, 'the server says its limits at start');

        // Started first: checked for expiry at the end.
        assert.equal((await request(port, '/api/erica-preparation', { ip: '203.0.113.50', body: { userId: 'member-E', caller: 'web' } })).status, 200);
        const tExpiry = Date.now(); // the binding was made before this answer came back

        // 1 · The coach's own flow: preparation, then save and fetch from the same IP → through to Wix.
        const A = '203.0.113.10';
        const prep = await request(port, '/api/erica-preparation', { ip: A, body: { userId: 'member-A', caller: 'web' } });
        assert.equal(prep.status, 200);
        let calls = wixHistoryCalls(out);
        const save = await request(port, '/api/conversation-history-save', { ip: A, body: { userId: 'member-A', text: '[]' } });
        assert.equal(save.status, 200, save.text);
        const fetch = await request(port, '/api/conversation-history-fetch', { ip: A, body: { userId: 'member-A' } });
        assert.equal(fetch.status, 200, fetch.text);
        assert.equal(wixHistoryCalls(out), calls + 2, 'both reached Wix');

        // 2 · Someone else's address, same member id → 403, and Wix is never asked.
        calls = wixHistoryCalls(out);
        const B = '198.51.100.20';
        const f403 = await request(port, '/api/conversation-history-fetch', { ip: B, body: { userId: 'member-A' } });
        assert.deepEqual([f403.status, f403.json.reason], [403, 'not_prepared_from_this_address']);
        assert.equal((await request(port, '/api/conversation-history-save', { ip: B, body: { userId: 'member-A', text: '[{"role":"user","content":"overwritten"}]' } })).status, 403);
        // A userId never prepared at all, even from A's address → 403.
        assert.equal((await request(port, '/api/conversation-history-fetch', { ip: A, body: { userId: 'member-Z' } })).status, 403);
        assert.equal(wixHistoryCalls(out), calls, 'no refused call reached Wix');
        assert.match(out(), /conversation-history-fetch - userId not prepared from this ip \(ip#[0-9a-f]{12}, identity unsigned\) → 403/, 'logged, with a hashed address');
        assert.doesNotMatch(out(), /198\.51\.100\.20/, 'the raw address is never logged');

        // 3 · A signed identity proves the user: no preparation needed, from any address.
        const S = '192.0.2.30';
        const token = ident.mint({ uid: 'member-S' });
        const signed = await request(port, '/api/conversation-history-fetch', { ip: S, headers: { 'X-Erica-Identity': token }, body: { userId: 'member-S' } });
        assert.equal(signed.status, 200, signed.text);
        assert.equal((await request(port, '/api/conversation-history-save', { ip: S, headers: { 'X-Erica-Identity': token }, body: { text: '[]' } })).status, 200);
        assert.equal((await request(port, '/api/conversation-history-fetch', { ip: S, body: { userId: 'member-S' } })).status, 403, 'the same id unsigned still needs the binding');

        // 4 · Over the limit (6/min here): 429 on preparation and history alike, signed or not;
        // another address and static files are untouched.
        const C = '192.0.2.40';
        for (let i = 0; i < 6; i++) assert.notEqual((await request(port, '/api/conversation-history-fetch', { ip: C, body: { userId: 'member-C' } })).status, 429, `request ${i + 1}`);
        const over = await request(port, '/api/conversation-history-fetch', { ip: C, body: { userId: 'member-C' } });
        assert.deepEqual([over.status, over.json.reason], [429, 'rate_limited']);
        assert.equal((await request(port, '/api/erica-preparation', { ip: C, body: { userId: 'member-C', caller: 'web' } })).status, 429);
        assert.equal((await request(port, '/api/conversation-history-save', { ip: C, headers: { 'X-Erica-Identity': ident.mint({ uid: 'member-C' }) }, body: { text: '[]' } })).status, 429, 'signed too');
        assert.equal((await request(port, '/index.html', { ip: C, method: 'GET' })).status, 200, 'static files are not limited');
        assert.equal((await request(port, '/api/conversation-history-fetch', { ip: A, body: { userId: 'member-A' } })).status, 200, 'A has its own budget');
        assert.equal((out().match(/rate limit exceeded/g) || []).length, 1, 'one log line per address per window, not one per refusal');

        // 5 · The binding expires: member-E was prepared at the start and never used since.
        await sleep(Math.max(0, tExpiry + TTL + 200 - Date.now()));
        assert.equal((await request(port, '/api/conversation-history-fetch', { ip: '203.0.113.50', body: { userId: 'member-E' } })).status, 403, 'past the window');
    } finally {
        server.kill();
    }
});
