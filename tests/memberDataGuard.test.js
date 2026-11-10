// Member data behind the preparation binding (SEC-01, SEC-02, SEC-03,
// production QA 10 Nov 2026). Signed identity is not enforced in production
// yet, so a loose userId opened coach settings (read and write), the
// clipboard, the activity timeline and the member's own vector store. Now an
// unsigned userId, or a guest's CleverTap objectId, passes only when the
// preparation for it came from this IP (lib/historyGuard.js, as history does);
// a signed identity always passes. And no read creates a vector store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const SECRET = 'member-guard-secret-' + 'm'.repeat(32);
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], {
            cwd: root, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let done = false;
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => {
            out += String(c);
            if (!done && /Server running at http:/.test(out) && /clients initialised/.test(out)) { done = true; clearTimeout(timer); resolve({ child, out: () => out }); }
        };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}

function request(port, route, { ip, body = null, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === null ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: {
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
            ...(ip ? { 'X-Forwarded-For': `${ip}, 10.0.0.1` } : {}), ...headers } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const t = Buffer.concat(chunks).toString(); let j = null; try { j = JSON.parse(t); } catch (_) {} resolve({ status: res.statusCode, json: j, text: t }); });
        });
        req.on('error', reject); if (data) req.write(data); req.end();
    });
}

const count = (out, re) => (out().match(re) || []).length;

