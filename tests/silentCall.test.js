// Silent calls (#32): the GPT-Live one-shot now resolves on the backend's
// response.created (it used to wait out 15 s, so a cold call attached the
// mic ~23 s after the click), and a call with no word for 20 s is reported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-silent-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

// Pull a class method's body out of app.js and run it against a fake `this`.
function method(name, params) {
    let start = src.indexOf(`    ${name}(${params}) {`);
    if (start < 0) start = src.indexOf(`    async ${name}(${params}) {`);
    assert.ok(start >= 0, 'method not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0; let i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(open + 1, i);
    const isAsync = src.slice(start, start + 12).includes('async');
    // eslint-disable-next-line no-new-func
    return isAsync ? new Function(params, `return (async () => {${body}})();`) : new Function(params, body);
}

test('GPT-Live one-shot: the backend response.created resolves it at once; its completion ends it', () => {
    const observe = method('_liveOneShotObserve', 'inner');
    let resolved = null; const ended = [];
    const app = {
        _oneShot: { active: true, responseId: null, _startedResolved: false, _resolveStarted: (v) => { resolved = v; } },
        _endOneShot: (o) => ended.push(o),
    };
    observe.call(app, { type: 'response.in_progress', response: { id: 'resp_A' } });
    assert.equal(resolved, null, 'only response.created starts it');
    observe.call(app, { type: 'response.created', response: { id: 'resp_A' } });
    assert.equal(resolved, true);
    assert.equal(app._oneShot.responseId, 'resp_A');
    observe.call(app, { type: 'response.completed', response: { id: 'resp_OTHER' } });
    assert.equal(ended.length, 0, 'another response does not end it');
    observe.call(app, { type: 'response.completed', response: { id: 'resp_A' } });
    assert.deepEqual(ended, [{ responseId: 'resp_A' }]);
    // No one-shot in flight: inert.
    observe.call({ _oneShot: null }, { type: 'response.created', response: { id: 'x' } });
});

test('wiring: the response.event case feeds the one-shot; a call start arms the alarm; hang-up disarms; spoken words count as life', () => {
    assert.match(src, /case 'response\.event': \{\s*const inner = message\.event;\s*if \(!inner\) break;\s*\/\/ The opening line \(speakOneShot\) waits for its response to start \(#32\)\.\s*this\._liveOneShotObserve\(inner\);/);
    assert.match(src, /toggleMicTrack\(\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(!this\.isRecording && !this\._voiceStepChecked\) \{ this\._voiceStepChecked = true; this\._voiceStepGate\(\); return; \}\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(!this\.isRecording\) this\._silentCallArm\('click'\);/, 'armed before the cold-start branch returns');
    assert.match(src, /stopRecording\(force = false\) \{\s*this\._silentCallDisarm\(\);/);
    assert.match(src, /this\.resetVoiceInactivityTimer\(\);\s*if \(!this\.isRestoringHistory\) this\._silentCallSawLife\(role, id\);/);
});

test('alarm: only a spoken word in an active call disarms it — not the delegated greeting text before the mic is on', () => {
    const sawLife = method('_silentCallSawLife', 'role, id');
    const mk = (isRecording) => ({ isRecording, _silentCall: { armedAt: Date.now() - 5000, timer: setTimeout(() => {}, 60000) } });
    const a = mk(false);
    sawLife.call(a, 'bot', 'live-deleg-1');
    assert.ok(a._silentCall.timer, 'not in a call yet: still armed');
    const b = mk(true);
    sawLife.call(b, 'bot', 'live-deleg-2');
    assert.ok(b._silentCall.timer, 'delegated text is not heard');
    sawLife.call(b, 'bot', 'live-bot-3');
    assert.equal(b._silentCall.timer, null);
    assert.ok(b._silentCall.firstLifeMs >= 5000);
    const c = mk(true);
    sawLife.call(c, 'user', 'live-user-1');
    assert.equal(c._silentCall.timer, null, "the user's own words count too");
    clearTimeout(a._silentCall.timer);
});

test('alarm: 20 s of silence logs loudly and posts a silent_call event with the connection state', async () => {
    const check = method('_silentCallCheck', '');
    const posts = []; const errors = [];
    const origFetch = global.fetch; const origErr = console.error;
    global.fetch = (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true }); };
    console.error = (...a) => errors.push(a);
    try {
        const app = {
            _silentCall: { armedAt: Date.now() - 20000, reason: 'click', timer: null },
            voiceApiMode: 'live', isConnected: true, isConnecting: false, isRecording: true, sessionId: 's-1',
            pc: { connectionState: 'connected', iceConnectionState: 'connected', getStats: async () => new Map([['o', { type: 'outbound-rtp', kind: 'audio', packetsSent: 0 }]]) },
            dataChannel: { readyState: 'open' },
            localStream: { getAudioTracks: () => [{ readyState: 'live' }] },
            audioSender: { track: null },
            _oneShot: { active: true, _startedResolved: false },
            apiUrl: (p) => p,
        };
        await check.call(app);
        assert.equal(errors.length, 1);
        assert.match(errors[0][0], /SILENT CALL/);
        assert.equal(posts.length, 1);
        const { body } = posts[0];
        assert.equal(body.kind, 'event');
        assert.equal(body.name, 'silent_call');
        assert.equal(body.meta.outboundPackets, 0);
        assert.equal(body.meta.senderHasTrack, false);
        assert.equal(body.meta.oneShotPending, true);
        assert.equal(body.meta.pc, 'connected');
        assert.ok(body.meta.msSinceStart >= 20000);
    } finally {
        global.fetch = origFetch; console.error = origErr;
    }
});

test('Studio: a silent_call is counted on the home Issues and shown in red on the session timeline', () => {
    const sid = 's-silent';
    const lines = [
        { type: 'session_start', t: new Date().toISOString(), sessionId: sid, actor: { objectId: 'x' } },
        { type: 'event', t: new Date().toISOString(), name: 'silent_call', meta: { voiceMode: 'live', msSinceStart: 20012, pc: 'connected', ice: 'connected', dataChannel: 'open', micTrack: 'live', senderHasTrack: false, outboundPackets: 0, oneShotPending: true } },
    ];
    fs.writeFileSync(path.join(process.env.SESSION_DATA_DIR, sid + '.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const metrics = require('../lib/metrics');
    assert.equal(metrics.compute({ includeTesters: true }).qualitySignals.silentCallCount, 1);
    const { _internal } = require('../lib/admin');
    const html = _internal.sessionDetailPage(sid, { entries: lines });
    assert.match(html, /🔇 <b>Silent call<\/b> — 20 s after the call started/);
    assert.match(html, /mic NOT attached/);
    assert.match(html, /opening line still pending/);
    assert.match(fs.readFileSync(path.join(root, 'lib/admin.js'), 'utf8'), /issueCard\('Silent calls', m\.qualitySignals\.silentCallCount/);
});
