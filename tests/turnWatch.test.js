// lib/turnWatch.js: the open user turn, what the reply slot shows while it
// waits, and what a dead session means for it (Varsha, 2026-10-14: a turn
// sent into a dying session was never asked again, and a thinking turn and a
// dead one looked the same). Pure, with a fake clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const tw = require('../lib/turnWatch');

function fakeClock(start = 1_000_000) {
    let now = start;
    let seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimer: (id) => { timers.delete(id); },
        pending: () => timers.size,
        advance(ms) {
            const end = now + ms;
            for (;;) {
                let next = null;
                for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
                if (!next) break;
                timers.delete(next[0]);
                now = next[1].at;
                next[1].fn();
            }
            now = end;
        },
    };
}

function make(opts = {}) {
    const clock = fakeClock();
    const views = []; const fails = []; const events = [];
    const watch = tw.createTurnWatch({
        now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        coachName: () => opts.coach || 'Erica',
        onChange: (v) => views.push(v),
        onFail: (r) => fails.push(r),
        onEvent: (name, meta) => events.push({ name, meta }),
    });
    return { clock, watch, views, fails, events };
}

const item = (text) => ({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

test('a sent turn with no answer: dots, then "is thinking..." at 4 s, "Still working on it..." at 15 s, failed at 60 s — timers change the label only', () => {
    const { clock, watch, fails } = make({ coach: 'Jasmine' });
    assert.deepEqual(watch.view(), { state: 'idle', dots: false, label: null, failed: null });
    watch.send({ id: 'user-text-1', message: item('hello'), session: 1 });
    assert.deepEqual(watch.view(), { state: 'waiting', dots: true, label: null, failed: null });
    clock.advance(3999);
    assert.equal(watch.view().label, null);
    clock.advance(1);
    assert.equal(watch.view().label, 'Jasmine is thinking...');
    clock.advance(11000);
    assert.equal(watch.view().label, 'Still working on it...');
    assert.equal(fails.length, 0, 'no timer before the cap does anything but relabel');
    clock.advance(45000 - 1);
    assert.equal(watch.view().dots, true);
    clock.advance(1);
    assert.deepEqual(watch.view(), { state: 'failed', dots: false, label: null, failed: { partial: false, cause: 'cap' } });
    assert.equal(fails.length, 1);
    assert.equal(fails[0].cause, 'cap');
    assert.equal(fails[0].hard, false, 'the cap is not a transport signal (no safety card)');
    assert.equal(clock.pending(), 0, 'nothing left running after failed');
});

test('a pending tool names what is happening; its end goes back to the time label; parallel tools do not hide each other', () => {
    const { clock, watch } = make();
    watch.send({ id: 'u1', message: item('q'), session: 1 });
    assert.equal(watch.toolStart('call_1', 'get_page_context'), true);
    assert.equal(watch.view().label, 'Reading this page...');
    watch.toolStart('call_2', 'search_knowledge');
    watch.toolEnd('call_1');
    assert.equal(watch.view().label, 'Looking through our resources...', 'the other tool still runs');
    watch.toolEnd('call_2');
    assert.equal(watch.view().label, null);
    clock.advance(5000);
    assert.equal(watch.view().label, 'Erica is thinking...');
    // No turn open (a spoken call turn): the tracker does not take the tool.
    const other = make();
    assert.equal(other.watch.toolStart('c', 'search_web'), false);
});

test('the first visible output hides the dots; the final one ends the turn; nothing stays scheduled', () => {
    const { clock, watch, events } = make();
    watch.send({ id: 'u1', message: item('q'), session: 1 });
    clock.advance(1500);
    watch.output({ final: false });
    assert.deepEqual(watch.view(), { state: 'streaming', dots: false, label: null, failed: null });
    watch.output({ final: true });
    assert.deepEqual(watch.view(), { state: 'done', dots: false, label: null, failed: null });
    assert.equal(clock.pending(), 0);
    assert.equal(watch.isOpen(), false);
    assert.deepEqual(watch.openIds(), []);
    // Coach output with no open turn (the opening line) changes nothing.
    watch.output({ final: true });
    assert.equal(watch.view().state, 'done');
    assert.equal(events.filter((e) => e.name === 'turn_recovered').length, 0, 'a plain answer is not a recovery');
});

test('a session end with no open turn: chat goes to standby, a call reconnects as before', () => {
    const { watch, events } = make();
    assert.deepEqual(watch.hardSignal({ cause: 'session_closed:expired', inCall: false }), { action: 'standby', turnId: null });
    assert.deepEqual(watch.hardSignal({ cause: 'pc_failed', inCall: true }), { action: 'resume-call', turnId: null });
    assert.equal(events.length, 0);
});

test('an open turn on a dead session: one fresh session re-sends it; a second failure is failed (hard) — never a third session', () => {
    const { clock, watch, fails, events } = make();
    watch.send({ id: 'u1', message: item('first'), session: 1 });
    watch.send({ id: 'u2', message: item('second'), session: 1 });
    clock.advance(2000);
    const d1 = watch.hardSignal({ cause: 'session_closed:expired', inCall: false });
    assert.deepEqual(d1, { action: 'recover', turnId: 'u1' });
    assert.deepEqual(watch.view(), { state: 'recovering', dots: true, label: 'Connection dropped. Reconnecting...', failed: null });
    assert.deepEqual(watch.openIds(), ['u1', 'u2'], 'left out of the new session history: they are re-sent');
    // The new session: both unanswered turns, in order, once.
    const again = watch.sessionStarted(2);
    assert.deepEqual(again.map((e) => e.id), ['u1', 'u2']);
    assert.equal(again[0].message.item.content[0].text, 'first');
    assert.deepEqual(watch.sessionStarted(2), [], 'never twice into the same session');
    assert.equal(watch.view().state, 'waiting');
    const d2 = watch.hardSignal({ cause: 'dc_closed', inCall: false });
    assert.deepEqual(d2, { action: 'fail', turnId: 'u1' });
    assert.equal(fails.length, 1);
    assert.deepEqual([fails[0].cause, fails[0].hard, fails[0].partial, fails[0].attempts], ['dc_closed', true, false, 1]);
    assert.deepEqual(watch.view(), { state: 'failed', dots: false, label: null, failed: { partial: false, cause: 'dc_closed' } });
    const stalled = events.filter((e) => e.name === 'turn_stalled');
    assert.deepEqual(stalled.map((e) => [e.meta.turnId, e.meta.cause, e.meta.attempt]), [['u1', 'session_closed:expired', 1], ['u1', 'dc_closed', 2]]);
    assert.equal(stalled[0].meta.msSinceSend, 2000);
    assert.deepEqual(events.filter((e) => e.name === 'turn_failed').map((e) => e.meta), [{ turnId: 'u1', cause: 'dc_closed', attempts: 1, partial: false }]);
    for (const e of events) assert.ok(!JSON.stringify(e).includes('first'), 'telemetry carries no message text');
    // After failed, a session end is just a session end.
    assert.equal(watch.hardSignal({ cause: 'pc_failed', inCall: false }).action, 'standby');
});

test('a reply that already started is cut off, never re-sent automatically', () => {
    const { watch, fails } = make();
    watch.send({ id: 'u1', message: item('q'), session: 1 });
    watch.output({ final: false });
    assert.deepEqual(watch.hardSignal({ cause: 'session_closed:expired', inCall: false }), { action: 'fail', turnId: 'u1' });
    assert.deepEqual([fails[0].cause, fails[0].partial], ['session_closed:expired', true]);
    assert.deepEqual(watch.view().failed, { partial: true, cause: 'session_closed:expired' });
});

test('a live cut wins over recovery: the open turn fails at once', () => {
    const { watch, fails } = make();
    watch.send({ id: 'u1', message: item('q'), session: 1 });
    assert.deepEqual(watch.hardSignal({ cause: 'pc_failed', inCall: false, cut: true }), { action: 'fail', turnId: 'u1' });
    assert.deepEqual([fails[0].cause, fails[0].hard], ['cut', false]);
    // fail() is idempotent, and a cut on its own fails an open turn the same way.
    const b = make();
    b.watch.send({ id: 'u9', message: item('q'), session: 1 });
    assert.equal(b.watch.fail('cut').cause, 'cut');
    assert.equal(b.watch.fail('cut'), null);
    assert.equal(b.fails.length, 1);
});

test('a message queued while not connected opens the turn; one recovery connect at most, then failed', () => {
    const { watch, fails } = make();
    watch.queue();
    assert.equal(watch.view().dots, true, 'dots from the tap, not from the connect');
    assert.equal(watch.isOpen(), true);
    assert.deepEqual(watch.hardSignal({ cause: 'session_closed:content', inCall: false }).action, 'recover');
    assert.deepEqual(watch.sessionStarted(2), [], 'nothing was sent yet: the queue flushes itself');
    assert.equal(watch.hardSignal({ cause: 'session_closed:content', inCall: false }).action, 'fail');
    assert.equal(fails[0].turnId.startsWith('queued-'), true);
    // A connect that never came up fails the turn too.
    const b = make();
    b.watch.send({ id: 'u1', message: item('q'), session: 1 });
    b.watch.hardSignal({ cause: 'pc_failed', inCall: false });
    b.watch.connectFailed();
    assert.deepEqual([b.fails[0].cause, b.fails[0].hard], ['connect_failed', true]);
});

test('Try again is the person asking: a fresh 60 s, its session re-sends the turn; if that dies too it fails, with no automatic session after the tap', () => {
    const { clock, watch, fails, events } = make();
    watch.send({ id: 'u1', message: item('q'), session: 1 });
    clock.advance(60000);
    assert.equal(watch.view().state, 'failed');
    assert.equal(watch.retry(), true);
    assert.equal(watch.retry(), false, 'only from failed');
    assert.deepEqual(watch.view(), { state: 'recovering', dots: true, label: 'Connection dropped. Reconnecting...', failed: null });
    assert.deepEqual(watch.sessionStarted(2).map((e) => e.id), ['u1']);
    clock.advance(3000);
    watch.output({ final: true });
    const rec = events.find((e) => e.name === 'turn_recovered');
    assert.deepEqual(rec.meta, { turnId: 'u1', step: 'user_retry', msToReply: 3000 });
    // Again, but the retry session dies: failed, not another automatic connect.
    const b = make();
    b.watch.send({ id: 'u1', message: item('q'), session: 1 });
    b.watch.hardSignal({ cause: 'pc_failed', inCall: false });
    b.watch.connectFailed();
    b.watch.retry();
    b.watch.sessionStarted(3);
    assert.equal(b.watch.hardSignal({ cause: 'session_closed:expired', inCall: false }).action, 'fail');
    assert.equal(b.fails.length, 2);
    assert.equal(fails.length, 1);
    // In a call the session stays open: Try again re-sends into that same one.
    const c = make();
    c.watch.send({ id: 'u1', message: item('q'), session: 7 });
    c.watch.fail('cap');
    c.watch.retry();
    assert.deepEqual(c.watch.sessionStarted(7).map((e) => e.id), ['u1']);
});

test('a recovered turn reports fresh_session when the answer arrives', () => {
    const { clock, watch, events } = make();
    watch.send({ id: 'u1', message: item('q'), session: 1 });
    watch.hardSignal({ cause: 'session_closed:expired', inCall: false });
    watch.sessionStarted(2);
    clock.advance(4200);
    watch.output({ final: false });
    assert.deepEqual(events.find((e) => e.name === 'turn_recovered').meta, { turnId: 'u1', step: 'fresh_session', msToReply: 4200 });
});

test('a new send restarts the clock and joins the open turn; reset clears everything', () => {
    const { clock, watch } = make();
    watch.send({ id: 'u1', message: item('a'), session: 1 });
    clock.advance(50000);
    watch.send({ id: 'u2', message: item('b'), session: 1 });
    clock.advance(20000);
    assert.equal(watch.view().state, 'waiting', '60 s from the latest send, not the first');
    assert.deepEqual(watch.openIds(), ['u1', 'u2']);
    watch.reset();
    assert.deepEqual(watch.view(), { state: 'idle', dots: false, label: null, failed: null });
    assert.equal(clock.pending(), 0);
});

// The invariant the whole thing exists for: no indicator spins forever.
test('fuzz: the dots show only while waiting or recovering, and never 60 s past the latest send', () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let run = 0; run < 40; run++) {
        const { clock, watch } = make();
        let lastSend = null;
        let session = 1;
        for (let step = 0; step < 120; step++) {
            const r = rnd();
            if (r < 0.15) { watch.send({ id: 'u' + step, message: item('x'), session }); lastSend = clock.now(); }
            else if (r < 0.2) { watch.queue(); lastSend = clock.now(); }
            else if (r < 0.3) watch.output({ final: rnd() < 0.5 });
            else if (r < 0.38) watch.hardSignal({ cause: 'pc_failed', inCall: rnd() < 0.3, cut: rnd() < 0.1 });
            else if (r < 0.45) watch.sessionStarted(++session);
            else if (r < 0.5) { if (watch.retry()) lastSend = clock.now(); }
            else if (r < 0.55) watch.toolStart('c' + step, 'deep_think');
            else if (r < 0.6) watch.toolEnd('c' + (step - 1));
            else if (r < 0.63) watch.connectFailed();
            else clock.advance(Math.floor(rnd() * 20000));
            const v = watch.view();
            if (v.dots) {
                assert.ok(['waiting', 'recovering'].includes(v.state), `dots in ${v.state}`);
                assert.ok(clock.now() - lastSend < 60000, `dots ${clock.now() - lastSend} ms after the send`);
            }
            if (['idle', 'done', 'failed', 'streaming'].includes(v.state)) assert.equal(v.dots, false);
        }
        clock.advance(61000);
        assert.equal(watch.view().dots, false, 'after 61 quiet seconds nothing is showing');
    }
});

