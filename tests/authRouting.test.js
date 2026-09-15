const test = require('node:test');
const assert = require('node:assert/strict');
const { authenticateAdmin, configuredAdminIdentities } = require('../lib/adminAuth');
const { aiCoachEnvironmentLabel } = require('../lib/environmentLabel');

test('admin UI labels the single Railway environment as the prototype environment', () => {
    const previous = process.env.AI_COACH_ENVIRONMENT;
    try {
        delete process.env.AI_COACH_ENVIRONMENT;
        assert.equal(aiCoachEnvironmentLabel(process.env.AI_COACH_ENVIRONMENT), 'Prototype');

        process.env.AI_COACH_ENVIRONMENT = 'production';
        assert.equal(aiCoachEnvironmentLabel(process.env.AI_COACH_ENVIRONMENT), 'Prototype');

        process.env.AI_COACH_ENVIRONMENT = 'prototype';
        assert.equal(aiCoachEnvironmentLabel(process.env.AI_COACH_ENVIRONMENT), 'Prototype');
    } finally {
        if (previous === undefined) delete process.env.AI_COACH_ENVIRONMENT;
        else process.env.AI_COACH_ENVIRONMENT = previous;
    }
});

test('custom Admin auth accepts a configured username and password', () => {
    const result = authenticateAdmin(
        { identity: 'Coach-Admin', password: 'correct-horse' },
        { ADMIN_PASSWORD: 'correct-horse', ADMIN_USERNAME: 'coach-admin' }
    );
    assert.deepEqual(result, { ok: true, identity: 'coach-admin' });
});

test('custom Admin auth keeps the existing password-only prototype usable', () => {
    assert.deepEqual(configuredAdminIdentities({ ADMIN_PASSWORD: 'configured' }), ['admin']);
    assert.equal(
        authenticateAdmin({ identity: 'admin', password: 'configured' }, { ADMIN_PASSWORD: 'configured' }).ok,
        true
    );
});

test('custom Admin auth distinguishes invalid credentials from access denied', () => {
    const env = { ADMIN_PASSWORD: 'correct-horse', ADMIN_ALLOWED_USERS: 'owner@example.test' };
    assert.deepEqual(
        authenticateAdmin({ identity: 'owner@example.test', password: 'wrong' }, env),
        { ok: false, code: 'invalid_credentials' }
    );
    assert.deepEqual(
        authenticateAdmin({ identity: 'other@example.test', password: 'correct-horse' }, env),
        { ok: false, code: 'access_denied', identity: 'other@example.test' }
    );
});

test('custom Admin auth reports missing password configuration', () => {
    assert.deepEqual(
        authenticateAdmin({ identity: 'admin', password: 'anything' }, {}),
        { ok: false, code: 'config_error' }
    );
});
