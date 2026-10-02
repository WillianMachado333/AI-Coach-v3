// #40 GPT-Live cost guardrails. GPT-Live bills a connection while inbound
// audio flows, speech or not; on 2026-09-29 test tabs left running cost
// ~1,760 billed minutes. Every Live connection ends at 30 min, or after
// 10 min with no turn: the client cuts first, the server (lib/liveGuard.js)
// hangs up a minute later if usage is still flowing, answers a late usage
// snapshot with { cut: true }, and refuses the client's automatic reconnect
// right after a cut. The Studio home shows today's spend against an alert
// and names any connection open > 20 min.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-guard-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });

const test = require('node:test');
const assert = require('node:assert/strict');
const liveGuard = require('../lib/liveGuard');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const MIN = 60 * 1000;

function guardAt(clock) {
    const hangups = []; const events = [];
    liveGuard._internal.reset();
    liveGuard.configure({
        now: () => clock.t,
        hangup: async (id) => { hangups.push(id); return { status: clock.hangupStatus || 200, body: '' }; },
        logEvent: (sid, name, meta) => events.push({ sid, name, meta }),
    });
    return { hangups, events };
}
const usage = (liveSessionId, seconds, extra = {}) => ({ voiceMode: 'live', source: 'session.usage.updated', liveSessionId, sessionId: 'v1', connectionId: 'c-1', usage: { seconds }, ...extra });

test('config: 30 / 10 min by default, from the env otherwise; a request can only shorten its own limits', () => {
    delete process.env.ERICA_LIVE_MAX_SESSION_MIN; delete process.env.ERICA_LIVE_IDLE_CUT_MIN;
    assert.deepEqual(liveGuard.config(), { maxMin: 30, idleMin: 10, graceS: 60 });
    process.env.ERICA_LIVE_MAX_SESSION_MIN = '45'; process.env.ERICA_LIVE_IDLE_CUT_MIN = 'nonsense';
    assert.deepEqual(liveGuard.config(), { maxMin: 45, idleMin: 10, graceS: 60 });
    delete process.env.ERICA_LIVE_MAX_SESSION_MIN; delete process.env.ERICA_LIVE_IDLE_CUT_MIN;
    const { lowered } = liveGuard._internal;
    assert.equal(lowered('2', 30), 2);
    assert.equal(lowered('90', 30), 30, 'never longer than the server allows');
    assert.equal(lowered(undefined, 30), 30);
    assert.equal(lowered('-1', 30), 30);
});

test('server backstop: past the max (+1 min) the session is hung up at OpenAI, logged, and an automatic reconnect is refused; a tap is not', async () => {
    const clock = { t: 0 };
    const { hangups, events } = guardAt(clock);
    liveGuard.register({ liveId: 'ls_A', sessionId: 'v1' });
    // Audio flowing the whole time, and turns too: the max still applies.
    for (let m = 1; m <= 31; m++) {
        clock.t = m * MIN;
        liveGuard.noteTurn('v1');
        assert.deepEqual(liveGuard.onUsage(usage('ls_A', m * 60)), { cut: false }, `minute ${m}`);
        await liveGuard.sweep();
    }
    assert.deepEqual(hangups, [], 'not before max + grace');
    clock.t = 31 * MIN + 1000;
    await liveGuard.sweep();
    assert.deepEqual(hangups, ['ls_A']);
    const cut = events.find((e) => e.name === 'live_session_cut');
    assert.equal(cut.sid, 'v1');
    assert.deepEqual([cut.meta.reason, cut.meta.by, cut.meta.hangup, cut.meta.liveSessionId], ['max', 'server', 200, 'ls_A']);
    assert.ok(cut.meta.minutes > 31);
    // Usage still arriving: the tripwire tells the client, once logged.
    clock.t += 15000;
    assert.deepEqual(liveGuard.onUsage(usage('ls_A', 1900)), { cut: true, reason: 'max' });
    assert.deepEqual(liveGuard.onUsage(usage('ls_A', 1915)), { cut: true, reason: 'max' });
    assert.equal(events.filter((e) => e.name === 'live_session_overrun').length, 1);
    await liveGuard.sweep();
    assert.equal(hangups.length, 1, 'hung up once');
    // The client's own reconnect right after: refused. The person's: allowed.
    assert.equal(liveGuard.refuseAutoReconnect('v1').reason, 'max');
    assert.equal(liveGuard.refuseAutoReconnect('another-visit'), null);
    liveGuard.clearCut('v1');
    assert.equal(liveGuard.refuseAutoReconnect('v1'), null);
});

