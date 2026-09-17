/*
 * Who may use the admin, decided in Wix.
 *
 * A member holding the "Coach Studio Admin" badge gets the Studio surface.
 * Ported from Courses Transplant (app/wix-badges.mjs, 12-Aug-2026), which in
 * turn was ported from PIMS.
 *
 * Badges, not member roles: roles are only readable through the frontend SDK,
 * and a headless project reads an identity with no roles on it at all.
 * Badges are in the REST API, and they are what somebody can create in the
 * Wix dashboard without a developer.
 *
 * Read with the PROJECT's credentials, never the member's token. A member
 * cannot be trusted to report which badges they hold — that would be letting
 * the browser decide what it is allowed to do. This is why the admin needs
 * WIX_CLIENT_SECRET while signing in needs only the client ID.
 */

const API = 'https://www.wixapis.com';

/** The badge that grants the admin. Named here once so it cannot drift. */
const ADMIN_BADGE = 'Coach Studio Admin';

const badgesConfigured = () =>
    Boolean(process.env.WIX_CLIENT_ID && process.env.WIX_CLIENT_SECRET);

/* ---------------------------------------------------------------- admin token */

// Wix gives four hours, so it is held rather than minted per call. The PROMISE
// is cached, not the value: two requests arriving together on a cold process
// would otherwise both mint one and the second would quietly replace the first.
let adminToken = null;

async function fetchAdminToken() {
    const res = await fetch(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: process.env.WIX_CLIENT_ID,
            client_secret: process.env.WIX_CLIENT_SECRET,
        }),
    });
    if (!res.ok) {
        // Said plainly, because the two ways this fails look identical from
        // outside: a secret regenerated in the dashboard, and one pasted with
        // whitespace.
        throw new Error(`Wix refused the client credentials (${res.status}). ` +
            'Check WIX_CLIENT_ID and WIX_CLIENT_SECRET on this deployment.');
    }
    const body = await res.json();
    if (!body.access_token) throw new Error('Wix returned no admin token');
    return body.access_token;
}

async function adminAuth() {
    // A minute of slack, so a token cannot expire between this check and the
    // call it authorises.
    if (adminToken && adminToken.expiresAt > Date.now() + 60_000) return adminToken.promise;
    const promise = fetchAdminToken();
    adminToken = { promise, expiresAt: Date.now() + 4 * 60 * 60_000 };
    // A failure must NOT be cached, or one bad minute locks the admin out
    // for four hours.
    promise.catch(() => { adminToken = null; });
    return promise;
}

const authHeaders = async () => ({
    authorization: await adminAuth(),
    'content-type': 'application/json',
});

/* -------------------------------------------------------------------- badges */

let badgeCache = null;
const BADGE_LIST_MS = 5 * 60_000;

// The badge list is small and changes rarely. Cached ONLY on success: caching
// a failure would answer "no badges" for the next five minutes, which reads
// as "this person has no access" and locks people out of their own platform.
async function allBadges() {
    if (badgeCache && Date.now() - badgeCache.at < BADGE_LIST_MS) return badgeCache.titles;
    const res = await fetch(`${API}/badges/v4/badges/query`, {
        method: 'POST', headers: await authHeaders(), body: JSON.stringify({ query: {} }),
    });
    if (!res.ok) throw new Error(`Wix would not list the badges (${res.status}).`);
    const body = await res.json();
    const titles = new Map();
    for (const b of (body && body.badges) || []) {
        if (b.id && b.title) titles.set(b.id, b.title);
    }
    badgeCache = { at: Date.now(), titles };
    return titles;
}

/**
 * The badge titles a member holds.
 *
 * Two calls: assignments carry only badge ids, so the id → title map comes
 * second. Throws rather than returning [] when Wix cannot answer — "no
 * badges" and "we could not ask" must not look the same to the caller.
 */
async function badgeTitlesFor(memberId) {
    if (!badgesConfigured()) {
        throw new Error('WIX_CLIENT_SECRET is not set on this deployment, so badges cannot be read.');
    }
    const res = await fetch(`${API}/badges/v4/assignments/query`, {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({ query: { filter: { memberId } } }),
    });
    if (!res.ok) throw new Error(`Wix would not report this member's badges (${res.status}).`);

    const body = await res.json();
    const held = new Set(((body && body.badgeAssignments) || [])
        .map(a => a.badgeId).filter(Boolean));
    if (!held.size) return [];

    const titles = await allBadges();
    return [...held].map(id => titles.get(id)).filter(Boolean);
}

/* ------------------------------------------------------------- authorisation */

// Per-member, short. The badge is re-read rather than trusted from the
// session so that TAKING THE BADGE AWAY IN WIX TAKES ACCESS AWAY — within a
// minute, not at the next sign-in, which could be a week later. That is the
// whole point of keeping authority in Wix instead of copying it here.
const HOLD_MS = 60_000;
const holders = new Map();

/**
 * The decision itself, kept pure and separate from fetching so it can be
 * tested without a network: which titles grant the admin, and what to say
 * when they do not. Badge titles are compared case-insensitively and
 * trimmed — somebody typing "coach studio admin " in the Wix dashboard means
 * the same badge, and a demo lost to a trailing space is not a security
 * property.
 */
function grants(badges) {
    const want = ADMIN_BADGE.toLowerCase();
    const held = (badges || []).map(b => String(b).trim().toLowerCase());
    if (held.includes(want)) return { ok: true, badges };
    return { ok: false, reason: `this account does not hold the "${ADMIN_BADGE}" badge`, badges };
}

async function holdsAdminBadge(memberId) {
    if (!memberId) return { ok: false, reason: 'not signed in' };
    const cached = holders.get(memberId);
    if (cached && Date.now() - cached.at < HOLD_MS) return cached.answer;

    try {
        const answer = grants(await badgeTitlesFor(memberId));
        holders.set(memberId, { at: Date.now(), answer });
        return answer;
    } catch (e) {
        // Not cached, and NOT silently a "no": the reason reaches the page,
        // so a Wix outage or a missing secret cannot be mistaken for a
        // permission problem.
        return { ok: false, reason: e.message, failed: true };
    }
}

module.exports = {
    ADMIN_BADGE,
    badgesConfigured,
    badgeTitlesFor,
    grants,
    holdsAdminBadge,
};
