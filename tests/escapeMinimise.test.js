// TT-2238 (Eric, 16 Nov 2026): "I cannot click away from the AI Coach to have it
// minimized or use the escape key." Click-away shipped in #87; this is Escape.
// Two halves: on the page (bridge.js) Escape folds the open chat; inside the
// coach's iframe, where keys never reach the page, the coach asks for the fold.
// TT-2237 (Eric): the paper clip confuses people, so the attach button is hidden.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runBridge } = require('./helpers/bridgeHarness');
const { createHarness } = require('./helpers/appHarness');
const rules = require('../lib/coachUiRules');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ---- the page (bridge.js) -------------------------------------------------
function open({ settle = true } = {}) {
    const b = runBridge();
    b.advance(1000);
    b.icon().click();
    assert.equal(b.win.__ctBridgeStatus().state, 'expanded');
    if (settle) b.advance(500);
    return b;
}
const state = (b) => b.win.__ctBridgeStatus().state;
const press = (b, props) => (b.doc.listeners.keydown || []).forEach((fn) => fn({ type: 'keydown', isTrusted: true, ...props }));

test('page: Escape folds the open chat to the icon', () => {
    const b = open();
    press(b, { key: 'Escape' });
    assert.equal(state(b), 'icon');
    assert.match(b.byId('ct-bridge-container').getAttribute('style'), /transform:\s*scale\(0\)/);
});

test('page: other keys, a script\'s key, a text being composed, a folded chat, and the first 400 ms do nothing', () => {
    const b = open();
    press(b, { key: 'Enter' });
    press(b, { key: 'a' });
    assert.equal(state(b), 'expanded', 'other keys');
    press(b, { key: 'Escape', isTrusted: false });
    assert.equal(state(b), 'expanded', 'a script\'s key');
    press(b, { key: 'Escape', isComposing: true });
    assert.equal(state(b), 'expanded', 'an IME composition');
    const fresh = open({ settle: false });
    press(fresh, { key: 'Escape' });
    assert.equal(state(fresh), 'expanded', 'inside the 400 ms after opening');
    fresh.advance(401);
    press(fresh, { key: 'Escape' });
    assert.equal(state(fresh), 'icon');
    press(fresh, { key: 'Escape' });
    assert.equal(state(fresh), 'icon', 'already folded: nothing');
});

test('page: the chat can be opened again after Escape, and Escape folds it again', () => {
    const b = open();
    press(b, { key: 'Escape' });
    b.icon().click();
    assert.equal(state(b), 'expanded');
    b.advance(500);
    press(b, { key: 'Escape' });
    assert.equal(state(b), 'icon');
});

// ---- the rule ---------------------------------------------------------------
test('rule: Escape minimises unless it is spoken for', () => {
    assert.equal(rules.escapeMinimises({ key: 'Escape' }, false), true);
    assert.equal(rules.escapeMinimises({ key: 'Escape', isTrusted: true }, false), true);
    assert.equal(rules.escapeMinimises({ key: 'Escape' }, true), false, 'something of the coach\'s is open');
    assert.equal(rules.escapeMinimises({ key: 'Escape', defaultPrevented: true }, false), false, 'someone handled it');
    assert.equal(rules.escapeMinimises({ key: 'Escape', isComposing: true }, false), false);
    assert.equal(rules.escapeMinimises({ key: 'Escape', isTrusted: false }, false), false);
    assert.equal(rules.escapeMinimises({ key: 'Enter' }, false), false);
    assert.equal(rules.escapeMinimises(null, false), false);
});

// ---- the coach (inside the iframe) -------------------------------------------
function coach() {
    const h = createHarness();
    const posted = [];
    h.ctx.parent = { postMessage: (m, origin) => posted.push([m, origin]) };
    const ui = h.ctx.uiLayout;
    const element = (id, cls = '', style = {}) => {
        const el = h.doc.createElement('div');
        el.id = id;
        if (cls) el.className = cls;
        Object.assign(el.style, style);
        h.doc.body.appendChild(el);
        return el;
    };
    return { h, ui, posted, element, esc: (extra = {}) => ui.minimiseOnEscape(h.app, { key: 'Escape', isTrusted: true, ...extra }) };
}

test('coach: embedded, Escape asks the page to fold the chat', () => {
    const c = coach();
    c.esc();
    // (the message is built inside the page's own realm: compare as JSON)
    assert.equal(JSON.stringify(c.posted), JSON.stringify([[{ type: 'MINIMIZE_TO_ICON' }, '*']]));
});

test('coach: not embedded (the app\'s own page): nothing to fold, nothing sent', () => {
    const c = coach();
    c.h.ctx.parent = c.h.ctx; // window.parent === window
    c.esc();
    assert.deepEqual(c.posted, []);
});

