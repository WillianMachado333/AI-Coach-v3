// When Wix fails (429 / network error), /api/erica-preparation serves the
// generic fallback. That answer must still carry the visit id the server
// already opened (else the client invents an s-c- id and the visit splits
// in the Studio), and the generic prep must not stand in for the person's
// real one for long: a short fallback TTL, for users and guests alike.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function prep(port, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: '/api/erica-preparation', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); req.write(data); req.end();
    });
}

const upstreamCalls = (out) => (out().match(/\[fake-wix\] prep call \d+/g) || []).length;

test('HTTP: a Wix 429 / network error still hands the client its visit id; the fallback is cached briefly, never for the normal TTL', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-prepfallback-'));
    const dirs = { SESSION_DATA_DIR: path.join(tmp, 'sessions'), SESSION_PROMPTS_DIR: path.join(tmp, 'prompts'), CLIPBOARD_DATA_DIR: path.join(tmp, 'clipboard'),
        AUDIT_DIR: path.join(tmp, 'audit'), ACTIVITY_DATA_DIR: path.join(tmp, 'activity'), INJECTED_DATA_DIR: path.join(tmp, 'injected') };
    const port = 22000 + Math.floor(Math.random() * 900);
    const { child: server, out } = await startServer(port, { ...dirs, SESSION_SECRET: 'x',
        FAKE_WIX_PREP: '429,error,200,429,200', ERICA_PREP_FALLBACK_TTL_MS: '400' });
    try {
        // 1 · Wix answers 429 → fallback, WITH the visit id the server opened.
        const a = await prep(port, { userId: 'member-F', caller: 'web' });
        assert.equal(a.status, 200);
        assert.equal(a.headers['x-erica-fallback'], 'true');
        const sid = a.headers['x-session-id'];
        assert.match(String(sid), /^s-v/, 'the fallback carries the s-v visit id');
        assert.match(a.headers['access-control-expose-headers'] || '', /X-Session-Id/, 'readable by the client');
        assert.doesNotMatch(a.text, /REAL-PREP/);
        const file = path.join(dirs.SESSION_DATA_DIR, sid + '.ndjson');
        assert.ok(fs.existsSync(file), 'the id the client got is the visit the server opened');
        assert.match(fs.readFileSync(file, 'utf8'), /"identitySource":"unsigned"/);

        // 2 · Right after: served from the short fallback cache (no Wix call),
        //     still marked as fallback, the same visit resumed.
        const b = await prep(port, { userId: 'member-F', caller: 'web', sessionId: sid });
        assert.equal(b.headers['x-cache'], 'HIT');
        assert.equal(b.headers['x-erica-fallback'], 'true', 'a cached fallback is still labelled');
        assert.equal(b.headers['x-session-id'], sid);
        assert.equal(upstreamCalls(out), 1, 'a reload burst does not re-hit a rate-limited Wix');

        // 3 · Past the fallback TTL, Wix fails at the network level → fallback, with a visit id.
        await sleep(500);
        const c = await prep(port, { userId: 'member-F', caller: 'web', sessionId: sid });
        assert.equal(c.headers['x-erica-fallback'], 'true');
        assert.equal(c.headers['x-session-id'], sid, 'network-error branch keeps the visit too');

        // 4 · Wix is back: the person gets their real preparation (not a
        //     generic one held for the 2-minute signed-in TTL).
        await sleep(500);
        const d = await prep(port, { userId: 'member-F', caller: 'web', sessionId: sid });
        assert.equal(d.headers['x-erica-fallback'], undefined);
        assert.equal(d.headers['x-cache'], 'MISS');
        assert.match(d.text, /REAL-PREP for member-F/);
        assert.equal(upstreamCalls(out), 3);

        // 5 · Guests: the fallback is not held for the 24-hour guest TTL.
        const g1 = await prep(port, { caller: 'web', objectId: 'ct-guest-1' });
        assert.equal(g1.headers['x-erica-fallback'], 'true');
        assert.match(String(g1.headers['x-session-id']), /^s-v/);
        await sleep(500);
        const g2 = await prep(port, { caller: 'web', objectId: 'ct-guest-1' });
        assert.equal(g2.headers['x-erica-fallback'], undefined);
        assert.match(g2.text, /REAL-PREP for guest/);

        assert.match(out(), /Serving fallback response for: user:member-F \{ sessionId: 's-v/, 'the degradation is logged with its visit');
    } finally {
        server.kill();
    }
});

test('client: the generic fallback is not kept in the page\'s 60 s preparation cache', () => {
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const flag = src.indexOf("response.headers.get('X-Erica-Fallback') === 'true'");
    const set = src.indexOf('this._prepCache.set(cacheKey, { ts: Date.now(), data: parsed });');
    assert.ok(flag > 0 && set > flag, 'the flag is read before the cache write');
    const between = src.slice(flag, set);
    assert.match(between, /if \(isFallback\) \{[\s\S]*console\.warn\([\s\S]*\} else \{\s*$/, 'the cache write only happens in the non-fallback branch, and the fallback is logged');
});
