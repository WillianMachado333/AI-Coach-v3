// The bridge opens the coach served by the same host as bridge.js itself, so
// a production service's bridge opens the production coach (V3 production
// prep, 4 Nov 2026). It used to hardcode web-staging-2c7ff for the coach
// iframe and the corner icon's videos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBridge } = require('./helpers/bridgeHarness');

const PROD = 'https://web-production-2c7ff.up.railway.app';
const STAGING = 'https://web-staging-2c7ff.up.railway.app';

test('the coach and the icon videos come from the host that served bridge.js', () => {
    const b = runBridge({ currentScript: PROD + '/bridge.js' });
    b.advance(1000);
    assert.ok(b.iframe(), 'the coach iframe is injected');
    assert.equal(b.iframe().src, PROD + '/index.html?caller=web');
    assert.match(b.icon().getAttribute('style'), new RegExp(PROD.replace(/\./g, '\\.') + '/companions/Erica-thumb\\.png'));
    const idle = b.byId('ct-bridge-icon-video-idle');
    assert.equal(idle.getAttribute('src'), PROD + '/companions/idle/84p/Erica.webm');
    assert.equal(b.win.__ctBridgeStatus().coachOrigin, PROD);
});

test('without document.currentScript: the <script> that loaded bridge.js decides', () => {
    const b = runBridge({ currentScript: null, scripts: ['https://static.parastorage.com/x.js', PROD + '/bridge.js?v=1'] });
    b.advance(1000);
    assert.equal(b.iframe().src, PROD + '/index.html?caller=web');
});

test('nothing to read, or a non-https script: staging, as before', () => {
    for (const opts of [{}, { currentScript: 'http://evil.example/bridge.js' }, { currentScript: 'not a url at all %%' }]) {
        const b = runBridge(opts);
        b.advance(1000);
        assert.equal(b.iframe().src, STAGING + '/index.html?caller=web', JSON.stringify(opts));
    }
});

test('the Studio simulator flag and the member id still ride on the production coach URL', () => {
    const b = runBridge({
        currentScript: PROD + '/bridge.js',
        location: { hostname: 'www.awav.com', search: '?simulator=1', pathname: '/', href: 'https://www.awav.com/?simulator=1' },
        entry: { wixLocalStorage: 'true', userAuthenticated: true, loggedInUserId: 'member-1' },
    });
    b.advance(1000);
    assert.equal(b.iframe().src, PROD + '/index.html?caller=admin-simulator&simulator=1&userId=member-1');
});

test('no hardcoded staging host is left outside the fallback', () => {
    const src = require('node:fs').readFileSync(require('./helpers/bridgeHarness').BRIDGE_PATH, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const uses = code.match(/web-staging-2c7ff/g) || [];
    assert.equal(uses.length, 1, 'only STAGING_ORIGIN');
});
