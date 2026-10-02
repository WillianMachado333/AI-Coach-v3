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
const usageCost = require('./usageCost');

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
// #40: the Studio home turns red past this much OpenAI spend in a UTC day,
// and names any connection open longer than LONG_CONNECTION_MIN.
const LONG_CONNECTION_MIN = 20;
function dailySpendAlertUsd() {
    const n = Number(process.env.ERICA_DAILY_SPEND_ALERT_USD);
    return Number.isFinite(n) && n > 0 ? n : 10;
}

function compute({ since = null, includeTesters = false } = {}) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoff = since ? new Date(since).getTime() : 0;

    // usd/minutes come from usage snapshots (lib/usageCost.js); metered counts
    // how many sessions actually reported usage, so "$0" can be told apart
    // from "nothing was metered".
    const bucket24 = { sessions: 0, turns: 0, tools: 0, usd: 0, minutes: 0, metered: 0 };
    const bucket7 = { sessions: 0, turns: 0, tools: 0, usd: 0, minutes: 0, metered: 0 };
    const bucket30 = { sessions: 0, turns: 0, tools: 0, usd: 0, minutes: 0, metered: 0 };
    // Per-day series for the last 30 days, keyed by YYYY-MM-DD.
    const daily = new Map();
    for (let d = 29; d >= 0; d--) {
        const key = new Date(now - d * dayMs).toISOString().slice(0, 10);
        daily.set(key, { sessions: 0, turns: 0, tools: 0, toolErrors: 0, usd: 0, minutes: 0 });
    }
    const costRows = [];          // one per metered session in the 30-day window
    const costParts = { realtime: 0, transcription: 0, voice: 0, backend: 0, clipboard: 0, navigator: 0 };
    let unpricedSessions = 0;
    const toolUsage = {};
    const toolErrors = {};
    const ttfbSamples = []; // ms from session start to first bot turn
    const gapSamples = [];  // ms between consecutive turns
    const lenSamples = [];  // ms session duration (last - start)

    let ragedClose = 0;
    let longSilenceCount = 0;
    // Calls where 20 s passed with no word from Erica or the user (#32):
    // the client logs a silent_call event; counted per event.
    let silentCallCount = 0;
    // Visits where Wix failed and the prep was the generic fallback (#36).
    let prepFallbackVisits = 0;
    let toolFailureCount = 0;
    let sessionsSeen = 0;
    let sessionsWithReasoning = 0;
    // #40: what was spent today (UTC, OpenAI's day), testers INCLUDED — a
    // test tab left running is real money — and any connection open longer
    // than LONG_CONNECTION_MIN today.
    const todayIso = new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const spendToday = { since: todayIso, usd: 0, testerUsd: 0, liveSeconds: 0, sessions: 0, longConnections: [] };
    const reasoningSummaryLens = [];

    for (const { file } of iterateSessions()) {
        const entries = readEntries(file);
        if (entries.length === 0) continue;
        const start = entries.find((e) => e.type === 'session_start');
        if (!start) continue;
        if ((entries[entries.length - 1].t || '') >= todayIso) {
            const spent = usageCost.spendSince(entries, todayIso);
            if (spent.lines) {
                const sessionId = file.slice(file.lastIndexOf(path.sep) + 1, -'.ndjson'.length);
                spendToday.usd += spent.usd;
                spendToday.liveSeconds += spent.liveSeconds;
                spendToday.sessions++;
                if (start.actor?.tester) spendToday.testerUsd += spent.usd;
                for (const c of usageCost.longConnectionsSince(entries, todayIso, LONG_CONNECTION_MIN)) {
                    spendToday.longConnections.push({ sessionId, actor: start.actor || {}, ...c });
                }
            }
        }
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

        // Cost, from the usage lines the client relayed from OpenAI.
        const usageLines = entries.filter((e) => e.type === 'usage');
        if (usageLines.length) {
            const c = usageCost.summarizeSession(usageLines);
            for (const [b, inB] of [[bucket24, inBucket24], [bucket7, inBucket7], [bucket30, inBucket30]]) {
                if (!inB) continue;
                b.usd += c.usd; b.minutes += c.minutes; b.metered++;
            }
            if (dayBucket) { dayBucket.usd += c.usd; dayBucket.minutes += c.minutes; }
            if (inBucket30) {
                for (const k of Object.keys(costParts)) costParts[k] += c.parts[k] || 0;
                if (c.unpriced.length) unpricedSessions++;
                costRows.push({ sessionId: file.slice(file.lastIndexOf(path.sep) + 1, -'.ndjson'.length), startedAt: start.t, lastAt: lastEntry.t || start.t, actor: start.actor || {}, cost: c });
            }
        }

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
        silentCallCount += entries.filter((e) => e.type === 'event' && e.name === 'silent_call').length;
        if (entries.some((e) => e.type === 'event' && e.name === 'prep_fallback')) prepFallbackVisits++;
        // Session length.
        const lenMs = lastT - startT;
        if (lenMs >= 0) lenSamples.push(lenMs);

        // Rage close.
        if (turns.length < 3 && lenMs < 30 * 1000 && turns.length > 0 && turns[turns.length - 1].role === 'user') {
            ragedClose++;
        }

        // Reasoning capture rate — count sessions that have at least one
        // reasoning_summary event and accumulate summary lengths.
        const reasoningEvents = entries.filter((e) => e.type === 'event' && e.name === 'reasoning_summary');
        if (reasoningEvents.length > 0) {
            sessionsWithReasoning++;
            for (const r of reasoningEvents) {
                const chars = r.meta && (r.meta.chars || (r.meta.summary || '').length);
                if (chars) reasoningSummaryLens.push(chars);
            }
        }
    }

    return {
        computedAt: new Date().toISOString(),
        includeTesters,
        since,
        sessionsSeen,
        volume: { last24h: bucket24, last7d: bucket7, last30d: bucket30 },
        daily: Array.from(daily.entries()).map(([date, v]) => ({ date, ...v })),
        spendToday: {
            ...spendToday,
            usd: Math.round(spendToday.usd * 1e6) / 1e6,
            testerUsd: Math.round(spendToday.testerUsd * 1e6) / 1e6,
            alertUsd: dailySpendAlertUsd(),
            over: spendToday.usd > dailySpendAlertUsd(),
            longConnections: spendToday.longConnections.sort((a, b) => b.minutes - a.minutes),
        },
        toolUsage: Object.entries(toolUsage).sort((a, b) => b[1] - a[1]),
        toolErrors: Object.entries(toolErrors).sort((a, b) => b[1] - a[1]),
        timeToFirstBotMs: percentiles(ttfbSamples),
        turnGapsMs: percentiles(gapSamples),
        sessionLengthsMs: percentiles(lenSamples),
        qualitySignals: {
            rageClose: ragedClose,
            longSilenceCount,
            silentCallCount,
            prepFallbackVisits,
            toolFailureCount
        },
        cost: {
            // 30-day window, sorted costliest first.
            top: costRows.sort((a, b) => b.cost.usd - a.cost.usd).slice(0, 10),
            metered: costRows.length,
            unpricedSessions,
            parts: costParts,
            priceTable: { date: usageCost.PRICE_TABLE_DATE, source: usageCost.PRICE_SOURCE }
        },
        reasoning: {
            sessionsWithReasoning,
            sessionsSeen,
            pctSessionsWithReasoning: sessionsSeen ? Math.round((sessionsWithReasoning / sessionsSeen) * 100) : 0,
            avgSummaryLength: reasoningSummaryLens.length
                ? Math.round(reasoningSummaryLens.reduce((a, b) => a + b, 0) / reasoningSummaryLens.length)
                : 0,
            summarySamples: reasoningSummaryLens.length
        }
    };
}

module.exports = { compute };
