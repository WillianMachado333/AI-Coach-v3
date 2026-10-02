// #40 step 2: the speech gate. In a GPT-Live call the mic reaches OpenAI only
// while someone speaks (on-device Silero VAD) or Erica is busy — Live goes
// quiet and holds its answer back when no audio flows in (measured on
// staging 2026-10-02), so "busy" spans the delegation, the backend's
// thinking and Erica's audio. A closed gate blips 1 s every 200 s (Live
// drops a session ~267 s after its last audio). The VAD files come from the
// pinned npm packages under /vad/<version>/, brotli, immutable.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-gate-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeechGate, createCoachActivity, DEFAULTS } = require('../lib/speechGate');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const FRAME = 32;

// Feed frames from `from` to `to` (ms) with a probability function; collect events.
function run(gate, from, to, probAt, busyAt = () => false, events = []) {
    for (let at = from; at < to; at += FRAME) {
        const ev = gate.frame({ prob: probAt(at), at, frameMs: FRAME, coachBusy: busyAt(at) });
        if (ev) events.push({ at, ...ev });
    }
    return events;
}

test('noise never opens the gate; 120 ms of speech does; a 64 ms click does not', () => {
    const g = createSpeechGate();
    // Fan + keyboard: Silero gave at most 0.09 on staging.
    assert.deepEqual(run(g, 0, 60000, (at) => (at % 640 === 0 ? 0.2 : 0.05)), []);
    assert.equal(g.state, 'closed');
    // Two speech-like frames (a cough, a click) and back to noise: still closed.
    assert.deepEqual(run(g, 60000, 61000, (at) => (at < 60064 ? 0.9 : 0.05)), []);
    // Speech: open on the 4th frame (≥ 120 ms).
    const ev = run(g, 61000, 61400, () => 0.9);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].action, ev[0].reason, ev[0].at], ['open', 'speech', 61000 + 3 * FRAME]);
    assert.ok(ev[0].closedMs > 60000);
});

test('it closes 1.2 s after the last speech-ish frame, not while Erica is busy, and 1 s after she is done', () => {
    const g = createSpeechGate();
    run(g, 0, 200, () => 0.9); // open
    assert.equal(g.state, 'open');
    // A pause with words trailing off (0.4 ≥ close threshold) keeps it open.
    assert.deepEqual(run(g, 200, 1500, () => 0.4), []);
    const ev = run(g, 1500, 4000, () => 0.05);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].action, 'close');
    assert.ok(ev[0].at >= 1500 + 1200 - FRAME && ev[0].at <= 1500 + 1200 + FRAME, 'hangover ~1.2 s, closed at ' + ev[0].at);
    // Erica busy (a delegation, thinking, then speaking until 12 s): open the
    // whole time, closed 1 s after her last audio.
    const g2 = createSpeechGate(); const c2 = createCoachActivity();
    const ev2 = run(g2, 0, 20000, (at) => (at < 3000 ? 0.9 : 0.02), (at) => {
        if (at >= 3500 && at < 3500 + FRAME) c2.delegation(at);
        if (at >= 3500 && at < 8000) c2.backend(at);
        if (at >= 8000 && at < 12000) c2.audible(at);
        return c2.busy(at);
    });
    assert.deepEqual(ev2.map((e) => e.action), ['open', 'close']);
    assert.ok(ev2[1].at >= 13000 - FRAME && ev2[1].at <= 13000 + FRAME, 'closed at ' + ev2[1].at);
});

test('Erica busy opens a closed gate with no speech (her greeting, an answer to a typed message)', () => {
    const g = createSpeechGate();
    run(g, 0, 5000, () => 0.02);
    const ev = run(g, 5000, 5100, () => 0.02, () => true);
    assert.deepEqual([ev[0].action, ev[0].reason], ['open', 'coach']);
});

test('keep-alive: a closed gate blips every 150 s (Live drops a session ~267 s after its last audio); an open one never', () => {
    const g = createSpeechGate();
    g.frame({ prob: 0, at: 0, frameMs: 0 });
    assert.equal(g.blipDue(149000), false);
    assert.equal(g.blipDue(150000), true);
    g.noteBlip(150000);
    assert.equal(g.blipDue(299000), false);
    assert.equal(g.blipDue(300000), true);
    run(g, 400000, 400200, () => 0.9);
    assert.equal(g.blipDue(900000), false, 'open: audio flows anyway');
    assert.equal(g.totals(400200).blips, 1);
});

