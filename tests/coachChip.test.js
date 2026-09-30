// #35 (c): the header chip (face + name, never the style), renaming the coach
// by conversation (change_coach_name) or ⋮, kept in the person's settings on
// the server (not the device), the Live voice layer told at once, and a quiet
// reconnect after the reply so the name is part of the next session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function method(sig) {
    const isAsync = src.indexOf(`    ${sig} {`) < 0;
    const start = isAsync ? src.indexOf(`    async ${sig} {`) : src.indexOf(`    ${sig} {`);
    assert.ok(start >= 0, 'method not found: ' + sig);
    const open = src.indexOf(') {', start) + 2;
    let depth = 0; let i = open;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
    const params = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    const Fn = isAsync ? (async () => {}).constructor : Function;
    // eslint-disable-next-line no-new-func
    return new Fn(params, src.slice(open + 1, i));
}

function fakeApp({ mode = 'live', connected = true, names = {} } = {}) {
    const log = [];
    const el = {};
    global.document = { getElementById: (id) => el[id] || null, querySelectorAll: () => [] };
    el.coachChip = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, classList: { toggle() {} } };
    el.coachChipName = { textContent: '' };
    el.coachChipThumb = { src: '' };
    const app = {
        voiceApiMode: mode, isConnected: connected, isRecording: false, selectedCompanionId: 'Supportive',
        currentVoiceProfile: { character: 'Erica', companionId: 'Supportive' }, currentVoiceThumbUrl: 'companions/Erica-thumb.png',
        _coachSettings: { scope: 'account', settings: { customNames: names } },
        trackCoachEvent: () => {}, configureSession: () => log.push(['configure']),
        _saveCoachSettings: (set, by) => { log.push(['save', set, by]); },
        _logSessionEvent: (n, m) => log.push(['event', n, m]),
        sendMessage: (m) => { log.push(['send', m]); return true; },
        getEffectiveVoiceProfile() { return this.currentVoiceProfile; },
    };
    app._currentCompanionId = method('_currentCompanionId()').bind(app);
    app._customNameFor = method('_customNameFor(companionId)').bind(app);
    app._updateCoachChip = method('_updateCoachChip()').bind(app);
    app.setCoachDisplayName = method("setCoachDisplayName(newName, via = 'menu')").bind(app);
    app._nameHintAllowed = method('_nameHintAllowed()').bind(app);
    app._nameHintLine = method('_nameHintLine()').bind(app);
    return { app, log, el };
}

test('rename by conversation: kept in the settings (not the device), the Live voice layer told at once, a quiet reconnect queued, the chip shows it', () => {
    global.window = { localStorage: { setItem: () => { throw new Error('must not write the device'); }, getItem: () => null, removeItem: () => {} } };
    const { app, log, el } = fakeApp();
    app.setCoachDisplayName('Ana', 'tool');
    assert.equal(app.currentVoiceProfile.character, 'Ana');
    assert.deepEqual(log.find((l) => l[0] === 'save'), ['save', { customNames: { Supportive: 'Ana' } }, 'tool']);
    const append = log.find((l) => l[0] === 'send' && l[1].type === 'session.instructions.append')[1];
    assert.equal(append.delegation_id, null);
    assert.match(append.content, /Your name is now Ana — the person chose it\. Use Ana from now on, including when you introduce yourself\./);
    assert.equal(app._renameReconnectPending, true, 'reopen the session after the reply');
    assert.deepEqual(log.find((l) => l[1] === 'coach_renamed')[2], { from: 'Erica', to: 'Ana', companionId: 'Supportive', via: 'tool', reset: false });
    assert.equal(el.coachChipName.textContent, 'Ana');
    assert.match(el.coachChip.attrs['aria-label'], /^Ana — change how your coach looks and sounds$/);
    // Back to the original name: the stored name is removed.
    app.setCoachDisplayName('Erica', 'menu');
    assert.deepEqual(log.filter((l) => l[0] === 'save').at(-1), ['save', { customNames: { Supportive: null } }, 'menu']);
});

test('Realtime: one layer — the session update is enough, no append and no reconnect', () => {
    global.window = { localStorage: { setItem: () => {}, getItem: () => null, removeItem: () => {} } };
    const { app, log } = fakeApp({ mode: 'realtime' });
    app.setCoachDisplayName('Ana', 'tool');
    assert.ok(!log.some((l) => l[0] === 'send'));
    assert.equal(app._renameReconnectPending, undefined);
    assert.ok(log.some((l) => l[0] === 'configure'));
});

