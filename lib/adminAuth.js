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

function timingSafeEqualString(actual, expected) {
    const actualBuffer = Buffer.from(String(actual == null ? '' : actual));
    const expectedBuffer = Buffer.from(String(expected == null ? '' : expected));
    if (actualBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function authenticatePassword({ identity, password } = {}, env = process.env) {
    const expectedPassword = String(env.ADMIN_PASSWORD || '');
    if (!expectedPassword) return { ok: false, code: 'config_error' };

    const normalizedIdentity = normalizeIdentity(identity);
    if (!normalizedIdentity || !timingSafeEqualString(password, expectedPassword)) {
        return { ok: false, code: 'invalid_credentials' };
    }
    return { ok: true, identity: normalizedIdentity };
}

module.exports = {
    authenticatePassword,
    normalizeIdentity,
    splitIdentities,
};
