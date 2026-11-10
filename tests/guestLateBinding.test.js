// Since #74 the server opens a guest's own data (settings, activity, notes,
// own search) only for a CleverTap objectId bound at preparation. The host
// can answer REQUEST_CLEVERTAP_ID after the first preparation went out
// without it; then the whole visit got 403s, and the clipboard fetch was
// retried on every page event. The coach now binds the late id with one quiet
// preparation call and fetches again what was refused; a 403 on the notes is
// final for the connection.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function method(sig) {
    const start = src.indexOf(`    ${sig} {`) >= 0 ? src.indexOf(`    ${sig} {`) : src.indexOf(`    async ${sig} {`);
    assert.ok(start >= 0, 'method not found: ' + sig);
    const open = src.indexOf(') {', start) + 2;
    let depth = 0; let i = open;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
    const params = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
    // eslint-disable-next-line no-new-func
    return new Function(params, src.slice(open + 1, i));
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeApp({ userId = null, cleverTapId = 'ct-guest-1', fetchStatus = 200 } = {}) {
    const calls = []; const warns = [];
    global.window = { __ttCleverTapId: cleverTapId, location: { search: '?caller=web' } };
    global.URLSearchParams = URLSearchParams;
    global.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: fetchStatus < 300, status: fetchStatus, json: async () => ({}) }; };
    const app = {
        sessionId: 's-vGuest', apiUrl: (p) => p, getUserIdFromURL: () => userId, _hostPage: () => 'https://www.talenttransformation.com/',
        _coachSettings: { scope: 'none', settings: null }, _coachSettingsLoad: Promise.resolve({ scope: 'none' }),
        settingsLoads: 0, clipboardInjects: 0,
        _loadCoachSettings() { this.settingsLoads++; return Promise.resolve({ scope: 'guest', settings: { voice: 'marin' } }); },
        _injectClipboardIntoSession() { this.clipboardInjects++; },
    };
    app._bindLateCleverTapId = method('_bindLateCleverTapId()').bind(app);
    const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    const restore = () => { console.warn = origWarn; };
    return { app, calls, warns, restore };
}

test('the id arrives after a preparation that went without it: one quiet preparation binds it, then settings and refused notes are fetched again', async () => {
    const { app, calls, restore } = fakeApp();
    try {
        app._prepAsked = true; app._prepBoundObjectId = null; app._clipboardRefused = true; app._clipboardInjectedFor = 'pc-1';
        app._bindLateCleverTapId();
        await tick(); await tick();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/api/erica-preparation');
        assert.deepEqual(calls[0].body, { caller: 'web', objectId: 'ct-guest-1', sessionId: 's-vGuest', context: { hostPage: 'https://www.talenttransformation.com/' } });
        assert.equal(app.settingsLoads, 1, 'settings read again');
        assert.equal(app._coachSettings.scope, 'guest');
        assert.equal(app.clipboardInjects, 1, 'notes asked again');
        assert.equal(app._clipboardRefused, false);
        app._bindLateCleverTapId(); await tick();
        assert.equal(calls.length, 1, 'once per id');
    } finally { restore(); }
});

test('nothing to bind: a member, no preparation yet, the preparation already carried this id, or no id', async () => {
    for (const [label, opts, setup] of [
        ['member', { userId: 'member-1' }, (a) => { a._prepAsked = true; }],
        ['no preparation yet', {}, (a) => { a._prepAsked = false; }],
        ['already bound', {}, (a) => { a._prepAsked = true; a._prepBoundObjectId = 'ct-guest-1'; }],
        ['no id', { cleverTapId: null }, (a) => { a._prepAsked = true; }],
    ]) {
        const { app, calls, restore } = fakeApp(opts);
        try { setup(app); app._bindLateCleverTapId(); await tick(); assert.equal(calls.length, 0, label); } finally { restore(); }
    }
});

test('a failed binding says so and can be tried again', async () => {
    const { app, calls, warns, restore } = fakeApp({ fetchStatus: 429 });
    try {
        app._prepAsked = true; app._prepBoundObjectId = null;
        app._bindLateCleverTapId(); await tick(); await tick();
        assert.ok(warns.some((w) => /Guest id NOT bound/.test(w)));
        assert.equal(app._prepBoundObjectId, null, 'free to try again');
        app._bindLateCleverTapId(); await tick();
        assert.equal(calls.length, 2);
    } finally { restore(); }
});

test('wiring: the preparation records what it bound; the CLEVERTAP_ID_RESPONSE listener triggers the late binding; a 403 on the notes is final for the connection', () => {
    assert.match(src, /this\._prepAsked = true;\s*this\._prepBoundObjectId = window\.__ttCleverTapId \? String\(window\.__ttCleverTapId\) : null;\s*const response = await this\.fetchWithBackoff\(/);
    const setup = src.slice(src.indexOf('    setupIframeMessaging() {'), src.indexOf('    _bindLateCleverTapId() {'));
    assert.match(setup, /event\.data\.type === 'CLEVERTAP_ID_RESPONSE'\) setTimeout\(\(\) => this\._bindLateCleverTapId\(\), 0\)/);
    const clip = src.slice(src.indexOf('    _injectClipboardIntoSession() {'), src.indexOf('    _injectClipboardIntoSession() {') + 6000);
    assert.match(clip, /if \(\/HTTP 403\/\.test\(String\(err\?\.message\)\)\) \{\s*this\._clipboardRefused = true;/);
    const refusedBranch = clip.slice(clip.indexOf('this._clipboardRefused = true;'), clip.indexOf('return;', clip.indexOf('this._clipboardRefused = true;')));
    assert.doesNotMatch(refusedBranch, /_clipboardInjectedFor = null/, 'a 403 is not retried on every page event');
});
