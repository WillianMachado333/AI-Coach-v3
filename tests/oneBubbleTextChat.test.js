// TT-2233 (Eric, Edge on Windows, after several complex questions): one typed
// question gave two bubbles. The voice layer's transcript (live-bot-*) and the
// backend's answer (live-deleg-*) both rendered in a text chat, and
// upsertMessage matches by id, so nothing merged them: a spoken paraphrase cut
// off mid-sentence, then the full answer, sometimes a stray "Mm-hmm.".
//
// In a text chat the voice layer's words are held. If the backend answers
// they are dropped (with a log line); if she was the only one to answer they
// render, 1.5 s after her last word. A call is as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/appHarness');
const tw = require('../lib/turnWatch');

const FULL = 'There are three things to weigh here: the salary range, the growth path, and the team you would work with. Start with the growth path.';

function harness(opts) {
    const h = createHarness(opts);
    h.app._liveStandby = true;
    h.app._voiceStepChecked = true;
    h.app._silentCallArm = () => {};
    return h;
}
const bots = (h) => h.app.messages.filter((m) => m.role === 'bot');
const delegation = (h) => h.live.deliver({ type: 'session.delegation.created' });
const heldLog = (h) => h.logs.log.filter((a) => /voice-layer words held back/.test(String(a[0])));

test('text chat: the voice layer says words, the backend delegation starts and answers: one bot bubble, the backend text, never the voice words', async () => {
    const h = harness();
    h.app.sendTextMessage('Which offer should I take?');
    await h.advance(3000);
    h.live.say('Mm-hmm. So what is the main');
    await h.advance(300);
    assert.equal(bots(h).length, 0, 'the voice words are held, not rendered');
    assert.equal(h.indicator().visible, true, 'the dots stay while the answer is on its way');
    delegation(h);
    await h.advance(300);
    h.live.reply(FULL);
    await h.advance(3000);
    assert.equal(bots(h).length, 1, 'exactly one bot bubble');
    assert.equal(bots(h)[0].text, FULL);
    assert.equal(bots(h)[0].final, true);
    assert.ok(!h.app.messages.some((m) => /Mm-hmm|what is the main/.test(m.text)), 'none with the voice words');
    assert.equal(h.indicator().visible, false, 'the answer replaced the dots');
    assert.equal(heldLog(h).length, 1, 'dropping them is not silent: one log line');
    assert.equal(h.failedNote(), null);
    assert.deepEqual(h.events('turn_failed'), []);
});

test('text chat: the voice words come after the backend answer (a late paraphrase of it): still one bubble', async () => {
    const h = harness();
    h.app.sendTextMessage('Which offer should I take?');
    await h.advance(3000);
    delegation(h);
    h.live.reply(FULL);
    await h.advance(500);
    h.live.say('So the short version is, start with the growth');
    await h.advance(3000);
    assert.equal(bots(h).length, 1);
    assert.equal(bots(h)[0].text, FULL);
    assert.equal(heldLog(h).length, 1);
});

test('text chat: the voice layer is the only one to answer (no delegation): one finalised bubble 1.5 s after her last word, the dots stay until then', async () => {
    const h = harness();
    h.app.sendTextMessage('thanks, bye');
    await h.advance(3000);
    h.live.say('You are welcome, ');
    await h.advance(600);
    h.live.say('good luck!');
    await h.advance(1000);
    assert.equal(bots(h).length, 0, 'not yet: still inside the 1.5 s');
    assert.equal(h.indicator().visible, true, 'the dots stay');
    await h.advance(700);
    assert.equal(bots(h).length, 1);
    assert.equal(bots(h)[0].text, 'You are welcome, good luck!');
    assert.equal(bots(h)[0].final, true);
    assert.equal(h.indicator().visible, false, 'the answer replaced the dots');
    assert.equal(heldLog(h).length, 0);
    await h.advance(2 * 60000);
    assert.equal(h.failedNote(), null, 'no false failure');
});

test('text chat: a second question after an answered one is judged on its own: a voice-only reply to it renders', async () => {
    const h = harness();
    h.app.sendTextMessage('Which offer should I take?');
    await h.advance(3000);
    delegation(h);
    h.live.reply(FULL);
    await h.advance(2000);
    h.app.sendTextMessage('thanks!');
    await h.advance(800);
    h.live.say('Anytime.');
    await h.advance(2000);
    assert.deepEqual(bots(h).map((m) => m.text), [FULL, 'Anytime.']);
});

test('text chat: a held voice reply that the session cuts off is a cut-off reply for the turn watch, as before (no silent resend)', async () => {
    const h = harness();
    h.app.sendTextMessage('Q typed in chat');
    await h.advance(3000);
    h.live.say('Let me check that.');
    await h.advance(2500);
    h.live.closeSession('expired');
    await h.advance(10000);
    assert.ok(h.failedNote(), 'the failure shows');
    assert.equal(h.events('turn_failed')[0].meta.partial, true);
});

test('call: the voice layer renders as before, streaming, and the backend text is held', async () => {
    const h = harness();
    h.app.toggleMicTrack();
    await h.advance(3000);
    h.app.sendTextMessage('Which offer should I take?');
    await h.advance(300);
    h.live.say('Let me think about that.');
    await h.advance(200);
    assert.equal(bots(h).length, 1, 'the spoken words show at once');
    assert.equal(bots(h)[0].text, 'Let me think about that.');
    assert.equal(bots(h)[0].final, false, 'still streaming');
    delegation(h);
    h.live.reply(FULL);
    await h.advance(200);
    assert.equal(bots(h).length, 1, 'the backend text is held in a call: the spoken transcript is the reply');
    await h.advance(3000);
    assert.equal(heldLog(h).length, 0, 'no text-chat hold in a call');
    assert.equal(bots(h)[0].final, true);
});

test('the turn watch: a held reply counts as started but the dots stay until something shows', () => {
    const views = [];
    const w = tw.createTurnWatch({ setTimer: () => 0, clearTimer: () => {}, onChange: (v) => views.push(v) });
    w.send({ id: 'u1', message: { type: 'm' }, session: 1 });
    assert.equal(w.view().dots, true, 'waiting');
    w.output({ key: 'live-bot-1', final: false, held: true });
    assert.equal(w.view().dots, true, 'held: the dots stay');
    assert.equal(w.isOpen(), false, 'but a reply has started (nothing is waiting)');
    w.output({ key: 'live-deleg-1', final: false });
    assert.equal(w.view().dots, false, 'something shows: the dots go');

    // A session that dies while it is held: cut off, never re-sent.
    const d = tw.createTurnWatch({ setTimer: () => 0, clearTimer: () => {} });
    d.send({ id: 'u2', message: { type: 'm' }, session: 1 });
    d.output({ key: 'live-bot-2', final: false, held: true });
    assert.equal(d.hardSignal({ cause: 'expired' }).action, 'fail');

    // A turn nothing ever came for: the dots, then the same recovery as before.
    const n = tw.createTurnWatch({ setTimer: () => 0, clearTimer: () => {} });
    n.send({ id: 'u3', message: { type: 'm' }, session: 1 });
    assert.equal(n.hardSignal({ cause: 'expired' }).action, 'recover');
    assert.equal(n.sessionStarted(2).length, 1, 're-sent once');
    assert.equal(n.view().dots, true);
});
