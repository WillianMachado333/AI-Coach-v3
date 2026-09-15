'use strict';

const crypto = require('crypto');

function normalizeIdentity(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function splitIdentities(value) {
    return String(value || '')
        .split(/[;,\n]/)
        .map(normalizeIdentity)
        .filter(Boolean);
}

function configuredAdminIdentities(env = process.env) {
    // An explicit allow-list takes precedence. This keeps the prototype
    // usable with the existing ADMIN_PASSWORD while allowing the operator to
    // constrain access to one or more email addresses/usernames.
    const allowed = splitIdentities(env.ADMIN_ALLOWED_USERS);
    if (allowed.length) return [...new Set(allowed)];

    const configured = [env.ADMIN_USERNAME, env.ADMIN_EMAIL, env.ADMIN_LOGIN]
        .map(normalizeIdentity)
        .filter(Boolean);
    return [...new Set(configured.length ? configured : ['admin'])];
}

function timingSafeEqualString(actual, expected) {
    const actualBuffer = Buffer.from(String(actual == null ? '' : actual));
    const expectedBuffer = Buffer.from(String(expected == null ? '' : expected));
    if (actualBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function authenticateAdmin({ identity, password } = {}, env = process.env) {
    const expectedPassword = String(env.ADMIN_PASSWORD || '');
    if (!expectedPassword) return { ok: false, code: 'config_error' };

    const normalizedIdentity = normalizeIdentity(identity);
    if (!normalizedIdentity || !timingSafeEqualString(password, expectedPassword)) {
        return { ok: false, code: 'invalid_credentials' };
    }
    if (!configuredAdminIdentities(env).includes(normalizedIdentity)) {
        return { ok: false, code: 'access_denied', identity: normalizedIdentity };
    }
    return { ok: true, identity: normalizedIdentity };
}

module.exports = {
    authenticateAdmin,
    configuredAdminIdentities,
    normalizeIdentity,
};
