// The chip's list of coaches (Eric on a phone, 2026-10-03): the picker
// appears where it was tapped — the chip on top opens a list under it; the
// first call's step stays at the bottom, by the call button. A row picks
// (the cards' apply path, voice_selected via 'dropdown'); ▶ only previews;
// outside / Esc / a drag up close without a change; ↑/↓/Enter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function method(name, params) {
    let start = src.indexOf(`    ${name}(${params}) {`);
    if (start < 0) start = src.indexOf(`    async ${name}(${params}) {`);
    assert.ok(start >= 0, 'method not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0; let i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(open + 1, i);
    const isAsync = src.slice(start, start + 12).includes('async');
    // eslint-disable-next-line no-new-func
    return isAsync ? new Function(params, `return (async () => {${body}})();`) : new Function(params, body);
}

test('the chip opens the list (and closes it when open); never during a call; the first call keeps the bottom step', async () => {
    const open = method('_openCoachChip', '');
    const calls = [];
    const app = { _loadVoiceCards: async () => {}, _voiceCards: [{ id: 'Supportive' }], _openCoachDropdown: () => calls.push('open'), _closeCoachDropdown: (v) => calls.push('close:' + v), _showVoiceStep: () => calls.push('sheet') };
    open.call(app); await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, ['open']);
    app._coachDropdownOpen = true;
    open.call(app);
    assert.deepEqual(calls, ['open', 'close:chip'], 'a second tap on the chip closes it');
    const log = console.log; console.log = () => {};
    open.call({ ...app, isRecording: true, _coachDropdownOpen: false });
    console.log = log;
    assert.deepEqual(calls, ['open', 'close:chip'], 'in a call: a new voice would cut it');
    assert.match(src, /if \(this\._voiceStepNeeded\(\)\) this\._showVoiceStep\(\);\s*else this\.toggleMicTrack\(\);/, 'the first call: the step at the bottom');
});

test('a row picks through the cards’ path (via dropdown) and shows the face at once; ▶ only previews; a close without a pick is a cancel with its reason', async () => {
    const pickRow = method('_pickDropdownCard', 'card');
    const close = method('_closeCoachDropdown', 'via');
    const preview = method('_previewDropdownCard', 'card, row');
    const log = [];
    const jasmine = { id: 'Guidance', name: 'Jasmine', voice: 'coral' };
    const app = {
        _coachDropdownOpen: true,
        _closeCoachDropdown: function (v) { log.push(['close', v]); },
        _finishVoiceStep: async (card, via) => log.push(['finish', card && card.id, via]),
        _updateCoachChip: () => log.push(['chip']),
        _showPreviewPlaying: (row, p) => log.push(['playing', row]),
        playCoachPreview: (o) => { log.push(['preview', o.companionId, o.openaiVoice]); return Promise.resolve(true); },
        _cardPreviewText: (c) => 'Hi, I am ' + c.name,
        _logSessionEvent: (n, m) => log.push(['event', n, m]),
        _switchVoiceTo: () => log.push(['SWITCH']),
    };
    await pickRow.call(app, jasmine);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(log, [['close', null], ['finish', 'Guidance', 'dropdown'], ['chip']]);
    log.length = 0;
    preview.call(app, jasmine, 'row-el');
    assert.deepEqual(log, [['preview', 'Guidance', 'coral'], ['playing', 'row-el'], ['event', 'voice_previewed', { card: 'Guidance', voice: 'coral', via: 'dropdown' }]]);
    assert.ok(!log.some((l) => l[0] === 'SWITCH' || l[0] === 'finish'), 'a preview selects nothing and switches nothing');
    // Closing: the list hides, the chip says collapsed, the preview stops; a reason means "no change".
    global.document = { getElementById: (id) => ({ classList: { add: () => log.push(['hide', id]) }, removeAttribute: () => {}, setAttribute: (k, v) => log.push(['attr', id, k, v]), contains: () => false, focus: () => {} }), activeElement: null };
    log.length = 0;
    const closing = { _coachDropdownOpen: true, stopActivePreview: () => log.push(['stop']), _finishVoiceStep: (c, v) => log.push(['finish', c, v]) };
    close.call(closing, 'outside');
    assert.deepEqual(log.filter((l) => l[0] !== 'hide'), [['attr', 'coachChip', 'aria-expanded', 'false'], ['stop'], ['finish', null, 'outside']]);
    assert.equal(closing._coachDropdownOpen, false);
    log.length = 0;
    close.call(closing, 'escape');
    assert.deepEqual(log, [], 'already closed: nothing');
    closing._coachDropdownOpen = true; log.length = 0;
    close.call(closing, null);
    assert.ok(!log.some((l) => l[0] === 'finish'), 'a pick closes without a cancel');
    delete global.document;
});

