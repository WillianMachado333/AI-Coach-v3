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

// ---- The site's popups (Willian, 19 Nov 2026) --------------------------------
// Closing a promotion popup is a real click outside the coach, and it folded the
// coach too. The popups the site has: Wix lightboxes, the cookie banner and
// CleverTap's web popups (ids, tags and close classes as the SDK creates them).
const nested = (b, tag, attrs = {}, depth = 2) => {
    // popup root > box > ... > the element that is clicked
    const root = b.doc.createElement(tag);
    if (attrs.id) root.id = attrs.id;
    if (attrs.hook) root.setAttribute('data-hook', attrs.hook);
    b.doc.body.appendChild(root);
    let leaf = root;
    for (let i = 0; i < depth; i++) {
        const child = b.doc.createElement('div');
        leaf.appendChild(child);
        leaf = child;
    }
    const button = b.doc.createElement('button');
    leaf.appendChild(button);
    return { root, button };
};

const POPUPS = [
    ['Wix lightbox root', 'div', { id: 'POPUPS_ROOT' }],
    ['Wix lightbox wrapper', 'div', { id: 'popups-wrapper' }],
    ['CleverTap wzrk_wrapper', 'div', { id: 'wzrk_wrapper' }],
    ['CleverTap push prompt', 'div', { id: 'pnWrapper' }],
    ['CleverTap image-only popup', 'div', { id: 'wzrkImageOnlyDiv' }],
    ['CleverTap intent preview', 'div', { id: 'intentPreview' }],
    ['CleverTap wizParDiv0', 'div', { id: 'wizParDiv0' }],
    ['CleverTap intentOpacityDiv2', 'div', { id: 'intentOpacityDiv2' }],
    ['CleverTap web popup (image only)', 'ct-web-popup-imageonly', {}],
    ['CleverTap web popup (pip)', 'ct-web-popup-pip', {}],
    ['CleverTap web inbox', 'ct-web-inbox', {}],
    ['cookie banner', 'div', { hook: 'consent-banner-root' }],
];
for (const [name, tag, attrs] of POPUPS) {
    test(`popups: a click inside the ${name} does not fold the chat`, () => {
        const b = open();
        const { button } = nested(b, tag, attrs);
        clickDocument(b, button);
        assert.equal(state(b), 'expanded');
        // The page next to it still folds the chat: that use is kept.
        clickDocument(b, pageElement(b));
        assert.equal(state(b), 'icon');
    });
}

test('popups: the close class of a CleverTap popup is spared wherever it sits', () => {
    const b = open();
    for (const cls of ['wzrkClose', 'CT_InterstitialClose', 'CT_InterstitialCTA', 'jsCT_CTA']) {
        const el = b.doc.createElement('div');
        el.classList.add(cls);
        b.doc.body.appendChild(el);
        clickDocument(b, el);
        assert.equal(state(b), 'expanded', cls);
    }
});

test('popups: a click on a shadow root\'s content arrives as its host element, and is spared too', () => {
    const b = open();
    const host = b.doc.createElement('ct-web-popup-pip');
    b.doc.body.appendChild(host);
    const inner = { id: '', tagName: 'BUTTON', parentNode: null, host }; // inside the shadow tree: no parent, a host
    clickDocument(b, inner);
    assert.equal(state(b), 'expanded');
});

test('popups: once the popup is gone, a click on the page folds the chat again', () => {
    const b = open();
    const { root, button } = nested(b, 'div', { id: 'POPUPS_ROOT' });
    clickDocument(b, button);
    assert.equal(state(b), 'expanded', 'closing the popup');
    root.remove();
    clickDocument(b, pageElement(b));
    assert.equal(state(b), 'icon', 'the page, popup gone');
});

test('popups: elements that merely look like a popup do not shield a click', () => {
    for (const id of ['popups', 'POPUPS', 'wzrk', 'wizPar', 'popup-wrapper', 'my-ct-web-popup', 'xwzrk_wrapper']) {
        const b = open();
        clickDocument(b, pageElement(b, id));
        assert.equal(state(b), 'icon', 'a plain page element with the id "' + id + '" still folds the chat');
    }
});
