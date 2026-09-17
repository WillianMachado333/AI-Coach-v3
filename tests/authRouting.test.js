const test = require('node:test');
const assert = require('node:assert/strict');
const { callbackUri, newPkce } = require('../lib/wixAuth');
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

test('Wix callback uses the public AI Coach origin', () => {
    assert.equal(
        callbackUri({ AI_COACH_ORIGIN: 'https://coach.example.test/' }),
        'https://coach.example.test/admin/auth/callback'
    );
    assert.equal(
        callbackUri({ RAILWAY_PUBLIC_DOMAIN: 'web-staging.example.test' }),
        'https://web-staging.example.test/admin/auth/callback'
    );
});

test('Wix PKCE creates distinct verifier, state, and SHA-256 challenge values', () => {
    const first = newPkce();
    const second = newPkce();
    assert.match(first.verifier, /^[A-Za-z0-9_-]+$/);
    assert.match(first.state, /^[A-Za-z0-9_-]+$/);
    assert.match(first.challenge, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(first.verifier, second.verifier);
    assert.notEqual(first.state, second.state);
});
