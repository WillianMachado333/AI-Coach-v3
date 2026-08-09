/*
 * Coach Studio metrics — aggregates over recorded sessions on the volume.
 *
 * Reads all NDJSON session files from /data/sessions/ and computes:
 *
 *   volume:            counts of sessions / turns / tool_calls per bucket (24h/7d/30d)
 *   toolUsage:         { name -> count } over the window
 *   toolErrors:        { name -> errorCount } over the window
 *   timeToFirstBotMs:  distribution of ms from session_start to first bot turn
 *   turnGapsMs:        distribution of ms between consecutive turns
 *   sessionLengths:    distribution of ms between first and last entry per session
 *   qualitySignals:
 *     - rageClose  : sessions with < 3 turns AND < 30s span AND ended with a user turn
 *     - longSilence: sessions where any inter-turn gap > 90s (and no explicit close)
 *     - toolFailures: sessions with >= 1 tool_call carrying { error }
 *
 * Small compute. No cache — we walk files on each admin request. If the log
 * grows huge later we can add a rolling index.
 */

const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.SESSION_DATA_DIR || '/data/sessions';

function readEntries(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const out = [];
        for (const ln of raw.split('\n')) {
            if (!ln.trim()) continue;
            try { out.push(JSON.parse(ln)); } catch (_) { /* skip */ }
        }
        return out;
    } catch (_) { return []; }
}

function iterateSessions() {
    try {
        return fs.readdirSync(SESSIONS_DIR)
            .filter((f) => f.endsWith('.ndjson'))
            .map((f) => ({ file: path.join(SESSIONS_DIR, f), sessionId: f.slice(0, -'.ndjson'.length) }));
    } catch (_) { return []; }
}

function percentiles(arr, ps = [50, 90, 99]) {
    if (!arr.length) return ps.reduce((o, p) => { o['p' + p] = null; return o; }, {});
    const sorted = [...arr].sort((a, b) => a - b);
    return ps.reduce((o, p) => {
        const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
        o['p' + p] = sorted[idx];
        return o;
    }, {});
}

/**
 * Compute the full metrics bundle. Optionally filter by `since` (ISO string
 * or Date) — sessions whose LAST activity is older are skipped.
 * `includeTesters` = false by default; matches admin observatory convention.
 */
function compute({ since = null, includeTesters = false } = {}) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoff = since ? new Date(since).getTime() : 0;

    const bucket24 = { sessions: 0, turns: 0, tools: 0 };
    const bucket7 = { sessions: 0, turns: 0, tools: 0 };
    const bucket30 = { sessions: 0, turns: 0, tools: 0 };
    // Per-day series for the last 30 days, keyed by YYYY-MM-DD.
    const daily = new Map();
    for (let d = 29; d >= 0; d--) {
        const key = new Date(now - d * dayMs).toISOString().slice(0, 10);
        daily.set(key, { sessions: 0, turns: 0, tools: 0, toolErrors: 0 });
    }
    const toolUsage = {};
    const toolErrors = {};
    const ttfbSamples = []; // ms from session start to first bot turn
    const gapSamples = [];  // ms between consecutive turns
    const lenSamples = [];  // ms session duration (last - start)

    let ragedClose = 0;
    let longSilenceCount = 0;
    let toolFailureCount = 0;
    let sessionsSeen = 0;

    for (const { file } of iterateSessions()) {
        const entries = readEntries(file);
        if (entries.length === 0) continue;
        const start = entries.find((e) => e.type === 'session_start');
        if (!start) continue;
        if (!includeTesters && start.actor?.tester) continue;
        const lastEntry = entries[entries.length - 1];
        const lastT = new Date(lastEntry.t || start.t).getTime();
        if (cutoff && lastT < cutoff) continue;

        sessionsSeen++;
        const startT = new Date(start.t).getTime();
        const ageMs = now - lastT;
        const inBucket24 = ageMs <= dayMs;
        const inBucket7 = ageMs <= 7 * dayMs;
        const inBucket30 = ageMs <= 30 * dayMs;
        if (inBucket24) bucket24.sessions++;
        if (inBucket7) bucket7.sessions++;
        if (inBucket30) bucket30.sessions++;
        // Daily series (by session start date).
        const dayKey = new Date(startT).toISOString().slice(0, 10);
        const dayBucket = daily.get(dayKey);
        if (dayBucket) dayBucket.sessions++;

        // Turns and tools per session.
        const turns = entries.filter((e) => e.type === 'turn');
        const tools = entries.filter((e) => e.type === 'tool_call');
        if (inBucket24) { bucket24.turns += turns.length; bucket24.tools += tools.length; }
        if (inBucket7) { bucket7.turns += turns.length; bucket7.tools += tools.length; }
        if (inBucket30) { bucket30.turns += turns.length; bucket30.tools += tools.length; }
        if (dayBucket) { dayBucket.turns += turns.length; dayBucket.tools += tools.length; dayBucket.toolErrors += tools.filter((t) => t.error).length; }

        for (const tc of tools) {
            const n = tc.name || '(unknown)';
            toolUsage[n] = (toolUsage[n] || 0) + 1;
            if (tc.error) toolErrors[n] = (toolErrors[n] || 0) + 1;
        }
        if (tools.some((tc) => tc.error)) toolFailureCount++;

        // Time to first bot turn.
        const firstBot = turns.find((t) => t.role === 'bot');
        if (firstBot) {
            const dt = new Date(firstBot.t).getTime() - startT;
            if (dt >= 0 && dt < 5 * 60 * 1000) ttfbSamples.push(dt);
        }
        // Turn gaps.
        for (let i = 1; i < turns.length; i++) {
            const dt = new Date(turns[i].t).getTime() - new Date(turns[i - 1].t).getTime();
            if (dt >= 0 && dt < 30 * 60 * 1000) gapSamples.push(dt);
            if (dt > 90 * 1000) longSilenceCount++;
        }
        // Session length.
        const lenMs = lastT - startT;
        if (lenMs >= 0) lenSamples.push(lenMs);

        // Rage close.
        if (turns.length < 3 && lenMs < 30 * 1000 && turns.length > 0 && turns[turns.length - 1].role === 'user') {
            ragedClose++;
        }
    }

    return {
        computedAt: new Date().toISOString(),
        includeTesters,
        since,
        sessionsSeen,
        volume: { last24h: bucket24, last7d: bucket7, last30d: bucket30 },
        daily: Array.from(daily.entries()).map(([date, v]) => ({ date, ...v })),
        toolUsage: Object.entries(toolUsage).sort((a, b) => b[1] - a[1]),
        toolErrors: Object.entries(toolErrors).sort((a, b) => b[1] - a[1]),
        timeToFirstBotMs: percentiles(ttfbSamples),
        turnGapsMs: percentiles(gapSamples),
        sessionLengthsMs: percentiles(lenSamples),
        qualitySignals: {
            rageClose: ragedClose,
            longSilenceCount,
            toolFailureCount
        }
    };
}

module.exports = { compute };
