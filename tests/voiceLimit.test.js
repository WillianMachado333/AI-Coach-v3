// The voice rule, as V2 production has it (AgentErica app.js: checkVoiceLimit,
// toggleMicTrack's login gate, incrementVoiceUsage; uiLayout/index.html for
// the prompts). AFAZERES #15: V3 had switched the start check off while the
// count still ended calls at questionsLimit, so a call stopped under a rule
// nobody could see. Now one function (voiceRefusal) answers both.
//   - a guest (no userId): no voice, the sign-up prompt. V2 has no guest allowance.
//   - a member: questionsLimit coach answers in calls per UTC day (Wix
//     preparation: 25, or 200000 on a paid plan); not loaded = no limit.
//   - used today = max(this device's count, today's voice questions in the
//     member's saved history).
//   - text: never counted, never refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers/appHarness');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const KEY = 'erica_voice_usage_v1';

// The harness opens voice for everyone (checkVoiceLimit and
// incrementVoiceUsage stubbed): here the real ones run, and the prompts are
// recorded instead of shown.
function harness({ userId = null, limit, used = 0, usedOn = null, serverUsed = 0, savedState = null, search = '' } = {}) {
    const shown = [];
    const h = createHarness({
        savedState, search,
        setup: (app) => {
            delete app.checkVoiceLimit;
            delete app.incrementVoiceUsage;
            app.getUserIdFromURL = () => userId;
            app._silentCallArm = () => {};
            app._voiceStepChecked = true;
            app.showLoginPrompt = () => shown.push('sign-up');
            app.showVoiceLimitUpgradeModal = () => shown.push('upgrade');
            app.showLimitReachedPrompt = () => shown.push('limit');
            if (limit !== undefined) app.questionsLimit = limit;
            app._serverVoiceUsageCount = serverUsed;
        },
    });
    h.shown = shown;
    h.app._liveStandby = true;
    if (used || usedOn) h.ctx.localStorage.setItem(KEY, JSON.stringify({ date: usedOn || h.app._getTodayString(), count: used }));
    h.count = () => (JSON.parse(h.ctx.localStorage.getItem(KEY) || '{"count":0}').count);
    h.refusals = () => h.events('voice_refused').map((e) => e.meta);
    return h;
}

test('a guest is refused voice with the sign-up prompt, whatever the count: no session, no voice step', async () => {
    for (const used of [0, 3]) {
        const h = harness({ limit: 25, used });
        h.app._voiceStepChecked = false;
        h.app.toggleMicTrack();
        await h.advance(3000);
        assert.deepEqual(h.shown, ['sign-up'], `used ${used}: the sign-up prompt`);
        assert.equal(h.live.creates.length, 0, 'nothing connects');
        assert.equal(h.app.isRecording, false);
        assert.equal(h.app._voiceStepChecked, false, 'the voice step is not spent on a refused call');
        assert.deepEqual(h.refusals(), [{ why: 'login', via: 'tap', used, limit: 25 }]);
    }
});

test('a guest is refused even before the preparation brings a limit (V2: the login gate does not need one)', async () => {
    const h = harness({});
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.deepEqual(h.shown, ['sign-up']);
    assert.equal(h.live.creates.length, 0);
});

test('a member under the limit starts a call', async () => {
    const h = harness({ userId: 'member-1', limit: 25, used: 24 });
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.deepEqual(h.shown, []);
    assert.equal(h.live.creates.length, 1);
    assert.equal(h.app.isRecording, true);
    assert.equal(h.refusals().length, 0);
});

test('a member at the limit who taps the call button gets the upgrade prompt and no call', async () => {
    const h = harness({ userId: 'member-1', limit: 25, used: 25 });
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.deepEqual(h.shown, ['upgrade']);
    assert.equal(h.live.creates.length, 0);
    assert.equal(h.app.isRecording, false);
    assert.deepEqual(h.refusals(), [{ why: 'limit', via: 'tap', used: 25, limit: 25 }]);
});

test('today\'s voice questions in the member\'s saved history count too (V2 effectiveCount): a cleared device does not reset the day', async () => {
    const h = harness({ userId: 'member-1', limit: 25, used: 0, serverUsed: 25 });
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.deepEqual(h.shown, ['upgrade']);
    assert.equal(h.live.creates.length, 0);
});

test('a new UTC day starts from zero', async () => {
    const h = harness({ userId: 'member-1', limit: 25, used: 25, usedOn: '2026-10-27' });
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.deepEqual(h.shown, []);
    assert.equal(h.app.isRecording, true);
});

test('a member on a paid plan (questionsLimit 200000) is not refused after a heavy day', async () => {
    const h = harness({ userId: 'member-1', limit: 200000, used: 500, serverUsed: 480 });
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.deepEqual(h.shown, []);
    assert.equal(h.app.isRecording, true);
});

