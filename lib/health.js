'use strict';

function createHealthPayload({ now = new Date(), uptimeSeconds = process.uptime() } = {}) {
    return {
        status: 'ok',
        service: 'ai-coach-v3',
        timestamp: now.toISOString(),
        uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds))
    };
}

module.exports = { createHealthPayload };
