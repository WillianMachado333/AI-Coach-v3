/**
 * Signed identity from the Wix host (item #28).
 *
 * Until now every endpoint trusted the userId / email / objectId a client
 * sent, so anyone holding an id got Erica "as" that person — preparation
 * (psychometric data), conversation history, the coach clipboard. The Wix
 * site (Velo backend, member context — see the PR for the snippet) now
 * mints a short-lived token; this module verifies it and is the ONE place
 * an endpoint gets identity from.
 *
 * Token:  v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, "v1." + payload))>
 * Payload: { uid, iat, exp, aud: 'erica', nonce }   (seconds; exp - iat ≤ 600)
 * Secret:  WIX_IDENTITY_SECRET (same value in Wix Secrets Manager)
 *
 * Policy (resolve):
 *   - valid token          → identity ONLY from the token (loose ids ignored; a mismatch is logged)
 *   - invalid token        → refused (401 + audit 'identity.rejected')
 *   - no token, flag off   → the loose userId/email, logged 'unsigned'  (today's behaviour)
 *   - no token, flag on    → no signed-in identity (userId/email dropped); endpoints decide:
 *                            history → 401, the rest → guest
 *   - guests               → the CleverTap objectId stays unsigned either way (the host cannot
 *                            prove who owns it), logged as such
 * Flag: ERICA_REQUIRE_SIGNED_IDENTITY = on | off (default off until the Wix side ships).
 */

const crypto = require('crypto');

const AUD = 'erica';
const MAX_LIFETIME_S = 600;
const CLOCK_SKEW_S = 60;
const HEADER = 'x-erica-identity';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

function secret() { return process.env.WIX_IDENTITY_SECRET || ''; }
function required() { return /^(on|true|1|yes)$/i.test(process.env.ERICA_REQUIRE_SIGNED_IDENTITY || ''); }

function sign(payloadB64, key) {
    return b64u(crypto.createHmac('sha256', key).update('v1.' + payloadB64).digest());
}

/** Mint a token (tests, and the reference the Velo snippet mirrors). */
function mint({ uid, iat = Math.floor(Date.now() / 1000), ttl = 300, aud = AUD, nonce = crypto.randomBytes(9).toString('base64url') } = {}, key = secret()) {
    if (!key) throw new Error('WIX_IDENTITY_SECRET is not set');
    const payload = b64u(JSON.stringify({ uid, iat, exp: iat + ttl, aud, nonce }));
    return `v1.${payload}.${sign(payload, key)}`;
}

/**
 * Verify a token. Returns { ok: true, uid, iat, exp } or { ok: false, reason }.
 * Never throws.
 */
