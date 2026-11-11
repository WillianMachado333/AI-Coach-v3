// REG-16 (QA retest, 10 Nov 2026; live in production). A GPT-Live session gets
// its instructions, tools and history from the session.update that
// configureLiveSession() sends on session.started. WebRTC reports
// "connected" earlier, and the data channel is open by then: the queued
// message (connect().then → _sendPendingTextMessage, 500 ms) went out before
// session.started, and the answer came from a model with none of the
// composed prompt. Measured: first-answer input 985 to 1,520 tokens instead of
// 8,800 to 9,700; invented links (a 404, a competitor's site), courses not
// cited, the page not read. That hit 35 of 128 turns on staging between 00:00
// and 01:00 UTC, when session.started took up to 3.8 s.
// Now no user turn reaches a Live session before its session.update.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, wire } = require('./helpers/appHarness');

function harness() {
    const h = createHarness();
    h.app._liveStandby = true;
    h.app._voiceStepChecked = true;
    h.app._silentCallArm = () => {};
    h.live.autoStart = false; // session.started comes when the test says so
    return h;
}
const started = (h) => h.live.deliver({ type: 'session.started', session: { id: 'ls_late', model: 'gpt-live-1' } });
const firstIndex = (w, pred) => w.findIndex(pred);

for (const delayMs of [2000, 4000]) {
    test(`a message queued at the tap waits for session.started (${delayMs / 1000} s late) and goes out only after the session.update`, async () => {
        const h = harness();
        h.app.sendTextMessage('which of the four areas is my weakest?');
        await h.advance(delayMs);
        assert.equal(h.live.current().connectionState, 'connected', 'WebRTC is connected and the channel open');
        assert.equal(h.live.current().dc.readyState, 'open');
        assert.deepEqual(wire(h.live.sent()).filter((x) => x !== 'other:session.ping'), [], `nothing sent before session.started: ${JSON.stringify(wire(h.live.sent()))}`);
        started(h);
        await h.advance(2000);
        const w = wire(h.live.sent());
        const update = firstIndex(w, (x) => x === 'update');
        const item = firstIndex(w, (x) => x === 'item:user:which of the four areas is my weakest?');
        const create = firstIndex(w, (x) => x === 'create');
        assert.ok(update >= 0, `a session.update went out: ${JSON.stringify(w)}`);
        assert.ok(item > update, `the message comes after the session.update: ${JSON.stringify(w)}`);
        assert.ok(create > update, `the response.create comes after the session.update: ${JSON.stringify(w)}`);
        assert.equal(w.filter((x) => x === 'item:user:which of the four areas is my weakest?').length, 1, 'sent once');
    });
}

test('a message typed between "connected" and session.started waits too (it used to go straight out)', async () => {
    const h = harness();
    h.app.sendTextMessage('first');
    await h.advance(1000); // connected, channel open, no session.started yet
    h.app.sendTextMessage('typed in the gap');
    await h.advance(1000);
    assert.equal(wire(h.live.sent()).filter((x) => x.startsWith('item:') || x === 'create').length, 0, `nothing before session.started: ${JSON.stringify(wire(h.live.sent()))}`);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user'], 'no second session opened for it');
    started(h);
    await h.advance(3000);
    const w = wire(h.live.sent());
    const update = w.indexOf('update');
    for (const text of ['first', 'typed in the gap']) {
        const i = w.indexOf('item:user:' + text);
        assert.ok(i > update && update >= 0, `${text} after the session.update: ${JSON.stringify(w)}`);
    }
});

test('with session.started on time nothing changes: the message goes out right after the configuration', async () => {
    const h = harness();
    h.live.autoStart = true;
    h.app.sendTextMessage('hello');
    await h.advance(2000);
    const w = wire(h.live.sent());
    assert.ok(w.indexOf('update') >= 0 && w.indexOf('item:user:hello') > w.indexOf('update'), JSON.stringify(w));
    assert.equal(w.filter((x) => x === 'item:user:hello').length, 1);
});
