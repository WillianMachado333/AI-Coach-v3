/**
 * Signed identity from the Wix host (item #28), client side.
 *
 * The host page (Wix, member context) mints a short-lived token and hands
 * it to this iframe — postMessage { type: 'ERICA_IDENTITY', token } from
 * the parent, or ?idt=<token> in the iframe URL (read once, then removed
 * from the address). This file keeps the latest token, asks the host for a
 * fresh one every 4 minutes (REQUEST_ERICA_IDENTITY), and adds it as the
 * X-Erica-Identity header to every same-origin /api/ request — so every
 * endpoint, present and future, carries it without per-call changes.
 *
 * The server derives who the user is ONLY from a valid token
 * (lib/signedIdentity.js). No token, no signed-in identity once
 * ERICA_REQUIRE_SIGNED_IDENTITY is on.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') { window.ericaIdentity = api; api.install(window); }
})(typeof self !== 'undefined' ? self : this, function () {
    const HEADER = 'X-Erica-Identity';
    const REFRESH_MS = 4 * 60 * 1000;
    // The same parents app.js trusts to steer the coach (_isTrustedBridgeOrigin).
    const TRUSTED_HOSTS = ['talenttransformation.com', 'www.talenttransformation.com', 'apps.talenttransformation.com',
        'awav.com', 'www.awav.com', 'web-staging-2c7ff.up.railway.app'];
    const TOKEN_RE = /^v1\.[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{20,100}$/;

    const state = { token: null, receivedAt: 0, source: null };

    function isTrustedOrigin(origin, selfOrigin) {
        if (!origin || origin === 'null') return false;
        try {
            const u = new URL(origin);
            if (u.origin === selfOrigin) return true;
            const host = u.hostname.toLowerCase();
            return TRUSTED_HOSTS.includes(host) || host.endsWith('.wixsite.com') || host.endsWith('.wix.com') || host.endsWith('.editorx.io');
        } catch (_) { return false; }
    }

    function setToken(token, source) {
        if (typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
        state.token = token;
        state.receivedAt = Date.now();
        state.source = source;
        return true;
    }

    // Header only for this app's own API: never leak the token to a third party.
    function shouldAttach(url, selfOrigin) {
        try {
            const u = new URL(url, selfOrigin + '/');
            return u.origin === selfOrigin && u.pathname.startsWith('/api/');
        } catch (_) { return false; }
    }

    function withHeader(init, token) {
        const next = Object.assign({}, init || {});
        const h = new Headers((init && init.headers) || {});
        if (!h.has(HEADER)) h.set(HEADER, token);
        next.headers = h;
        return next;
    }

    function install(win) {
        if (!win || win.__ericaIdentityInstalled) return;
        win.__ericaIdentityInstalled = true;
        const selfOrigin = win.location ? win.location.origin : '';

        // ?idt= from the embed URL: read once, then take it out of the address bar/history.
        try {
            const params = new URLSearchParams(win.location.search);
            const idt = params.get('idt');
            if (idt && setToken(idt, 'url')) {
                params.delete('idt');
                const q = params.toString();
                win.history.replaceState(null, '', win.location.pathname + (q ? '?' + q : '') + win.location.hash);
            }
        } catch (_) { /* no history API */ }

        win.addEventListener('message', (event) => {
            const d = event && event.data;
            if (!d || d.type !== 'ERICA_IDENTITY') return;
            if (event.source !== win.parent && event.source !== win) return;
            if (!isTrustedOrigin(event.origin, selfOrigin)) {
                console.warn('[identity] ERICA_IDENTITY from an untrusted origin ignored:', event.origin);
                return;
            }
            if (d.token === null) { state.token = null; state.source = 'cleared'; return; } // host says: signed out
            if (!setToken(d.token, 'host')) console.warn('[identity] ERICA_IDENTITY with a malformed token ignored');
        });

        const ask = () => { try { if (win.parent && win.parent !== win) win.parent.postMessage({ type: 'REQUEST_ERICA_IDENTITY' }, '*'); } catch (_) { /* not framed */ } };
        ask();
        setInterval(ask, REFRESH_MS);

        const origFetch = win.fetch && win.fetch.bind(win);
        if (!origFetch) return;
        win.fetch = function (input, init) {
            try {
                if (state.token) {
                    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
                    if (shouldAttach(url, selfOrigin)) {
                        if (typeof input !== 'string' && input && typeof Request !== 'undefined' && input instanceof Request) {
                            return origFetch(new Request(input, withHeader(init, state.token)));
                        }
                        return origFetch(input, withHeader(init, state.token));
                    }
                }
            } catch (_) { /* never break a request over the header */ }
            return origFetch(input, init);
        };
    }

    return { install, setToken, isTrustedOrigin, shouldAttach, HEADER, get token() { return state.token; }, get source() { return state.source; } };
});
