// Varsha's stall (2026-10-14) against the real app.js and a fake GPT-Live
// (tests/helpers/appHarness.js): a turn sent into a dying session is asked
// again once on a fresh one; a second failure is visible, with Try again; a
// content close never replays what was in the window and shows the static
// safety card once; an idle chat never reconnects on its own; a live cut wins
// over recovery; tool fetches and the session create time out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, wire } = require('./helpers/appHarness');
const tw = require('../lib/turnWatch');

const MIN = 60000;
const PRIOR = [['user', 'I have an interview'], ['assistant', 'Tell me more']];
const CRISIS = [['user', 'I have an interview'], ['assistant', 'Tell me more'], ['user', 'MARKER self-harm text'], ['assistant', 'I am here with you']];

function harness(opts) {
    const h = createHarness(opts);
    h.app._liveStandby = true;
    h.app._voiceStepChecked = true;
    h.app._silentCallArm = () => {};
    return h;
}

// What OpenAI did on 2026-10-14 and in the probe (V1): a session whose
// session.input holds the user's crisis text is closed for 'content' right
// after it starts, the error first.
function contentFilter(h, when = (create) => create.input.some((i) => i.role === 'user' && /MARKER/.test(i.content[0].text))) {
    h.live.onStarted = (create) => {
        if (!when(create)) return;
        h.live.contentFilterError();
        h.clock.setTimeout(() => h.live.closeSession('content'), 190);
    };
}

