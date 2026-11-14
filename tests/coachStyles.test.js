// TT-2232 (Eric, 13 Nov 2026): the header chip's coach list showed a face, a
// name and a play button, and every preview said "Hi, I'm X. I'm glad you're
// here." He expects the one-word style under each coach and a preview that
// explains how the coach works, as in V2. Decision (Willian, 14 Nov): restore
// V2's texts, keep the adaptive coaching style: picking a coach still changes
// only the face, the name and the voice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const src = read('app.js');
const css = read('styles.css');
const html = read('index.html');
const cards = JSON.parse(read('voiceCards.json')).cards;
const profiles = JSON.parse(read('voiceProfiles.json'));

function bodyOf(name, params) {
    const start = src.indexOf(`    ${name}(${params}) {`);
    assert.ok(start >= 0, 'method not found: ' + name);
    const open = src.indexOf('{', start);
    let depth = 0; let i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(open + 1, i);
}
// eslint-disable-next-line no-new-func
const method = (name, params) => new Function(params, bodyOf(name, params));

test('all eight cards carry the V2 label and preview, byte for byte from voiceProfiles.json; the style word is the card id', () => {
    assert.equal(cards.length, 8);
    for (const card of cards) {
        const p = profiles.find((x) => x.companionId === card.id);
        assert.ok(p, 'a profile for ' + card.id);
        assert.equal(card.label, p.configuration.label, card.id + ': label verbatim');
        assert.equal(card.preview, p.configuration.userFacingContext, card.id + ': preview verbatim');
        assert.ok(card.preview.trim().split(/\s+/).length >= 20, card.id + ': a real description, not a greeting');
    }
    assert.deepEqual(cards.map((c) => c.id), ['Supportive', 'Guidance', 'Empowering', 'Discovery', 'Strengths', 'Exploratory', 'Directive', 'Nurturing']);
});

test('the preview says the card\'s text; a card without one keeps the greeting', () => {
    const text = method('_cardPreviewText', 'card');
    assert.equal(text.call({}, cards[0]), cards[0].preview);
    assert.equal(text.call({}, { id: 'X', name: 'Zed' }), "Hi, I'm Zed. I'm glad you're here.");
    assert.equal(text.call({}, { id: 'X', name: 'Zed', preview: '   ' }), "Hi, I'm Zed. I'm glad you're here.", 'blank counts as none');
    // Both the list and the first call's carousel read the words from here.
    assert.equal((src.match(/text: this\._cardPreviewText\(card\)/g) || []).length, 2, 'the carousel card and the list row play the one text');
    assert.match(bodyOf('_prefetchCardPreview', 'card'), /const text = this\._cardPreviewText\(card\);/);
});

test('the list shows the one-word style under each name, as text (never HTML)', () => {
    // A minimal DOM: innerHTML records the class names of the spans it builds.
    const node = () => ({
        children: [], attrs: {}, _q: {},
        classList: { add() {}, remove() {}, toggle() {} },
        style: {}, scrollHeight: 0, clientHeight: 0,
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        addEventListener() {}, focus() {}, contains() { return false; },
        appendChild(c) { this.children.push(c); return c; },
        set innerHTML(v) {
            this._html = String(v); this._q = {};
            if (v === '') this.children = [];
            for (const m of this._html.matchAll(/class="([a-z-]+)"/g)) this._q['.' + m[1]] = { textContent: '', setAttribute() {}, addEventListener() {} };
        },
        get innerHTML() { return this._html || ''; },
        querySelector(s) { return this._q[s] || null; },
    });
    const dd = node(); const chip = node();
    global.document = { getElementById: (id) => (id === 'coachDropdown' ? dd : id === 'coachChip' ? chip : null), createElement: () => node() };
    global.VOICE_CARD_ICONS = '';
    try {
        const app = {
            _voiceCards: cards, _voiceStepOriginalCard: () => cards[0], apiUrl: (x) => x, _bindCoachDropdown() {}, _setCoachDropdownActive() {},
            _logSessionEvent() {}, _previewDropdownCard() {}, _pickDropdownCard() {},
        };
        method('_openCoachDropdown', '').call(app);
        assert.equal(dd.children.length, 8);
        const names = dd.children.map((r) => r._q['.coach-dd-name'].textContent);
        const styles = dd.children.map((r) => r._q['.coach-dd-style'].textContent);
        assert.deepEqual(names, ['Erica', 'Jasmine', 'Michael', 'Sean', 'Steve', 'Evan', 'Sarah', 'Emma']);
        assert.deepEqual(styles, ['Supportive', 'Guidance', 'Empowering', 'Discovery', 'Strengths', 'Exploratory', 'Directive', 'Nurturing']);
        // The words never go through innerHTML: a text with markup stays text.
        assert.ok(!dd.children.some((r) => /Supportive|Guidance|Empowering/.test(r.innerHTML)), 'not in the markup');
    } finally {
        delete global.document;
        delete global.VOICE_CARD_ICONS;
    }
    // The row stays the fixed 44 px one, with the two lines stacked and the name kept to one line.
    assert.match(css, /\.coach-dd-row \{[^}]*height: 44px;/);
    assert.match(css, /\.coach-dd-text \{[^}]*flex: 1; min-width: 0; display: flex; flex-direction: column;/);
    assert.match(css, /\.coach-dd-style \{[^}]*font-size: 11px;[^}]*text-overflow: ellipsis; white-space: nowrap;/);
    assert.match(css, /\.coach-dd-name \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
});

test('the decision: picking a coach still changes only the face, name and voice; the text is descriptive and never applied', () => {
    assert.ok(!/card\.(label|preview)/.test(bodyOf('_applyCard', 'card')), '_applyCard does not read the label or the preview');
    assert.ok(!/\.(label|preview)\b/.test(bodyOf('_pickDropdownCard', 'card')), 'the list pick does not either');
    assert.ok(!/card\.(label|preview)/.test(bodyOf('_switchVoiceTo', 'card')), 'nor the voice switch');
});

test('app.js and styles.css are cache-busted for this change', () => {
    assert.doesNotMatch(html, /styles\.css\?v=20261028a/, 'styles.css changed: its ?v= must too');
    assert.doesNotMatch(html, /app\.js\?v=20261114a/, 'app.js changed: its ?v= must too');
    assert.match(html, /<link rel="stylesheet" href="styles\.css\?v=20261114b">/);
    assert.match(html, /<script src="app\.js\?v=20261114b"><\/script>/);
});
