// Coach Studio access allowlist.
//
// The Wix "Coach Studio Admin" badge alone is not enough: any Talent
// Transformation Wix developer can assign it to themselves. Studio access
// needs a valid Wix sign-in AND the badge AND the person's email on this
// app's own list, kept on the volume (the repo is public).
//
// Owners come from the environment, ERICA_STUDIO_OWNERS (comma-separated
// emails), so the list can never lock its own owners out; owners add and
// remove everyone else from the Studio "Access" page. Until the variable is
// set the allowlist is not enforced (today's behaviour) and every Studio page
// says so in red.
//
// Roles cap what a person can do, here and over MCP:
//   admin   Studio, read:ops, write:content
//   people  + read:people, write:people
//   owner   + manage the allowlist
'use strict';

const fs = require('fs');
const path = require('path');

const ROLES = ['admin', 'people', 'owner'];
const ROLE_SCOPES = {
    admin: ['read:ops', 'write:content'],
    people: ['read:ops', 'write:content', 'read:people', 'write:people'],
    owner: ['read:ops', 'write:content', 'read:people', 'write:people', 'manage:access'],
};
const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;
const DENIAL_AUDIT_EVERY_MS = 10 * 60 * 1000;

function filePath() {
    return process.env.STUDIO_ACCESS_FILE
        || path.join(path.dirname(process.env.SESSION_DATA_DIR || '/data/sessions'), 'studio-access.json');
}

function normEmail(e) {
    const s = String(e == null ? '' : e).trim().toLowerCase();
    return EMAIL_RE.test(s) ? s : null;
}

// Read on every call: the variable is set in Railway, and tests change it.
function envOwners() {
    return [...new Set(String(process.env.ERICA_STUDIO_OWNERS || '').split(',').map(normEmail).filter(Boolean))];
}

function configured() {
    return envOwners().length > 0;
}

function readFile() {
    const p = filePath();
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return { users: {} };
        console.error('[studioAccess] ⚠️ allowlist NOT readable — only ERICA_STUDIO_OWNERS get in:', e.message);
        return { users: {}, unreadable: true };
    }
    try {
        const j = JSON.parse(raw);
        return { users: (j && typeof j.users === 'object' && j.users) || {} };
    } catch (e) {
        console.error('[studioAccess] ⚠️ allowlist file is corrupt — only ERICA_STUDIO_OWNERS get in:', e.message);
        return { users: {}, unreadable: true };
    }
}

function writeFile(data) {
    const p = filePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ users: data.users }, null, 2));
    fs.renameSync(tmp, p);
}

function roleFor(email) {
    const e = normEmail(email);
    if (!e) return null;
    if (envOwners().includes(e)) return 'owner';
    const u = readFile().users[e];
    return u && ROLES.includes(u.role) ? u.role : null;
}

// The gate. Not configured: everyone with the badge gets in, as before
// (role null, and callers show the red banner).
function check(email) {
    if (!configured()) return { ok: true, configured: false, role: null };
    const role = roleFor(email);
    return role ? { ok: true, configured: true, role } : { ok: false, configured: true, role: null };
}

function scopesFor(role) {
    return (ROLE_SCOPES[role] || []).slice();
}

function list() {
    const owners = envOwners();
    const { users, unreadable } = readFile();
    const rows = owners.map((email) => ({ email, role: 'owner', source: 'env' }));
    for (const [email, u] of Object.entries(users).sort(([a], [b]) => a.localeCompare(b))) {
        if (owners.includes(email) || !ROLES.includes(u.role)) continue;
        rows.push({ email, role: u.role, source: 'studio', addedBy: u.addedBy || null, addedAt: u.addedAt || null, updatedAt: u.updatedAt || null });
    }
    return { rows, configured: owners.length > 0, unreadable: !!unreadable };
}

function guard(email, actor) {
    const e = normEmail(email);
    if (!e) throw new Error('Not a valid email address.');
    if (envOwners().includes(e)) throw new Error(`${e} is an owner from ERICA_STUDIO_OWNERS; change it in Railway.`);
    if (normEmail(actor) === e) throw new Error('You cannot change your own access.');
    return e;
}

function set(email, role, { actor, audit } = {}) {
    if (!ROLES.includes(role)) throw new Error('Unknown role: ' + role);
    const e = guard(email, actor);
    const data = readFile();
    if (data.unreadable) throw new Error('The allowlist file could not be read; not overwriting it.');
    const before = data.users[e] || null;
    if (before && before.role === role) return { changed: false, email: e, role };
    const now = new Date().toISOString();
    data.users[e] = { role, addedBy: before ? before.addedBy : actor || null, addedAt: before ? before.addedAt : now, updatedAt: now };
    writeFile(data);
    if (audit) audit.append({ actor: actor || 'unknown', action: before ? 'access.role' : 'access.add', target: e, meta: { role, from: before ? before.role : null } });
    return { changed: true, email: e, role, from: before ? before.role : null };
}

function remove(email, { actor, audit } = {}) {
    const e = guard(email, actor);
    const data = readFile();
    if (data.unreadable) throw new Error('The allowlist file could not be read; not overwriting it.');
    const before = data.users[e];
    if (!before) return { changed: false, email: e };
    delete data.users[e];
    writeFile(data);
    if (audit) audit.append({ actor: actor || 'unknown', action: 'access.remove', target: e, meta: { from: before.role } });
    return { changed: true, email: e, from: before.role };
}

// A badge holder who is not on the list: audited, at most once per email
// every 10 minutes (each page load would otherwise add a line).
const _lastDenial = new Map();
function auditDenial(email, { audit, memberId, via } = {}) {
    const key = normEmail(email) || 'member:' + (memberId || '?');
    const now = Date.now();
    if (now - (_lastDenial.get(key) || 0) < DENIAL_AUDIT_EVERY_MS) return false;
    _lastDenial.set(key, now);
    if (audit) audit.append({ actor: key, action: 'access.denied', target: key, meta: { reason: 'not_allowlisted', via: via || 'studio' } });
    console.warn('[studioAccess] 🚫 badge holder not on the Coach Studio allowlist:', key);
    return true;
}

module.exports = { ROLES, ROLE_SCOPES, configured, envOwners, roleFor, check, scopesFor, list, set, remove, auditDenial, normEmail, _internal: { filePath, readFile, resetDenials: () => _lastDenial.clear() } };