test('no questionsLimit loaded: a member has no limit (V2: "No limit enforced"); the count still runs', async () => {
    const h = harness({ userId: 'member-1', used: 9999 });
    assert.equal(h.app.questionsLimit, undefined);
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.deepEqual(h.shown, []);
    assert.equal(h.app.isRecording, true);
    h.live.say('Here is one thought.');
    await h.advance(2000);
    assert.equal(h.count(), 10000, 'counted');
    assert.equal(h.app.isRecording, true, 'and the call goes on');
});

test('reaching the limit mid-call ends the call like a hang-up, with V2\'s limit message; the next tap is refused', async () => {
    const h = harness({ userId: 'member-1', limit: 3, used: 1 });
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.equal(h.app.isRecording, true);
    h.live.say('First answer.');
    await h.advance(2000);
    assert.equal(h.count(), 2, 'one of the coach\'s answers in a call is one use');
    assert.equal(h.app.isRecording, true, 'under the limit: the call goes on');
    assert.deepEqual(h.shown, []);

    h.live.say('Second answer.');
    await h.advance(2000);
    assert.equal(h.count(), 3);
    assert.equal(h.app.isRecording, false, 'the call ended');
    assert.equal(h.app.localStream, null, 'the mic is released');
    assert.equal(h.app.audioOutputGate, true, 'her audio is gated');
    assert.equal(h.state().mode, 'chat', 'a reload does not bring the call back');
    assert.deepEqual(h.shown, ['limit'], 'V2\'s "You’ve reached your voice limit for today" message');
    assert.deepEqual(h.events('voice_limit_reached').map((e) => e.meta), [{ why: 'limit', used: 3, limit: 3 }]);
    assert.deepEqual(h.clock.errors, [], 'no exception on the way');

    // Nothing reconnects for the call, and the same rule refuses the next tap.
    await h.advance(5 * 60 * 1000);
    assert.equal(h.live.creates.length, 1, 'no automatic reconnect');
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.deepEqual(h.shown, ['limit', 'upgrade']);
    assert.equal(h.live.creates.length, 1);
    assert.equal(h.app.isRecording, false);
});

test('mid-call the count uses the same "used today" as the start: today\'s voice in the saved history, learned during the call, ends it at the next answer', async () => {
    const h = harness({ userId: 'member-1', limit: 25, used: 1 });
    h.app.toggleMicTrack();
    await h.advance(3000);
    assert.equal(h.app.isRecording, true);
    // A history fetch during the call (a reconnect) shows another device's voice today.
    h.app._serverVoiceUsageCount = 30;
    h.live.say('An answer.');
    await h.advance(2000);
    assert.equal(h.count(), 2, 'this device: 2');
    assert.equal(h.app.isRecording, false, 'but the day is used up: the call ends (V2 compared only this device\'s count here)');
    assert.deepEqual(h.shown, ['limit']);
    assert.deepEqual(h.events('voice_limit_reached').map((e) => e.meta), [{ why: 'limit', used: 30, limit: 25 }]);
});

test('text chat at the limit is never refused, and its answers never count — the voice layer\'s filler words in chat neither', async () => {
    const h = harness({ userId: 'member-1', limit: 2, used: 2 });
    h.app.sendTextMessage('hello');
    await h.advance(3000);
    assert.equal(h.live.creates.length, 1, 'the chat session connects');
    h.live.say('Let me check.');
    await h.advance(2000);
    h.live.reply('Here is your answer');
    await h.advance(500);
    assert.ok(h.app.messages.some((m) => m.role === 'bot' && m.final && m.text === 'Here is your answer'), 'the answer renders');
    assert.equal(h.count(), 2, 'not counted');
    assert.deepEqual(h.shown, [], 'no prompt');
    assert.equal(h.refusals().length, 0);

    // A guest's chat the same.
    const g = harness({ limit: 25 });
    g.app.sendTextMessage('hello');
    await g.advance(3000);
    g.live.reply('Hi there');
    await g.advance(500);
    assert.equal(g.live.creates.length, 1);
    assert.equal(g.count(), 0);
    assert.deepEqual(g.shown, []);
});

test('a call left open is restored only under the rule: a guest gets the sign-up prompt at load, a member at the limit the limit message', async () => {
    const g = harness({ savedState: { mode: 'call' } });
    g.app.restoreModeIfNeeded();
    await g.advance(3000);
    assert.deepEqual(g.shown, ['sign-up']);
    assert.equal(g.live.creates.length, 0);
    assert.equal(g.app.isRecording, false);

    const m = harness({ userId: 'member-1', limit: 25, used: 25, savedState: { mode: 'call' } });
    m.app.restoreModeIfNeeded();
    await m.advance(3000);
    assert.deepEqual(m.shown, ['limit']);
    assert.equal(m.live.creates.length, 0);
    assert.deepEqual(m.refusals().map((r) => r.via), ['restore']);

    const ok = harness({ userId: 'member-1', limit: 25, used: 3, savedState: { mode: 'call' } });
    ok.app.restoreModeIfNeeded();
    await ok.advance(3000);
    assert.deepEqual(ok.shown, []);
    assert.equal(ok.live.creates.length, 1);
    assert.equal(ok.app.isRecording, true);
});

