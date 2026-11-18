// Eric, at a convention (18 Nov 2026): the minimise button in the chat header
// was not always there to press, so the open coach could not be put away.
// Immediate fix in the bridge: a click on the page outside the open chat folds
// it to the icon. A click inside the coach's iframe never reaches the page's
// document, so only the page, the icon and the bridge's own overlays arrive.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBridge } = require('./helpers/bridgeHarness');

const COACH = 'https://web-staging-2c7ff.up.railway.app';

function open({ settle = true } = {}) {
    const b = runBridge();
    b.advance(1000);
    b.icon().click(); // loads and opens the coach
    assert.equal(b.win.__ctBridgeStatus().state, 'expanded');
    if (settle) b.advance(500); // past the 400 ms after opening
    return b;
}
const state = (b) => b.win.__ctBridgeStatus().state;
// A click on the host page: the listeners the bridge put on the document.
const clickDocument = (b, target, extra = {}) =>
    (b.doc.listeners.click || []).forEach((fn) => fn({ type: 'click', target, isTrusted: true, ...extra }));
const pageElement = (b, id) => {
    const el = b.doc.createElement('div');
    if (id) el.id = id;
    b.doc.body.appendChild(el);
    return el;
};

test('a click on the page outside the open chat folds it to the icon', () => {
    const b = open();
    clickDocument(b, pageElement(b));
    assert.equal(state(b), 'icon');
    assert.match(b.byId('ct-bridge-container').getAttribute('style'), /transform:\s*scale\(0\)/);
    assert.match(b.byId('ct-bridge-container').getAttribute('style'), /pointer-events:\s*none/);
});

test('a click on the bare page body folds it too', () => {
    const b = open();
    clickDocument(b, b.doc.body);
    assert.equal(state(b), 'icon');
});

test('a click on the chat itself, on the icon, or on any bridge overlay does not fold it', () => {
    const b = open();
    clickDocument(b, b.byId('ct-bridge-container'));
    assert.equal(state(b), 'expanded', 'the chat container');
    clickDocument(b, b.iframe());
    assert.equal(state(b), 'expanded', 'the iframe element');
    clickDocument(b, b.icon());
    assert.equal(state(b), 'expanded', 'the icon (its own handler toggles it)');
    const pills = pageElement(b, 'ct-bridge-hover-pills');
    const pill = b.doc.createElement('button');
    pills.appendChild(pill);
    clickDocument(b, pill);
    assert.equal(state(b), 'expanded', 'a child of a bridge overlay');
});

test('the icon still toggles by itself: one click folds, the next opens, an outside click folds again', () => {
    const b = open();
    b.icon().click();
    assert.equal(state(b), 'icon');
    b.icon().click();
    assert.equal(state(b), 'expanded');
    b.advance(500);
    clickDocument(b, pageElement(b));
    assert.equal(state(b), 'icon');
});

test('a click that a script made (the coach pressing the site\'s own buttons) does not fold the chat', () => {
    const b = open();
    clickDocument(b, pageElement(b), { isTrusted: false });
    assert.equal(state(b), 'expanded');
    clickDocument(b, pageElement(b), { isTrusted: true });
    assert.equal(state(b), 'icon');
});

test('the first 400 ms after the chat opens are ignored: a click already on its way cannot close what just opened', () => {
    const b = open({ settle: false });
    clickDocument(b, pageElement(b));
    assert.equal(state(b), 'expanded', 'inside the 400 ms');
    b.advance(399);
    clickDocument(b, pageElement(b));
    assert.equal(state(b), 'expanded', 'still inside');
    b.advance(2);
    clickDocument(b, pageElement(b));
    assert.equal(state(b), 'icon', 'after it');
    // A nudge that opens the chat from the coach starts the same window.
    b.postToBridge({ type: 'EXPAND_TO_CHAT' }, COACH);
    assert.equal(state(b), 'expanded');
    clickDocument(b, pageElement(b));
    assert.equal(state(b), 'expanded', 'the window restarts with every opening');
});

test('with the chat already folded, a click on the page does nothing', () => {
    const b = runBridge();
    b.advance(1000);
    assert.equal(state(b), 'icon');
    clickDocument(b, pageElement(b));
    assert.equal(state(b), 'icon');
    assert.equal(b.iframe(), null, 'and it does not load the coach');
});

test('the coach is told it was folded, as with the minimise button', () => {
    const b = open();
    const sent = [];
    b.iframe().contentWindow = { postMessage: (m) => sent.push(m) };
    clickDocument(b, pageElement(b));
    assert.deepEqual(sent.map((m) => m.type), ['CT_BRIDGE_COLLAPSED']);
});

test('the coach\'s own minimise request still works', () => {
    const b = open();
    b.postToBridge({ type: 'MINIMIZE_TO_ICON' }, COACH);
    assert.equal(state(b), 'icon');
});
