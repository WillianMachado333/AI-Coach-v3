// TT-2239 (Diksha, 24 Nov 2026), in the mobile app: a question sent from the
// Quizzes, Report or Well-being screen opened the AI Coach tab, and nothing was
// sent. The app sends that text by script only after the coach says
// 'ericaConnected' on the native bridge, and coach V3 (GPT-Live) said it only
// when a session opened, which in standby only a message does. Standby takes a
// message, so it now reports ready; window.ericaSendText is the inbound call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHarness, wire } = require('./helpers/appHarness');

function harness({ search = '?caller=app' } = {}) {
    const bridge = [];
    const h = createHarness({
        search,
        setup: (app, ctx) => { ctx.messageToApp = (payload) => bridge.push(payload); },
    });
    h.app._liveStandby = true;
    h.app._voiceStepChecked = true;
    h.app._silentCallArm = () => {};
    h.app.openingLineSent = false;
    h.ctx._erica = h.app;
    return { h, bridge, actions: () => bridge.filter((p) => p && p.action).map((p) => p.action) };
}
const users = (h) => h.app.messages.filter((m) => m.role === 'user');
const bots = (h) => h.app.messages.filter((m) => m.role === 'bot');

// The app's side, as Tech Exactly built it: hold the text, send it when the
// coach says it is connected.
function appGate(env, text) {
    let pending = text;
    const seen = env.bridge.length;
    return () => {
        if (!pending) return;
        if (env.bridge.slice(seen).some((p) => p && p.action === 'ericaConnected')) {
            const t = pending; pending = null;
            env.h.app.sendTextMessage(t);
        }
    };
}

test('standby says ericaConnected once, without opening a session', async () => {
    const env = harness();
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    assert.deepEqual(env.actions(), ['ericaConnected']);
    const ready = env.bridge.find((p) => p.action === 'ericaConnected');
    assert.equal(ready.standby, true);
    assert.equal(env.h.live.creates.length, 0, 'still no session on load');
});

test('the app waits for ericaConnected, then sends: the question goes once and is answered', async () => {
    const env = harness();
    const gate = appGate(env, 'Which quiz should I take next?');
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    gate();
    await env.h.advance(4000);
    assert.deepEqual(users(env.h).map((m) => m.text), ['Which quiz should I take next?']);
    assert.equal(env.h.live.creates.length, 1);
    env.h.live.reply('Try Career Interests.');
    await env.h.advance(500);
    assert.deepEqual(bots(env.h).map((m) => m.text), ['Try Career Interests.']);
    // The real session's connect does not repeat ericaConnected.
    assert.deepEqual(env.actions(), ['ericaConnected']);
});

test('a slow preparation still reports ready after 3 s', async () => {
    const env = harness();
    env.h.app.fetchEricaPreparation = () => new Promise(() => {}); // never answers
    await env.h.app.autoConnect();
    await env.h.advance(2500);
    assert.deepEqual(env.actions(), []);
    await env.h.advance(1500);
    assert.deepEqual(env.actions(), ['ericaConnected']);
});

test('the same text sent twice within 5 s goes once; again after 5 s it goes', async () => {
    const env = harness();
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    env.h.app.sendTextMessage('Hello coach');
    env.h.app.sendTextMessage('Hello coach');
    await env.h.advance(4000);
    assert.deepEqual(users(env.h).map((m) => m.text), ['Hello coach']);
    env.h.live.reply('Hi!');
    await env.h.advance(6000);
    env.h.app.sendTextMessage('Hello coach');
    await env.h.advance(4000);
    assert.equal(users(env.h).length, 2, 'a real repeat later is a new message');
});

test('typed messages are never dropped as repeats', async () => {
    const env = harness();
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    env.h.app.textInput.value = 'ok';
    env.h.app.sendTextMessage();
    await env.h.advance(3000);
    env.h.live.reply('Sure.');
    await env.h.advance(500);
    env.h.app.textInput.value = 'ok';
    env.h.app.sendTextMessage();
    await env.h.advance(3000);
    assert.deepEqual(users(env.h).map((m) => m.text), ['ok', 'ok']);
});

test('after a conversation the coach goes back to standby and stays ready: no disconnected event', async () => {
    const env = harness();
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    env.h.app.sendTextMessage('First question');
    await env.h.advance(3000);
    env.h.live.reply('First answer.');
    await env.h.advance(500);
    env.h.live.closeSession('expired');
    await env.h.advance(2000);
    assert.equal(env.h.app._liveStandby, true);
    assert.deepEqual(env.actions(), ['ericaConnected']);
});

test('not ready for more than 1.5 s says ericaDisconnected; standby afterwards says ericaConnected again', async () => {
    const env = harness();
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    env.h.app.updateStatus(false);
    assert.deepEqual(env.actions(), ['ericaConnected'], 'not at once');
    await env.h.advance(2000);
    assert.deepEqual(env.actions(), ['ericaConnected', 'ericaDisconnected']);
    env.h.app._enterStandby();
    assert.deepEqual(env.actions(), ['ericaConnected', 'ericaDisconnected', 'ericaConnected']);
});

