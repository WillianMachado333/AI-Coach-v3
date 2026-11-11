// REG-16, the server's half. (1) The share of first answers made without the
// composed prompt is visible in production: each GPT-Live connection's first
// response.completed is measured by its input tokens (a configured one reads
// ~8,800 to 9,700, a premature one 985 to 1,520); under 3,000 it is logged as
// a thin first answer and counted in /api/health (firstAnswers), with no user
// text. (2) The session carries the minimal safety rules from its creation,
// in case a turn ever reaches it before the client's session.update.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const watch = require('../lib/firstAnswerWatch');
const { STARTUP_SAFETY } = require('../lib/coachUiRules');

const root = path.join(__dirname, '..');

test('the watch: only the first response.completed of each connection counts; under 3,000 input tokens it is thin', () => {
    watch._reset();
    assert.equal(watch.onUsage('s-v1', { source: 'session.usage.updated', connectionId: 'c1', usage: { seconds: 3 } }), null, 'not a backend answer');
    assert.deepEqual(watch.onUsage('s-v1', { source: 'response.completed', connectionId: 'c1', usage: { input_tokens: 1203 } }), { thin: true, inputTokens: 1203 });
    assert.equal(watch.onUsage('s-v1', { source: 'response.completed', connectionId: 'c1', usage: { input_tokens: 9100 } }), null, 'the second answer of that connection is not a first answer');
    assert.deepEqual(watch.onUsage('s-v1', { source: 'response.completed', connectionId: 'c2', usage: { input_tokens: 9100 } }), { thin: false, inputTokens: 9100 }, 'a reconnect is a new first answer');
    assert.deepEqual(watch.onUsage('s-v2', { source: 'response.completed', connectionId: 'c1', usage: { input_tokens: 8800 } }), { thin: false, inputTokens: 8800 });
    const s = watch.snapshot();
    assert.deepEqual([s.checked, s.thin, s.thresholdTokens], [3, 1, 3000]);
    assert.ok(s.lastThinAt);
    watch._reset();
});

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
function request(port, urlPath, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); if (body) req.write(body); req.end();
    });
}

test('HTTP: a thin first answer is logged and counted in /api/health; the Live session starts with the safety rules', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-reg16-'));
    const liveLog = path.join(tmp, 'live.ndjson');
    const port = await freePort();
    const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeLiveApi.js'), 'server.js'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(port), OPENAI_API_KEY: 'sk-test-fake-live', SESSION_SECRET: 'x', FAKE_LIVE_LOG: liveLog,
            SESSION_DATA_DIR: path.join(tmp, 's'), SESSION_PROMPTS_DIR: path.join(tmp, 'p'), AUDIT_DIR: path.join(tmp, 'a') },
    });
    let out = '';
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
            const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(); } };
            child.stdout.on('data', onData); child.stderr.on('data', onData);
        });
        const sid = 's-vREG16test';
        const usage = (connectionId, input) => request(port, '/api/session-log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, kind: 'usage', voiceMode: 'live', source: 'response.completed', connectionId, responseId: 'resp_' + connectionId, model: 'gpt-5-mini', usage: { input_tokens: input, output_tokens: 80 } }) });
        await usage('c-early', 1203);
        await usage('c-early', 9300); // its second answer: not a first answer
        await usage('c-ok', 9100);
        const health = JSON.parse((await request(port, '/api/health')).body);
        assert.equal(health.firstAnswers.checked, 2);
        assert.equal(health.firstAnswers.thin, 1);
        assert.equal(health.firstAnswers.thresholdTokens, 3000);
        assert.equal(out.split('\n').filter((l) => /REG-16 thin first answer: s-vREG16test connection c-early read 1203 input tokens/.test(l)).length, 1);

        // The session creation carries the minimal safety rules (voice layer and backend).
        const res = await request(port, '/api/proxy/live', { method: 'POST', headers: { 'Content-Type': 'application/sdp', 'X-Erica-Session': sid, 'X-Erica-Reconnect': 'user',
            'X-Erica-Live-Instructions': Buffer.from('You are Erica, a warm coach.').toString('base64') }, body: 'v=0\r\n' });
        assert.ok(res.status < 300, `proxy/live answered ${res.status}: ${res.body.slice(0, 200)}`);
        const created = fs.readFileSync(liveLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'create');
        assert.equal(created.length, 1);
        assert.ok(created[0].session.instructions.startsWith('You are Erica, a warm coach.'), 'the client\'s voice instructions stay first');
        assert.ok(created[0].session.instructions.includes(STARTUP_SAFETY), 'voice layer: safety rules from the start');
        assert.ok(created[0].session.backendInstructions.includes(STARTUP_SAFETY), 'backend: safety rules from the start');
    } finally { child.kill(); }
});

test('the startup rules: crisis care that never ends the conversation, no invented links, no phone numbers yet (Eric decides those)', () => {
    assert.match(STARTUP_SAFETY, /suicide or self-harm/);
    assert.match(STARTUP_SAFETY, /mental health professional or emergency services/);
    assert.match(STARTUP_SAFETY, /never end the conversation/);
    assert.match(STARTUP_SAFETY, /Never invent a link/);
    assert.doesNotMatch(STARTUP_SAFETY, /\d{3}/, 'no phone numbers before Eric approves the crisis rules');
});