test('idle: no turn for 10 min (+1) while audio is billed → cut; turns keep it open; a silent connection is not touched', async () => {
    const clock = { t: 0 };
    const { hangups, events } = guardAt(clock);
    liveGuard.register({ liveId: 'ls_busy', sessionId: 'v-busy' });
    liveGuard.register({ liveId: 'ls_noise', sessionId: 'v-noise' });
    liveGuard.register({ liveId: 'ls_quiet', sessionId: 'v-quiet' });
    for (let s = 15; s <= 11 * 60 + 30; s += 15) {
        clock.t = s * 1000;
        if (s % 120 === 0) liveGuard.noteTurn('v-busy'); // someone speaks every 2 min
        liveGuard.onUsage({ ...usage('ls_busy', s), sessionId: 'v-busy' });
        liveGuard.onUsage({ ...usage('ls_noise', s), sessionId: 'v-noise' }); // a fan into the mic, nobody talks
        if (s === 15) liveGuard.onUsage({ ...usage('ls_quiet', 15), sessionId: 'v-quiet' }); // opened, then no audio
        await liveGuard.sweep();
    }
    assert.deepEqual(hangups, ['ls_noise']);
    assert.equal(events.find((e) => e.name === 'live_session_cut').meta.reason, 'idle');
    assert.equal(liveGuard.refuseAutoReconnect('v-noise').reason, 'idle');
    assert.equal(liveGuard.refuseAutoReconnect('v-busy'), null);
});

test('an automatic reconnect keeps the quiet time (an idle tab reopening its dropped session still reaches the limit); a tap starts afresh', () => {
    const clock = { t: 0 };
    guardAt(clock);
    liveGuard.register({ liveId: 'ls_1', sessionId: 'v1' });
    clock.t = 4.5 * MIN; // Live dropped it (no audio), the client reconnects on its own
    const auto = liveGuard.register({ liveId: 'ls_2', sessionId: 'v1', auto: true });
    assert.equal(auto.lastTurnAt, 0);
    const tap = liveGuard.register({ liveId: 'ls_3', sessionId: 'v1' });
    assert.equal(tap.lastTurnAt, 4.5 * MIN);
});

test('the client ending a connection is not a cut; a hang-up OpenAI does not confirm is loud only if audio was flowing', async () => {
    const clock = { t: 0, hangupStatus: 404 };
    const { hangups, events } = guardAt(clock);
    liveGuard.register({ liveId: 'ls_closed', sessionId: 'v1' });
    liveGuard.onUsage(usage('ls_closed', 30));
    liveGuard.onUsage({ ...usage('ls_closed', null), source: 'disconnect', usage: null });
    liveGuard.register({ liveId: 'ls_gone', sessionId: 'v2' }); // pagehide: no disconnect marker
    liveGuard.register({ liveId: 'ls_flowing', sessionId: 'v3' });
    for (let m = 1; m <= 32; m++) {
        clock.t = m * MIN;
        liveGuard.onUsage({ ...usage('ls_flowing', m * 60), sessionId: 'v3' });
        await liveGuard.sweep();
    }
    assert.deepEqual(hangups.sort(), ['ls_flowing', 'ls_gone'], 'the ended one is left alone');
    const cuts = events.filter((e) => e.name === 'live_session_cut');
    assert.equal(cuts.length, 1, 'the gone one was not billing: no event');
    assert.equal(cuts[0].sid, 'v3');
    assert.equal(cuts[0].meta.hangup, 404);
    assert.match(cuts[0].meta.hangupError, /not found|^$/);
});