test('totals: streaming vs on-device time and opens by cause, the current stretch included', () => {
    const g = createSpeechGate();
    run(g, 0, 10000, () => 0.02);                       // 10 s gated
    run(g, 10000, 15000, () => 0.9);                    // speech opens, ~5 s
    run(g, 15000, 20000, () => 0.02, (at) => at < 17000); // Erica busy, then quiet → close
    run(g, 20000, 30000, () => 0.02);
    const t = g.totals(30000);
    assert.equal(t.opens, 1);
    assert.equal(t.opensBySpeech, 1);
    assert.equal(t.openMs + t.closedMs, 30000);
    // Opened on the 4th speech frame (10.1 s), closed when Erica stopped being busy (17 s).
    assert.ok(t.openMs > 6800 && t.openMs < 7000, 'open ' + t.openMs);
});

test('Erica busy: from the delegation through the backend thinking and her audio; settles without audio; capped', () => {
    const c = createCoachActivity();
    assert.equal(c.busy(0), false);
    c.delegation(1000);
    for (let at = 1000; at <= 16000; at += 2000) { c.backend(at); assert.equal(c.busy(at + 500), true, 'thinking at ' + at); }
    c.audible(17000); c.audible(25000); // she speaks 17–25 s
    assert.equal(c.busy(25500), true);
    assert.equal(c.busy(26100), false, '1 s after her last audio');
    // A delegation that never speaks (a tool-only turn): over 8 s after the backend went quiet.
    c.delegation(40000); c.backend(41000);
    assert.equal(c.busy(48900), true);
    assert.equal(c.busy(49100), false);
    // Hard cap.
    c.delegation(100000);
    for (let at = 100000; at < 200000; at += 5000) c.backend(at);
    assert.equal(c.busy(190001), false, 'never more than 90 s');
    // The opening line: busy until she has spoken and gone quiet, or 20 s.
    const o = createCoachActivity();
    o.expectSpeech(0);
    assert.equal(o.busy(5000), true);
    o.audible(6000);
    assert.equal(o.busy(6500), true);
    assert.equal(o.busy(7100), false);
    const o2 = createCoachActivity();
    o2.expectSpeech(0);
    assert.equal(o2.busy(19000), true);
    assert.equal(o2.busy(20001), false);
});

test('one exchange end to end: the gate opens on the first syllable and carries the whole answer', () => {
    const g = createSpeechGate(); const c = createCoachActivity();
    // Noise 0–20 s; the user speaks 20–27 s; Live delegates at 28 s; the backend
    // thinks to 38 s; Erica speaks 38–50 s; noise after.
    const prob = (at) => (at >= 20000 && at < 27000 ? 0.92 : 0.06);
    const events = [];
    for (let at = 0; at < 70000; at += FRAME) {
        if (at >= 28000 && at < 28000 + FRAME) c.delegation(at);
        if (at >= 28000 && at <= 38000 && at % 2000 < FRAME) c.backend(at);
        if (at >= 38000 && at < 50000) c.audible(at);
        const ev = g.frame({ prob: prob(at), at, frameMs: FRAME, coachBusy: c.busy(at) });
        if (ev) events.push({ at, ...ev });
    }
    assert.deepEqual(events.map((e) => e.action), ['open', 'close'], JSON.stringify(events));
    assert.ok(events[0].at <= 20000 + 4 * FRAME, 'opened at ' + events[0].at + ': within the 300 ms pre-roll');
    assert.ok(events[0].at + 0 < 20000 + DEFAULTS.preRollMs, 'the frames that opened it are still in the delay line');
    assert.ok(events[1].at >= 51000 - FRAME && events[1].at <= 51000 + FRAME, 'closed 1 s after she finished: ' + events[1].at);
    const t = g.totals(70000);
    assert.ok(t.closedMs > 38000, 'the noise stayed on the device: ' + t.closedMs);
});

// ---- the client wiring --------------------------------------------------------

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