test('a send from standby: dots from the tap; the chat session gets no user text in session.input and the backend gets the conversation as items', async () => {
    const h = harness();
    h.history(PRIOR);
    h.app.sendTextMessage('hello');
    assert.equal(h.indicator() && h.indicator().visible, true, 'the reply slot shows the dots before any session exists');
    await h.advance(3000);
    assert.equal(h.live.creates.length, 1);
    const c = h.live.creates[0];
    assert.equal(c.kind, 'user');
    assert.deepEqual(c.input, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tell me more' }] }]);
    assert.deepEqual(wire(h.live.sent(0)), ['update', 'item:user:I have an interview', 'item:assistant:Tell me more', 'item:user:hello', 'create']);
    assert.equal(h.indicator().visible, true);
    h.live.reply('Hi there');
    await h.advance(200);
    assert.equal(h.indicator().visible, false, 'the answer replaced the dots');
    assert.equal(h.app.messages.filter((m) => m.role === 'bot').length, 2);
});

test('session.closed during an open turn: exactly one fresh session, every unanswered message re-sent once in order, one response.create', async () => {
    const h = harness();
    h.history(PRIOR);
    h.app.sendTextMessage('first');
    await h.advance(3000);
    h.app.sendTextMessage('second');
    await h.advance(200);
    assert.deepEqual(wire(h.live.sent(0)).slice(-4), ['item:user:first', 'create', 'item:user:second', 'create']);
    h.live.closeSession('expired');
    assert.equal(h.live.pcs[0].closed, true, 'session.closed closes the peer connection at once');
    assert.equal(h.app.isConnected, false);
    await h.advance(5000);
    assert.equal(h.live.creates.length, 2);
    const rec = h.live.creates[1];
    assert.equal(rec.kind, 'recover');
    assert.deepEqual(rec.input.map((i) => i.content[0].text), ['Tell me more']);
    assert.deepEqual(wire(h.live.sent(1)), ['update', 'item:user:I have an interview', 'item:assistant:Tell me more', 'item:user:first', 'item:user:second', 'create'],
        'the unanswered turns are not history: they go once, after it, with one response.create');
    assert.equal(h.indicator().visible, true);
    h.live.reply('Here is my answer');
    await h.advance(200);
    assert.equal(h.indicator().visible, false);
    assert.equal(h.app.messages.filter((m) => m.role === 'user' && m.text === 'first').length, 1, 'no second bubble for a re-send');
    const closed = h.events('live_closed');
    assert.equal(closed.length, 1);
    assert.deepEqual([closed[0].meta.reason, closed[0].meta.turnOpen, closed[0].meta.hadUsage], ['expired', true, true]);
    assert.equal(h.events('turn_stalled').length, 1);
    assert.equal(h.events('turn_recovered')[0].meta.step, 'fresh_session');
    await h.advance(5 * MIN);
    assert.equal(h.live.creates.length, 2, 'nothing more opens on its own');
});

test('a second failure is failed with Try again (and the safety card, once); no third session; Try again re-sends as the person asking', async () => {
    const h = harness();
    h.history(PRIOR);
    h.app.sendTextMessage('first');
    await h.advance(3000);
    h.live.closeSession('expired');
    await h.advance(3000);
    assert.equal(h.live.creates.length, 2);
    h.live.failPc('failed');
    await h.advance(1000);
    const note = h.failedNote();
    assert.ok(note && note.visible, 'a visible failed state');
    assert.match(note.textContent, /Erica couldn’t answer this\./);
    const retry = note.querySelector('button');
    assert.equal(retry.textContent, 'Try again');
    assert.equal(h.indicator().visible, false);
    assert.equal(h.live.pcs[1].closed, true, 'the connection is closed before Try again is offered');
    assert.equal(h.safetyCards().length, 1, 'failed on a hard signal: the card');
    assert.deepEqual(h.events('turn_failed').map((e) => e.meta.cause), ['pc_failed']);
    assert.deepEqual(h.events('safety_fallback_shown').map((e) => e.meta.trigger), ['turn_failed']);
    await h.advance(5 * MIN);
    assert.equal(h.live.creates.length, 2, 'never a third automatic session');
    retry.click();
    assert.equal(h.failedNote(), null);
    assert.equal(h.indicator().visible, true);
    await h.advance(3000);
    assert.equal(h.live.creates.length, 3);
    assert.equal(h.live.creates[2].kind, 'user', "a tap is the person's own reconnect");
    assert.deepEqual(wire(h.live.sent(2)).slice(-2), ['item:user:first', 'create']);
    h.live.reply('Sorry for the wait');
    await h.advance(200);
    assert.equal(h.events('turn_recovered')[0].meta.step, 'user_retry');
    assert.equal(h.safetyCards().length, 1, 'still once per conversation');
});

test('content close: the card once, every later session.input leaves out what was in the window, at most 2 connects per turn, and it survives a reload and a coach switch', async () => {
    const h = harness();
    h.history(CRISIS);
    contentFilter(h, () => true); // whatever the input: the backstop must hold on its own
    h.app.sendTextMessage('ok');
    await h.advance(3000);
    assert.equal(h.live.creates.length, 2, 'the content close, then one recovery');
    assert.equal(h.live.creates[1].kind, 'recover');
    assert.deepEqual(h.live.creates[1].input, [], 'nothing that was in the window at the close goes back into session.input');
    assert.equal(h.live.creates[1].headers['Content-Type'], 'application/sdp');
    await h.advance(5 * MIN);
    assert.equal(h.live.creates.length, 2, 'the second close fails the turn: no third session');
    assert.ok(h.failedNote(), 'failed, with Try again');
    assert.equal(h.safetyCards().length, 1, 'one card for the conversation');
    assert.deepEqual(h.events('safety_fallback_shown').map((e) => e.meta.trigger), ['content_close']);
    assert.deepEqual(h.events('live_closed').map((e) => e.meta.reason), ['content', 'content']);
    assert.deepEqual(h.events('live_error').map((e) => e.meta.code), ['content_filter', 'content_filter'], 'logged, never a teardown on its own');
    const saved = h.state();
    const keys = CRISIS.map(([role, text]) => tw.messageKey({ role, text }));
    for (const k of keys) assert.ok(saved.contentClosed.keys.includes(k), 'the block is in the saved state');
    assert.doesNotMatch(JSON.stringify(saved.contentClosed), /MARKER/, 'keys, not text');

    // Reload: the same conversation from the saved state, a call this time.
    const h2 = harness({ savedState: saved });
    assert.equal(h2.safetyCards().length, 1, 'the card is back where it was, once');
    h2.history([['user', 'new topic'], ['assistant', 'Sure, tell me']]);
    h2.app.toggleMicTrack();
    await h2.advance(3000);
    assert.equal(h2.live.creates.length, 1);
    assert.deepEqual(h2.live.creates[0].input.map((i) => i.content[0].text), ['new topic', 'Sure, tell me'], 'a call keeps user text, minus the blocked messages');
    assert.ok(wire(h2.live.sent(0)).includes('item:user:MARKER self-harm text'), 'the backend keeps the whole conversation');
    // A coach switch opens a new session the same way.
    const switched = h2.app.reconnectWithNewVoice({ skipOpeningLine: true });
    await h2.advance(3000);
    await switched;
    assert.equal(h2.live.creates.length, 2);
    assert.ok(!h2.live.creates[1].input.some((i) => /MARKER|I am here with you/.test(i.content[0].text)));
    assert.equal(h2.safetyCards().length, 1);
});

test('Varsha regression, prevented: with the crisis message in the window a chat send gets its answer — no content close, and the backend still has the context', async () => {
    const h = harness();
    h.history(CRISIS);
    contentFilter(h);
    h.app.sendTextMessage('i am glad you are here');
    await h.advance(3000);
    assert.equal(h.live.creates.length, 1);
    assert.equal(h.events('live_closed').length, 0);
    assert.ok(wire(h.live.sent(0)).includes('item:user:MARKER self-harm text'));
    h.live.reply('I am glad too');
    await h.advance(200);
    assert.equal(h.indicator().visible, false);
    assert.equal(h.safetyCards().length, 0, 'a healthy coach: no card');
    // The same history in a call would trip the filter (the fake does what
    // OpenAI did): one close, then never again for those messages.
    const c = harness();
    c.history(CRISIS);
    contentFilter(c);
    c.app.toggleMicTrack();
    await c.advance(3000);
    assert.equal(c.events('live_closed').length, 1);
    assert.equal(c.app.isRecording, false, 'a content close in a call ends it to text standby');
    assert.equal(c.app.callEndedNotice.classList.contains('hidden'), false, '"Call ended — tap to resume"');
    assert.equal(c.safetyCards().length, 1);
    await c.advance(5 * MIN);
    assert.equal(c.live.creates.length, 1, 'no automatic reconnect into the same history');
    c.app.toggleMicTrack();
    await c.advance(3000);
    assert.equal(c.live.creates.length, 2);
    assert.equal(c.events('live_closed').length, 1, 'the resumed call does not trip it again');
    assert.equal(c.app.isRecording, true);
});

test('chat with no open turn: an expired session or a dropped connection goes to standby — zero automatic connects; the next send reconnects as the person', async () => {
    for (const end of ['expired', 'pc_failed', 'dc_closed']) {
        const h = harness();
        h.app.sendTextMessage('hello');
        await h.advance(3000);
        h.live.reply('Hi');
        await h.advance(200);
        if (end === 'expired') h.live.closeSession('expired');
        else if (end === 'pc_failed') h.live.failPc('failed');
        else h.live.current().dc.close();
        await h.advance(5 * MIN);
        assert.equal(h.live.creates.length, 1, `${end}: no automatic connect`);
        assert.equal(h.app._liveStandby, true, `${end}: standby`);
        assert.equal(h.live.pcs[0].closed, true);
        assert.equal(h.indicator().visible, false);
        assert.equal(h.failedNote(), null);
        h.app.sendTextMessage('again');
        await h.advance(3000);
        assert.equal(h.live.creates.length, 2);
        assert.equal(h.live.creates[1].kind, 'user');
    }
});

test('a call that drops (not for content) reconnects on its own as before, keeping the mic', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.equal(h.app.isRecording, true);
    const mic = h.app.localStream;
    h.live.failPc('disconnected');
    await h.advance(3000);
    assert.equal(h.live.creates.length, 2);
    assert.equal(h.live.creates[1].kind, 'auto');
    assert.equal(h.app.localStream, mic, 'the mic survives the reconnect');
    // A stale event from the old connection changes nothing.
    h.live.failPc('failed', 0);
    await h.advance(3000);
    assert.equal(h.live.creates.length, 2);
});

