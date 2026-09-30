// In-chat AI Navigator: one routing implementation (form and chat agree), the
// model's answer read strictly, the route that logs and prices each read,
// and the client that applies the style once, asks one question when a tag is
// unclear, tells the Live voice layer, and stops when the person picks a coach.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-nav-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
const root = path.join(__dirname, '..');
const data = require('../navigatorData.json');
const routing = require('../navigatorRouting');
const nav = require('../lib/navigatorInfer');

test('routing: the shared module gives every one of the 36 table routes; a partial answer falls back to weights; the form uses the same module', () => {
    for (const [key, want] of Object.entries(data.routes)) {
        const [mood, readiness, clarity] = key.split('|');
        const r = routing.route(data, { mood, readiness, clarity });
        assert.deepEqual([r.primary, r.autonomy, r.via], [want[0], want[1], 'table'], key);
    }
    assert.deepEqual(routing.route(data, { readiness: 'ReadyToAct' }), { primary: 'Directive', autonomy: 'Empowering', scores: { Directive: 3, Empowering: 2, Guidance: 1 }, tags: { readiness: 'ReadyToAct' }, via: 'weights' });
    assert.equal(routing.route(data, { mood: 'NotAnOption' }).via, 'none', 'unknown values are ignored');
    const form = fs.readFileSync(path.join(root, 'navigator.js'), 'utf8');
    assert.match(form, /global\.EricaNavigatorRouting\.route\(this\.data, tags\)/);
    assert.doesNotMatch(form, /this\.data\.routes\[key\]/, 'no second copy of the logic');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.ok(html.indexOf('navigatorRouting.js') < html.indexOf('src="navigator.js'), 'loaded before the form');
});

test('the model answer is read strictly: only real options, confidences clamped, "ready" only when all three are clear, the weakest question named for the one ask', () => {
    const r = nav.interpret({ mood: 'Guidance', readiness: 'ReadyToAct', clarity: 'Clear', confidence: { mood: 0.9, readiness: 1.4, clarity: 0.7 } });
    assert.deepEqual(r.tags, { mood: 'Guidance', readiness: 'ReadyToAct', clarity: 'Clear' });
    assert.deepEqual(r.confidence, { mood: 0.9, readiness: 1, clarity: 0.7 });
    assert.equal(r.ready, true);
    assert.deepEqual([r.style, r.autonomy, r.via], [data.routes['Guidance|ReadyToAct|Clear'][0], data.routes['Guidance|ReadyToAct|Clear'][1], 'table']);
    assert.equal(r.ask, null);
    const p = nav.interpret({ mood: 'FeelUnderstood', readiness: null, clarity: 'Bogus', confidence: { mood: 0.8, readiness: 0.9, clarity: 0.9 } });
    assert.deepEqual(p.tags, { mood: 'FeelUnderstood' });
    assert.deepEqual(p.confidence, { mood: 0.8, readiness: 0, clarity: 0 }, 'no tag, no confidence');
    assert.equal(p.ready, false);
    assert.equal(p.via, 'weights');
    assert.equal(p.ask.id, 'readiness');
    assert.equal(p.ask.title, data.questions.find((q) => q.id === 'readiness').title, 'the question comes from navigatorData.json');
    assert.ok(p.ask.options.length >= 3);
});

