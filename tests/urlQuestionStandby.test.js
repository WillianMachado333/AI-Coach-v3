// TT-2239 (Diksha, 18 Nov 2026): a message sent to the AI Coach from a quiz, a
// report page or Well-being opens the coach tab with ?question=... in the URL.
// The question was read only by connect(); a GPT-Live page in standby (no
// session on load) never calls it before the first typed message, so the
// question was dropped: nothing sent, nothing answered.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, wire } = require('./helpers/appHarness');

function harness(search) {
    const h = createHarness({ search });
    delete h.app.getUrlQuestion; // the harness stubs it to null; this reads the real URL
    h.app._liveStandby = true;
    h.app._voiceStepChecked = true;
    h.app._silentCallArm = () => {};
    h.app.openingLineSent = false;
    return h;
}
const bots = (h) => h.app.messages.filter((m) => m.role === 'bot');
const users = (h) => h.app.messages.filter((m) => m.role === 'user');

test('a coach opened with ?question=: in standby the question is sent, once, and answered', async () => {
    const h = harness('?caller=app&question=What%20should%20I%20focus%20on%20this%20week%3F');
    await h.app.autoConnect();
    await h.advance(4000);
    assert.equal(h.live.creates.length, 1, 'the chat session opens for it');
    assert.deepEqual(wire(h.live.sent(0)).filter((x) => x.startsWith('item:user:')), ['item:user:What should I focus on this week?']);
    assert.deepEqual(users(h).map((m) => m.text), ['What should I focus on this week?'], 'it shows in the chat as sent');
    h.live.reply('Start with one thing.');
    await h.advance(500);
    assert.deepEqual(bots(h).map((m) => m.text), ['Start with one thing.']);
    assert.equal(h.indicator().visible, false);
    assert.equal(h.app.openingLineSent, true, 'no opening line over the question');
    // Reloading the same URL state in the same page does not send it again.
    await h.app.autoConnect();
    await h.advance(4000);
    assert.equal(h.live.creates.length, 1);
    assert.equal(users(h).length, 1);
});

test('?q= works the same, and a long question is cut at 500 characters as before', async () => {
    const h = harness('?q=' + encodeURIComponent('x'.repeat(700)));
    await h.app.autoConnect();
    await h.advance(4000);
    assert.equal(users(h).length, 1);
    assert.equal(users(h)[0].text.length, 500);
});

test('autosubmit=n: the question waits in the composer, nothing is sent and no session opens', async () => {
    const h = harness('?question=Hello%20coach&autosubmit=n');
    await h.app.autoConnect();
    await h.advance(4000);
    assert.equal(h.app.textInput.value, 'Hello coach');
    assert.equal(h.live.creates.length, 0, 'no session on load, as in standby');
    assert.equal(users(h).length, 0);
});

test('no question in the URL: standby as before, nothing is sent, the opening line is left alone', async () => {
    const h = harness('?caller=app');
    await h.app.autoConnect();
    await h.advance(4000);
    assert.equal(h.live.creates.length, 0);
    assert.equal(users(h).length, 0);
    assert.equal(h.app.openingLineSent, false);
});

test('the question waits for the preparation, then goes (the coach and style are known first)', async () => {
    const h = harness('?question=Hi');
    let release; let calls = 0;
    // The page-load prefetch is the slow one; the session's own connect finds it done.
    h.app.fetchEricaPreparation = () => (++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve());
    await h.app.autoConnect();
    await h.advance(3000);
    assert.equal(h.live.creates.length, 0, 'not before the preparation is in');
    release();
    await h.advance(4000);
    assert.equal(h.live.creates.length, 1);
    assert.deepEqual(users(h).map((m) => m.text), ['Hi']);
});

test('a failed preparation does not lose the question', async () => {
    const h = harness('?question=Hi');
    h.app.fetchEricaPreparation = () => Promise.reject(new Error('down'));
    const warn = console.warn; console.warn = () => {};
    try {
        await h.app.autoConnect();
        await h.advance(4000);
    } finally {
        console.warn = warn;
    }
    assert.deepEqual(users(h).map((m) => m.text), ['Hi']);
});