test('client: the sender carries the delayed mic only when open; a blip is 1 s of silence; no VAD frames for 2 s → stream everything, loudly', async () => {
    const apply = method('_speechGateApply', 'g, open');
    const tick = method('_speechGateTick', 'g');
    const blip = method('_speechGateBlip', 'g, why');
    const replaced = [];
    const sender = { replaceTrack: async (t) => { replaced.push(t ? t.id : null); } };
    const app = { audioSender: sender };
    app._speechGateBlip = blip;
    const g = { track: { id: 'delayed' }, blipTrack: { id: 'silence' }, sent: undefined, state: 'on', readyAt: Date.now(), lastFrameAt: Date.now(),
        gate: createSpeechGate() };
    app._gate = g;
    apply.call(app, g, false); apply.call(app, g, false); apply.call(app, g, true); apply.call(app, g, true);
    assert.deepEqual(replaced, [null, 'delayed'], 'switched only on change');
    // Blip: the gate is closed and 200 s have passed.
    apply.call(app, g, false);
    g.gate.frame({ prob: 0, at: Date.now() - 151000, frameMs: 0 });
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms, 5));
    try {
        tick.call(app, g);
        assert.deepEqual(replaced.slice(-1), ['silence']);
        await new Promise((r) => realSetTimeout(r, 30));
        assert.deepEqual(replaced.slice(-1), [null], 'back to nothing after the blip');
    } finally {
        global.setTimeout = realSetTimeout;
    }
    // The watchdog.
    let unavailable = null;
    app._speechGateUnavailable = (stage, err) => { unavailable = [stage, err]; };
    g.lastFrameAt = Date.now() - 2500;
    tick.call(app, g);
    assert.equal(unavailable[0], 'frames');
});

test('client: unavailable → the plain mic again, an event, and a ⚠️ line; start is a no-op outside a gated Live call', async () => {
    const unavailable = method('_speechGateUnavailable', 'stage, error');
    const replaced = []; const events = [];
    const mic = { id: 'mic' };
    const app = {
        _gate: { state: 'on' }, isRecording: true, audioSender: { replaceTrack: async (t) => replaced.push(t && t.id) },
        localStream: { getAudioTracks: () => [mic] }, _postGateEvent: (n, m) => events.push([n, m]),
        _speechGateStop: function () { this._gate = null; },
    };
    const warn = console.warn; let line = '';
    console.warn = (s) => { line = s; };
    unavailable.call(app, 'start', 'Unable to load a worklet module');
    console.warn = warn;
    assert.deepEqual(replaced, ['mic']);
    assert.deepEqual(events[0], ['speech_gate_unavailable', { stage: 'start', error: 'Unable to load a worklet module' }]);
    assert.match(line, /⚠️ speech gate unavailable \(start: .*\) — this call streams everything/);
    const start = method('_speechGateStart', '');
    for (const app2 of [
        { voiceApiMode: 'realtime', _speechGateCfg: { enabled: true }, isRecording: true, localStream: {} },
        { voiceApiMode: 'live', _speechGateCfg: { enabled: false }, isRecording: true, localStream: {} },
        { voiceApiMode: 'live', _speechGateCfg: null, isRecording: true, localStream: {} },
    ]) {
        await start.call(app2);
        assert.equal(app2._gate, undefined);
    }
});

