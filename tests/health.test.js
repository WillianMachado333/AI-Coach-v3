const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthPayload } = require('../lib/health');

test('health payload is stable, safe, and suitable for Railway probes', () => {
    const payload = createHealthPayload({
        now: new Date('2026-09-17T12:00:00.000Z'),
        uptimeSeconds: 12.9
    });

    assert.deepEqual(payload, {
        status: 'ok',
        service: 'ai-coach-v3',
        timestamp: '2026-09-17T12:00:00.000Z',
        uptimeSeconds: 12
    });
    assert.equal(JSON.stringify(payload).includes('key'), false);
    assert.equal(JSON.stringify(payload).includes('token'), false);
});