test('without a registry entry (a restart, an old client) the snapshot’s own minutes trip the max; Realtime is not this guard’s', () => {
    const clock = { t: 0 };
    const { events } = guardAt(clock);
    const old = { voiceMode: 'live', source: 'session.usage.updated', sessionId: 'v-old', connectionId: 'c-old', usage: { seconds: 1850 } };
    assert.deepEqual(liveGuard.onUsage({ ...old, sessionMinutes: 30.5 }), { cut: false });
    assert.deepEqual(liveGuard.onUsage({ ...old, sessionMinutes: 31.5 }), { cut: true, reason: 'max' });
    assert.deepEqual(liveGuard.onUsage({ ...old, sessionMinutes: 31.75 }), { cut: true, reason: 'max' });
    assert.equal(events.filter((e) => e.name === 'live_session_overrun').length, 1);
    assert.equal(liveGuard.refuseAutoReconnect('v-old').reason, 'max');
    assert.deepEqual(liveGuard.onUsage({ ...old, voiceMode: 'realtime', sessionMinutes: 90 }), { cut: false });
});

// ---- the client (app.js) ------------------------------------------------------

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

test('client: cuts at the max and after the idle limit; a turn resets the quiet time; an automatic reconnect keeps it', () => {
    const start = method('_liveGuardStart', "kind = 'user'");
    const check = method('_liveGuardCheck', 'now = Date.now()');
    const note = method('_liveGuardNoteTurn', '');
    const stop = method('_liveGuardStop', '');
    const cuts = [];
    const app = { voiceApiMode: 'live', isConnected: true, _liveLimits: { maxMin: 30, idleMin: 10 }, _cutLive: (r, by) => cuts.push([r, by]) };
    app._liveGuardStop = stop; app._liveGuardCheck = check;
    start.call(app, 'user');
    const t0 = app._liveGuard.startedAt;
    assert.equal(check.call(app, t0 + 9 * MIN), null);
    note.call(app);
    const noted = app._liveLastTurnAt;
    assert.equal(check.call(app, noted + 9.9 * MIN), null);
    assert.equal(check.call(app, noted + 10 * MIN), 'idle');
    assert.deepEqual(cuts.pop(), ['idle', 'client']);
    // Talking all along: the max still ends it.
    app._liveLastTurnAt = t0 + 29.9 * MIN;
    assert.equal(check.call(app, t0 + 30 * MIN), 'max');
    // An automatic reconnect keeps the quiet time; the person's starts afresh.
    app._liveLastTurnAt = 1000;
    start.call(app, 'auto');
    assert.equal(app._liveLastTurnAt, 1000);
    start.call(app, 'user');
    assert.ok(app._liveLastTurnAt > 1000);
    // Not Live, or not connected: inert.
    assert.equal(check.call({ ...app, voiceApiMode: 'realtime' }, Date.now() + 99 * MIN), null);
    assert.equal(check.call({ ...app, isConnected: false }, Date.now() + 99 * MIN), null);
    stop.call(app);
    assert.equal(app._liveGuard, null);
});

test('client: a cut ends the connection once, logs it, leaves the page in standby, and shows "Call ended — tap to resume" only for a call', async () => {
    const cut = method('_cutLive', "reason, by = 'client'");
    const posted = []; const ui = [];
    global.window = { uiLayout: { updateStatusDot: (_a, s) => ui.push(['dot', s]), showCallEnded: (_a, r) => ui.push(['ended', r]) } };
    global.fetch = async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true }; };
    const mk = (inCall) => {
        const app = {
            sessionId: 'v1', _liveSessionId: 'ls_9', isRecording: inCall, _liveLimits: { maxMin: 30, idleMin: 10 },
            _liveGuard: { startedAt: Date.now() - 30 * MIN }, apiUrl: (p) => p,
            textInput: { disabled: true }, callButton: { disabled: true }, disconnects: 0,
            disconnect: async function () { this.disconnects++; this.isRecording = false; },
            setMicButtonState: function (s) { this.mic = s; }, updateTextButtonVisibility: () => {}, _postConnectionState: function () { this.posted = true; },
        };
        return app;
    };
    const call = mk(true);
    await cut.call(call, 'max', 'client');
    await cut.call(call, 'max', 'server');
    assert.equal(call.disconnects, 1, 'once');
    assert.deepEqual(posted.map((p) => [p.kind, p.name, p.meta.reason, p.meta.by, p.meta.inCall, p.meta.liveSessionId]), [['event', 'live_session_cut', 'max', 'client', true, 'ls_9']]);
    assert.ok(posted[0].meta.minutes >= 30);
    assert.deepEqual([call._liveStandby, call.textInput.disabled, call.callButton.disabled, call.mic, call.posted], [true, false, false, 'enabled', true]);
    assert.deepEqual(ui, [['dot', 'standby'], ['ended', 'max']]);
    // Typing, not calling: quiet — the next message reconnects.
    ui.length = 0;
    await cut.call(mk(false), 'idle', 'client');
    assert.deepEqual(ui, [['dot', 'standby']]);
    delete global.window; delete global.fetch;
});