test('client wiring: starts with the call, stops with it, survives a reconnect; Live events and the opening line feed "Erica busy"', () => {
    assert.match(src, /this\._speechGateStart\(\);\s*\} catch \(error\) \{\s*console\.error\('Error starting recording:', error\);/);
    assert.match(src, /stopRecording\(force = false\) \{\s*this\._silentCallDisarm\(\);\s*this\._speechGateStop\('hangup'\);/);
    assert.match(src, /this\._liveGuardStop\(\);\s*if \(!keepMic\) this\._speechGateStop\('teardown'\);/);
    assert.match(src, /mic re-attached to the new connection[^\n]*\n\s*\}\s*\/\/[^\n]*\n\s*this\._speechGateReattach\(\);/);
    // The keep-alive is silence from a running source (an unconnected destination sent nothing and Live expired the session).
    const startSrc = src.slice(src.indexOf('    async _speechGateStart() {'), src.indexOf('    _speechGateFrame(g, prob) {'));
    assert.match(startSrc, /zero\.gain\.value = 0;\s*g\.osc = ctx\.createOscillator\(\);\s*g\.osc\.connect\(zero\);\s*zero\.connect\(blipOut\);\s*g\.osc\.start\(\);/);
    // A new Live session gets audio at once, at start and after a reconnect.
    assert.match(startSrc, /this\._speechGateBlip\(g, 'a new Live session expires within ~30 s if no audio reaches it'\);/);
    // ...after Live says the session started (a blip before it exists was wasted: staging 2026-10-02).
    assert.match(src, /case 'session\.started':[\s\S]{0,250}this\._resetLiveTurnGate\(\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(this\._gate && this\._gate\.state === 'on'\) this\._speechGateBlip\(this\._gate, /);
    assert.match(src, /case 'session\.delegation\.created': \{\s*const coach = this\._gateCoach\(\);\s*if \(coach\) coach\.delegation\(Date\.now\(\)\);/);
    assert.match(src, /this\._liveOneShotObserve\(inner\);\s*\/\/[^\n]*\n\s*\{ const coach = this\._gateCoach\(\); if \(coach\) coach\.backend\(Date\.now\(\)\); \}/);
    assert.match(src, /if \(!text\) return false;\s*\/\/[^\n]*\n\s*\{ const coach = this\._gateCoach\(\); if \(coach\) coach\.expectSpeech\(Date\.now\(\)\); \}/);
    // The delay line and the VAD on the same mic stream; single-threaded wasm (no cross-origin isolation in the embed).
    const start = src.slice(src.indexOf('    async _speechGateStart() {'), src.indexOf('    _speechGateFrame(g, prob) {'));
    assert.match(start, /delay\.delayTime\.value = g\.gate\.config\.preRollMs \/ 1000;\s*const out = ctx\.createMediaStreamDestination\(\);\s*src\.connect\(delay\);\s*delay\.connect\(out\);/);
    assert.match(start, /getStream: async \(\) => stream, pauseStream: async \(\) => \{\}/, 'the VAD must never stop the call’s mic');
    assert.match(src, /window\.ort\.env\.wasm\.numThreads = 1;/);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.ok(html.indexOf('lib/speechGate.js') > 0 && html.indexOf('lib/speechGate.js') < html.indexOf('src="app.js'), 'loaded before app.js');
    assert.doesNotMatch(html, /ort\.min\.js|bundle\.min\.js/, 'the VAD files load with the first call, not with the page');
});

// ---- the server: /vad/ files and the config ---------------------------------------

function startServer(port, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: root,
            env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', SESSION_SECRET: 'test-secret-gate', ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(child); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function get(port, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('HTTP: /api/voice-mode publishes the gate; /vad/<version>/ serves exactly the VAD files, brotli, immutable; ERICA_SPEECH_GATE=off turns it off', async () => {
    const vadAssets = require('../lib/vadAssets');
    assert.equal(vadAssets.BASE, '/vad/1.30.0-0.0.31/', 'pinned versions (package.json)');
    const port = 19000 + Math.floor(Math.random() * 900);
    let server = await startServer(port);
    try {
        const mode = JSON.parse((await get(port, '/api/voice-mode')).body.toString());
        assert.deepEqual(mode.speechGate, { enabled: true, assets: vadAssets.BASE, model: 'v5' });
        const wasm = await get(port, vadAssets.BASE + 'ort-wasm-simd-threaded.wasm', { 'Accept-Encoding': 'gzip, br' });
        assert.equal(wasm.status, 200);
        assert.equal(wasm.headers['content-type'], 'application/wasm');
        assert.equal(wasm.headers['content-encoding'], 'br');
        assert.match(wasm.headers['cache-control'], /max-age=31536000, immutable/);
        const raw = zlib.brotliDecompressSync(wasm.body);
        assert.deepEqual([...raw.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'a wasm module');
        assert.ok(wasm.body.length < raw.length / 4, `brotli ${wasm.body.length} of ${raw.length}`);
        const model = await get(port, vadAssets.BASE + 'silero_vad_v5.onnx');
        assert.equal(model.headers['content-encoding'], undefined, 'no br asked, none given');
        assert.equal(model.body.length, fs.statSync(path.join(root, 'node_modules', '@ricky0123', 'vad-web', 'dist', 'silero_vad_v5.onnx')).size);
        for (const p of ['bundle.min.js', 'vad.worklet.bundle.min.js', 'ort.min.js', 'ort-wasm-simd-threaded.mjs']) {
            assert.equal((await get(port, vadAssets.BASE + p)).status, 200, p);
        }
        for (const p of [vadAssets.BASE + 'package.json', vadAssets.BASE + '../../server.js', '/vad/0.0.0-0.0.0/bundle.min.js', vadAssets.BASE + 'silero_vad_legacy.onnx', '/vad/']) {
            assert.equal((await get(port, p)).status, 404, p);
        }
        assert.equal((await get(port, '/lib/speechGate.js')).status, 200, 'the browser module is public');
    } finally {
        server.kill();
    }
    server = await startServer(port + 1, { ERICA_SPEECH_GATE: 'off' });
    try {
        const mode = JSON.parse((await get(port + 1, '/api/voice-mode')).body.toString());
        assert.equal(mode.speechGate.enabled, false);
    } finally {
        server.kill();
    }
});

test('Studio: a visit shows what streamed and what stayed on the device; open/close and cut rows in the timeline', () => {
    const sessionLog = require('../lib/sessionLog');
    const admin = require('../lib/admin');
    const sid = sessionLog.startSession({ objectId: 'ct-abc123', caller: 'app' });
    sessionLog.logEvent(sid, { name: 'speech_gate_on', meta: { model: 'silero_vad_v5', preRollMs: 300, readyMs: 640 } });
    sessionLog.logEvent(sid, { name: 'gate_open', meta: { reason: 'speech', prob: 0.96, closedMs: 280000 } });
    sessionLog.logEvent(sid, { name: 'gate_close', meta: { openMs: 31000, maxProb: 1 } });
    sessionLog.logEvent(sid, { name: 'speech_gate_summary', meta: { streamingMs: 62000, gatedMs: 838000, opens: 6, opensBySpeech: 3, opensByCoach: 3, blips: 4 } });
    sessionLog.logEvent(sid, { name: 'live_session_cut', meta: { reason: 'idle', by: 'client', minutes: 12.2, inCall: true } });
    const html = admin._internal.sessionDetailPage(sid, sessionLog.readSession(sid));
    assert.match(html, /<span data-gate-totals><b>Speech gate<\/b> streamed 62 s · on the device only 14 min<\/span>/);
    assert.match(html, /data-gate-event="gate_open"[^>]*><div[^>]*>🎙️ mic to OpenAI — speech \(p 0\.96\) · after 4\.7 min on the device only/);
    assert.match(html, /🔇 mic kept on the device — after 31 s streaming/);
    assert.match(html, /🎙️ <b>Speech gate<\/b> — streamed 62 s · on the device only 14 min · 6 opens \(3 speech, 3 Erica\) · 4 keep-alive blips/);
    assert.match(html, /✂️ <b>Live connection ended<\/b> — no turn for the idle limit · by the app · after 12\.2 min · in a call/);
    // A call that ended without its summary (a closed tab) counts from its events.
    const sid2 = sessionLog.startSession({ objectId: 'ct-def456', caller: 'app' });
    sessionLog.logEvent(sid2, { name: 'gate_open', meta: { reason: 'coach', prob: 0, closedMs: 0 } });
    sessionLog.logEvent(sid2, { name: 'gate_close', meta: { openMs: 9000 } });
    sessionLog.logEvent(sid2, { name: 'gate_open', meta: { reason: 'speech', prob: 0.9, closedMs: 120000 } });
    sessionLog.logEvent(sid2, { name: 'speech_gate_unavailable', meta: { stage: 'frames', error: 'no VAD frame for 3 s' } });
    const html2 = admin._internal.sessionDetailPage(sid2, sessionLog.readSession(sid2));
    assert.match(html2, /streamed 9 s · on the device only 2 min \(from open\/close events\) · <span[^>]*>⚠ unavailable in 1 call<\/span>/);
    assert.match(html2, /⚠️ <b>Speech gate unavailable<\/b> \(frames: no VAD frame for 3 s\) — this call streamed everything/);
});