test('a live cut wins over recovery; the recover kind never clears a cut', async () => {
    // The client's own cut with a turn open: failed at once, no session.
    const h = harness();
    h.app.sendTextMessage('q');
    await h.advance(3000);
    await h.app._cutLive('max', 'client');
    await h.advance(5 * MIN);
    assert.equal(h.live.creates.length, 1);
    assert.equal(h.events('turn_failed')[0].meta.cause, 'cut');
    assert.equal(h.safetyCards().length, 0, 'a cost cut is not the coach failing');
    assert.ok(h.failedNote());

    // The server refuses the recovery session (409 after a cut).
    const s = harness();
    s.live.policy = (create) => (create.kind === 'recover' ? { status: 409, body: { error: 'live_session_cut', cut: true, reason: 'max' } } : undefined);
    s.app.sendTextMessage('q');
    await s.advance(3000);
    s.live.closeSession('expired');
    await s.advance(5 * MIN);
    assert.deepEqual(s.live.creates.map((c) => c.kind), ['user', 'recover']);
    assert.deepEqual(s.events('turn_failed').map((e) => e.meta.cause), ['cut']);
    assert.ok(s.app._liveCut, 'the server cut stands');

    // A cut in place: 'recover' does not clear it, the person's 'user' does.
    const k = harness();
    k.app._liveCut = { reason: 'max', by: 'server', at: Date.now() };
    k.app._reconnectKind = 'recover';
    let open = k.app.establishConnection();
    await k.advance(1500);
    await open;
    assert.equal(k.live.creates[0].headers['X-Erica-Reconnect'], 'recover');
    assert.ok(k.app._liveCut, 'recover never clears a cut');
    k.app._teardownWebRTCOnly();
    open = k.app.establishConnection();
    await k.advance(1500);
    await open;
    assert.equal(k.live.creates[1].headers['X-Erica-Reconnect'], 'user');
    assert.equal(k.app._liveCut, null);
});