test('the greeting may offer a name once — only in a first conversation with no name chosen; never a question', () => {
    const fresh = fakeApp();
    fresh.app.messages = [];
    assert.equal(fresh.app._nameHintAllowed(), true);
    assert.match(fresh.app._nameHintLine(), /Only in your very first message, and only if it fits naturally, you may mention that the person can call you whatever they like \(for example: "I'm Erica — call me whatever you like"\)\. Never ask them for a name for you\./);
    const talked = fakeApp(); talked.app.messages = [{ role: 'user', text: 'hi' }];
    assert.equal(talked.app._nameHintAllowed(), false, 'not after the person has spoken');
    const named = fakeApp({ names: { Supportive: 'Ana' } }); named.app.messages = [];
    assert.equal(named.app._nameHintAllowed(), false, 'not once they have named the coach');
    assert.match(src, /if \(this\._nameHintAllowed\(\)\) instructions \+= '\\n\\n' \+ this\._nameHintLine\(\);/, 'backend instructions');
    assert.match(src, /'Begin the conversation with a brief, warm greeting introducing yourself\.' \+\s*\(this\._nameHintAllowed\(\) \? ' ' \+ this\._nameHintLine\(\) : ''\)/, 'Live voice layer');
});

test('wiring: the tool and ⋮ both go through the same rename; the name is restored at a visit start; old device names moved (signed-in) or removed (guest); the quiet reconnect waits for the reply and never runs in a call; the chip opens the cards outside a call', () => {
    assert.match(src, /this\.setCoachDisplayName\(newName, 'tool'\);/);
    assert.match(src, /Confirm it in one short, warm line and use this name from now on\./);
    const ui = fs.readFileSync(path.join(root, 'uiLayout.js'), 'utf8');
    assert.match(ui, /app\.setCoachDisplayName\(trimmed, 'menu'\);/);
    assert.match(ui, /getElementById\('coachChip'\);\s*if \(coachChip\) coachChip\.addEventListener\('click'/);
    assert.match(src, /const storedName = this\._customNameFor \? this\._customNameFor\(this\._currentCompanionId\(\)\) : null;/, 'setSelectedVoice reads the settings, not localStorage');
    assert.match(src, /\.then\(\(\) => this\._loadVoiceCards\(\)\)\.then\(\(\) => this\._applyStoredCoachSettings\(\)\)/, 'applied at page load (Live standby), not only when a session opens');
    assert.doesNotMatch(src, /localStorage\?\.setItem\(storageKey, String\(newName\)\)/, 'no rename written to the device');
    assert.match(src, /this\._migrateLegacyNames\(r\.scope === 'account'\);/);
    assert.match(src, /if \(role !== 'user' && this\._renameReconnectPending && !this\.isRecording\) \{/);
    assert.match(src, /if \(this\.isRecording\) \{ console\.log\('\[Erica\] 🎙️ Coach chip: change after the call'\); return; \}/);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.ok(html.indexOf('id="coachChip"') > 0 && html.indexOf('id="coachChip"') < html.indexOf('id="moreMenuBtn"'), 'chip in the header, left of ⋮');
});

test('the default coach (no picked card) still finds its stored name', () => {
    const { app } = fakeApp({ names: { Supportive: 'Ana' } });
    app.selectedCompanionId = null;
    app.currentVoiceProfile = { character: 'Erica', id: 'Supportive' };
    assert.equal(app._currentCompanionId(), 'Supportive');
    assert.equal(app._customNameFor(app._currentCompanionId()), 'Ana');
});

test('the name survives a profile rebuild: every connect reloads the preparation, which recreates the profiles with the card name', () => {
    const { app } = fakeApp({ names: { Supportive: 'Ana' } });
    app.selectedCompanionId = null;
    const fresh = { character: 'Erica', companionId: 'Supportive', openaiVoice: 'marin' };
    app.voiceProfilesByVoice = { marin: [fresh] };
    app.voiceProfilesById = { supportive: fresh };
    const calls = [];
    Object.assign(app, {
        resolveCompanionThumb: () => null, _announcePersonaToHost: () => calls.push(['host', app.currentVoiceProfile.character]),
        buildVoiceStyleInstructions: () => '', configureSession: () => calls.push(['configure', app.currentVoiceProfile.character]),
        populateAgentDetailsPanel: () => {},
    });
    global.window = { localStorage: { getItem: () => { throw new Error('names are not read from the device'); } } };
    method('updateVoiceProfile(openaiVoice)').call(app, 'marin');
    assert.equal(app.currentVoiceProfile, fresh);
    assert.equal(fresh.character, 'Ana');
    assert.equal(fresh._baseName, 'Erica');
    assert.deepEqual(calls, [['host', 'Ana'], ['configure', 'Ana']], 'the host and the session get the chosen name');
    // No name chosen: the card name stays.
    const other = fakeApp();
    const p2 = { character: 'Erica', companionId: 'Supportive', openaiVoice: 'marin' };
    Object.assign(other.app, { selectedCompanionId: null, voiceProfilesByVoice: { marin: [p2] }, voiceProfilesById: { supportive: p2 },
        resolveCompanionThumb: () => null, _announcePersonaToHost: () => {}, buildVoiceStyleInstructions: () => '', configureSession: () => {}, populateAgentDetailsPanel: () => {} });
    method('updateVoiceProfile(openaiVoice)').call(other.app, 'marin');
    assert.equal(p2.character, 'Erica');
});

test('the default coach (no picked card): the voice step knows what it has, so Skip after a preview goes back to it', () => {
    const { app } = fakeApp();
    app.selectedCompanionId = null;
    app.selectedVoice = 'marin';
    app.currentVoiceProfile = { character: 'Erica', companionId: 'Supportive' };
    app._voiceCards = [{ id: 'Supportive', name: 'Erica', voice: 'marin', thumb: 'e.png' }, { id: 'Guidance', name: 'Jasmine', voice: 'coral', thumb: 'j.png' }];
    app._cardForCompanion = method('_cardForCompanion(companionId, voice)').bind(app);
    app._voiceStepOriginalCard = method('_voiceStepOriginalCard()').bind(app);
    assert.equal(app._voiceStepOriginalCard().id, 'Supportive');
    // Not one of the cards (another voice): found in the profiles, whose ids are keyed lowercase.
    app._voiceCards = [];
    app.voiceProfilesById = { supportive: { character: 'Erica', openaiVoice: 'marin' } };
    assert.deepEqual(app._voiceStepOriginalCard(), { id: 'Supportive', name: 'Erica', thumb: null, voice: 'marin' });
});

test('quiet reconnect (new name or voice outside a call): the composer stays usable, a send in between queues instead of opening a second session, and a failure says so and still sends what was queued', async () => {
    const reconnect = method('_quietReconnect(options)');
    const run = async ({ opens }) => {
        const log = [];
        const app = {
            textInput: { disabled: false }, sendTextButton: { disabled: false }, _pendingTextMessages: [],
            disconnect: async () => { app.isConnected = false; app.textInput.disabled = true; app.sendTextButton.disabled = true; log.push('disconnect'); },
            establishConnection: async () => {
                log.push(['establish', { connecting: app.isConnecting, inputEnabled: !app.textInput.disabled }]);
                app._pendingTextMessages.push({ text: 'typed meanwhile' }); // the person keeps typing
            },
            _waitConnected: async () => { log.push(['wait', app.isConnecting]); return opens; },
            _maybeSendOpeningLine: async () => log.push('opening'),
            connect: async () => { log.push('connect'); },
            _sendPendingTextMessage: () => log.push('flush'),
        };
        global.window = {};
        const warn = console.warn; const err = console.error; const warned = [];
        console.warn = (...a) => warned.push(a.join(' ')); console.error = () => {};
        const open = await reconnect.call(app, { skipOpeningLine: true });
        await new Promise((r) => setTimeout(r, 0));
        console.warn = warn; console.error = err;
        return { app, log, open, warned };
    };
    const ok = await run({ opens: true });
    assert.equal(ok.open, true);
    assert.deepEqual(ok.log[1], ['establish', { connecting: true, inputEnabled: true }], 'flagged as connecting, composer usable');
    assert.deepEqual(ok.log[2], ['wait', true], 'still connecting until the new session is open');
    assert.equal(ok.app.isConnecting, false);
    assert.ok(!ok.log.includes('connect') && !ok.log.includes('opening'), 'no second session, no opening line');
    const bad = await run({ opens: false });
    assert.equal(bad.open, false);
    assert.match(bad.warned.join('\n'), /Session NOT reopened after the quiet reconnect — connecting again for 1 queued message\(s\)/);
    assert.deepEqual(bad.log.slice(-2), ['connect', 'flush']);
    // A send checks isConnecting before opening a session.
    assert.match(src, /this\._pendingTextMessages\.push\(\{ text, attachments \}\);[\s\S]{0,900}if \(!this\.isConnecting\) \{\s*this\.connect\(\{ skipOpeningLine: true \}\)/);
    // Both callers are quiet.
    assert.match(src, /this\.reconnectWithNewVoice\(\{ skipOpeningLine: true, quiet: true \}\)\s*\.then\(\(open\) =>/, 'the rename');
    assert.match(src, /await this\.reconnectWithNewVoice\(\{ skipOpeningLine: true, quiet: true \}\);/, 'the voice switch');
});

test('a rename while the Live session is still opening (isConnected is then the string "connecting"): no append into a missing channel; the reopen after the reply happens only if the session was created with the old name', async (t) => {
    global.window = { localStorage: { setItem: () => {}, getItem: () => null, removeItem: () => {} } };
    const { app, log } = fakeApp({ connected: 'connecting' });
    app.isConnecting = true;
    const logs = []; const l0 = console.log; console.log = (...a) => logs.push(a.join(' '));
    app.setCoachDisplayName('Ana', 'tool');
    console.log = l0;
    assert.ok(!log.some((l) => l[0] === 'send'), 'no append while opening');
    assert.match(logs.join('\n'), /Session still opening — the new name goes in when it is reopened after the next reply/);
    assert.equal(app._renameReconnectPending, true);
    // After the reply: reopen only if the session was created with another name.
    const note = method('_navNoteTurn(role, text, turnIndexHint)');
    const reopen = async (createdAs) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const calls = [];
        Object.assign(app, { _renameReconnectPending: true, isConnected: true, isRecording: false, _sessionCoachName: createdAs, _navState: null,
            reconnectWithNewVoice: (o) => { calls.push(o); return Promise.resolve(true); } });
        const q = console.log; console.log = () => {};
        note.call(app, 'assistant', 'Of course — I’m Ana from now on.');
        t.mock.timers.tick(800);
        console.log = q;
        t.mock.timers.reset();
        return calls;
    };
    assert.deepEqual(await reopen('Erica'), [{ skipOpeningLine: true, quiet: true }], 'created as Erica → reopened as Ana');
    assert.deepEqual(await reopen('Ana'), [], 'already created as Ana → nothing to do');
});

test('a card picked while the session is still opening: wait for it, then switch only if it opened with another voice', async () => {
    const switchTo = method('_switchVoiceTo(card)');
    const run = async (openedWith) => {
        const calls = [];
        const app = {
            selectedCompanionId: 'Supportive', selectedVoice: 'marin', isConnected: 'connecting', isConnecting: true, _sessionVoice: null,
            _applyCard(c) { this.selectedCompanionId = c.id; this.selectedVoice = c.voice; }, _noteCoachSwitch() {},
            _waitConnected: async () => { app.isConnected = true; app.isConnecting = false; app._sessionVoice = openedWith; return true; },
            reconnectWithNewVoice: async (o) => { calls.push(o); app._sessionVoice = app.selectedVoice; return true; },
        };
        await switchTo.call(app, { id: 'Empowering', voice: 'cedar' });
        return calls;
    };
    assert.deepEqual(await run('cedar'), [], 'the opening session already took cedar');
    assert.deepEqual(await run('marin'), [{ skipOpeningLine: true, quiet: true }], 'it opened with marin: one quiet switch');
});

test('a card picked mid-conversation: both layers are told who spoke before, so the new coach does not keep the old name; not on a restore, not before anyone spoke', () => {
    const { app } = fakeApp();
    app._noteCoachSwitch = method('_noteCoachSwitch()').bind(app);
    app._coachSwitchLine = method('_coachSwitchLine()').bind(app);
    app.messages = [{ role: 'user', text: 'hi' }];
    app._noteCoachSwitch(); // only the person has spoken: nothing signed by Erica yet
    assert.equal(app._coachSwitchLine(), '');
    app.messages.push({ role: 'bot', text: "Hi! I'm Erica." });
    app._noteCoachSwitch();
    app.currentVoiceProfile = { character: 'Michael', companionId: 'Empowering' };
    assert.equal(app._coachSwitchLine(), 'The person switched coaches during this conversation: earlier replies were from Erica. You are Michael now — introduce yourself as Michael and never call yourself Erica.');
    app._noteCoachSwitch(); // Michael → back to Erica
    app.currentVoiceProfile = { character: 'Erica', companionId: 'Supportive' };
    assert.equal(app._coachSwitchLine(), 'The person switched coaches during this conversation: earlier replies were from Michael. You are Erica now — introduce yourself as Erica and never call yourself Michael.');
    // Wiring: the person's switches only (the voice step's switch), into both layers.
    assert.match(src, /if \(!sameFace \|\| target\.voice !== this\.selectedVoice\) \{ this\._noteCoachSwitch\(\); this\._applyCard\(target\); \}/);
    const restore = src.slice(src.indexOf('    async _applyStoredCoachSettings() {'), src.indexOf('    _urlCoachGiven() {'));
    assert.ok(restore.includes('this._applyCard(card)') && !restore.includes('_noteCoachSwitch'), 'a restore at page load is not a switch');
    assert.match(src, /if \(this\._coachSwitchLine\(\)\) instructions \+= '\\n\\n' \+ this\._coachSwitchLine\(\);/, 'backend');
    assert.match(src, /\+ \(this\._coachSwitchLine\(\) \? ' ' \+ this\._coachSwitchLine\(\) : ''\);/, 'Live voice layer');
});

test('voice step sheet: dragging it down past 60 px or flicking it down closes it like Skip / Cancel; short, slow, sideways or cancelled drags do not', () => {
    const bind = method('_bindVoiceStepDrag(box)');
    let clock = 0;
    global.performance = { now: () => clock };
    const run = (moves, { endType = 'pointerup' } = {}) => {
        const on = {};
        const box = { style: {}, addEventListener: (t, f) => { on[t] = f; }, setPointerCapture() {} };
        let closed = 0;
        const app = { _voiceStepCancel: () => { closed++; } };
        bind.call(app, box);
        clock = 0;
        on.pointerdown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
        let last = { x: 100, y: 100 };
        for (const [dt, dx, dy] of moves) { clock += dt; last = { x: 100 + dx, y: 100 + dy }; on.pointermove({ pointerId: 1, clientX: last.x, clientY: last.y }); }
        clock += 8;
        on[endType]({ pointerId: 1, type: endType, clientX: last.x, clientY: last.y });
        return { closed, box };
    };
    const steps = (n, dt, dx, dy) => Array.from({ length: n }, (_, i) => [dt, dx * (i + 1) / n, dy * (i + 1) / n]);
    assert.equal(run(steps(20, 30, 0, 70)).closed, 1, 'slow drag down 70 px');
    assert.equal(run(steps(20, 30, 0, 40)).closed, 0, 'slow drag down 40 px');
    assert.equal(run(steps(6, 8, 0, 48)).closed, 1, 'flick: 48 px in ~50 ms');
    assert.equal(run(steps(6, 8, 0, 20)).closed, 0, 'a quick twitch under 24 px');
    assert.equal(run(steps(10, 16, -120, 70)).closed, 0, "sideways first: the carousel's pan, not a close");
    assert.equal(run(steps(20, 30, 0, 90), { endType: 'pointercancel' }).closed, 0, 'cancelled by the browser');
    assert.equal(run(steps(20, 30, 0, -90)).closed, 0, 'dragged up');
    const { box } = run(steps(20, 30, 0, 40));
    assert.equal(box.style.transform, '', 'springs back when not closed');
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    assert.match(css, /\.voice-step \{[^}]*touch-action: pan-x;/, 'vertical drags are the sheet\'s, horizontal pans the carousel\'s');
    assert.match(css, /\.voice-step-cards \{[^}]*overflow-x: auto;[^}]*scroll-snap-type: x mandatory;/);
    assert.match(css, /\.voice-card \{[^}]*flex: 0 0 calc\(\(100% - 24px\) \/ 4\); max-width: 96px; scroll-snap-align: start;/, '4 in view on a phone');
});

test('voice step carousel: all 8 coaches, the first four as before; previews fetched as cards come into view; SVG play badge with a playing state', () => {
    const cards = JSON.parse(fs.readFileSync(path.join(root, 'voiceCards.json'), 'utf8')).cards;
    assert.deepEqual(cards.map((c) => c.name), ['Erica', 'Jasmine', 'Michael', 'Sean', 'Steve', 'Evan', 'Sarah', 'Emma']);
    assert.equal(new Set(cards.map((c) => c.id)).size, 8);
    assert.match(src, /new IntersectionObserver\(\(entries\) => \{[\s\S]{0,400}this\._prefetchCardPreview\(card\);[\s\S]{0,200}\}, \{ root: list, threshold: 0\.5 \}\)/);
    assert.match(src, /if \(this\._voiceCardObserver\) this\._voiceCardObserver\.observe\(b\);\s*else if \(i < 4\) this\._prefetchCardPreview\(card\);/, 'no observer: the first four only');
    assert.ok(!/voice-card-play" aria-hidden="true">▶/.test(src), 'no text glyph');
    assert.match(src, /const VOICE_CARD_ICONS =\s*'<svg class="voice-card-icon-play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/);
    assert.match(src, /this\._voiceStepCancel = \(\) => done\(null, 'drag'\);/);
    assert.match(src, /mode: changeMode \? 'change' : 'first_call', via: via \|\| 'button' \}\);/);
});

test("voice step carousel with a mouse (the site's ~420 px corner panel): arrows, vertical wheel, mouse drag, ←/→; the edges say where there is more", () => {
    const bind = method('_bindVoiceCarousel(list)');
    const update = method('_updateVoiceCarousel(list)');
    let clock = 1000;
    global.performance = { now: () => clock };
    global.getComputedStyle = () => ({ columnGap: '8px' });
    delete global.ResizeObserver;
    const make = () => {
        const on = {}; const calls = [];
        const cards = Array.from({ length: 8 }, (_, i) => ({ i, offsetWidth: 92, focus() { active = this; }, scrollIntoView(o) { calls.push(['into', i, o.inline]); }, getAttribute: () => 'c' + i }));
        let active = null;
        const rail = { cls: new Set(['voice-step-rail']), classList: { contains: (c) => rail.cls.has(c), toggle: (c, v) => (v ? rail.cls.add(c) : rail.cls.delete(c)) } };
        const list = {
            parentElement: rail, scrollLeft: 0, scrollWidth: 792, clientWidth: 392, cls: new Set(),
            classList: { add: (c) => list.cls.add(c), remove: (c) => list.cls.delete(c) },
            addEventListener: (t, f, o) => { (on[t] = on[t] || []).push(f); },
            removeEventListener: (t, f) => { on[t] = (on[t] || []).filter((x) => x !== f); },
            querySelector: () => cards[0], querySelectorAll: () => cards,
            scrollBy: (o) => calls.push(['by', o.left]), scrollTo: (o) => calls.push(['to', o.left]), setPointerCapture() {},
        };
        const btn = {}; ['voiceStepPrev', 'voiceStepNext'].forEach((id) => { btn[id] = { addEventListener: (t, f) => { btn[id].click = f; } }; });
        global.document = { getElementById: (id) => btn[id] || null, get activeElement() { return active; } };
        const app = {}; app._updateVoiceCarousel = update.bind(app);
        bind.call(app, list);
        const fire = (t, e) => { let prevented = false; let stopped = false; const ev = Object.assign({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }, e); (on[t] || []).forEach((f) => f(ev)); return { prevented, stopped }; };
        return { list, rail, calls, fire, btn, cards, setActive: (c) => { active = c; } };
    };
    // Edges: overflow at the start → only "next" and a right fade (CSS keys off these classes).
    const a = make();
    a.list.scrollLeft = 0; a.fire('scroll', {});
    assert.deepEqual([...a.rail.cls].sort(), ['at-start', 'overflow', 'voice-step-rail']);
    a.list.scrollLeft = 400; a.fire('scroll', {});
    assert.deepEqual([...a.rail.cls].sort(), ['at-end', 'overflow', 'voice-step-rail']);
    a.list.scrollWidth = 392; a.fire('scroll', {});
    assert.ok(!a.rail.cls.has('overflow'), 'all fit: no arrows, no fade');
    // Arrows: a page (the cards in view) at a time.
    const b = make();
    b.btn.voiceStepNext.click(); b.btn.voiceStepPrev.click();
    assert.deepEqual(b.calls, [['by', 400], ['by', -400]]);
    // Wheel: a notch = one card; trackpad deltas add up; horizontal or no overflow = left alone.
    const w = make();
    assert.equal(w.fire('wheel', { deltaY: 100, deltaX: 0, deltaMode: 0 }).prevented, true);
    for (let k = 0; k < 5; k++) { clock += 16; w.fire('wheel', { deltaY: 8, deltaX: 0, deltaMode: 0 }); }
    assert.deepEqual(w.calls, [['by', 100], ['by', 100]]);
    assert.equal(w.fire('wheel', { deltaY: 2, deltaX: 30, deltaMode: 0 }).prevented, false, 'a sideways trackpad swipe scrolls natively');
    w.list.scrollWidth = 392;
    assert.equal(w.fire('wheel', { deltaY: 100, deltaX: 0, deltaMode: 0 }).prevented, false, 'nothing to scroll: the page keeps the wheel');
    // Mouse drag: scrolls with snap off, settles on a card, and is not a click.
    const d = make();
    d.fire('pointerdown', { pointerId: 3, pointerType: 'mouse', button: 0, clientX: 300 });
    d.fire('pointermove', { pointerId: 3, clientX: 297 });
    assert.equal(d.list.scrollLeft, 0, 'under 6 px: still a click');
    d.fire('pointermove', { pointerId: 3, clientX: 140 });
    assert.equal(d.list.scrollLeft, 160);
    assert.ok(d.list.cls.has('mouse-dragging'));
    d.fire('pointerup', { pointerId: 3 });
    assert.ok(!d.list.cls.has('mouse-dragging'));
    assert.deepEqual(d.calls.at(-1), ['to', 200], 'settles on the nearest card');
    assert.equal(d.fire('click', {}).stopped, true, 'the click that ends a drag is swallowed');
    assert.equal(d.fire('dragstart', {}).prevented, true, "the browser's image drag would cancel the pointer");
    const t = make();
    t.fire('pointerdown', { pointerId: 4, pointerType: 'touch', button: 0, clientX: 300 });
    t.fire('pointermove', { pointerId: 4, clientX: 100 });
    assert.equal(t.list.scrollLeft, 0, 'touch is the native swipe, untouched');
    // Keyboard: → / ← move the focus between cards.
    const k = make();
    k.setActive(k.cards[2]);
    assert.equal(k.fire('keydown', { key: 'ArrowRight' }).prevented, true);
    assert.equal(k.cards.indexOf(global.document.activeElement), 3);
    assert.deepEqual(k.calls.at(-1), ['into', 3, 'nearest']);
    k.setActive(k.cards[0]);
    assert.equal(k.fire('keydown', { key: 'ArrowLeft' }).prevented, false, 'nothing before the first card');
    // CSS: arrows and fade for fine pointers only; HTML: the rail wraps the cards.
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    const fine = css.slice(css.indexOf('@media (hover: hover) and (pointer: fine) {'));
    assert.match(css, /\.voice-step-arrow \{ display: none;[^}]*width: 44px; height: 44px;/, '44 px targets, hidden by default');
    assert.match(fine, /\.voice-step-rail\.overflow:not\(\.at-start\) \.voice-step-arrow-prev,\s*\.voice-step-rail\.overflow:not\(\.at-end\) \.voice-step-arrow-next \{ display: flex; \}/);
    assert.match(fine, /mask-image: linear-gradient\(to right, transparent 0, #000 var\(--fade-l\), #000 calc\(100% - var\(--fade-r\)\), transparent 100%\)/);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /<div id="voiceStepRail" class="voice-step-rail">\s*<button id="voiceStepPrev"[\s\S]*?<div id="voiceStepCards" class="voice-step-cards"><\/div>\s*<button id="voiceStepNext"/);
    assert.match(src, /<img src="\$\{this\.apiUrl\(card\.thumb\)\}" alt="" draggable="false">/);
});
