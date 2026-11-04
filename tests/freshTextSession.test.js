// A text-mode GPT-Live session lives ~29 s: it expires without inbound audio.
// A turn with tools takes up to ~25 s (staging, 3 Nov 2026: two knowledge
// searches 8.5 s, deep_think 5.6 s, the answer 2.6 s), so a message must not
// go into a session already part-way through its life. Measured: a send into
// a ~30 s old session expired at once and its one recovery ran out too.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, wire } = require('./helpers/appHarness');

function harness() {
    const h = createHarness();
    h.app._liveStandby = true;
    h.app._voiceStepChecked = true;
    h.app._silentCallArm = () => {};
    return h;
}

test('a chat message sent into a session that is no longer fresh gets a new session; the old one is closed first', async () => {
    const h = harness();
    h.app.sendTextMessage('first');
    await h.advance(3000);
    h.live.reply('Answer one');
    await h.advance(8000);
    h.app.sendTextMessage('second');
    await h.advance(3000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'user'], 'a fresh session for the second message');
    assert.equal(h.live.pcs[0].closed, true, 'the old session is closed');
    assert.deepEqual(h.live.pcs.map((p) => wire(p.dc.sent).filter((x) => x === 'item:user:second').length), [0, 1], 'sent once, on the new session');
    assert.equal(h.events('turn_stalled').length, 0, 'not counted as a stall');
});

test('a quick follow-up inside a fresh session stays on it', async () => {
    const h = harness();
    h.app.sendTextMessage('first');
    await h.advance(2000);
    h.live.reply('Answer one');
    await h.advance(1000);
    h.app.sendTextMessage('second');
    await h.advance(2000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user']);
});

test('a message sent while the previous reply is still open stays on its session (the turn watch owns it)', async () => {
    const h = harness();
    h.app.sendTextMessage('first');
    await h.advance(9000);
    h.app.sendTextMessage('second');
    await h.advance(1000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user']);
});

test('in a call nothing changes: the call keeps its session', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(12000);
    h.app.sendTextMessage('typed in a call');
    await h.advance(2000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user']);
});
