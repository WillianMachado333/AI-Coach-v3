'use strict';

// `failures` (lib/failureStats.js snapshot): when given, the payload carries
// it, and status is "degraded" while a failure is recent. HTTP stays 200, so
// a platform health check does not restart a process that is serving.
function createHealthPayload({ now = new Date(), uptimeSeconds = process.uptime(), failures = null } = {}) {
    const payload = {
        status: failures && failures.degraded ? 'degraded' : 'ok',
        service: 'ai-coach-v3',
        timestamp: now.toISOString(),
        uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds))
    };
    if (failures) payload.failures = failures;
    return payload;
}

module.exports = { createHealthPayload };