// Owner decision (2026-10-28, staging probe): user-role text in GPT-Live's
// session.input is what the content filter closed sessions on. Chat-mode
// sessions get the coach's messages only; the backend gets the whole window
// as items after session.started. A content close blocks what was in the
// window from every later session.input, also in a call.
test('liveHistoryPlan: chat keeps user text out of session.input and gives the backend the window; a call keeps it, minus what a content close blocked', () => {
    const window = [
        { role: 'user', text: 'I have an interview' },
        { role: 'assistant', text: 'Tell me more' },
        { role: 'user', text: 'MARKER crisis text' },
        { role: 'assistant', text: 'I am here with you' },
    ];
    const chat = tw.liveHistoryPlan(window, { callMode: false });
    assert.deepEqual(chat.input.map((t) => t.role), ['assistant', 'assistant']);
    assert.deepEqual(chat.backend, window, 'the backend keeps the whole conversation, in order');
    const call = tw.liveHistoryPlan(window, { callMode: true });
    assert.deepEqual(call.input, window);
    assert.deepEqual(call.backend, [], 'nothing twice when session.input already carries it all');
    const blocked = [tw.messageKey(window[2]), tw.messageKey(window[3])];
    const after = tw.liveHistoryPlan(window, { callMode: true, blocked });
    assert.deepEqual(after.input.map((t) => t.text), ['I have an interview', 'Tell me more']);
    assert.deepEqual(after.backend, window);
    assert.deepEqual(tw.liveHistoryPlan([], { callMode: false }), { input: [], backend: [] });
    // Keys: stable across reloads and id schemes, and no text in them.
    assert.equal(tw.messageKey({ role: 'user', text: 'ok' }), tw.messageKey({ role: 'user', content: 'ok' }));
    assert.notEqual(tw.messageKey({ role: 'user', text: 'ok' }), tw.messageKey({ role: 'assistant', text: 'ok' }));
    assert.match(tw.messageKey(window[2]), /^k[0-9a-f]{8}$/);
});