test('a tool fetch that hangs ends in an error function output (20 s; deep_think 30 s), so the model carries on', async () => {
    const h = harness();
    const out = [];
    h.app._sendFunctionResult = (id, result) => out.push([id, JSON.parse(result)]);
    h.hangs.add('/api/knowledge-search');
    h.hangs.add('/api/deep-think');
    h.app.executeFunction('search_knowledge', { query: 'values' }, 'call_k', null);
    h.app.executeFunction('deep_think', { query: 'why' }, 'call_d', null);
    await h.advance(19900);
    assert.equal(out.length, 0);
    await h.advance(200);
    assert.deepEqual(out.map(([id]) => id), ['call_k']);
    assert.match(out[0][1].error, /timed out after 20 s/);
    await h.advance(9700);
    assert.equal(out.length, 1, 'deep_think gets 30 s');
    await h.advance(200);
    assert.equal(out.length, 2);
    assert.equal(out[1][0], 'call_d');
    assert.match(out[1][1].error, /timed out after 30 s/);
});

test('the session create times out at 12 s: the queued turn fails visibly, with the card', async () => {
    const h = harness();
    h.live.policy = () => 'hang';
    h.app.sendTextMessage('q');
    await h.advance(11900);
    assert.equal(h.failedNote(), null);
    assert.equal(h.indicator().visible, true);
    await h.advance(300);
    assert.ok(h.failedNote(), 'failed, not a spinner');
    assert.equal(h.indicator().visible, false);
    assert.deepEqual(h.events('turn_failed').map((e) => e.meta.cause), ['connect_failed']);
    assert.equal(h.safetyCards().length, 1);
});

