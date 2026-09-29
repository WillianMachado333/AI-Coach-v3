// Real session turns in the Studio (#30): what a turn post may carry, the
// redaction path over a real socket, the timeline order with reasoning /
// clipboard / usage lines, and the page rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-turns-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });

const { sanitizeTurnMeta, sanitizeTurnText, sanitizeRevision, arrangeTimeline, TEXT_MAX } = require('../lib/sessionTurns');
const root = path.join(__dirname, '..');

test('user_turn meta: whitelist, attachment names only, and a client can never set synthetic', () => {
    const m = sanitizeTurnMeta({
        messageId: 'user-text-1', at: '2026-09-29T10:00:00.000Z', inputType: 'photo',
        attachments: [{ kind: 'image', name: 'cv.png', src: 'data:image/png;base64,AAAA' }, 'notes.txt', { name: '' }],
        synthetic: true, text: 'smuggled', voiceMode: 'live',
    }, 'user_turn');
    assert.deepEqual(m, { messageId: 'user-text-1', at: '2026-09-29T10:00:00.000Z', inputType: 'photo', attachments: ['cv.png', 'notes.txt'] });
    assert.equal(sanitizeTurnMeta({ inputType: 'telepathy' }, 'user_turn').inputType, 'text');
    assert.deepEqual(sanitizeTurnMeta(null, 'user_turn'), { inputType: 'text' });
    assert.equal(sanitizeTurnText('x'.repeat(TEXT_MAX + 50)).length, TEXT_MAX);
    assert.equal(sanitizeTurnText(42), null);
});

test('bot_turn meta: voice mode, in-call flag and the ids that tie it to its reasoning', () => {
    assert.deepEqual(sanitizeTurnMeta({ messageId: 'live-bot-9', voiceMode: 'live', inCall: true, delegationId: 'item_D1', responseId: 'resp_R', synthetic: true }, 'bot_turn'),
        { messageId: 'live-bot-9', voiceMode: 'live', inCall: true, responseId: 'resp_R', delegationId: 'item_D1' });
    assert.deepEqual(sanitizeTurnMeta({ voiceMode: 'carrier-pigeon', inCall: 'yes' }, 'bot_turn'), { inCall: false });
    assert.deepEqual(sanitizeRevision({ messageId: 'm1', text: 'clean' }), { messageId: 'm1', text: 'clean' });
    assert.equal(sanitizeRevision({ text: 'no id' }), null);
});

// A real Live session as it lands on disk: file order is server receive order.
const MIXED = [
    { type: 'session_start', t: '2026-09-29T10:00:00.000Z', actor: {} },
    { type: 'event', t: '2026-09-29T10:00:01.000Z', name: 'clipboard_read', meta: { key: 'ctid-x', lines: 2 } },
    { type: 'turn', role: 'user', t: '2026-09-29T10:00:05.000Z', text: { redacted: true, length: 38, hash: 'abc' }, meta: { messageId: 'u1', inputType: 'voice' } },
    { type: 'usage', t: '2026-09-29T10:00:06.000Z', source: 'session.usage.updated', usage: { seconds: 15 }, priced: { usd: 0.0125 } },
    { type: 'event', t: '2026-09-29T10:00:08.000Z', name: 'reasoning_summary', meta: { source: 'live_backend', delegationId: 'D1', summary: 'Weigh the options.', answer: 'Start with the deadline.', model: 'gpt-5.6-terra' } },
    { type: 'usage', t: '2026-09-29T10:00:08.500Z', source: 'response.completed', usage: { input_tokens: 9000 }, priced: { usd: 0.004 } },
    { type: 'turn', role: 'bot', t: '2026-09-29T10:00:11.000Z', text: 'Let us start with the deadline, then the colleague.', meta: { messageId: 'b1', voiceMode: 'live', inCall: true, delegationId: 'D1' } },
    { type: 'turn', role: 'user', t: '2026-09-29T10:00:20.000Z', text: 'what about the report?', meta: { messageId: 'u2', inputType: 'text' } },
    // Spoken before the backend record closed: the reasoning arrives after its answer.
    { type: 'turn', role: 'bot', t: '2026-09-29T10:00:23.000Z', text: '{"garbage": true}', meta: { messageId: 'b2', voiceMode: 'live', inCall: false, delegationId: 'D2' } },
    { type: 'event', t: '2026-09-29T10:00:24.000Z', name: 'reasoning_unsummarized', meta: { source: 'live_backend', delegationId: 'D2', answer: 'The report shows a pattern.', reasoningTokens: 5 } },
    { type: 'event', t: '2026-09-29T10:00:25.000Z', name: 'turn_revised', meta: { messageId: 'b2', text: 'Your report shows a clear pattern.' } },
    // Reasoning whose delegation produced no logged turn stays where it is.
    { type: 'event', t: '2026-09-29T10:00:30.000Z', name: 'reasoning_summary', meta: { source: 'live_backend', delegationId: 'D9', summary: 'Orphan.', answer: 'Never spoken.' } },
];