test('schema and prompt come from navigatorData.json (strict JSON; every question and option)', () => {
    const s = nav.schemaFor();
    assert.equal(s.additionalProperties, false);
    assert.deepEqual(s.required, ['mood', 'readiness', 'clarity', 'confidence']);
    assert.deepEqual(s.properties.readiness.anyOf[0].enum, ['ReadyToAct', 'ThinkItThrough', 'NotReadyYet']);
    const prompt = nav.systemPrompt();
    for (const q of data.questions) { assert.ok(prompt.includes(q.title)); for (const o of q.options) assert.ok(prompt.includes(o.value)); }
    assert.match(prompt, /Never infer from the coach's words/);
});

test('infer: sends the person and the coach labelled, returns usage; refuses a visit with no user turn or a non-JSON answer', async () => {
    let seen = null;
    const client = { responses: { create: async (req) => { seen = req; return { id: 'resp_1', model: 'gpt-4.1-mini-x', usage: { input_tokens: 10, output_tokens: 5 }, output_text: JSON.stringify({ mood: 'NeedConfidence', readiness: 'ReadyToAct', clarity: 'Clear', confidence: { mood: 0.8, readiness: 0.8, clarity: 0.8 } }) }; } } };
    const r = await nav.infer({ client, model: 'gpt-4.1-mini', turns: [{ role: 'user', text: '  I just need a   boost ' }, { role: 'coach', text: 'Tell me more.' }, { role: 'user', text: '' }] });
    assert.match(seen.input[1].content, /Person: I just need a boost\nCoach: Tell me more\./);
    assert.equal(seen.text.format.strict, true);
    assert.equal(r.style, data.routes['NeedConfidence|ReadyToAct|Clear'][0]);
    assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
    await assert.rejects(nav.infer({ client, model: 'm', turns: [{ role: 'coach', text: 'Hi' }] }), /no user turn/);
    const bad = { responses: { create: async () => ({ output_text: 'not json' }) } };
    await assert.rejects(nav.infer({ client: bad, model: 'm', turns: [{ role: 'user', text: 'hi' }] }), /not JSON/);
});

// --- HTTP ---
function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], { cwd: root, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function post(port, p, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const d = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), ...headers } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
        });
        req.on('error', reject); req.write(d); req.end();
    });
}

