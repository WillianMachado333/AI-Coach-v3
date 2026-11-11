// REG-16 watch: the first answer of each GPT-Live connection, measured by
// the backend's input tokens (the usage snapshot the client relays for every
// response.completed). A configured session's first answer reads ~8,800 to
// 9,700 tokens (the composed prompt, tools, history); one sent before the
// session.update read 985 to 1,520. Under THRESHOLD it is counted as thin and
// logged, so the share of affected turns in production can be read from
// /api/health and the logs, without any user text.
'use strict';

const THRESHOLD = Number(process.env.ERICA_THIN_FIRST_ANSWER_TOKENS) > 0 ? Number(process.env.ERICA_THIN_FIRST_ANSWER_TOKENS) : 3000;
const MAX_TRACKED = 20000;

const seen = new Map(); // `${sessionId}|${connectionId}` -> true (oldest first, capped)
let checked = 0;
let thin = 0;
let lastThinAt = null;

/**
 * One usage snapshot from /api/session-log. Returns null unless it is the
 * first response.completed of its connection; then { thin, inputTokens }.
 */
function onUsage(sessionId, snapshot) {
    if (!snapshot || snapshot.source !== 'response.completed') return null;
    const key = `${sessionId || ''}|${snapshot.connectionId || ''}`;
    if (seen.has(key)) return null;
    seen.set(key, true);
    while (seen.size > MAX_TRACKED) seen.delete(seen.keys().next().value);
    const inputTokens = Number(snapshot.usage && snapshot.usage.input_tokens);
    if (!Number.isFinite(inputTokens)) return null;
    checked++;
    const isThin = inputTokens < THRESHOLD;
    if (isThin) { thin++; lastThinAt = new Date().toISOString(); }
    return { thin: isThin, inputTokens };
}

/** Since the process started: first answers checked, how many were thin. */
function snapshot() {
    return { checked, thin, thresholdTokens: THRESHOLD, lastThinAt };
}

module.exports = { onUsage, snapshot, THRESHOLD, _reset: () => { seen.clear(); checked = 0; thin = 0; lastThinAt = null; } };
