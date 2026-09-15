const test = require('node:test');
const assert = require('node:assert/strict');
const wixOauth = require('../lib/wixOauth');

test('auth callback is isolated to the configured AI Coach environment origin', () => {
    const previous = {
        admin: process.env.AI_COACH_ADMIN_ORIGIN,
        public: process.env.PUBLIC_ORIGIN,
        railway: process.env.RAILWAY_PUBLIC_DOMAIN
    };
    try {
        process.env.AI_COACH_ADMIN_ORIGIN = 'https://ai-coach-staging.example.test/admin/';
        delete process.env.PUBLIC_ORIGIN;
        delete process.env.RAILWAY_PUBLIC_DOMAIN;
        assert.equal(wixOauth.callbackUri(), 'https://ai-coach-staging.example.test/auth/callback');

        process.env.AI_COACH_ADMIN_ORIGIN = 'https://ai-coach-production.example.test';
        assert.equal(wixOauth.callbackUri(), 'https://ai-coach-production.example.test/auth/callback');
    } finally {
        if (previous.admin === undefined) delete process.env.AI_COACH_ADMIN_ORIGIN;
        else process.env.AI_COACH_ADMIN_ORIGIN = previous.admin;
        if (previous.public === undefined) delete process.env.PUBLIC_ORIGIN;
        else process.env.PUBLIC_ORIGIN = previous.public;
        if (previous.railway === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN;
        else process.env.RAILWAY_PUBLIC_DOMAIN = previous.railway;
    }
});