test('coach: whatever is open inside the coach takes Escape first', () => {
    const lightbox = coach(); lightbox.element('lb', 'image-lightbox'); lightbox.esc();
    assert.deepEqual(lightbox.posted, [], 'the photo viewer');
    const step = coach(); step.element('voiceStep', 'voice-step'); step.esc();
    assert.deepEqual(step.posted, [], 'the first call\'s voice step');
    const hiddenStep = coach(); hiddenStep.element('voiceStep', 'voice-step hidden'); hiddenStep.esc();
    assert.equal(hiddenStep.posted.length, 1, 'a closed voice step does not count');
    const picker = coach(); picker.element('voiceMenuOverlay', '', { display: 'flex' }); picker.esc();
    assert.deepEqual(picker.posted, [], 'the coach picker');
    const closedPicker = coach(); closedPicker.element('voiceMenuOverlay', '', { display: 'none' }); closedPicker.esc();
    assert.equal(closedPicker.posted.length, 1);
    const dropdown = coach(); dropdown.h.app._coachDropdownOpen = true; dropdown.esc();
    assert.deepEqual(dropdown.posted, [], 'the coach list');
});

test('coach: a handled key, a composition and a script\'s key do not fold it', () => {
    const c = coach();
    c.esc({ defaultPrevented: true });
    c.esc({ isComposing: true });
    c.esc({ isTrusted: false });
    c.esc({ key: 'Enter' });
    assert.deepEqual(c.posted, []);
});

test('coach: wiring: the more menu keeps Escape for itself, then the rest is minimiseOnEscape', () => {
    const src = read('uiLayout.js');
    assert.match(src, /document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key !== 'Escape'\) return;\s*if \(isMoreMenuOpen\(app\)\) \{\s*setMoreMenuOpen\(app, false\);\s*return;\s*\}\s*minimiseOnEscape\(app, e\);/);
    assert.match(src, /postMessage\(\{ type: 'MINIMIZE_TO_ICON' \}, '\*'\)/);
});

// ---- TT-2237: the paper clip -----------------------------------------------------
test('the attach button is hidden by one CSS rule; its markup, input and code stay', () => {
    const css = read('styles.css');
    assert.match(css, /#attachmentButton \{ display: none; \}/);
    assert.match(css, /#attachmentButton ~ #userTextInput \{ padding-left: 16px; \}/, 'the textarea takes its place');
    const html = read('index.html');
    assert.match(html, /id="attachmentButton"[^>]+aria-label="Attach a photo or file"/, 'the markup stays: one rule brings it back');
    assert.match(html, /id="attachmentInput"/);
});

test('the cache-busting versions moved with the files that changed', () => {
    const html = read('index.html');
    assert.match(html, /<script src="uiLayout\.js\?v=20261119a"><\/script>/);
    assert.match(html, /<script src="lib\/coachUiRules\.js\?v=20261119a"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="styles\.css\?v=20261119a">/);
});

// ---- Escape and the site's popups -------------------------------------------------
// CleverTap's SDK closes its popup on Escape and Wix lightboxes close on it: the
// same key must not also fold the coach.
const withPopup = (b, tag, id) => {
    const el = b.doc.createElement(tag);
    if (id) el.id = id;
    b.doc.body.appendChild(el);
    return el;
};

for (const [name, tag, id] of [
    ['a Wix lightbox', 'div', 'popups-wrapper'],
    ['a CleverTap image-only popup', 'div', 'wzrkImageOnlyDiv'],
    ['a CleverTap wzrk wrapper', 'div', 'wzrk_wrapper'],
    ['a CleverTap push prompt', 'div', 'pnWrapper'],
    ['a CleverTap intent preview', 'div', 'intentPreview'],
    ['a CleverTap web popup', 'ct-web-popup-pip', ''],
]) {
    test(`page: Escape with ${name} open is the popup's, not the coach's; once it is gone Escape folds the chat`, () => {
        const b = open();
        const popup = withPopup(b, tag, id);
        press(b, { key: 'Escape' });
        assert.equal(state(b), 'expanded');
        popup.remove();
        press(b, { key: 'Escape' });
        assert.equal(state(b), 'icon');
    });
}

test('page: a popup element with no size (hidden) does not take Escape', () => {
    const b = open();
    const popup = withPopup(b, 'div', 'wzrkImageOnlyDiv');
    popup.getBoundingClientRect = () => ({ width: 0, height: 0 });
    press(b, { key: 'Escape' });
    assert.equal(state(b), 'icon');
});

test('page: a popup that has a size takes Escape; the inbox element sitting in the page does not', () => {
    const shown = open();
    const popup = withPopup(shown, 'div', 'popups-wrapper');
    popup.getBoundingClientRect = () => ({ width: 300, height: 200 });
    press(shown, { key: 'Escape' });
    assert.equal(state(shown), 'expanded');
    const inbox = open();
    withPopup(inbox, 'ct-web-inbox', '');
    press(inbox, { key: 'Escape' });
    assert.equal(state(inbox), 'icon', 'the inbox can sit in the page closed');
});