test('client: a usage snapshot answered { cut: true } ends the connection it was about — not a newer one', async () => {
    const post = method('_postUsage', 'snapshot');
    const cuts = [];
    let verdict = { ok: true, cut: true, reason: 'idle' };
    global.fetch = async () => ({ ok: true, json: async () => verdict });
    const meter = { connectionId: 'c-1', connectedAt: Date.now() - MIN };
    const app = {
        sessionId: 'v1', voiceApiMode: 'live', _liveSessionId: 'ls_1', _usageModelInfo: {}, apiUrl: (p) => p,
        _usageMeter: meter, _usageBeginConnection: () => meter, _cutLive: (r, by) => cuts.push([r, by]),
    };
    let sent = null;
    const realFetch = global.fetch;
    global.fetch = async (url, init) => { sent = JSON.parse(init.body); return realFetch(url, init); };
    post.call(app, { source: 'session.usage.updated', usage: { seconds: 600 } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.liveSessionId, 'ls_1', 'the server matches it to the session it may hang up');
    assert.deepEqual(cuts, [['idle', 'server']]);
    // The answer arrives after the person already reconnected: ignored.
    post.call(app, { source: 'session.usage.updated', usage: { seconds: 615 } });
    meter.connectionId = 'c-2';
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(cuts.length, 1);
    verdict = { ok: true };
    delete global.fetch;
});

test('client wiring: guard on open/teardown, turns noted, the reconnect kind sent, a 409 cut is not an OpenAI failure, no auto-reconnect after a cut', () => {
    assert.match(src, /this\.startSessionInactivityTimer\(\);\s*if \(this\.voiceApiMode === 'live'\) this\._liveGuardStart\(this\._liveConnectKind\);/);
    assert.match(src, /_teardownWebRTCOnly\(\{ keepMic = false \} = \{\}\) \{\s*this\._liveGuardStop\(\);/);
    assert.match(src, /async disconnect\(\) \{\s*this\._liveGuardStop\(\);/);
    assert.match(src, /if \(message\.role !== 'user' && message\.role !== 'bot'\) return;\s*this\._liveGuardNoteTurn\(\);/);
    assert.match(src, /headers\['X-Erica-Session'\] = this\.sessionId;\s*headers\['X-Erica-Reconnect'\] = reconnectKind;/);
    assert.match(src, /if \(isLive && response\.status === 409\) \{[\s\S]{0,400}cutErr\.liveCut = refusal\.reason \|\| 'max';\s*throw cutErr;/);
    assert.match(src, /if \(error && error\.liveCut\) throw error;\s*console\.error\('Connection error:', error\);\s*\/\/ Track consecutive OpenAI connection failures/, 'before the maintenance-redirect counter');
    assert.match(src, /if \(!this\.isConnecting && !this\._autoReconnecting && !this\._liveCut\) \{/);
    assert.match(src, /this\._reconnectKind = 'auto';\s*this\.connect\(\{ skipOpeningLine: true \}\)/);
    assert.match(src, /if \(error && error\.liveCut\) \{[\s\S]{0,200}setTimeout\(\(\) => this\._cutLive\(error\.liveCut, 'server'\), 0\);/);
    assert.match(src, /this\._liveSessionId = \(liveJson\.session && liveJson\.session\.id\) \|\| null;/);
    // The notice resumes the call; the usage limit path (questionsLimit) is untouched.
    const ui = fs.readFileSync(path.join(root, 'uiLayout.js'), 'utf8');
    assert.match(ui, /app\.callEndedNotice\.addEventListener\('click', \(\) => \{\s*if \(typeof app\._resumeAfterCut === 'function'\) app\._resumeAfterCut\(\);/);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /<button id="callEndedNotice" type="button" class="call-ended hidden"[^>]*>[\s\S]*?<span>Call ended — tap to resume<\/span>/);
    assert.match(method('_resumeAfterCut', '').toString(), /this\._clearLiveCut\(\);\s*this\.toggleMicTrack\(\);/);
});

// ---- the server over HTTP (fake GPT-Live, tests/helpers/fakeLiveApi.js) ----------

function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', './tests/helpers/fakeLiveApi.js', 'server.js'], {
            cwd: root,
            env: { ...process.env, PORT: String(port), OPENAI_API_KEY: 'sk-test-fake-live', SESSION_SECRET: 'test-secret-guard', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function request(port, urlPath, { method: m = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: m, headers }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); if (body) req.write(body); req.end();
    });
}

test('HTTP: limits published; the session id registered; a late snapshot hangs it up and answers cut; the automatic reconnect gets 409, a tap does not', async () => {
    const liveLog = path.join(tmp, 'live.ndjson');
    const port = 19000 + Math.floor(Math.random() * 900);
    const srv = await startServer(port, {
        SESSION_DATA_DIR: path.join(tmp, 'srv-sessions'), FAKE_LIVE_LOG: liveLog,
        ERICA_LIVE_MAX_SESSION_MIN: '25', ERICA_LIVE_GUARD_GRACE_S: '1',
    });
    try {
        const mode = JSON.parse((await request(port, '/api/voice-mode')).body);
        assert.deepEqual([mode.liveMaxSessionMin, mode.liveIdleCutMin], [25, 10]);
        const sid = 'v-http-1';
        const open = (kind, extra = {}) => request(port, '/api/proxy/live', { method: 'POST', headers: { 'Content-Type': 'application/sdp', 'X-Erica-Session': sid, 'X-Erica-Reconnect': kind, ...extra }, body: 'v=0\r\n' });
        // A verification run may shorten its own max (0.01 min) — never lengthen it.
        const first = await open('user', { 'X-Erica-Live-Max-Min': '0.01' });
        assert.equal(first.status, 200);
        const liveId = JSON.parse(first.body).session.id;
        await new Promise((r) => setTimeout(r, 2000)); // 0.6 s max + 1 s grace
        const snap = (seconds) => request(port, '/api/session-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, kind: 'usage', voiceMode: 'live', source: 'session.usage.updated', liveSessionId: liveId, connectionId: 'c-1', sessionMinutes: 0.04, usage: { seconds } }) });
        const verdict = JSON.parse((await snap(2)).body);
        assert.deepEqual([verdict.ok, verdict.cut, verdict.reason], [true, true, 'max']);
        await new Promise((r) => setTimeout(r, 300));
        const calls = fs.readFileSync(liveLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.deepEqual(calls.map((c) => [c.kind, c.id]), [['create', liveId], ['hangup', liveId]]);
        assert.equal(calls[1].auth, true, 'with the server key');
        assert.match(srv.out(), /\[liveGuard\] ✂️ live_session_cut max/);
        // The usage was still recorded: the money was spent.
        const lines = fs.readFileSync(path.join(tmp, 'srv-sessions', sid + '.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.ok(lines.some((l) => l.type === 'usage' && l.usage && l.usage.seconds === 2));
        assert.ok(lines.some((l) => l.type === 'event' && l.name === 'live_session_cut' && l.meta.by === 'server' && l.meta.hangup === 200));
        // The snapshot that triggered the cut is the cut, not an overrun after it (staging, 2026-10-02).
        assert.ok(!lines.some((l) => l.type === 'event' && l.name === 'live_session_overrun'));
        assert.doesNotMatch(srv.out(), /usage still arriving/);
        const after = JSON.parse((await snap(17)).body);
        assert.equal(after.cut, true);
        await new Promise((r) => setTimeout(r, 200));
        const lines2 = fs.readFileSync(path.join(tmp, 'srv-sessions', sid + '.ndjson'), 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
        assert.equal(lines2.filter((l) => l.type === 'event' && l.name === 'live_session_overrun').length, 1, 'a later one is');
        // Right after: the client's own reconnect is refused; the person's tap opens a new one.
        const auto = await open('auto');
        assert.equal(auto.status, 409);
        assert.deepEqual(JSON.parse(auto.body), { error: 'live_session_cut', cut: true, reason: 'max' });
        assert.equal((await open('user')).status, 200);
        assert.equal((await open('auto')).status, 200, 'the tap cleared the cut');
    } finally {
        srv.child.kill();
    }
});

// ---- the Studio: spent today, the alert, long connections ------------------------

test('Studio: spent today counts by when it was spent (Live seconds are cumulative), testers included; red past the alert; connections > 20 min named', () => {
    const sessionLog = require('../lib/sessionLog');
    const metrics = require('../lib/metrics');
    const admin = require('../lib/admin');
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const before = new Date(Date.parse(today) - 5 * MIN).toISOString();
    const guest = sessionLog.startSession({ objectId: 'guest-77', caller: 'app' });
    const tester = sessionLog.startSession({ email: 'qa+test@talenttransformation.com', caller: 'admin-simulator' }); // a tester by construction
    // A connection that spans midnight: 600 s by 23:55 (written as of then), 1200 s now → 600 s today.
    fs.appendFileSync(path.join(process.env.SESSION_DATA_DIR, guest + '.ndjson'), JSON.stringify({ type: 'usage', t: before, source: 'session.usage.updated', voiceMode: 'live', model: 'gpt-live-1', connectionId: 'c-night', sessionMinutes: 10, usage: { seconds: 600 } }) + String.fromCharCode(10));
    sessionLog.logUsage(guest, { source: 'session.usage.updated', voiceMode: 'live', model: 'gpt-live-1', connectionId: 'c-night', sessionMinutes: 20.5, usage: { seconds: 1200 } });
    // The tester's runaway tab: 4 h of billed Live seconds today = $12.
    sessionLog.logUsage(tester, { source: 'session.usage.updated', voiceMode: 'live', model: 'gpt-live-1', connectionId: 'c-run', sessionMinutes: 240, usage: { seconds: 14400 } });
    const m = metrics.compute({ includeTesters: false });
    const s = m.spendToday;
    assert.equal(s.since, today);
    assert.equal(Math.round(s.usd * 100) / 100, 12.5, '$0.50 (600 s) + $12.00 — the testers are real money');
    assert.equal(Math.round(s.testerUsd * 100) / 100, 12);
    assert.equal(s.liveSeconds, 600 + 14400);
    assert.deepEqual([s.alertUsd, s.over], [10, true]);
    assert.deepEqual(s.longConnections.map((c) => [c.connectionId, c.minutes]), [['c-run', 240], ['c-night', 20.5]]);
    const html = admin._internal.indexPage({ e: 'willian@tt.com', sub: 'admin' });
    assert.match(html, /data-spend-alarm="over">🔴 <b>\$12\.50<\/b> spent at OpenAI today \(UTC\) — over the \$10\.00 alert, \$12\.00 of it from testers/);
    assert.match(html, /data-spend-alarm="long">⚠️ A live connection was open <b>240 min<\/b> \(240 billed Live min\)/);
    assert.match(html, /data-spend-alarm="long">⚠️ A live connection was open <b>21 min<\/b>/);
    assert.match(html, /<div class="card sect-card sect-crit">\s*<div class="rot">Spent today<\/div>\s*<div class="val" style="color:var\(--crit\)">\$12\.50<\/div>/);
    process.env.ERICA_DAILY_SPEND_ALERT_USD = '50';
    const calm = admin._internal.indexPage({ e: 'willian@tt.com', sub: 'admin' });
    assert.doesNotMatch(calm, /data-spend-alarm="over"/);
    assert.match(calm, /data-spend-alarm="long"/, 'a long connection is named whatever the spend');
    assert.match(calm, /of \$50\.00 alert/);
    delete process.env.ERICA_DAILY_SPEND_ALERT_USD;
});