test('HTTP /api/navigator/infer: the read is logged on the visit and priced; at most a few per visit; a failed read says so', async () => {
    const answers = [
        JSON.stringify({ mood: 'Guidance', readiness: null, clarity: null, confidence: { mood: 0.7, readiness: 0, clarity: 0 } }),
        JSON.stringify({ mood: 'Guidance', readiness: 'ReadyToAct', clarity: 'Clear', confidence: { mood: 0.9, readiness: 0.8, clarity: 0.7 } }),
        'garbage',
    ];
    const dirs = { SESSION_DATA_DIR: path.join(tmp, 'http-sessions'), SESSION_PROMPTS_DIR: path.join(tmp, 'http-prompts'), SESSION_SECRET: 'x', OPENAI_API_KEY: 'sk-test-no-network', FAKE_OPENAI_RESPONSES: JSON.stringify(answers) };
    const port = 25000 + Math.floor(Math.random() * 900);
    const { child } = await startServer(port, dirs);
    try {
        const sid = 's-vNavTest0001';
        const turns = [{ role: 'user', text: 'I need to figure out my next step at work.' }];
        const a = await post(port, '/api/navigator/infer', { sessionId: sid, turnIndex: 2, turns, userId: 'member-N' });
        assert.equal(a.status, 200);
        assert.equal(a.json.ready, false);
        assert.equal(a.json.ask.id, 'readiness');
        const b = await post(port, '/api/navigator/infer', { sessionId: sid, turnIndex: 3, turns });
        assert.equal(b.json.ready, true);
        assert.equal(b.json.style, data.routes['Guidance|ReadyToAct|Clear'][0]);
        const c = await post(port, '/api/navigator/infer', { sessionId: sid, turnIndex: 4, turns });
        assert.equal(c.status, 502, 'a non-JSON read fails loudly');
        await post(port, '/api/navigator/infer', { sessionId: sid, turnIndex: 5, turns });
        assert.equal((await post(port, '/api/navigator/infer', { sessionId: sid, turnIndex: 6, turns })).status, 429, `at most ${nav.CALLS_PER_VISIT_MAX} per visit`);
        assert.equal((await post(port, '/api/navigator/infer', { turns })).status, 400);
        const lines = fs.readFileSync(path.join(dirs.SESSION_DATA_DIR, sid + '.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const inferred = lines.filter((l) => l.name === 'style_inferred').map((l) => l.meta);
        assert.deepEqual(inferred.map((m) => [m.turnIndex, m.ready, m.style]), [[2, false, a.json.style], [3, true, b.json.style]]);
        assert.equal(inferred[0].ask, 'readiness');
        assert.equal(lines.filter((l) => l.name === 'style_inference_failed').length, 2);
        const usage = lines.filter((l) => l.type === 'usage');
        assert.equal(usage.length, 2);
        const usageCost = require('../lib/usageCost');
        const cost = usageCost.summarizeSession(usage);
        assert.ok(cost.parts.navigator > 0, 'priced as its own part');
        assert.equal(cost.unpriced.length, 0);
    } finally {
        child.kill();
    }
});

// --- Client ---
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function method(sig) {
    const start = src.indexOf(`    ${sig} {`) >= 0 ? src.indexOf(`    ${sig} {`) : src.indexOf(`    async ${sig} {`);
    assert.ok(start >= 0, 'method not found: ' + sig);
    const open = src.indexOf(') {', start) + 2; // after the parameter list (it may hold braces)
    let depth = 0; let i = open;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
    const params = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const body = src.slice(open + 1, i);
    const isAsync = src.slice(start, start + 12).includes('async');
    // eslint-disable-next-line no-new-func
    return isAsync ? new Function(params, `return (async () => {${body}})();`) : new Function(params, body);
}

function fakeApp(answers) {
    const events = []; const refreshes = []; const sent = []; const calls = [];
    const strengths = JSON.parse(fs.readFileSync(path.join(root, 'voiceProfiles.json'), 'utf8')).find((p) => p.companionId === 'Strengths').configuration;
    global.window = { coachUiRules: { splitForLiveAppend: (t) => [t] } };
    global.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); const a = answers.shift(); return { ok: true, json: async () => a }; };
    const app = {
        _NAV_FIRST_TURN: 2, _NAV_MAX_CALLS: 3, sessionId: 's-vClient', voiceApiMode: 'live', isConnected: true,
        dataChannel: { readyState: 'open' }, selectedCompanionId: 'Supportive',
        currentVoiceProfile: { character: 'Erica', companionId: 'Supportive', openaiVoice: 'marin', label: 'Calm, Reassuring Coach', coachingStyle: { primaryObjective: 'Emotional safety before action' } },
        voiceProfilesById: { Strengths: { ...strengths, companionId: 'Strengths' } },
        apiUrl: (p) => p, getUserIdFromURL: () => 'member-C',
        _refreshSessionInstructions: (reason) => { refreshes.push(reason); return true; },
        _logSessionEvent: (name, meta) => events.push([name, meta]),
        sendMessage: (m) => { sent.push(m); return true; },
    };
    app._navNoteTurn = method('_navNoteTurn(role, text, turnIndexHint)').bind(app);
    app._navInfer = method('_navInfer(st)').bind(app);
    app._applyInferredStyle = method('_applyInferredStyle(styleId, { turnIndex = null, ready = false } = {})').bind(app);
    app.getEffectiveVoiceProfile = method('getEffectiveVoiceProfile()').bind(app);
    return { app, events, refreshes, sent, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('client: first read after the 2nd message; unclear → one natural question, dropped after the reply; clear → the style applies once (backend + Live voice layer), face and name stay', async () => {
    const { app, events, refreshes, sent, calls } = fakeApp([
        { ready: false, style: 'Directive', ask: { id: 'readiness', title: 'Where are you at with this right now?', options: ["I'm ready to take action", 'I think it through'] } },
        { ready: true, style: 'Strengths', tags: {}, confidence: {} },
    ]);
    app._navNoteTurn('user', 'Hi'); await tick();
    assert.equal(calls.length, 0, 'not after the first message');
    app._navNoteTurn('bot', 'Hello!');
    app._navNoteTurn('user', 'I want to feel better about my work'); await tick(); await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].turns.map((t) => t.role), ['user', 'coach', 'user']);
    assert.equal(calls[0].userId, 'member-C');
    assert.match(app._navigatorAsk, /ask ONE short, warm question that tells you "Where are you at with this right now\?"/);
    assert.match(app._navigatorAsk, /Never mention a questionnaire/);
    assert.equal(app.styleOverride, undefined, 'not clear yet: no style change');
    app._navNoteTurn('bot', 'Where do you feel you are with it?');
    assert.equal(app._navigatorAsk, null, 'the question was asked once');
    assert.deepEqual(refreshes, ['navigator question', 'navigator question asked']);
    app._navNoteTurn('user', "I'm ready to act, I just need a push"); await tick(); await tick();
    assert.equal(app.styleOverride.styleId, 'Strengths');
    const eff = app.getEffectiveVoiceProfile();
    assert.deepEqual([eff.character, eff.openaiVoice, eff.companionId], ['Erica', 'marin', 'Supportive'], 'who the coach is stays');
    assert.equal(eff.label, 'Build on your strengths');
    assert.match(eff.coachingStyle.primaryObjective, /strengths/i);
    assert.ok(refreshes.includes('navigator style'));
    const append = sent.find((m) => m.type === 'session.instructions.append');
    assert.equal(append.delegation_id, null);
    assert.match(append.content, /Coaching approach for this person from now on: Progress through strengths/);
    assert.deepEqual(events.at(-1), ['style_applied', { from: 'Supportive', to: 'Strengths', reason: 'navigator', turnIndex: 3, ready: true, changed: true, voiceLayer: true }]);
    app._navNoteTurn('user', 'more'); await tick();
    assert.equal(calls.length, 2, 'done: no more reads');
});

