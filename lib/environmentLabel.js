function aiCoachEnvironmentLabel(value) {
    const configured = String(value || '').trim().toLowerCase();
    if (configured === 'staging') return 'Staging';
    if (configured === 'production' || configured === 'prototype' || !configured) return 'Prototype';
    return configured[0].toUpperCase() + configured.slice(1);
}

module.exports = { aiCoachEnvironmentLabel };
