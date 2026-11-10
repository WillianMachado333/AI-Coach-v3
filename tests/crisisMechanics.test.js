// Crisis mechanics (production QA, 10 Nov 2026):
// - SAF-05: mid-crisis, the navigator switched a person with a suicide plan to
//   a style whose rules forbid urgency and directive language, and injected a
//   profiling question into crisis turns.
// - SAF-07: no crisis conversation left any trace the Studio could count.
// - The persona line "Your behavioral guardrails take PRIORITY over the
//   general guidelines above" ranked persona rules above the mental-health
//   guidance.
// A deterministic crisis signal now freezes the style and the question for the
// rest of the conversation and logs crisis_signal once per category.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { crisisSignal } = require('../lib/coachUiRules');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('crisisSignal: the QA probes and their PT/ES equivalents are caught, by category', () => {
    const cases = [
        ['I keep thinking about not being here anymore', 'suicide'],
        ['I have a plan, I am going to take all my pills tonight', 'suicide'],
        ['sometimes I want to die', 'suicide'],
        ['I feel suicidal', 'suicide'],
        ['I cut myself last night, I don\'t want to talk about it', 'self_harm'],
        ['I have been self-harming again', 'self_harm'],
        ['I could overdose and nobody would care', 'self_harm'],
        ['I want to kill my boss', 'harm_others'],
        ['he hits me when he is drunk', 'abuse'],
        ['às vezes eu quero morrer', 'suicide'],
        ['não quero mais viver', 'suicide'],
        ['pensei em me cortar de novo', 'self_harm'],
        ['quiero morir', 'suicide'],
        ['no quiero seguir viviendo', null], // "viviendo" is not "vivir": stays a known gap
        ['a veces pienso en cortarme', 'self_harm'],
    ];
    for (const [text, want] of cases) assert.equal(crisisSignal(text), want, text);
});

test('crisisSignal: everyday figures of speech do not trip it', () => {
    for (const text of [
        'I am killing it at work lately',
        'this deadline is killing me',
        'I would die for a coffee right now',
        'we need to cut costs this quarter',
        'my presentation died in the meeting',
        'I want to hurt less when I get feedback',
        '', null, undefined,
    ]) assert.equal(crisisSignal(text), null, String(text));
});

// The navigator client, extracted from app.js (same approach as navigatorInfer.test.js).
function method(sig) {
    const start = src.indexOf(`    ${sig} {`) >= 0 ? src.indexOf(`    ${sig} {`) : src.indexOf(`    async ${sig} {`);
    assert.ok(start >= 0, 'method not found: ' + sig);
    const open = src.indexOf(') {', start) + 2;
    let depth = 0; let i = open;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
    const params = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const body = src.slice(open + 1, i);
    const isAsync = src.slice(start, start + 12).includes('async');
    // eslint-disable-next-line no-new-func
    return isAsync ? new Function(params, `return (async () => {${body}})();`) : new Function(params, body);
}

function fakeApp(answers, { withRule = true } = {}) {
    const events = []; const refreshes = []; const applied = []; const calls = [];
    global.window = { coachUiRules: withRule ? { crisisSignal, splitForLiveAppend: (t) => [t] } : { splitForLiveAppend: (t) => [t] } };
    global.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); const a = answers.shift(); return { ok: true, json: async () => a }; };
    const app = {
        _NAV_FIRST_TURN: 2, _NAV_MAX_CALLS: 3, sessionId: 's-vCrisis', isRecording: false,
        apiUrl: (p) => p, getUserIdFromURL: () => null,
        _refreshSessionInstructions: (reason) => { refreshes.push(reason); return true; },
        _logSessionEvent: (name, meta) => events.push([name, meta]),
        _applyInferredStyle: (style, meta) => applied.push([style, meta]),
    };
    app._navNoteTurn = method('_navNoteTurn(role, text, turnIndexHint)').bind(app);
    app._navInfer = method('_navInfer(st)').bind(app);
    app._noteCrisis = method('_noteCrisis(text, turnIndex)').bind(app);
    return { app, events, refreshes, applied, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a crisis turn: no style inference, no style switch, for the rest of the conversation; one crisis_signal per category', async () => {
    const { app, events, applied, calls } = fakeApp([{ ready: true, style: 'Empowering' }, { ready: true, style: 'Empowering' }]);
    app._navNoteTurn('user', 'Hi, I need some help'); await tick();
    app._navNoteTurn('bot', 'Of course, tell me more.');
    app._navNoteTurn('user', 'I have a plan, I am going to take all my pills tonight'); await tick(); await tick();
    assert.equal(calls.length, 0, 'the navigator is not even asked');
    assert.equal(applied.length, 0, 'the style stays');
    app._navNoteTurn('bot', 'I am really glad you told me…');
    app._navNoteTurn('user', 'leave it, I am fine, let us talk about my career'); await tick(); await tick();
    app._navNoteTurn('user', 'which job fits me?'); await tick(); await tick();
    assert.equal(calls.length, 0, 'still frozen after the person changes the subject');
    assert.equal(applied.length, 0);
    app._navNoteTurn('user', 'I also cut myself sometimes'); await tick();
    app._navNoteTurn('user', 'I really want to die'); await tick();
    const crisis = events.filter(([n]) => n === 'crisis_signal').map(([, m]) => m);
    assert.deepEqual(crisis.map((m) => [m.category, m.first]), [['suicide', true], ['self_harm', false]], 'once per category');
    assert.equal(crisis[0].turnIndex, 2);
});

test('an answer already in flight when the crisis arrives is ignored', async () => {
    let release;
    const { app, applied } = fakeApp([]);
    global.fetch = () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ ready: true, style: 'Empowering' }) }); });
    app._navNoteTurn('user', 'Hi'); app._navNoteTurn('bot', 'Hello');
    app._navNoteTurn('user', 'I feel stuck at work'); await tick(); // inference in flight
    app._navNoteTurn('user', 'honestly I do not want to be alive'); // the crisis
    release(); await tick(); await tick();
    assert.equal(applied.length, 0, 'the late answer does not switch the style');
});

test('the onboarding question already queued is dropped when the crisis arrives', async () => {
    const { app, refreshes } = fakeApp([{ ready: false, style: 'Directive', ask: { id: 'clarity', title: 'How clear are you about what is going on?', options: ['Clear', 'Unclear'] } }]);
    app._navNoteTurn('user', 'hi'); app._navNoteTurn('bot', 'hello');
    app._navNoteTurn('user', 'things are hard'); await tick(); await tick();
    assert.ok(app._navigatorAsk, 'the question was queued');
    app._navNoteTurn('user', 'I keep thinking about not being here anymore'); await tick();
    assert.equal(app._navigatorAsk, null, 'dropped');
    assert.ok(refreshes.includes('crisis: navigator question dropped'));
});

test('a missing rule module is loud, never silent', async () => {
    const errors = []; const orig = console.error; console.error = (m) => errors.push(String(m));
    try {
        const { app } = fakeApp([], { withRule: false });
        app._navNoteTurn('user', 'I want to die'); app._navNoteTurn('user', 'still');
        assert.equal(errors.filter((e) => /crisisSignal missing/.test(e)).length, 1, 'once');
    } finally { console.error = orig; }
});

test('the persona line no longer ranks above the mental health and safety guidance', () => {
    assert.match(src, /Your behavioral guardrails take PRIORITY over the general guidelines above, except the mental health and safety guidance, which always comes first\./);
    assert.doesNotMatch(src, /take PRIORITY over the general guidelines above\. `/);
});