test('timeline: reasoning sits right before the answer it produced; QC revisions replace the text; nothing is lost', () => {
    const out = arrangeTimeline(MIXED);
    const label = (e) => e.type === 'turn' ? `${e.role}:${e.meta.messageId}` : e.type === 'event' ? `${e.name}:${(e.meta && e.meta.delegationId) || ''}` : e.type;
    assert.deepEqual(out.map(label), [
        'session_start', 'clipboard_read:', 'user:u1', 'usage',
        'usage',
        'reasoning_summary:D1', 'bot:b1',
        'user:u2',
        'reasoning_unsummarized:D2', 'bot:b2',
        'reasoning_summary:D9',
    ]);
    assert.equal(out.find((e) => e.meta && e.meta.messageId === 'b2').text, 'Your report shows a clear pattern.');
    assert.equal(out.filter((e) => e._anchored).length, 2);
    assert.ok(!out.some((e) => e.name === 'turn_revised'), 'revisions are applied, not shown');
    assert.equal(MIXED[8].text, '{"garbage": true}', 'input untouched');
});

test('Studio: real turns render in order, reasoning before the answer without repeating it, redacted turns say so', () => {
    const { _internal } = require('../lib/admin');
    const html = _internal.sessionDetailPage('s-real', { entries: MIXED });
    const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, 'missing: ' + s); return i; };
    // Order: redacted user turn → D1 reasoning → its answer → typed user turn → D2 reasoning → revised answer.
    const order = [
        at('🔒 User text not stored — 38 chars · voice'),
        at("Erica's reasoning → answer below"),
        at('Let us start with the deadline, then the colleague.'),
        at('what about the report?'),
        at('Your report shows a clear pattern.'),
    ];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(!html.includes('Start with the deadline.'), 'an anchored reasoning block does not repeat the backend answer');
    assert.ok(!html.includes('The report shows a pattern.'));
    assert.ok(html.includes('Never spoken.'), 'orphan reasoning still shows its answer');
    assert.ok(!html.includes('{&quot;garbage&quot;'), 'the QC-replaced text is gone');
    assert.match(html, /🎙 voice/);
    assert.match(html, /⌨️ typed/);
    assert.match(html, /live · in call/);
    assert.match(html, /edited by QC/);
    assert.ok(!html.includes('[redacted,'), 'the new placeholder replaces the old bracket form');
});