test('HTTP: settings, clipboard, activity and the own vector store open only for an id prepared from this IP, or signed; guests by objectId alike; no read creates a store', async () => {
    const ident = require('../lib/signedIdentity');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-memberguard-'));
    const settingsDir = path.join(tmp, 'user-settings');
    const clipDir = path.join(tmp, 'clipboard');
    // A guest's clipboard record that a stranger's account must never adopt.
    fs.mkdirSync(clipDir, { recursive: true });
    const nowIso = new Date().toISOString();
    fs.writeFileSync(path.join(clipDir, 'ctid-ct-stranger.json'), JSON.stringify({
        v: 1, key: 'ctid-ct-stranger', createdAt: nowIso, updatedAt: nowIso, lastVisitAt: null, lastCursor: null, writes: [],
        items: [{ id: 'i1', kind: 'goal', text: "the stranger's private goal", status: 'active', firstSeen: nowIso, lastSeen: nowIso, source: {}, by: 'distill' }],
    }));
    // Wix's generic guest preparation: what an unknown or random id gets.
    const guestMessage = path.join(tmp, 'guest-message.txt');
    fs.writeFileSync(guestMessage, JSON.parse(fs.readFileSync(path.join(root, 'ericaPreparationFallBack.txt'), 'utf8')).message);
    // The OpenAI account: 250 stores, member-K's on page 3, a guest's store.
    const stores = [];
    for (let i = 0; i < 250; i++) stores.push({ id: `vs_${i}`, name: `user-filler-${i}` });
    stores.splice(230, 0, { id: 'vs_member_K', name: 'user-member-K' });
    stores.push({ id: 'vs_guest_G', name: 'user-guest-ct-guest-G' });

    const env = {
        SESSION_DATA_DIR: path.join(tmp, 'sessions'), SESSION_PROMPTS_DIR: path.join(tmp, 'prompts'), CLIPBOARD_DATA_DIR: clipDir,
        AUDIT_DIR: path.join(tmp, 'audit'), ACTIVITY_DATA_DIR: path.join(tmp, 'activity'), INJECTED_DATA_DIR: path.join(tmp, 'injected'),
        USER_SETTINGS_DIR: settingsDir, SESSION_SECRET: 'x', WIX_IDENTITY_SECRET: SECRET, ERICA_REQUIRE_SIGNED_IDENTITY: '',
        OPENAI_API_KEY: 'sk-test-no-network', FRAMEWORKS_STORE_ID: 'vs_frameworks', COURSES_STORE_ID: '',
        CLEVERTAP_ACCOUNT_ID: '', CLEVERTAP_PASSCODE: '', ERICA_LOG_LEVEL: 'debug', ERICA_RATE_LIMIT_MAX: '1000',
        FAKE_WIX_PREP: '200', FAKE_WIX_PREP_MESSAGE_FILE: guestMessage, FAKE_OPENAI_VECTOR_STORES: JSON.stringify(stores),
    };
    const children = [];
    try {
        const port = await freePort();
        const srv = await startServer(port, env);
        children.push(srv.child);
        const { out } = srv;
        const prep = (ip, body) => request(port, '/api/erica-preparation', { ip, body: { caller: 'web', ...body } });
        const settings = (ip, body, headers) => request(port, '/api/user-settings', { ip, body, headers });
        const search = (ip, body, headers) => request(port, '/api/knowledge-search', { ip, body: { query: 'what did my report say?', ...body }, headers });
        const refused = (r) => [r.status, r.json && r.json.reason];
        const NOT_PREPARED = [403, 'not_prepared_from_this_address'];

        // 1 · Unsigned userId, no preparation: 403 everywhere, and nothing written or searched.
        const M = '203.0.113.12';
        assert.deepEqual(refused(await settings(M, { userId: 'member-K' })), NOT_PREPARED, 'settings read');
        assert.deepEqual(refused(await settings(M, { userId: 'member-K', set: { voice: 'ash' } })), NOT_PREPARED, 'settings write');
        assert.equal(fs.existsSync(path.join(settingsDir, 'user-member-K.json')), false, 'the refused write wrote nothing');
        assert.deepEqual(refused(await search(M, { scope: 'user_data', userId: 'member-K' })), NOT_PREPARED, 'knowledge-search user_data');
        assert.deepEqual(refused(await request(port, '/api/user-activity', { ip: M, body: { userId: 'member-K' } })), NOT_PREPARED, 'user-activity');
        assert.deepEqual(refused(await request(port, '/api/clipboard/block', { ip: M, body: { userId: 'member-K' } })), NOT_PREPARED, 'clipboard block');
        assert.deepEqual(refused(await request(port, '/api/clipboard/distill', { ip: M, body: { userId: 'member-K', turns: [] } })), NOT_PREPARED, 'clipboard distill');
        assert.equal(count(out, /\[fake-openai\] (vector_stores\.list|file_search)/g), 0, 'a refused search lists and searches nothing');
        // Scope 'all' keeps the shared stores and says the person's was left out.
        const all = await search(M, { scope: 'all', userId: 'member-K' });
        assert.equal(all.status, 200, all.text);
        assert.deepEqual([all.json.vectorStoreIds, all.json.userDataRefused], [['vs_frameworks'], 'not_prepared_from_this_address']);
        assert.match(out(), /knowledge-search - userId not prepared from this ip \(ip#[0-9a-f]{12}, identity unsigned\): scope 'all' searched WITHOUT the person's store/);
        // Frameworks only: no identity check at all.
        assert.equal((await search(M, { scope: 'frameworks', userId: 'member-K' })).status, 200);

        // 2 · After the preparation from the same IP: allowed, and the store is found on page 3.
        assert.equal((await prep(M, { userId: 'member-K' })).status, 200);
        const w = await settings(M, { userId: 'member-K', set: { voice: 'ash' } });
        assert.deepEqual([w.status, w.json.scope], [200, 'account'], w.text);
        assert.equal((await settings(M, { userId: 'member-K' })).json.settings.voice, 'ash');
        const listsBefore = count(out, /\[fake-openai\] vector_stores\.list/g);
        const own = await search(M, { scope: 'user_data', userId: 'member-K' });
        assert.equal(own.status, 200, own.text);
        assert.deepEqual(own.json.vectorStoreIds, ['vs_member_K']);
        assert.equal(own.json.chunks[0].text, 'chunk from vs_member_K');
        assert.equal(count(out, /\[fake-openai\] vector_stores\.list/g) - listsBefore, 3, 'three pages listed to reach it');
        assert.equal((await request(port, '/api/user-activity', { ip: M, body: { userId: 'member-K' } })).status, 200);
        assert.equal((await request(port, '/api/clipboard/block', { ip: M, body: { userId: 'member-K' } })).status, 200);
        // An objectId next to the userId that this IP never prepared is dropped, never adopted.
        const adopt = await request(port, '/api/clipboard/block', { ip: M, body: { userId: 'member-K', objectId: 'ct-stranger' } });
        assert.equal(adopt.status, 200);
        assert.doesNotMatch(adopt.json.text, /stranger's private goal/);
        assert.equal(fs.existsSync(path.join(clipDir, 'user-member-K.json')), false, 'no guest record adopted into the account');
        // The same member id from another address: still 403.
        const A = '198.51.100.21';
        assert.deepEqual(refused(await settings(A, { userId: 'member-K' })), NOT_PREPARED);
        assert.deepEqual(refused(await search(A, { scope: 'user_data', userId: 'member-K' })), NOT_PREPARED);

        // 3 · A signed identity needs no preparation, from any address.
        const S = '192.0.2.31';
        const tok = { 'X-Erica-Identity': ident.mint({ uid: 'member-S' }, SECRET) };
        const sw = await settings(S, { set: { voice: 'coral' } }, tok);
        assert.deepEqual([sw.status, sw.json.scope], [200, 'account'], sw.text);
        assert.equal((await settings(S, {}, tok)).json.settings.voice, 'coral');
        const ss = await search(S, { scope: 'user_data' }, tok);
        assert.deepEqual([ss.status, ss.json.vectorStoreIds, ss.json.reason], [200, [], 'no stores available for scope'], 'member-S has no store: none made');
        assert.equal((await request(port, '/api/clipboard/block', { ip: S, body: {}, headers: tok })).status, 200);

        // 4 · A guest's CleverTap objectId: 403 before its preparation, allowed after.
        const G = '192.0.2.41';
        assert.deepEqual(refused(await settings(G, { objectId: 'ct-guest-G' })), NOT_PREPARED);
        assert.deepEqual(refused(await search(G, { scope: 'user_data', objectId: 'ct-guest-G' })), NOT_PREPARED);
        assert.deepEqual(refused(await request(port, '/api/user-activity', { ip: G, body: { objectId: 'ct-guest-G' } })), NOT_PREPARED);
        assert.deepEqual(refused(await request(port, '/api/clipboard/block', { ip: G, body: { objectId: 'ct-guest-G' } })), NOT_PREPARED);
        assert.match(out(), /user-settings - objectId not prepared from this ip \(ip#[0-9a-f]{12}, identity guest\) → 403/);
        assert.equal((await prep(G, { objectId: 'ct-guest-G' })).status, 200);
        const gs = await settings(G, { objectId: 'ct-guest-G', set: { voiceStepDone: true } });
        assert.deepEqual([gs.status, gs.json.scope], [200, 'visit'], gs.text);
        const gk = await search(G, { scope: 'user_data', objectId: 'ct-guest-G' });
        assert.deepEqual([gk.status, gk.json.vectorStoreIds], [200, ['vs_guest_G']]);
        assert.equal((await request(port, '/api/user-activity', { ip: G, body: { objectId: 'ct-guest-G' } })).status, 200);
        // An objectId binding never opens a userId of the same value (separate maps).
        const X = '192.0.2.51';
        assert.equal((await prep(X, { objectId: 'member-K' })).status, 200);
        assert.deepEqual(refused(await settings(X, { userId: 'member-K' })), NOT_PREPARED);
        assert.equal((await request(port, '/api/conversation-history-fetch', { ip: X, body: { userId: 'member-K' } })).status, 403);

        // 5 · A random id: its preparation (Wix's generic guest text) and its search create no store.
        const R = '192.0.2.61';
        const rid = 'random-' + Math.random().toString(36).slice(2, 10);
        assert.equal((await prep(R, { userId: rid })).status, 200);
        for (let i = 0; i < 50 && !/no user-specific body found \(generic or guest preparation\)/.test(out()); i++) await sleep(50);
        assert.match(out(), /no user-specific body found \(generic or guest preparation\), skipping; no store touched/);
        const rs = await search(R, { scope: 'user_data', userId: rid });
        assert.deepEqual([rs.status, rs.json.vectorStoreIds, rs.json.reason], [200, [], 'no stores available for scope']);
        const listed = count(out, /\[fake-openai\] vector_stores\.list/g);
        assert.equal((await search(R, { scope: 'user_data', userId: rid })).status, 200);
        assert.equal(count(out, /\[fake-openai\] vector_stores\.list/g), listed, 'the miss is remembered: no second listing');
        await sleep(200); // any fire-and-forget sync would have landed by now
        assert.equal(count(out, /\[fake-openai\] vector_stores\.create/g), 0, 'no store was created by any read or by a generic preparation');
    } finally {
        children.forEach((c) => c.kill());
    }
});
