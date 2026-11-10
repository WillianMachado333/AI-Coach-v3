// While the site loads, the bridge costs bridge.js and the icon's still image,
// nothing more (V3 production prep, 4 Nov 2026: the live site is under a Wix
// performance alert, Login opening 6-10 s after the click). The coach iframe
// (its scripts, Tailwind, photos, clips) and the speaking/waving clips load on
// the first hover, touch, focus or click. The waving clip is the 84p webm the
// coach uses (~46 KB), not the 6 MB mp4 the icon preloaded on every page.
// At rest the icon must still look available (Willian, 10 Nov 2026: "it
// looked disconnected until I clicked"): the ring is green, and the idle clip
// starts once the page has finished loading and the browser is idle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBridge } = require('./helpers/bridgeHarness');

const STAGING = 'https://web-staging-2c7ff.up.railway.app';
const GREEN = /0 0 0 3px #22c55e/;

test('while the page loads: the still image and the available (green) ring; no coach, no clips', () => {
    const b = runBridge();
    b.advance(5000);
    assert.ok(b.icon(), 'the icon is there');
    assert.match(b.icon().getAttribute('style'), /companions\/Erica-thumb\.png/);
    assert.match(b.icon().getAttribute('style'), GREEN, 'available, not grey "offline"');
    assert.equal(b.icon().getAttribute('title'), 'Your AI coach is available');
    assert.equal(b.iframe(), null, 'no coach until the person shows interest');
    assert.equal(b.videos().length, 0, 'no clips before the page has loaded');
    assert.equal(b.win.__ctBridgeStatus().coachLoaded, false);
});

test('once the page has loaded and the browser is idle: the idle clip breathes in the corner; still no coach', () => {
    const b = runBridge();
    b.advance(1000);
    b.pageLoaded();
    b.advance(1000);
    assert.equal(b.videos().length, 0, 'waits for the browser to be idle');
    b.advance(1000);
    const clips = b.videos();
    assert.equal(clips.length, 1, 'the idle clip only');
    assert.equal(clips[0].id, 'ct-bridge-icon-video-idle');
    assert.equal(clips[0].getAttribute('src'), STAGING + '/companions/idle/84p/Erica.webm', 'the same file hover would load: no second download');
    assert.equal(b.iframe(), null, 'the coach still waits for interest');
    b.wake();
    assert.equal(b.videos().length, 3, 'hover adds speaking and waving, never a second idle');
});

test('people who ask for less motion or less data: the still image and the green ring, no clip at rest', () => {
    for (const opts of [{ reducedMotion: true }, { saveData: true }]) {
        const b = runBridge(opts);
        b.advance(1000);
        b.pageLoaded();
        b.advance(5000);
        assert.equal(b.videos().length, 0, JSON.stringify(opts));
        assert.match(b.icon().getAttribute('style'), GREEN);
    }
});

test('the coach\'s standby (GPT-Live before its first session) shows green too; connecting amber, disconnected red', () => {
    const b = runBridge();
    b.advance(1000);
    b.wake();
    for (const [state, colour] of [['connecting', '#f59e0b'], ['standby', '#22c55e'], ['connected', '#22c55e'], ['disconnected', '#ef4444']]) {
        b.postToBridge({ type: 'CT_CONNECTION_STATE', state });
        assert.match(b.icon().getAttribute('style'), new RegExp('0 0 0 3px ' + colour), state);
    }
});