test('the indicator: no label at first, "Erica is thinking..." at 4 s, "Still working on it..." at 15 s, gone at 60 s with a failed state (no card) and the connection closed', async () => {
    const h = harness();
    h.app.sendTextMessage('q');
    await h.advance(600); // queued at 0, sent once the session is up (~0.6 s)
    const label = () => (h.indicator().querySelector('[data-turn-label]') || {}).textContent || '';
    assert.equal(h.indicator().visible, true);
    assert.equal(label(), '');
    await h.advance(3900);
    assert.equal(label(), '');
    await h.advance(200);
    assert.equal(label(), 'Erica is thinking...');
    assert.equal(h.indicator().querySelector('[data-turn-label]').getAttribute('aria-live'), 'polite');
    await h.advance(11000);
    assert.equal(label(), 'Still working on it...');
    await h.advance(44800);
    assert.equal(h.indicator().visible, true);
    await h.advance(200);
    assert.equal(h.indicator().visible, false, 'never past 60 s');
    assert.ok(h.failedNote());
    assert.equal(h.safetyCards().length, 0, 'the cap is not a hard signal');
    assert.equal(h.live.pcs[0].closed, true, 'closed before Try again is offered: no late duplicate');
    assert.deepEqual(h.events('turn_failed').map((e) => e.meta.cause), ['cap']);
    await h.advance(5 * MIN);
    assert.equal(h.live.creates.length, 1);
    // A tool names what is happening while it runs.
    const t = harness();
    t.app.sendTextMessage('q');
    await t.advance(1000);
    t.hangs.add('/api/knowledge-search');
    t.app._sendFunctionResult = () => {};
    t.app.executeFunction('search_knowledge', { query: 'x' }, 'call_1', null);
    await t.advance(10);
    assert.equal(t.indicator().querySelector('[data-turn-label]').textContent, 'Looking through our resources...');
});

test('the card: a link on the web (new tab), a plain pointer and no link in the My Talents app; built with no model and no network', async () => {
    const web = harness({ search: '?caller=web' });
    web.app._showSafetyCard('content_close');
    const card = web.safetyCards()[0];
    const a = card.querySelector('a');
    assert.equal(a.getAttribute('href'), 'https://www.talenttransformation.com/post/finding-mental-health-support');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(a.textContent, 'Finding Mental Health Support');
    assert.match(card.textContent, /^Support is available/);
    assert.match(card.textContent, /contact your local emergency services now\./);
    const fetchesBefore = web.fetches.filter((f) => !f.url.includes('/api/session-log')).length;
    assert.equal(web.app._showSafetyCard('turn_failed'), false, 'once per conversation');
    assert.equal(web.safetyCards().length, 1);
    assert.equal(web.fetches.filter((f) => !f.url.includes('/api/session-log')).length, fetchesBefore);
    for (const search of ['', '?caller=app']) {
        const app = harness({ search });
        app.app._showSafetyCard('content_close');
        const c = app.safetyCards()[0];
        assert.equal(c.querySelector('a'), null);
        assert.match(c.textContent, /Search for "Finding Mental Health Support" on talenttransformation\.com\.$/);
        assert.doesNotMatch(c.textContent, /https?:/);
    }
    const bridged = harness({ search: '?caller=web', setup: (_, ctx) => { ctx.JSInterface = { postMessage() {} }; } });
    bridged.app._showSafetyCard('content_close');
    assert.equal(bridged.safetyCards()[0].querySelector('a'), null, 'a native bridge means the app');
    // A new conversation may show it again.
    web.app.clearConversation();
    assert.equal(web.app._showSafetyCard('content_close'), true);
});
