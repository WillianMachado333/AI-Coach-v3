// A minimise button in the chat header (Varsha's review of 14 Oct 2026,
// point 8: "The minimize or close button doesn't exist"). It shows only once
// the corner-icon bridge says it opened the panel (CT_BRIDGE_EXPANDED), since
// only the bridge can fold it back; a click asks the bridge to do so
// (MINIMIZE_TO_ICON). A standalone page or the app web view never shows it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers/appHarness');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('index.html: the header has a minimise button, hidden until the bridge opens the panel, labelled for screen readers', () => {
    const html = read('index.html');
    const tag = html.match(/<button[^>]*id="minimizeChatBtn"[^>]*>/);
    assert.ok(tag, 'the button exists');
    assert.match(tag[0], /class="[^"]*\bhidden\b/, 'hidden by default');
    assert.match(tag[0], /aria-label="Minimize chat"/);
    assert.ok(html.indexOf('id="minimizeChatBtn"') < html.indexOf('id="moreMenuBtn"'), 'left of the ⋮ menu');
});

test('app.js: CT_BRIDGE_EXPANDED from a trusted origin shows the button; nothing else does', () => {
    const src = read('app.js');
    assert.match(src, /data\.type === 'CT_BRIDGE_EXPANDED'\)\s*\{[\s\S]{0,400}this\._isTrustedBridgeOrigin\(event\.origin\)[\s\S]{0,120}this\._showMinimizeButton\(/);
    assert.equal((src.match(/this\._showMinimizeButton\(/g) || []).length, 1, 'one caller');
});

test('the button, once shown, asks the bridge to fold the panel back to the icon', () => {
    const h = createHarness();
    const btn = h.doc.createElement('button');
    btn.id = 'minimizeChatBtn';
    btn.classList.add('hidden');
    h.doc.body.appendChild(btn);
    const sent = [];
    const bridge = { postMessage: (msg, origin) => sent.push({ msg, origin }) };
    h.app._showMinimizeButton(bridge, 'https://www.awav.com');
    assert.equal(btn.classList.contains('hidden'), false, 'shown');
    btn.click();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.type, 'MINIMIZE_TO_ICON');
    assert.equal(sent[0].origin, 'https://www.awav.com', 'sent to the bridge page only');
    h.app._showMinimizeButton(bridge, 'https://www.awav.com');
    btn.click();
    assert.equal(sent.length, 2, 'shown again after a reopen, still one message per click');
});