test('client: the last try applies what it has; a coach picked by the person stops the Navigator', async () => {
    const one = fakeApp([{ ready: false, style: 'Strengths', ask: null }, { ready: false, style: 'Strengths', ask: null }, { ready: false, style: 'Strengths', ask: null }]);
    for (let i = 0; i < 5; i++) { one.app._navNoteTurn('user', 'm' + i); await tick(); await tick(); one.app._navNoteTurn('bot', 'r' + i); }
    assert.equal(one.calls.length, 3);
    assert.equal(one.app.styleOverride.styleId, 'Strengths', 'applied on the 3rd and last read');
    const two = fakeApp([{ ready: true, style: 'Strengths' }]);
    two.app._navState = { turns: [], userTurns: 0, calls: 0, locked: true };
    two.app._navNoteTurn('user', 'a'); two.app._navNoteTurn('user', 'b'); await tick();
    assert.equal(two.calls.length, 0);
    const ui = fs.readFileSync(path.join(root, 'uiLayout.js'), 'utf8');
    assert.match(ui, /app\.styleOverride = null;\s*app\._navigatorAsk = null;\s*app\._navState = Object\.assign\(app\._navState \|\| \{ turns: \[\], userTurns: 0, calls: 0 \}, \{ locked: true \}\);/);
    assert.match(src, /if \(this\.styleOverride\) \{\s*instructions \+= '\\n\\nYour coaching approach was chosen for this person from how they described their situation\. Never mention coaching styles, questionnaires, or that you adjusted your approach\.';/);
    assert.match(src, /if \(this\._navigatorAsk\) instructions \+= '\\n\\n' \+ this\._navigatorAsk;/);
    assert.match(src, /try \{ this\._navNoteTurn\(isUser \? 'user' : 'bot', text\); \}/, 'fed from the posted turns');
    assert.match(src, /try \{ if \(data\.context\.url\) this\._noteVisitPage\(data\.context\.url\); \}/, 'page path from the bridge');
});