test('?voiceMode=true: a guest gets the sign-up prompt instead of the call', async () => {
    const h = harness({ search: '?voiceMode=true' });
    h.app.restoreModeIfNeeded();
    await h.advance(3000);
    assert.deepEqual(h.shown, ['sign-up']);
    assert.equal(h.live.creates.length, 0);
});

test('startRecording and a connect for a call apply the same rule themselves; a connect for text does not', async () => {
    const h = harness({ userId: 'member-1', limit: 25, used: 25 });
    const proto = h.ctx.__VoiceChatBot.prototype;
    // (Each awaited behind a clock advance: a broken rule fails, never hangs.)
    const start = proto.startRecording.call(h.app).then(() => 'started', (e) => e.message);
    await h.advance(3000);
    assert.match(await start, /voice rule/);
    assert.equal(h.app.isRecording, false);
    h.app._connectForCall = true;
    const call = h.app.connect();
    await h.advance(3000);
    await call;
    assert.equal(h.live.creates.length, 0, 'no session for a refused call');
    h.app._connectForCall = false;
    const text = h.app.connect({ skipOpeningLine: true });
    await h.advance(3000);
    await text;
    assert.equal(h.live.creates.length, 1, 'a text session connects');
    assert.deepEqual(h.shown, ['limit', 'limit']);
    assert.deepEqual(h.refusals().map((r) => r.via), ['start', 'connect']);
});

test('one rule: the only comparison with questionsLimit is in voiceRefusal, and the start and the count both go through it', () => {
    const src = read('app.js');
    const main = src.slice(0, src.indexOf('class PreviewSession'));
    assert.equal((main.match(/>=\s*this\.questionsLimit/g) || []).length, 1, 'one comparison');
    const body = (name) => {
        const m = main.match(new RegExp(`\\n    (async )?${name}\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n    \\}\\r?\\n`));
        assert.ok(m, `${name} found`);
        return m[0];
    };
    assert.match(body('voiceRefusal'), /if \(!this\.getUserIdFromURL\(\)\) return 'login';\s*if \(!this\.questionsLimit\) return null;\s*return this\._voiceUsedToday\(\) >= this\.questionsLimit \? 'limit' : null;/);
    assert.match(body('checkVoiceLimit'), /return !this\.voiceRefusal\(\);/);
    assert.match(body('incrementVoiceUsage'), /const why = this\.voiceRefusal\(\);/);
    assert.match(body('_refuseVoiceStart'), /if \(this\.checkVoiceLimit\(\)\) return false;/);
    // Counted: a final coach message in a call, once.
    assert.match(main, /if \(role === 'bot' && this\.isRecording && !wasFinal\) \{\s*this\.incrementVoiceUsage\(\);/);
    // The prototype-phase switches are gone.
    assert.doesNotMatch(main, /Prototype phase: no (daily voice-mode limit|login gate)/);
});

test('the prompts carry V2 production\'s copy (index.html, unchanged from AgentErica)', () => {
    const flat = (s) => s.replace(/\s+/g, ' ');
    const html = read('index.html');
    const modal = (id) => {
        const start = html.indexOf(`id="${id}"`);
        assert.ok(start > 0, `#${id} exists`);
        return flat(html.slice(start, html.indexOf('<!--', start)));
    };
    const signUp = modal('loginPromptModal');
    assert.ok(signUp.includes('We\'re here to support you. Sign up to unlock voice conversations and get guidance that\'s tailored for you.'));
    assert.ok(signUp.includes('Yes, I Want Personalized Guidance'));
    assert.ok(signUp.includes('No Thanks. Maybe Later'));
    const limit = modal('limitReachedModal');
    assert.ok(limit.includes('You’ve reached your voice limit for today. You can keep chatting by text. Voice will be back tomorrow.'));
    assert.ok(limit.includes('OK, Got it'));
    const upgrade = modal('voiceUpgradeModal');
    assert.ok(upgrade.includes('Want more voice time?'));
    assert.ok(upgrade.includes('You\'ve reached your daily voice limit. Upgrade to continue talking.'));
    assert.ok(upgrade.includes('Yep, upgrade me'));
    assert.ok(upgrade.includes('It’s okay. I’ll keep typing.'));
    // The yes buttons ask the host to sign in / upgrade, as V2.
    const ui = read('uiLayout.js');
    assert.match(ui, /sendToHost\(\{ action: "ericaRequestLogin" \}\)/);
    assert.match(ui, /sendToHost\(\{ action: "ericaRequestUpgrade" \}\)/);
});
