const test = require('node:test');
const assert = require('node:assert/strict');
const { signSession, verifySession } = require('../lib/admin');
const { grants, ADMIN_BADGE } = require('../lib/wixBadges');

// These pin the invariants that make Wix badge auth actually enforce
// anything: a session minted before this identity model existed must not
// be treated as valid, and the badge match must be exact-enough to be a
// real gate while forgiving whitespace/case slips in the Wix dashboard.
// Both were silently dropped once already (Sep-2026 password-form detour),
// so they get a permanent test rather than relying on code review to
// notice a second time.

test('verifySession rejects a session with no Wix member id', () => {
    const previous = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-secret-at-least-16-chars';
    try {
        const now = Math.floor(Date.now() / 1000);
        // Shape from the pre-Wix (and the Sep-2026 password-form regression)
        // session payloads: no `m`.
        const legacy = signSession({ sub: 'admin', u: 'someone', iat: now, exp: now + 3600 });
        assert.equal(verifySession(legacy), null);
    } finally {
        if (previous === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = previous;
    }
});

test('verifySession accepts a session shaped with a Wix member id', () => {
    const previous = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-secret-at-least-16-chars';
    try {
        const now = Math.floor(Date.now() / 1000);
        const value = signSession({ sub: 'admin', m: 'wix-member-1', e: 'a@b.com', n: 'A', iat: now, exp: now + 3600 });
        const session = verifySession(value);
        assert.ok(session);
        assert.equal(session.m, 'wix-member-1');
    } finally {
        if (previous === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = previous;
    }
});

test('verifySession rejects an expired session', () => {
    const previous = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-secret-at-least-16-chars';
    try {
        const now = Math.floor(Date.now() / 1000);
        const value = signSession({ sub: 'admin', m: 'wix-member-1', iat: now - 100, exp: now - 1 });
        assert.equal(verifySession(value), null);
    } finally {
        if (previous === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = previous;
    }
});

test('wixBadges.grants matches the admin badge case- and whitespace-insensitively', () => {
    assert.equal(grants([ADMIN_BADGE]).ok, true);
    assert.equal(grants([`  ${ADMIN_BADGE.toUpperCase()}  `]).ok, true);
    assert.equal(grants(['Some Other Badge']).ok, false);
    assert.equal(grants([]).ok, false);
    assert.equal(grants(undefined).ok, false);
});
