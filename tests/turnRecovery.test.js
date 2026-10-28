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

test('a second failure is failed with Try again (no safety card: no content close); no third session; Try again re-sends as the person asking', async () => {
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
    assert.equal(h.safetyCards().length, 0, 'a transport failure is not a crisis: no card');
    assert.deepEqual(h.events('turn_failed').map((e) => e.meta.cause), ['pc_failed']);
    assert.equal(h.events('safety_fallback_shown').length, 0);
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
    assert.equal(h.safetyCards().length, 0);
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

test('the session create times out at 12 s: the queued turn fails visibly (no card: a network failure is not a crisis)', async () => {
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
    assert.equal(h.safetyCards().length, 0);
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

// ---- Review of PR #55 (b211f1e) ---------------------------------------------

test('a call drop while a typed turn is streaming keeps the call: it reconnects on its own with the same mic; the turn is cut off (Try again), no standby, no card', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    const mic = h.app.localStream;
    h.app.sendTextMessage('typed in call');
    await h.advance(300);
    h.live.say('Sure, '); // the voice layer's filler is output for the typed turn
    await h.advance(100);
    h.live.failPc('disconnected');
    await h.advance(3000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto']);
    assert.equal(h.app.isRecording, true);
    assert.equal(h.app.localStream, mic, 'the same mic');
    assert.ok(h.app.pc && h.app.isConnected, 'connected again');
    assert.equal(h.app._liveStandby, false);
    assert.match(h.failedNote().textContent, /The reply was cut off\./);
    assert.equal(h.safetyCards().length, 0);
});

test("a call drop while a typed turn waits re-sends it on the call's next session; a second drop fails it but the call still reconnects with the same mic", async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    const mic = h.app.localStream;
    h.app.sendTextMessage('typed in call');
    await h.advance(300);
    h.live.failPc('disconnected');
    await h.advance(3000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto']);
    assert.deepEqual(wire(h.live.sent(1)).slice(-2), ['item:user:typed in call', 'create'], "re-sent once on the call's new session");
    assert.ok(!h.live.creates[1].input.some((i) => i.content[0].text === 'typed in call'), 'not also in session.input');
    h.live.failPc('disconnected');
    await h.advance(7000); // the second automatic reconnect in 2 min waits 5 s
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto', 'auto']);
    assert.equal(h.app.isRecording, true);
    assert.equal(h.app.localStream, mic);
    assert.ok(h.app.pc && h.app.isConnected);
    assert.equal(h.app._liveStandby, false);
    assert.ok(h.failedNote(), 'failed, with Try again');
    assert.equal(h.safetyCards().length, 0);
    // Try again re-sends into the call's open session.
    h.failedNote().querySelector('button').click();
    await h.advance(1000);
    assert.deepEqual(wire(h.live.sent(2)).slice(-2), ['item:user:typed in call', 'create']);
    assert.equal(h.live.creates.length, 3);
});

test('a call whose sessions keep dropping stops reconnecting on its own: 3 automatic reconnects in 2 min, then "Call ended — tap to resume", the mic released, one telemetry event', async () => {
    const h = harness();
    h.live.onStarted = () => h.clock.setTimeout(() => h.live.closeSession('expired'), 2000);
    h.app.toggleMicTrack();
    await h.advance(10 * MIN);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto', 'auto', 'auto']);
    assert.equal(h.app.isRecording, false);
    assert.equal(h.app.localStream, null, 'the mic is released');
    assert.equal(h.app._liveStandby, true);
    assert.equal(h.app.callEndedNotice.classList.contains('hidden'), false);
    assert.equal(h.app.callEndedNotice.dataset.reason, 'dropped');
    const capped = h.events('call_reconnect_capped');
    assert.equal(capped.length, 1);
    assert.deepEqual(capped[0].meta, { reconnects: 3, windowS: 120 });
    // The person resumes: a fresh budget.
    h.live.onStarted = null;
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.equal(h.live.creates[4].kind, 'user');
    h.live.failPc('disconnected');
    await h.advance(3000);
    assert.equal(h.live.creates[5].kind, 'auto', 'a resumed call reconnects again');
});

test('a slow chat turn that outlives two Live sessions (each expires 29.2 s after it starts) fails visibly with Try again, and shows no safety card', async () => {
    const h = harness();
    h.live.onStarted = () => h.clock.setTimeout(() => h.live.closeSession('expired'), 29200);
    h.app.sendTextMessage('Can you analyse my whole values report in depth?');
    await h.advance(5 * MIN);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'recover']);
    assert.ok(h.failedNote());
    assert.deepEqual(h.events('turn_failed').map((e) => e.meta.cause), ['session_closed:expired']);
    assert.equal(h.safetyCards().length, 0);
    assert.equal(h.events('safety_fallback_shown').length, 0);
});

test('a reply cut off by the expiry, or a 500 on the session create: the failed note only, no safety card', async () => {
    const h = harness({ search: '?caller=web' });
    h.app.sendTextMessage('quick question about my resume');
    await h.advance(3000);
    h.live.event({ type: 'response.created', response: { id: 'r1' } }, 'd1');
    h.live.event({ type: 'response.output_text.delta', delta: 'Start with your top three' }, 'd1');
    await h.advance(100);
    h.live.closeSession('expired');
    await h.advance(5000);
    assert.match(h.failedNote().textContent, /The reply was cut off\./);
    assert.equal(h.safetyCards().length, 0);
    assert.equal(h.live.creates.length, 1, 'a started reply is never re-sent on its own');

    const s = harness({ search: '?caller=web' });
    s.live.policy = () => ({ status: 500, body: { error: 'upstream' } });
    s.app.sendTextMessage('quick question about my resume');
    await s.advance(5000);
    assert.match(s.failedNote().textContent, /Erica couldn’t answer this\./);
    assert.equal(s.safetyCards().length, 0);
});

test('a message held behind a tool keeps its dots after the reply to the first one; if the session then expires, the recovery session re-sends it once', async () => {
    const h = harness();
    h.history(PRIOR);
    h.hangs.add('/api/knowledge-search');
    h.app.sendTextMessage('first');
    await h.advance(1000);
    h.live.functionCall('search_knowledge', { query: 'values' }, { delegation: 'd1' });
    await h.advance(100);
    h.app.sendTextMessage('second');
    await h.advance(500);
    assert.ok(!wire(h.live.sent(0)).includes('item:user:second'), 'held behind the tool');
    await h.advance(20000); // the tool times out: an error output, then the continuation
    h.live.reply('Answer to first', { delegation: 'd1', response: 'r_cont', completed: true });
    await h.advance(100);
    assert.deepEqual(wire(h.live.sent(0)).slice(-2), ['item:user:second', 'create'], 'flushed after the continuation');
    assert.equal(h.indicator().visible, true, 'the held message still waits');
    h.live.closeSession('expired');
    await h.advance(3000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'recover']);
    const w = wire(h.live.sent(1));
    assert.ok(w.includes('item:user:first') && w.includes('item:assistant:Answer to first'), 'answered: history now');
    assert.deepEqual(w.slice(-2), ['item:user:second', 'create']);
    assert.equal(w.filter((x) => x === 'item:user:second').length, 1);
    assert.equal(h.failedNote(), null);
});

test('two quick sends: the answer to the first leaves the second waiting; an expiry before its answer re-sends only the second', async () => {
    const h = harness();
    h.app.sendTextMessage('first');
    await h.advance(1000);
    h.live.event({ type: 'response.created', response: { id: 'r1' } }, 'd1');
    await h.advance(500);
    h.app.sendTextMessage('second');
    await h.advance(500);
    h.live.reply('Answer to first', { delegation: 'd1', response: 'r1', created: false, completed: true });
    await h.advance(100);
    assert.equal(h.indicator().visible, true, 'the second still waits');
    h.live.closeSession('expired');
    await h.advance(3000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'recover']);
    const w = wire(h.live.sent(1));
    assert.deepEqual(w.slice(-2), ['item:user:second', 'create']);
    assert.ok(!w.slice(0, -2).includes('item:user:second'));
    assert.ok(w.includes('item:user:first') && w.includes('item:assistant:Answer to first'));
});