function verify(token, { key = secret(), now = Math.floor(Date.now() / 1000) } = {}) {
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
    if (!key) return { ok: false, reason: 'no_secret_configured' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return { ok: false, reason: 'malformed' };
    const expected = fromB64u(sign(parts[1], key));
    const got = fromB64u(parts[2]);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return { ok: false, reason: 'bad_signature' };
    let p;
    try { p = JSON.parse(fromB64u(parts[1]).toString('utf8')); } catch (_) { return { ok: false, reason: 'malformed' }; }
    if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed' };
    if (p.aud !== AUD) return { ok: false, reason: 'wrong_audience' };
    if (typeof p.uid !== 'string' || !p.uid.trim() || p.uid.length > 128) return { ok: false, reason: 'no_subject' };
    if (!Number.isFinite(p.iat) || !Number.isFinite(p.exp)) return { ok: false, reason: 'malformed' };
    if (p.exp - p.iat > MAX_LIFETIME_S) return { ok: false, reason: 'lifetime_too_long' };
    if (p.iat > now + CLOCK_SKEW_S) return { ok: false, reason: 'issued_in_future' };
    if (p.exp < now - CLOCK_SKEW_S) return { ok: false, reason: 'expired' };
    return { ok: true, uid: p.uid, iat: p.iat, exp: p.exp };
}

function tokenFrom(req, body) {
    const h = req && req.headers && req.headers[HEADER];
    if (typeof h === 'string' && h) return h;
    if (body && typeof body.identityToken === 'string' && body.identityToken) return body.identityToken;
    return null;
}

const ipOf = (req) => String((req && req.headers && req.headers['x-forwarded-for']) || (req && req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
const ipHash = (ip) => (ip ? crypto.createHash('sha256').update('erica-ip|' + ip).digest('hex').slice(0, 12) : null);

// One audit line per (ip, reason, endpoint) per minute: a flood of forged
// tokens must not grow the hash-chained audit log without bound.
const auditSeen = new Map();
function auditRejection(audit, { endpoint, reason, req }) {
    const ip = ipHash(ipOf(req));
    const k = `${ip}|${reason}|${endpoint}`;
    const now = Date.now();
    const last = auditSeen.get(k);
    if (last && now - last < 60000) return false;
    auditSeen.set(k, now);
    if (auditSeen.size > 5000) auditSeen.delete(auditSeen.keys().next().value);
    try { if (audit) audit.append({ actor: 'system', action: 'identity.rejected', target: endpoint, meta: { reason, ipHash: ip } }); } catch (e) {
        console.error('[identity] audit append failed:', e?.message || e);
    }
    return true;
}

/**
 * The identity a request may act as.
 *
 * Returns { ok: true, userId, email, objectId, source, signed } — or
 * { ok: false, status: 401, reason } when a token was presented and failed.
 *   source: 'signed' | 'unsigned' (loose ids, flag off) | 'guest' (objectId only) | 'none'
 * `loose` = { userId, email, objectId } as the client sent them.
 */
function resolve(req, loose = {}, { endpoint = '?', audit = null, body = null, trustLoose = false } = {}) {
    const token = tokenFrom(req, body);
    const guestId = typeof loose.objectId === 'string' && loose.objectId.trim() ? loose.objectId.trim() : null;
    if (token) {
        const v = verify(token);
        if (!v.ok) {
            if (v.reason === 'no_secret_configured' && !required()) {
                // The host started sending tokens before this server got the
                // secret: say so loudly, keep today's behaviour.
                console.error(`[identity] ⚠️ token presented to ${endpoint} but WIX_IDENTITY_SECRET is not set — NOT verified, falling back to unsigned ids`);
            } else {
                console.warn(`[identity] ❌ token refused at ${endpoint}: ${v.reason}`);
                auditRejection(audit, { endpoint, reason: v.reason, req });
                return { ok: false, status: 401, reason: v.reason };
            }
        } else {
            if (loose.userId && String(loose.userId) !== v.uid) {
                console.warn(`[identity] ${endpoint}: body userId differs from the signed one — ignored, using the token`);
            }
            return { ok: true, userId: v.uid, email: null, objectId: guestId, source: 'signed', signed: true };
        }
    }
    const userId = typeof loose.userId === 'string' && loose.userId.trim() ? loose.userId.trim() : null;
    const email = typeof loose.email === 'string' && loose.email.trim() ? loose.email.trim() : null;
    if ((userId || email) && !required()) {
        return { ok: true, userId, email, objectId: guestId, source: 'unsigned', signed: false };
    }
    // A Coach Studio admin in the Simulator poses as a user on purpose; the
    // endpoint has checked the admin session before passing trustLoose.
    if ((userId || email) && trustLoose) {
        console.log(`[identity] ${endpoint}: unsigned id accepted for a Studio admin (simulator)`);
        return { ok: true, userId, email, objectId: guestId, source: 'admin-simulator', signed: false };
    }
    if ((userId || email) && required()) {
        console.warn(`[identity] ${endpoint}: unsigned userId/email dropped (ERICA_REQUIRE_SIGNED_IDENTITY=on)`);
    }
    return { ok: true, userId: null, email: null, objectId: guestId, source: guestId ? 'guest' : 'none', signed: false };
}

function status() {
    return { required: required(), secretConfigured: !!secret() };
}

module.exports = { mint, verify, resolve, tokenFrom, status, HEADER, AUD, MAX_LIFETIME_S, _auditSeen: auditSeen };