for (const [how, act] of [
    ['hover', (b) => b.fire(b.icon(), 'mouseenter')],
    ['touch', (b) => b.fire(b.icon(), 'touchstart')],
    ['keyboard focus', (b) => b.fire(b.icon(), 'focus')],
    ['click', (b) => b.icon().click()],
    ['programmatic expand', (b) => b.win.__ctBridgeExpand()],
]) {
    test(`${how}: loads the coach and the icon clips, once`, () => {
        const b = runBridge();
        b.advance(1000);
        act(b);
        assert.ok(b.iframe(), 'the coach iframe is created');
        assert.equal(b.iframe().src, STAGING + '/index.html?caller=web');
        const [idle, speaking, waving] = b.videos();
        assert.equal(idle.getAttribute('src'), STAGING + '/companions/idle/84p/Erica.webm');
        assert.equal(speaking.getAttribute('src'), STAGING + '/companions/speaking/84p/Erica.webm');
        assert.equal(waving.getAttribute('src'), STAGING + '/companions/waving/84p/Erica.webm', 'the light clip, not waving/*.mp4');
        assert.match(b.icon().getAttribute('style'), /0 0 0 3px #f59e0b/, 'connecting');
        b.wake(); b.icon().click(); b.icon().click();
        assert.equal(b.doc.querySelectorAll('iframe').length, 1, 'never a second coach');
        assert.equal(b.videos().length, 3, 'never a second set of clips');
    });
}

test('click opens the chat on the first click (load + expand together)', () => {
    const b = runBridge();
    b.advance(1000);
    b.icon().click();
    assert.equal(b.win.__ctBridgeStatus().state, 'expanded');
    assert.ok(b.iframe());
});

test('signing in before the coach loads: the coach opens with the member id; the 2 s member check starts with the coach', () => {
    const b = runBridge();
    b.advance(10000);
    b.setEntry({ wixLocalStorage: 'true', userAuthenticated: true, loggedInUserId: 'member-7' });
    b.advance(3000);
    assert.equal(b.iframe(), null, 'still nothing loaded');
    b.wake();
    assert.equal(b.iframe().src, STAGING + '/index.html?caller=web&userId=member-7');
    b.setEntry(null);
    b.advance(3000);
    assert.equal(b.iframe().src, STAGING + '/index.html?caller=web', 'signing out reloads the loaded coach');
});

test('the resting icon shows the coach the person last talked to on this site', () => {
    const first = runBridge();
    first.advance(1000);
    first.wake();
    first.postToBridge({ type: 'CT_ICON_PERSONA', key: 'Omar', thumb: 'omar-thumb.png' });
    const saved = first.local.get('ctIconPersona');
    assert.deepEqual(JSON.parse(saved), { key: 'Omar', thumb: 'omar-thumb.png' });

    // The next page view: Omar's still at rest, and still nothing else loads.
    const next = runBridge({ localSeed: { ctIconPersona: saved } });
    next.advance(1000);
    assert.match(next.icon().getAttribute('style'), /companions\/omar-thumb\.png/);
    assert.equal(next.iframe(), null);
    next.wake();
    assert.equal(next.videos()[0].getAttribute('src'), STAGING + '/companions/idle/84p/Omar.webm');
});

test('a saved persona that is junk or unsafe falls back to Erica (or to the key\'s own thumb)', () => {
    const still = (value) => {
        const b = runBridge({ localSeed: { ctIconPersona: value } });
        b.advance(1000);
        return b.icon().getAttribute('style');
    };
    assert.match(still(JSON.stringify({ key: 'Jasmine', thumb: null })), /companions\/Jasmine-thumb\.png/);
    assert.match(still('not json'), /companions\/Erica-thumb\.png/);
    assert.match(still(JSON.stringify({ key: '../evil', thumb: 'x-thumb.png' })), /companions\/Erica-thumb\.png/);
    assert.match(still(JSON.stringify({ key: 'Omar', thumb: '"><script>' })), /companions\/Omar-thumb\.png/);
});

test('page events from before the coach loaded reach it once it says it is listening', () => {
    const b = runBridge({ location: { hostname: 'www.awav.com', search: '', pathname: '/journeys', href: 'https://www.awav.com/journeys' } });
    b.win.clevertap = { event: [] };
    b.advance(200); // the bridge wraps clevertap.event
    b.win.clevertap.event.push('Visited My Journey Page', { PageName: 'My Journey' });
    b.advance(1000);
    b.wake();
    const sent = [];
    b.iframe().contentWindow = { postMessage: (m) => sent.push(m) };
    b.postToBridge({ type: 'HOST_EVENTS_READY' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'HOST_EVENT');
    assert.equal(sent[0].name, 'Visited My Journey Page');
});