test('a message sent while the previous reply streams keeps its dots; that reply finishing does not end its turn; an expiry then re-sends it', async () => {
    const h = harness();
    h.app.sendTextMessage('A');
    await h.advance(1000);
    h.live.event({ type: 'response.created', response: { id: 'rA' } }, 'dA');
    h.live.event({ type: 'response.output_text.delta', delta: 'Part one, ' }, 'dA');
    await h.advance(100);
    assert.equal(h.indicator().visible, false);
    h.app.sendTextMessage('B');
    await h.advance(200);
    assert.equal(h.indicator().visible, true, 'B waits');
    h.live.event({ type: 'response.output_text.delta', delta: 'part two.' }, 'dA');
    await h.advance(100);
    assert.equal(h.indicator().visible, true, "A's later words do not hide B's dots");
    h.live.event({ type: 'response.output_text.done', text: 'Part one, part two.' }, 'dA');
    await h.advance(100);
    assert.equal(h.indicator().visible, true, "A's answer does not end B's turn");
    h.live.closeSession('expired');
    await h.advance(3000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'recover']);
    assert.deepEqual(wire(h.live.sent(1)).slice(-2), ['item:user:B', 'create']);
    assert.equal(h.events('turn_stalled').length, 1);
    h.live.reply('Answer to B', { delegation: 'dB' });
    await h.advance(200);
    assert.equal(h.indicator().visible, false);
});

