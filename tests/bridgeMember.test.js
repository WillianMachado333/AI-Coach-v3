// The corner-icon bridge tells the coach who is signed in on the Wix page
// (Varsha's review, 29 Oct 2026: the coach could not read a member's report
// until the report page was open, because every visitor reached it as a
// guest). The site's own code keeps { wixLocalStorage: "true",
// userAuthenticated, loggedInUserId } in localStorage; the v2 embed reads
// the same entry. bridge.js runs here against a fake DOM and clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createDocument } = require('./helpers/fakeDom');

const source = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
const WIX_KEY = '__wix_member_state';

function runBridge(entry) {
    const doc = createDocument();
    const store = new Map();
    if (entry) store.set(WIX_KEY, JSON.stringify(entry));
    store.set('unrelated', '{"x":1}');
    const localStorage = {
        get length() { return store.size; },
        key: (i) => [...store.keys()][i] ?? null,
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    let now = 0;
    const timers = [];
    const win = {
        document: doc, localStorage, sessionStorage: localStorage, console: { log() {}, warn() {}, error() {} },
        location: { hostname: 'www.awav.com', search: '', pathname: '/', href: 'https://www.awav.com/' },
        navigator: { userAgent: 'node' }, innerWidth: 1280, innerHeight: 800,
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        addEventListener() {}, removeEventListener() {},
        setTimeout: (fn, ms = 0) => { timers.push({ fn, at: now + ms }); return timers.length; },
        setInterval: (fn, ms = 0) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
        clearTimeout() {}, clearInterval() {},
    };
    win.window = win; win.self = win; win.top = win;
    vm.runInContext(source, vm.createContext(win));
    const advance = (ms) => {
        const end = now + ms;
        for (;;) {
            const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!due) break;
            now = due.at;
            if (due.every) due.at += due.every; else timers.splice(timers.indexOf(due), 1);
            try { due.fn(); } catch (_) { /* UI helpers the fake DOM lacks */ }
        }
        now = end;
    };
    const iframe = () => doc.getElementById('ct-bridge-iframe');
    const setEntry = (e) => (e ? store.set(WIX_KEY, JSON.stringify(e)) : store.delete(WIX_KEY));
    return { advance, iframe, setEntry };
}

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