// Owner decision (2026-10-28): the site's own crisis guidance names only the
// TT article and generic professional / emergency help — no phone numbers.
test('the safety card: static copy; a link on the web, a plain pointer with no URL in the My Talents app', () => {
    const web = tw.safetyCardContent({ inApp: false });
    assert.equal(web.title, 'Support is available');
    assert.deepEqual(web.paragraphs, [
        "If you're going through something difficult right now, you're not alone, and your well-being matters. Please consider speaking with a licensed mental health professional. If you're thinking about harming yourself or you're in immediate danger, contact your local emergency services now.",
        "Here's a resource with steps and helplines that might help:",
    ]);
    assert.deepEqual(web.link, { label: 'Finding Mental Health Support', url: 'https://www.talenttransformation.com/post/finding-mental-health-support' });
    assert.equal(web.pointer, null);
    const app = tw.safetyCardContent({ inApp: true });
    assert.equal(app.link, null);
    assert.equal(app.pointer, 'Search for "Finding Mental Health Support" on talenttransformation.com.');
    assert.doesNotMatch(JSON.stringify(app), /https?:/);
    assert.doesNotMatch(JSON.stringify(web), /\d{3}[- ]?\d{3,4}|988|112|911/, 'no hard-coded phone number');
    // Who is the app: no caller (the webview) or caller=app, or a native bridge.
    assert.equal(tw.isNativeApp({ caller: 'app', hasBridge: false }), true);
    assert.equal(tw.isNativeApp({ caller: 'web', hasBridge: true }), true);
    assert.equal(tw.isNativeApp({ caller: 'web', hasBridge: false }), false);
    assert.equal(tw.isNativeApp({ caller: 'admin-simulator', hasBridge: false }), false);
});

test('limits: the timeouts PR1 sets', () => {
    assert.deepEqual(
        [tw.LIMITS.thinkingMs, tw.LIMITS.stillMs, tw.LIMITS.capMs, tw.LIMITS.toolMs, tw.LIMITS.deepThinkMs, tw.LIMITS.connectMs, tw.LIMITS.maxRecoveries],
        [4000, 15000, 60000, 20000, 30000, 12000, 1]);
});