test("a send from standby shows the person's bubble at the tap; the queued message goes once (not also as history) and is logged once", async () => {
    const realTurnLog = { setup: (app) => { delete app._logTurnFor; } }; // the harness stubs the Studio turn log
    const h = harness(realTurnLog);
    h.history(PRIOR);
    h.app.sendTextMessage('hello');
    const mine = () => h.app.messages.filter((m) => m.role === 'user' && m.text === 'hello');
    assert.equal(mine().length, 1, 'the bubble shows before any session exists');
    assert.ok(h.app.messageElements.get(mine()[0].id), 'on screen');
    assert.equal(h.live.creates.length, 0);
    await h.advance(3000);
    assert.equal(mine().length, 1, 'no second bubble when it is sent');
    assert.deepEqual(wire(h.live.sent(0)), ['update', 'item:user:I have an interview', 'item:assistant:Tell me more', 'item:user:hello', 'create']);
    assert.equal(h.posts.filter((p) => p.kind === 'user_turn' && p.text === 'hello').length, 1, 'one Studio turn');
    // A connect that fails keeps the bubble; Try again sends it, once.
    const s = harness(realTurnLog);
    s.live.policy = () => (s.live.creates.length === 1 ? { status: 500, body: {} } : undefined);
    s.app.sendTextMessage('hi');
    await s.advance(3000);
    assert.ok(s.failedNote());
    assert.equal(s.app.messages.filter((m) => m.text === 'hi').length, 1);
    s.failedNote().querySelector('button').click();
    await s.advance(3000);
    assert.equal(s.live.creates.length, 2);
    assert.deepEqual(wire(s.live.sent()).filter((x) => x === 'item:user:hi'), ['item:user:hi']);
    assert.equal(s.app.messages.filter((m) => m.text === 'hi').length, 1);
    assert.equal(s.posts.filter((p) => p.kind === 'user_turn' && p.text === 'hi').length, 1);
});

// ---- Re-review of PR #55 (7dd569f) ------------------------------------------

// A reconnected session that ends while its connect() is still unwinding (the
// 1 s wait after setRemoteDescription) used to leave the call frozen: mic
// live, no session, no notice, no further attempt.
test('a call whose reconnected session ends while its connect() is still unwinding (0 ms, 300 ms, or its data channel closing at session.started) reconnects again, keeping the mic', async () => {
    const cases = [
        ['closed 0 ms after session.started', (h) => h.live.closeSession('expired')],
        ['closed 300 ms after session.started', (h) => h.clock.setTimeout(() => h.live.closeSession('expired'), 300)],
        ['data channel closed at session.started', (h, pc) => pc.dc.close()],
    ];
    for (const [label, end] of cases) {
        const h = harness();
        h.app.toggleMicTrack();
        await h.advance(3000);
        const mic = h.app.localStream;
        let n = 0;
        h.live.onStarted = (create, pc) => { if (++n === 1) end(h, pc); };
        h.live.failPc('disconnected');
        await h.advance(10000);
        assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto', 'auto'], label);
        assert.ok(h.app.pc && h.app.isConnected, `${label}: connected again`);
        assert.equal(h.app.isRecording, true, label);
        assert.equal(h.app.localStream, mic, `${label}: the same mic`);
        assert.equal(h.app.callEndedNotice.classList.contains('hidden'), true, `${label}: no notice`);
        assert.equal(h.events('call_reconnect_capped').length, 0, label);
    }
});

