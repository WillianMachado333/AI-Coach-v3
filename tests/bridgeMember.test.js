// The corner-icon bridge tells the coach who is signed in on the Wix page
// (Varsha's review, 29 Oct 2026: the coach could not read a member's report
// until the report page was open, because every visitor reached it as a
// guest). The site's own code keeps { wixLocalStorage: "true",
// userAuthenticated, loggedInUserId } in localStorage; the v2 embed reads
// the same entry. bridge.js runs here against a fake DOM and clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBridge: run } = require('./helpers/bridgeHarness');

const runBridge = (entry) => run({ entry });

test('a signed-in member: the coach iframe carries their Wix member id', () => {
    const b = runBridge({ wixLocalStorage: 'true', userAuthenticated: true, loggedInUserId: 'member-123' });
    b.advance(1000);
    assert.ok(b.iframe(), 'the coach iframe is injected');
    assert.match(b.iframe().src, /[?&]caller=web&userId=member-123$/);
});

test('a guest (no entry, or signed out): no member id', () => {
    for (const entry of [null, { wixLocalStorage: 'true', userAuthenticated: false, loggedInUserId: 'member-123' }]) {
        const b = runBridge(entry);
        b.advance(1000);
        assert.doesNotMatch(b.iframe().src, /userId=/, JSON.stringify(entry));
    }
});

test('signing in or out on the page reloads the coach with the new identity; no change, no reload', () => {
    const b = runBridge(null);
    b.advance(1000);
    const guestSrc = b.iframe().src;
    b.advance(10000);
    assert.equal(b.iframe().src, guestSrc, 'nothing changes while the person stays a guest');
    b.setEntry({ wixLocalStorage: 'true', userAuthenticated: 'true', loggedInUserId: 'member 9' });
    b.advance(3000);
    assert.match(b.iframe().src, /userId=member%209$/, 'signed in');
    b.setEntry({ wixLocalStorage: 'true', userAuthenticated: false, loggedInUserId: null });
    b.advance(3000);
    assert.doesNotMatch(b.iframe().src, /userId=/, 'signed out');
});
