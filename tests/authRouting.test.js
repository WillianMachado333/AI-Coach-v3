const test = require('node:test');
const assert = require('node:assert/strict');
const { authenticatePassword } = require('../lib/adminAuth');
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

test('custom Admin auth accepts a valid local identity and password', () => {
    const result = authenticatePassword(
        { identity: 'Coach-Admin', password: 'correct-horse' },
        { ADMIN_PASSWORD: 'correct-horse' }
    );
    assert.deepEqual(result, { ok: true, identity: 'coach-admin' });
});

test('password validation does not use an environment allow-list as a role source', () => {
    assert.equal(authenticatePassword(
        { identity: 'other@example.test', password: 'configured' },
        { ADMIN_PASSWORD: 'configured', ADMIN_ALLOWED_USERS: 'owner@example.test' }
    ).ok, true);
});

test('custom Admin auth rejects an invalid password', () => {
    const env = { ADMIN_PASSWORD: 'correct-horse', ADMIN_ALLOWED_USERS: 'owner@example.test' };
    assert.deepEqual(
        authenticatePassword({ identity: 'owner@example.test', password: 'wrong' }, env),
        { ok: false, code: 'invalid_credentials' }
    );
});

test('custom Admin auth reports missing password configuration', () => {
    assert.deepEqual(
        authenticatePassword({ identity: 'admin', password: 'anything' }, {}),
        { ok: false, code: 'config_error' }
    );
});