test('a call whose every reconnect ends at session.started stops after 3 automatic reconnects: "Call ended — tap to resume", the mic released, one telemetry event', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.live.onStarted = () => h.live.closeSession('expired');
    h.live.failPc('disconnected');
    await h.advance(2 * MIN);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto', 'auto', 'auto']);
    assert.equal(h.app.isRecording, false);
    assert.equal(h.app.localStream, null, 'the mic is released');
    assert.equal(h.app._liveStandby, true);
    assert.equal(h.app.callEndedNotice.classList.contains('hidden'), false);
    assert.equal(h.app.callEndedNotice.dataset.reason, 'dropped');
    assert.deepEqual(h.events('call_reconnect_capped').map((e) => e.meta), [{ reconnects: 3, windowS: 120 }]);
    assert.deepEqual(h.navigations, [], 'no maintenance.html');
    await h.advance(5 * MIN);
    assert.equal(h.live.creates.length, 4, 'nothing reconnects after the notice');
});

test('a call whose automatic reconnect cannot create a session (a 500, or the 12 s create timeout) tries again within the cap, then "Call ended — tap to resume" with the mic released', async () => {
    for (const [label, verdict] of [['500', { status: 500, body: { error: 'upstream' } }], ['create timeout', 'hang']]) {
        const h = harness();
        h.app.toggleMicTrack();
        await h.advance(3000);
        h.live.policy = (create) => (create.kind === 'auto' ? verdict : undefined);
        h.live.failPc('disconnected');
        await h.advance(2 * MIN);
        assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto', 'auto', 'auto'], label);
        assert.equal(h.app.isRecording, false, label);
        assert.equal(h.app.localStream, null, `${label}: the mic is released`);
        assert.equal(h.app.callEndedNotice.dataset.reason, 'dropped', label);
        assert.equal(h.events('call_reconnect_capped').length, 1, label);
        assert.deepEqual(h.navigations, [], `${label}: the page stays (no maintenance.html)`);
    }
});

test("a call's automatic reconnect refused by the server's cut (409) ends with the cut's notice: no further automatic attempt, no 'dropped'", async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.live.policy = (create) => (create.kind === 'auto' ? { status: 409, body: { error: 'live_session_cut', cut: true, reason: 'max' } } : undefined);
    h.live.failPc('disconnected');
    await h.advance(2 * MIN);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto']);
    assert.ok(h.app._liveCut, 'the server cut stands');
    assert.equal(h.app.isRecording, false);
    assert.equal(h.app.callEndedNotice.dataset.reason, 'max');
    assert.equal(h.events('call_reconnect_capped').length, 0);
});

// The voice layer's transcript keeps one bubble per utterance until 1.5 s
// after its last word; a typed message answered within that utterance used to
// stay 'unanswered' and fail at the 60 s cap (then Try again re-sent it into
// the call: a second answer).
test('a message typed in a call while Erica is still speaking, answered by her voice with no 1.5 s pause: the dots go when she answers, no failure at 60 s, nothing re-sent, one bubble per utterance', async () => {
    // B typed right after A's answer; her next words follow within 1.5 s.
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.app.sendTextMessage('A');
    await h.advance(300);
    h.live.say('Answer to A.');
    await h.advance(200);
    h.app.sendTextMessage('B');
    await h.advance(200);
    assert.equal(h.indicator().visible, true, 'B waits');
    await h.advance(800);
    h.live.say(' Sure, let me look.');
    await h.advance(1000);
    h.live.say(' Here is the answer to B.');
    await h.advance(3000);
    assert.equal(h.indicator().visible, false, 'B was answered by voice');
    await h.advance(65000);
    assert.equal(h.failedNote(), null, 'no false failure (and so no Try again that would ask twice)');
    assert.deepEqual(h.events('turn_failed'), []);
    assert.deepEqual(wire(h.live.sent()).filter((x) => x === 'item:user:B'), ['item:user:B'], 'B went once');
    const spoken = h.app.messages.filter((m) => m.role === 'bot' && m.text.includes('Answer to A.'));
    assert.equal(spoken.length, 1, 'the utterance stays one bubble');
    assert.match(spoken[0].text, /Here is the answer to B\./);

    // B typed mid-sentence; she speaks on, a word every 800 ms.
    const c = harness();
    c.app.toggleMicTrack();
    await c.advance(3000);
    c.app.sendTextMessage('A');
    await c.advance(300);
    c.live.say('Answer to A, ');
    await c.advance(500);
    c.app.sendTextMessage('B');
    for (let i = 0; i < 10; i++) { await c.advance(800); c.live.say('more words '); }
    await c.advance(3000);
    assert.equal(c.indicator().visible, false);
    await c.advance(65000);
    assert.equal(c.failedNote(), null);
    assert.deepEqual(c.events('turn_failed'), []);

    // B typed while she speaks, then a pause before any word for it: the end
    // of that utterance does not answer B; her next utterance does.
    const p = harness();
    p.app.toggleMicTrack();
    await p.advance(3000);
    p.app.sendTextMessage('A');
    await p.advance(300);
    p.live.say('Answer to A.');
    await p.advance(200);
    p.app.sendTextMessage('B');
    await p.advance(3000);
    assert.equal(p.indicator().visible, true, 'B still waits after her answer to A ended');
    p.live.say('Answer to B.');
    await p.advance(3000);
    assert.equal(p.indicator().visible, false);
    await p.advance(65000);
    assert.equal(p.failedNote(), null);
});

