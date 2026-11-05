// The coach's sign-up and upgrade prompts ("Yes, I Want Personalized
// Guidance" when a guest taps voice, "Yep, upgrade me" at the voice limit)
// post { action: 'ericaRequestLogin' | 'ericaRequestUpgrade' } to the page.
// V2's Wix page code answered them; the V3 bridge did not, so on the floating
// coach those buttons only closed the modal (found with PR #66, 4 Nov 2026).
// The bridge now presses the site's own Login / Upgrade Membership buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBridge } = require('./helpers/bridgeHarness');

const COACH = 'https://web-staging-2c7ff.up.railway.app';

// A fake host page: elements with attributes, text and a visible flag, and a
// querySelectorAll that understands the selectors the bridge uses.
function hostPage(b, specs) {
    const els = specs.map((s) => ({
        tagName: (s.tag || 'button').toUpperCase(), attrs: s.attrs || {}, innerText: s.text || '', clicks: 0,
        getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
        getBoundingClientRect() { return s.visible === false ? { width: 0, height: 0 } : { width: 80, height: 30 }; },
        click() { this.clicks++; },
    }));
    const original = b.doc.querySelectorAll.bind(b.doc);
    b.doc.querySelectorAll = (sel) => {
        const one = (part) => {
            part = part.trim();
            const m = part.match(/^([a-z]*)\[([\w-]+)="([^"]+)"\]$/i);
            if (m) return els.filter((e) => (!m[1] || e.tagName === m[1].toUpperCase()) && e.attrs[m[2]] === m[3]);
            if (part === '[role="button"]') return els.filter((e) => e.attrs.role === 'button');
            if (/^[a-z]+$/i.test(part)) return els.filter((e) => e.tagName === part.toUpperCase());
            return null;
        };
        const parts = sel.split(',').map(one);
        if (parts.some((p) => p === null)) return original(sel);
        return [...new Set(parts.flat())];
    };
    return els;
}

function openCoach() {
    const b = runBridge();
    b.advance(1000);
    b.icon().click(); // loads and opens the coach
    assert.equal(b.win.__ctBridgeStatus().state, 'expanded');
    return b;
}

test('"Yes, I want personalized guidance": the chat folds and the site\'s visible Login button is pressed', () => {
    const b = openCoach();
    const [hiddenLogin, shownLogin] = hostPage(b, [
        { attrs: { 'data-testid': 'handle-button' }, text: 'Login', visible: false },
        { attrs: { 'data-testid': 'handle-button' }, text: 'Login' },
    ]);
    b.postToBridge({ action: 'ericaRequestLogin' }, COACH);
    assert.equal(shownLogin.clicks, 1, 'the one on screen');
    assert.equal(hiddenLogin.clicks, 0);
    assert.equal(b.win.__ctBridgeStatus().state, 'icon', 'Wix\'s login window must not open under the chat');
});

test('"Yep, upgrade me": the site\'s Upgrade Membership button; without one, the plans page', () => {
    const b = openCoach();
    const [upgrade] = hostPage(b, [{ attrs: { 'aria-label': 'Upgrade Membership' } }]);
    b.postToBridge({ action: 'ericaRequestUpgrade' }, COACH);
    assert.equal(upgrade.clicks, 1);

    const bare = openCoach();
    hostPage(bare, []);
    bare.postToBridge({ action: 'ericaRequestUpgrade' }, COACH);
    assert.equal(bare.win.location.href, '/plans-pricing');
});

test('login with only a text button ("Log In" link) works; with nothing to press it says so loudly and goes nowhere', () => {
    const b = openCoach();
    const [link] = hostPage(b, [{ tag: 'a', text: 'Log In' }, { tag: 'button', text: 'Donate' }]);
    b.postToBridge({ action: 'ericaRequestLogin' }, COACH);
    assert.equal(link.clicks, 1);

    const none = openCoach();
    hostPage(none, [{ tag: 'button', text: 'Donate' }]);
    const before = none.win.location.href;
    none.postToBridge({ action: 'ericaRequestLogin' }, COACH);
    assert.equal(none.win.location.href, before, 'no navigation');
    assert.ok(none.logs.some((l) => /🔴 ericaRequestLogin: no Login button/.test(l)));
});

test('only the coach may ask: another origin presses nothing', () => {
    const b = openCoach();
    const [login] = hostPage(b, [{ attrs: { 'data-testid': 'handle-button' }, text: 'Login' }]);
    b.postToBridge({ action: 'ericaRequestLogin' }, 'https://evil.example');
    assert.equal(login.clicks, 0);
    assert.equal(b.win.__ctBridgeStatus().state, 'expanded');
});