test('a disconnect straight back to standby (a cost cut) tells the app nothing: no question posted twice', async () => {
    const env = harness();
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    env.h.app.updateStatus(false); // disconnect()
    env.h.app._enterStandby();     // then standby, as _cutLive does
    await env.h.advance(3000);
    assert.deepEqual(env.actions(), ['ericaConnected']);
    assert.equal(env.h.app._bridgeReady, true);
});

test('a text the app sends while a session is still opening waits for it: one session, one bubble', async () => {
    const env = harness();
    vm.runInContext(bridgeScript(), env.h.ctx);
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    const opening = env.h.app.connect({ skipOpeningLine: true });
    env.h.ctx.ericaSendText('Sent while opening');
    await env.h.advance(6000);
    await opening;
    await env.h.advance(2000);
    assert.equal(env.h.live.creates.length, 1, 'no second session');
    assert.deepEqual(users(env.h).map((m) => m.text), ['Sent while opening']);
});

test('a quiet reconnect that fails goes back to standby, and the app can send again', async () => {
    const env = harness();
    vm.runInContext(bridgeScript(), env.h.ctx);
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    env.h.app.sendTextMessage('First');
    await env.h.advance(3000);
    env.h.live.reply('Hello.');
    await env.h.advance(500);
    const ok = env.h.live.policy;
    env.h.live.policy = () => ({ status: 500, body: { error: 'down' } });
    const reconnect = env.h.app._quietReconnect({ skipOpeningLine: true });
    await env.h.advance(20000);
    await reconnect;
    await env.h.advance(2000);
    env.h.live.policy = ok;
    assert.equal(env.h.app._liveStandby, true, 'standby again');
    assert.equal(env.h.app._bridgeReady, true);
    env.h.ctx.ericaSendText('After the failure');
    await env.h.advance(6000);
    assert.deepEqual(users(env.h).map((m) => m.text), ['First', 'After the failure']);
});

test("the app's startRecording() from standby opens the session as a call", async () => {
    const env = harness();
    let forCall = null;
    env.h.app.connect = async () => { forCall = env.h.app._connectForCall; env.h.app.isConnected = true; };
    env.h.app._refuseVoiceStart = () => false;
    const real = Object.getPrototypeOf(env.h.app).startRecording;
    const started = real.call(env.h.app).catch(() => {}); // no microphone in the harness
    await env.h.advance(2000);
    await started;
    assert.equal(forCall, true);
    assert.ok(!env.h.app._connectForCall, 'reset afterwards');
});

test('analytics still count real sessions only', async () => {
    const env = harness();
    const tracked = [];
    env.h.app.trackCoachEvent = (name) => tracked.push(name);
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    assert.deepEqual(tracked.filter((n) => /AI Coach (Dis)?[Cc]onnected/.test(n)), [], 'standby is not a session');
    env.h.app.sendTextMessage('Hi');
    await env.h.advance(4000);
    assert.deepEqual(tracked.filter((n) => n === 'AI Coach Connected'), ['AI Coach Connected']);
});

// window.ericaSendText lives in index.html, next to messageToApp.
function bridgeScript() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const start = html.indexOf('window.ericaSendText = function');
    assert.ok(start > 0, 'index.html defines window.ericaSendText');
    const end = html.indexOf('};', start) + 2;
    return html.slice(start, end);
}

test('ericaSendText before the coach is ready: the text waits, then goes on ericaConnected, once', async () => {
    const env = harness();
    vm.runInContext(bridgeScript(), env.h.ctx);
    assert.equal(env.h.ctx.ericaSendText('What should I focus on?'), true);
    assert.equal(env.h.ctx.ericaSendText('   '), false, 'an empty text is refused');
    assert.equal(users(env.h).length, 0, 'not before the coach is ready');
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    await env.h.advance(4000);
    assert.deepEqual(users(env.h).map((m) => m.text), ['What should I focus on?']);
    assert.equal(env.h.live.creates.length, 1);
    assert.equal(env.h.ctx.__ericaPendingTexts.length, 0, 'nothing left waiting');
});

test('ericaSendText once the coach is ready: sent straight away', async () => {
    const env = harness();
    vm.runInContext(bridgeScript(), env.h.ctx);
    await env.h.app.autoConnect();
    await env.h.advance(4000);
    env.h.ctx.ericaSendText('Hello');
    await env.h.advance(4000);
    assert.deepEqual(users(env.h).map((m) => m.text), ['Hello']);
    assert.ok(wire(env.h.live.sent(0)).includes('item:user:Hello'));
});

test('index.html loads the new app.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    assert.match(html, /<script src="app\.js\?v=20261125a"><\/script>/);
});