test('in a call, a message held behind a tool that reaches the model while Erica is still speaking counts as answered by what she says after it', async () => {
    const h = harness();
    h.hangs.add('/api/knowledge-search');
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.app.sendTextMessage('first');
    await h.advance(500);
    h.live.functionCall('search_knowledge', { query: 'values' }, { delegation: 'd1' });
    await h.advance(100);
    h.app.sendTextMessage('second');
    await h.advance(500);
    assert.ok(!wire(h.live.sent()).includes('item:user:second'), 'held behind the tool');
    await h.advance(20000); // the tool times out: an error output, then the continuation
    h.live.say('Here is what I found for the first.');
    await h.advance(200);
    h.live.reply('Answer to first', { delegation: 'd1', response: 'r_cont', completed: true });
    await h.advance(100);
    assert.deepEqual(wire(h.live.sent()).slice(-2), ['item:user:second', 'create'], 'flushed after the continuation');
    await h.advance(600);
    h.live.say(' And about the second one, here you go.');
    await h.advance(3000);
    assert.equal(h.indicator().visible, false, 'the held message was answered by voice');
    await h.advance(65000);
    assert.equal(h.failedNote(), null);
    assert.deepEqual(h.events('turn_failed'), []);
});

// ---- Re-review of PR #55, round 3 (1689b3b) ---------------------------------

// A call's automatic reconnects are bounded by the call cap, which ends in
// "Call ended — tap to resume". They used to count toward establishConnection's
// rule that 3 failed creates in a row send the page to maintenance.html, and
// they came 1.5 s apart: a few seconds offline (a Wi-Fi to cellular handoff)
// used up both and replaced the coach with "temporarily unavailable".
test('a call that is offline for 6 s (every session create rejects) reconnects once the network is back: spaced attempts, no maintenance.html, no notice', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    const mic = h.app.localStream;
    const online = h.ctx.fetch;
    const dropAt = h.clock.now();
    const offline = [];
    h.ctx.fetch = (url, init) => {
        if (String(url).includes('/api/proxy/live') && h.clock.now() < dropAt + 6000) {
            offline.push(h.clock.now() - dropAt);
            return Promise.reject(new TypeError('Failed to fetch'));
        }
        return online(url, init);
    };
    h.live.failPc('failed');
    await h.advance(30000);
    assert.deepEqual(h.navigations, [], 'the page stays');
    assert.deepEqual(offline, [1500], 'one attempt while offline, 1.5 s after the drop');
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'auto'], 'the next attempt waits long enough for the network to return');
    assert.ok(h.app.pc && h.app.isConnected === true, 'connected again');
    assert.equal(h.app.isRecording, true);
    assert.equal(h.app.localStream, mic, 'the same mic');
    assert.equal(h.app.callEndedNotice.classList.contains('hidden'), true, 'no notice');
    assert.equal(h.events('call_reconnect_capped').length, 0);
});