test('a pick replaced by a later one (two rows in a row) is not reported as "NOT applied"', async () => {
    const finish = method('_finishVoiceStep', 'card, via');
    const events = []; const errors = [];
    const app = {
        _voiceStepMode: 'change', _voiceStepOriginal: { id: 'Supportive', voice: 'marin' }, selectedCompanionId: 'Supportive', selectedVoice: 'marin', _sessionVoice: 'marin',
        _saveCoachSettings: () => {}, _updateCoachChip: () => {}, _logSessionEvent: (n, m) => events.push([n, m]), toggleMicTrack: () => {},
        _switchVoiceTo: async function (card) { await new Promise((r) => setTimeout(r, 10)); this.selectedCompanionId = this._last.id; this.selectedVoice = this._last.voice; this._sessionVoice = this._last.voice; },
    };
    const e0 = console.error; const l0 = console.log;
    console.error = (...a) => errors.push(a.join(' ')); console.log = () => {};
    app._last = { id: 'Nurturing', voice: 'alloy' };
    const pickRow = method('_pickDropdownCard', 'card');
    app._closeCoachDropdown = () => {};
    app._finishVoiceStep = finish;
    const calls = [];
    app.toggleMicTrack = () => calls.push('CALL');
    const first = pickRow.call(app, { id: 'Nurturing', name: 'Emma', voice: 'alloy' });
    app._last = { id: 'Empowering', voice: 'cedar' };
    const second = pickRow.call(app, { id: 'Empowering', name: 'Michael', voice: 'cedar' });
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 5));
    console.error = e0; console.log = l0;
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, [], 'a pick from the chip never starts a call');
    const sel = events.filter((e) => e[0] === 'voice_selected').map((e) => e[1]);
    assert.deepEqual(sel.map((m) => [m.card, m.applied, !!m.superseded, m.via, m.mode]), [['Nurturing', false, true, 'dropdown', 'change'], ['Empowering', true, false, 'dropdown', 'change']]);
});

test('keyboard and a11y: aria on the chip, listbox/option, ↑/↓/Home/End/Enter/Space/Esc/Tab; a drag up closes; tap outside closes', () => {
    assert.match(html, /<button id="coachChip"[^>]*aria-haspopup="listbox" aria-expanded="false" aria-controls="coachDropdown">/);
    assert.match(html, /<div id="coachDropdown" class="coach-dd hidden" role="listbox" aria-label="Choose your coach" tabindex="-1"><\/div>/);
    const open = src.slice(src.indexOf('    _openCoachDropdown() {'), src.indexOf('    _setCoachDropdownActive(i) {'));
    assert.match(open, /row\.setAttribute\('role', 'option'\);\s*row\.setAttribute\('aria-selected', card === current \? 'true' : 'false'\);/);
    assert.match(open, /chip\.setAttribute\('aria-expanded', 'true'\);/);
    assert.match(open, /this\._logSessionEvent\('voice_step_viewed', \{[^}]*mode: 'change', via: 'dropdown' \}\);/);
    const bind = src.slice(src.indexOf('    _bindCoachDropdown(dd, chip) {'), src.indexOf('    _previewDropdownCard(card, row) {'));
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape', 'Tab']) assert.ok(bind.includes(`e.key === '${k}'`), k);
    assert.match(bind, /document\.addEventListener\('pointerdown', \(e\) => \{[\s\S]*?if \(dd\.contains\(e\.target\) \|\| chip\.contains\(e\.target\)\) return;\s*this\._closeCoachDropdown\('outside'\);/);
    assert.match(bind, /drag\.atEnd && dy < -40 && Math\.abs\(dy\) > Math\.abs\(dx\) \* 1\.5/);
    assert.match(bind, /this\._closeCoachDropdown\('drag'\);/);
    assert.match(src, /setAttribute\('aria-activedescendant', rows\[at\]\.id\)/);
});

test('sizing: under the chip, over the chat (not pushing it), 44 px rows, scrolls inside past 60% of the screen', () => {
    const rule = (sel) => { const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}')); assert.ok(m, sel); return m[1]; };
    const dd = rule('.coach-dd');
    assert.match(dd, /position: absolute; top: 36px; left: 6px; z-index: 5;/);
    assert.match(dd, /max-height: 60vh; max-height: 60dvh; overflow-y: auto;/);
    assert.match(dd, /max-width: calc\(100vw - 12px\)/);
    assert.match(rule('.coach-dd-row'), /height: 44px;/);
    assert.match(css, /\.coach-dd-row\.playing \.voice-card-icon-wave \{ display: block;/, 'the same ▶ / wave as the cards (#43)');
    assert.match(src, /<button type="button" class="coach-dd-play" tabindex="-1">\$\{VOICE_CARD_ICONS\}<\/button>/);
});