// --- The redaction path over a real socket, both store modes ---
function startServer(port, extraEnv) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: root,
            env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...extraEnv },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(child); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function post(port, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: '/api/session-log', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
        });
        req.on('error', reject); req.write(data); req.end();
    });
}
const lines = (dir, sid) => fs.readFileSync(path.join(dir, sid + '.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

for (const mode of ['redacted', 'raw']) {
    test(`HTTP: user_turn under STORE_MESSAGE_TEXT=${mode} — ${mode === 'raw' ? 'stored' : 'redacted even when the client claims synthetic'}; bot text always stored`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erica-turns-${mode}-`));
        const port = 20000 + Math.floor(Math.random() * 900);
        const server = await startServer(port, { SESSION_DATA_DIR: dir, STORE_MESSAGE_TEXT: mode === 'raw' ? 'raw' : '' });
        try {
            const sid = 's-http-' + mode;
            const u = await post(port, { sessionId: sid, kind: 'user_turn', text: 'I freeze on salary questions', meta: { messageId: 'u1', inputType: 'voice', synthetic: true } });
            assert.equal(u.status, 200);
            assert.equal(u.body.store, mode);
            const b = await post(port, { sessionId: sid, kind: 'bot_turn', text: 'Let us practise that.', meta: { messageId: 'b1', voiceMode: 'realtime', inCall: true, responseId: 'resp_1' } });
            assert.equal(b.body.store, mode);
            await post(port, { sessionId: sid, kind: 'turn_revised', meta: { messageId: 'b1', text: 'Let us practise that together.' } });
            const [user, bot, rev] = lines(dir, sid);
            if (mode === 'raw') assert.equal(user.text, 'I freeze on salary questions');
            else {
                assert.deepEqual(Object.keys(user.text).sort(), ['hash', 'length', 'redacted']);
                assert.equal(user.text.length, 28);
                assert.ok(!JSON.stringify(user).includes('salary'), 'no user words on disk');
            }
            assert.equal(user.meta.synthetic, undefined, 'the client-set synthetic flag was dropped');
            assert.equal(user.meta.inputType, 'voice');
            assert.equal(bot.text, 'Let us practise that.');
            assert.equal(bot.meta.responseId, 'resp_1');
            assert.equal(rev.name, 'turn_revised');
        } finally {
            server.kill();
        }
    });
}

test('client: turns are posted from the final-message hook, bot turns settle, pills are marked, restored history is never logged', () => {
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    assert.match(src, /this\.saveConversationHistory\(\{ preferSoon: role === 'bot' \}\);\s*\/\/ Studio transcript \(#30\): one session-log turn per final message\.\s*this\._logTurnFor\(message\);/);
    const fn = src.slice(src.indexOf('    _logTurnFor(message) {'), src.indexOf('    _turnInputType(message) {'));
    assert.match(fn, /if \(!message \|\| this\.isRestoringHistory\) return;/);
    assert.match(fn, /setTimeout\(flush, 600\)/);
    assert.equal((src.match(/this\._nextTurnInputType = \{ type: 'pill', until: Date\.now\(\) \+ 2000 \};/g) || []).length, 2, 'both pill call sites');
    const postFn = src.slice(src.indexOf('    _postTurn(message, st) {'), src.indexOf('    _postTurnRevision(message, st) {'));
    assert.match(postFn, /kind: isUser \? 'user_turn' : 'bot_turn'/);
    assert.doesNotMatch(postFn, /synthetic|dataUrl|\.src\b/, 'no synthetic flag, no image data');
});

test('client: a Live delegation is claimed by one bot turn only (the in-call greeting after a typed answer gets none)', () => {
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const fn = src.slice(src.indexOf('    _turnModelIds(message) {'), src.indexOf('    _postTurn(message, st) {'));
    // Run the method body against a fake app: one delegation, two bot turns after the same user message.
    const body = fn.slice(fn.indexOf('{') + 1, fn.lastIndexOf('}'));
    const turnModelIds = new Function('message', body);
    const app = { voiceApiMode: 'live', _liveDelegationStartedAt: new Map([['D1', 1000]]), messages: [{ role: 'user', timestamp: 900 }] };
    assert.deepEqual(turnModelIds.call(app, { id: 'live-deleg-1', timestamp: 1500 }), { delegationId: 'D1' });
    assert.deepEqual(turnModelIds.call(app, { id: 'live-bot-2', timestamp: 3000 }), {}, 'already claimed');
    app._liveDelegationStartedAt.set('D2', 4000);
    app.messages.push({ role: 'user', timestamp: 3900 });
    assert.deepEqual(turnModelIds.call(app, { id: 'live-bot-3', timestamp: 4500 }), { delegationId: 'D2' });
});