test("a call whose automatic reconnects all fail spaces them out (1.5 s, then 5 s, then 15 s) and ends with 'Call ended — tap to resume', never maintenance.html; the person's own connects still count toward it", async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.live.policy = (create) => (create.kind === 'auto' ? { status: 500, body: { error: 'upstream' } } : undefined);
    const dropAt = h.clock.now();
    h.live.failPc('disconnected');
    await h.advance(2 * MIN);
    const autos = h.live.creates.filter((c) => c.kind === 'auto').map((c) => c.at - dropAt);
    assert.equal(autos.length, 3, String(autos));
    assert.equal(autos[0], 1500);
    assert.ok(autos[1] - autos[0] >= 5000, `second attempt ${autos[1] - autos[0]} ms after the first`);
    assert.ok(autos[2] - autos[1] >= 15000, `third attempt ${autos[2] - autos[1]} ms after the second`);
    assert.equal(h.app.callEndedNotice.dataset.reason, 'dropped');
    assert.equal(h.app.localStream, null, 'the mic is released');
    assert.deepEqual(h.navigations, [], 'the page stays');
    assert.equal(h.app._openaiFailCount || 0, 0, 'automatic reconnects are not counted for the redirect');
    // Unchanged: three failed connects of the person's own (send, Try
    // again, Try again) still go to the maintenance page.
    const c = harness();
    c.live.policy = () => ({ status: 500, body: {} });
    c.app.sendTextMessage('hello');
    await c.advance(3000);
    c.failedNote().querySelector('button').click();
    await c.advance(3000);
    c.failedNote().querySelector('button').click();
    await c.advance(3000);
    assert.deepEqual(c.navigations, ['maintenance.html']);
});

// A failed connect left isConnected at the truthy 'connecting', which the
// reconnect's 1.5 s timer read as connected: no attempt, no standby, and the
// call stayed on with the mic held and no session.
test("a message typed during a call reconnect waits for the call's own session: no connect of its own; a failed automatic create (a 500, or the 12 s timeout) leaves the call reconnecting, never frozen", async () => {
    for (const [label, verdict] of [['500', { status: 500, body: {} }], ['create timeout', 'hang']]) {
        const h = harness();
        h.app.toggleMicTrack();
        await h.advance(3000);
        const mic = h.app.localStream;
        let failed = false;
        h.live.policy = (create) => {
            if (create.kind !== 'auto' || failed) return undefined;
            failed = true;
            return verdict;
        };
        h.live.failPc('disconnected');
        await h.advance(300);
        h.app.sendTextMessage('hello?');
        await h.advance(40000);
        const kinds = h.live.creates.map((c) => c.kind);
        assert.deepEqual(kinds.filter((k) => k === 'user'), ['user'], `${label}: the typed message started no connect of its own (${kinds})`);
        assert.ok(kinds.filter((k) => k === 'auto').length >= 2, `${label}: the call tries again on its own (${kinds})`);
        assert.ok(h.app.pc && h.app.isConnected === true, `${label}: connected again`);
        assert.equal(h.app.isRecording, true, label);
        assert.equal(h.app.localStream, mic, `${label}: the same mic`);
        assert.equal(h.app.callEndedNotice.classList.contains('hidden'), true, `${label}: no notice`);
        assert.deepEqual(h.navigations, [], label);
        const sent = h.live.pcs.map((p) => wire(p.dc.sent).filter((x) => x === 'item:user:hello?').length);
        assert.equal(sent.reduce((a, b) => a + b, 0), 1, `${label}: the typed message reaches the reconnected call once (${sent})`);
        assert.equal(sent[sent.length - 1], 1, label);
    }
});

// Typed messages used to start connects of their own during a call
// reconnect: offline, each failed at once and counted toward the
// maintenance.html redirect, and each reset the call's reconnect budget.
test('a call offline for 30 s with three messages typed during the reconnect: no maintenance.html, no connect of their own, the cap ends it visibly with the mic released', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    const online = h.ctx.fetch;
    const dropAt = h.clock.now();
    h.ctx.fetch = (url, init) => {
        if (String(url).includes('/api/proxy/live') && h.clock.now() < dropAt + 30000) {
            h.live.creates.push({ kind: 'offline:' + ((init.headers || {})['X-Erica-Reconnect'] || 'user'), at: h.clock.now(), input: [] });
            return Promise.reject(new TypeError('Failed to fetch'));
        }
        return online(url, init);
    };
    h.live.failPc('failed');
    for (const [wait, text] of [[3000, 'hello?'], [6000, 'are you there?'], [7000, 'hello??']]) {
        await h.advance(wait);
        h.app.sendTextMessage(text);
    }
    await h.advance(40000);
    const kinds = h.live.creates.map((c) => c.kind);
    assert.deepEqual(h.navigations, [], `the page stays (${kinds})`);
    assert.deepEqual(kinds.filter((k) => /user/.test(k)), ['user'], `no typed message started a connect (${kinds})`);
    assert.equal(kinds.filter((k) => /auto/.test(k)).length, 3, `the cap bounds the attempts (${kinds})`);
    assert.equal(h.app.callEndedNotice.dataset.reason, 'dropped');
    assert.equal(h.app.localStream, null, 'the mic is released');
    assert.equal(h.app._openaiFailCount || 0, 0);
    assert.ok(h.failedNote(), 'the waiting messages show the failed note with Try again');
});

