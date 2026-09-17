/*
 * Signing in through Wix: OAuth 2.0 authorization code with PKCE.
 *
 * Ported from Courses Transplant (app/wix-oauth.mjs, 12-Aug-2026), which in
 * turn was ported from PIMS (src/server/wix-oauth.ts). Same six-step flow:
 *
 *   1. mint a visitor token (client ID only — the next call needs one)
 *   2. create a redirect session, which returns the Wix login page's URL
 *   3. send the person there; Wix owns that screen and we never see a password
 *   4. Wix sends them back with a code, in the URL *fragment*
 *   5. exchange code + verifier for a member token, server to server
 *   6. read who they are
 *
 * Nothing identifying travels in a URL the person can edit. The code is opaque,
 * single-use, and worthless without the verifier, which never leaves this
 * process.
 *
 * Badges (see wixBadges.js) need WIX_CLIENT_SECRET; signing in needs only the
 * client ID, which is public by design. The two checks are kept apart so a
 * working sign-in is never reported as broken because a credential it does not
 * use is absent.
 */

const { createHash, randomBytes, timingSafeEqual } = require('crypto');

const API = 'https://www.wixapis.com';
const PKCE_COOKIE = 'cs_wix_pkce';
const PKCE_MINUTES = 15;

const loginConfigured = () => Boolean(process.env.WIX_CLIENT_ID);
const adminConfigured = () =>
    Boolean(process.env.WIX_CLIENT_ID && process.env.WIX_CLIENT_SECRET);

/**
 * Where Wix sends people back to.
 *
 * Derived here, never taken from the request: Wix matches it exactly against
 * its allow-list, and a value the caller supplies is a value an attacker
 * supplies.
 */
function callbackUri() {
    // A trailing slash or a missing scheme in PUBLIC_ORIGIN would not fail
    // here. It would fail on Wix's allow-list check, after the person has
    // typed a password, with a message we never see — so normalise both
    // rather than trust the variable.
    const origin = (process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
    if (origin) {
        return `${/^https?:\/\//.test(origin) ? origin : `https://${origin}`}/auth/callback`;
    }
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (domain) return `https://${domain}/auth/callback`;
    return `http://localhost:${process.env.PORT || 8080}/auth/callback`;
}

const b64url = (b) => Buffer.from(b).toString('base64url');

function pkce() {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge, state: b64url(randomBytes(24)) };
}

// The verifier and state live in an httpOnly cookie for the length of the
// flow. Binding the exchange to the browser that began it is exactly what
// PKCE is for. sameSite must be "lax": Wix returns the member by top-level
// cross-site navigation, and "strict" would drop the cookie so every sign-in
// fails.
function pkceCookie(v) {
    return `${PKCE_COOKIE}=${encodeURIComponent(JSON.stringify(v))}; Path=/; HttpOnly; SameSite=Lax; ` +
        `Max-Age=${PKCE_MINUTES * 60}` +
        (process.env.NODE_ENV === 'production' ? '; Secure' : '');
}

// Cleared whether or not it parses: a flow is used once, and leaving it behind
// would let a replayed callback be checked against a live verifier.
function clearPkceCookie() {
    return `${PKCE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readPkce(raw) {
    if (!raw) return null;
    try {
        const p = JSON.parse(raw);
        return p && p.verifier && p.state ? { verifier: p.verifier, state: p.state, next: p.next || null } : null;
    } catch (_) { return null; }
}

async function token(body) {
    const res = await fetch(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(`Wix token endpoint refused the request (${res.status}).`);
    }
    return res.json();
}

/** Returns { url, pkce } — send the person to url, and stash pkce in their cookie. */
async function beginLogin() {
    const clientId = process.env.WIX_CLIENT_ID;
    if (!clientId) throw new Error('WIX_CLIENT_ID is not set on this deployment.');

    const visitor = await token({ clientId, grantType: 'anonymous' });
    if (!visitor.access_token) throw new Error('Wix returned no visitor token.');

    const { verifier, challenge, state } = pkce();
    const redirectUri = callbackUri();

    const res = await fetch(`${API}/_api/redirects-api/v1/redirect-session`, {
        method: 'POST',
        headers: { authorization: visitor.access_token, 'content-type': 'application/json' },
        body: JSON.stringify({
            auth: {
                authRequest: {
                    redirectUri,
                    clientId,
                    codeChallenge: challenge,
                    codeChallengeMethod: 'S256',
                    responseMode: 'fragment',
                    responseType: 'code',
                    scope: 'offline_access',
                    state,
                },
            },
        }),
    });
    if (!res.ok) {
        throw new Error(
            `Wix would not start a login (${res.status}). Check that the site is ` +
            `published, that ${redirectUri} is an allowed authorization redirect ` +
            "URI, and that the client's Login URL field is empty.");
    }

    const body = await res.json();
    const url = body && body.redirectSession && body.redirectSession.fullUrl;
    if (!url) throw new Error('Wix started a login but returned no URL.');
    return { url, pkce: { verifier, state } };
}

/** Exchanges the code for a member token and returns who they are. */
async function completeLogin({ code, state, stashed }) {
    const clientId = process.env.WIX_CLIENT_ID;
    if (!clientId) throw new Error('WIX_CLIENT_ID is not set on this deployment.');
    if (!stashed) throw new Error('This sign-in took too long, or was started in another browser.');

    const a = Buffer.from(String(stashed.state));
    const b = Buffer.from(String(state || ''));
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error('This sign-in could not be verified. Try again.');
    }

    const granted = await token({
        clientId,
        grantType: 'authorization_code',
        redirectUri: callbackUri(),
        code,
        codeVerifier: stashed.verifier,
    });
    if (!granted.access_token) throw new Error('Wix returned no member token.');

    // EXTENDED carries loginEmail and the name, and nothing else we have a
    // use for.
    const me = await fetch(`${API}/members/v1/members/my?fieldSet=EXTENDED`, {
        headers: { Authorization: granted.access_token },
    });
    if (!me.ok) throw new Error(`Wix would not identify the member (${me.status}).`);

    const meBody = await me.json();
    const member = meBody && meBody.member;
    const email = member && member.loginEmail;
    const memberId = member && member.id;
    if (!email || !memberId) throw new Error('Wix identified the member but returned no email.');

    const first = (member && member.contact && member.contact.firstName) || '';
    const last = (member && member.contact && member.contact.lastName) || '';
    const nickname = (member && member.profile && member.profile.nickname) || '';
    const name = `${first} ${last}`.trim() || nickname || email;

    return { memberId, email, name };
}

module.exports = {
    PKCE_COOKIE,
    loginConfigured,
    adminConfigured,
    callbackUri,
    pkceCookie,
    clearPkceCookie,
    readPkce,
    beginLogin,
    completeLogin,
};