// The call button checked "not connected" before "recording": a hang-up tap
// during a reconnect started a reconnect of its own (the mic attached again,
// after the person had hung up), or was swallowed while a create was in
// flight.
test('hang-up tapped during a call reconnect hangs up: the mic is released at once, no session comes back for the call, the automatic attempts stop', async () => {
    // In the 1.5 s delay before the automatic attempt.
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.live.failPc('disconnected');
    await h.advance(500);
    h.app.toggleMicTrack();
    assert.equal(h.app.isRecording, false, 'the tap hangs up');
    assert.equal(h.app.localStream, null, 'the mic is released');
    await h.advance(2 * MIN);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user'], 'nothing reconnects');
    assert.equal(h.app.pc, null);
    assert.equal(h.app.isRecording, false);
    assert.equal(h.app._liveStandby, true);
    assert.equal(h.app.callEndedNotice.classList.contains('hidden'), true);
    assert.equal(h.events('call_reconnect_capped').length, 0);

    // While the automatic attempt's create hangs (until the 12 s timeout).
    const g = harness();
    g.app.toggleMicTrack();
    await g.advance(3000);
    g.live.policy = (create) => (create.kind === 'auto' ? 'hang' : undefined);
    g.live.failPc('disconnected');
    await g.advance(3000);
    assert.deepEqual(g.live.creates.map((c) => c.kind), ['user', 'auto']);
    g.app.toggleMicTrack();
    assert.equal(g.app.isRecording, false, 'the tap is not swallowed');
    assert.equal(g.app.localStream, null);
    await g.advance(2 * MIN);
    assert.deepEqual(g.live.creates.map((c) => c.kind), ['user', 'auto'], 'no attempt after the hang-up');
    assert.equal(g.app.isRecording, false);
    assert.equal(g.app._liveStandby, true);
    assert.equal(g.events('call_reconnect_capped').length, 0);
    assert.deepEqual(g.navigations, []);

    // Every new session closes at session.started: the tap in the delay
    // neither reconnects nor gives the call a fresh budget.
    const s = harness();
    s.app.toggleMicTrack();
    await s.advance(3000);
    s.live.onStarted = () => s.live.closeSession('expired');
    s.live.failPc('disconnected');
    await s.advance(500);
    s.app.toggleMicTrack();
    await s.advance(2 * MIN);
    assert.deepEqual(s.live.creates.map((c) => c.kind), ['user']);
    assert.equal(s.app.isRecording, false);
    assert.equal(s.app.localStream, null);
});

// After that hang-up the person is in chat: a message typed into the call
// that was still waiting gets the chat's one fresh session, instead of a
// minute under "Reconnecting..." with nothing reconnecting.
test('hang-up tapped during a call reconnect while a typed message waits: the message gets its one fresh session, as in chat; the mic stays released', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.app.sendTextMessage('typed in call');
    await h.advance(300);
    h.live.failPc('disconnected');
    await h.advance(500);
    h.app.toggleMicTrack(); // hang up
    await h.advance(5000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'recover']);
    assert.equal(h.app.isRecording, false);
    assert.equal(h.app.localStream, null, 'no mic on the new session');
    assert.deepEqual(wire(h.live.sent(1)).filter((x) => x === 'item:user:typed in call'), ['item:user:typed in call'], 're-sent once');
    h.live.reply('Here you go');
    await h.advance(200);
    assert.equal(h.indicator().visible, false);
    await h.advance(2 * MIN);
    assert.equal(h.failedNote(), null);
    assert.equal(h.live.creates.length, 2);
});

// Try again with the channel open re-sends through _resendOpenTurns, which
// did not mark the open utterance: an answer inside it counted as older than
// the re-send (dots kept, a false failure at 60 s, a second Try again would
// ask twice).
test('in a call, Try again tapped while Erica is speaking and answered in the same utterance: the dots go, nothing fails at 60 s, the message goes once', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.app.sendTextMessage('typed');
    await h.advance(300);
    let failed = 0;
    h.live.policy = (create) => (create.kind === 'auto' && failed++ === 0 ? { status: 500, body: {} } : undefined);
    h.live.failPc('disconnected');
    await h.advance(15000);
    assert.ok(h.failedNote(), 'the turn failed with its connect');
    assert.ok(h.app.pc && h.app.isConnected === true, 'the call is back');
    const pcIndex = h.live.pcs.length - 1;
    h.live.say('So, as I was saying, ');
    await h.advance(700);
    h.failedNote().querySelector('button').click();
    for (let i = 0; i < 8; i++) { await h.advance(700); h.live.say(i < 3 ? 'more words ' : 'and about your typed question, here it is '); }
    await h.advance(3000);
    assert.equal(h.indicator().visible, false, 'answered in the same utterance');
    await h.advance(65000);
    assert.equal(h.failedNote(), null, 'no false failure');
    assert.deepEqual(h.events('turn_failed').map((e) => e.meta.cause), ['connect_failed']);
    assert.deepEqual(wire(h.live.sent(pcIndex)).filter((x) => x === 'item:user:typed'), ['item:user:typed'], 'Try again sent it once');
    assert.equal(h.live.pcs.length - 1, pcIndex, 'on the same session');
});

// The utterance split is for calls. Right after a hang-up her last utterance
// stays open for 1.5 s; a chat message sent then used to be "answered" by its
// trailing words, so a session that expired next recovered nothing and the
// message was lost without a note (Varsha's class).
test('right after a hang-up, a chat message sent while her last utterance is still open is not answered by its trailing words: an expiry then recovers it once', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.live.say('So that is my view on it.');
    await h.advance(200);
    h.app.toggleMicTrack(); // hang up
    await h.advance(200);
    assert.equal(h.app.isRecording, false);
    h.app.sendTextMessage('Q typed in chat');
    await h.advance(300);
    h.live.say(' Talk soon.');
    await h.advance(3000);
    assert.equal(h.indicator().visible, true, 'her trailing words are not the answer');
    h.live.closeSession('expired');
    await h.advance(5000);
    assert.deepEqual(h.live.creates.map((c) => c.kind), ['user', 'recover']);
    assert.deepEqual(h.live.pcs.map((p) => wire(p.dc.sent).filter((x) => x === 'item:user:Q typed in chat').length), [1, 1], 're-sent once on the recover session');
    assert.deepEqual(h.events('turn_stalled').map((e) => e.meta.cause), ['session_closed:expired']);
    h.live.reply('Answer to Q');
    await h.advance(200);
    assert.equal(h.indicator().visible, false);
    assert.equal(h.failedNote(), null);
});

// After a hang-up the session goes on in chat, and the voice layer may say a
// filler ("Let me check that.") for a typed message. Counted as the answer, a
// session that then died lost the message with no sign (Varsha's class).
for (const end of ['expired', 'pc failed']) {
    test(`after a hang-up, a voice-layer filler for a chat message does not answer it: ${end} before the backend answers leaves a visible failure with Try again, never a silent standby`, async () => {
        const h = harness();
        h.app.toggleMicTrack();
        await h.advance(3000);
        h.live.say('So that is my view.');
        await h.advance(3000);
        h.app.toggleMicTrack(); // hang up; the session goes on in chat
        await h.advance(1000);
        h.app.sendTextMessage('Q typed in chat');
        await h.advance(800);
        h.live.say('Let me check that.');
        await h.advance(2500);
        if (end === 'expired') h.live.closeSession('expired'); else h.live.failPc('failed');
        await h.advance(10000);
        assert.ok(h.failedNote(), 'the failure shows');
        assert.equal(h.events('turn_failed').length, 1);
        assert.equal(h.events('turn_failed')[0].meta.partial, true, 'a reply had started');
        h.failedNote().querySelector('button').click();
        await h.advance(3000);
        const sent = h.live.pcs.map((p) => wire(p.dc.sent).filter((x) => x === 'item:user:Q typed in chat').length);
        assert.equal(sent[sent.length - 1], 1, `Try again sends it once on the new session (${sent})`);
        h.live.reply('Answer to Q');
        await h.advance(200);
        assert.equal(h.failedNote(), null);
        assert.equal(h.indicator().visible, false);
    });
}

test('after a hang-up, a voice-layer reply with no backend answer ends the turn quietly at 60 s: no false failure', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.app.toggleMicTrack();
    await h.advance(1000);
    h.app.sendTextMessage('thanks, bye');
    await h.advance(800);
    h.live.say('You are welcome, good luck!');
    await h.advance(2 * MIN);
    assert.equal(h.failedNote(), null, 'no failed note');
    assert.equal(h.events('turn_failed').length, 0);
    assert.equal(h.indicator().visible, false);
});
