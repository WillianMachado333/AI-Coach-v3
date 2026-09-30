/*
 * Session logger — persists every Erica session to /data/sessions/{id}.ndjson
 * so the Coach Studio observatory can replay/inspect what actually happened.
 *
 * File layout on the Railway volume:
 *   /data/sessions/{sessionId}.ndjson   — append-only, one JSON object per line
 *   /data/prompts/{sha256}.json         — deduplicated system prompts referenced
 *                                         from turn entries via prompt_hash
 *
 * Environment knobs:
 *   STORE_MESSAGE_TEXT     'redacted' (default) | 'raw'  — controls user text
 *                          storage; assistant text is always kept because it's
 *                          the coach voice we want to audit.
 *   TESTER_INTERNAL_DOMAINS  comma-separated email domains treated as testers.
 *   TESTER_EMAIL_MARKERS     comma-separated substrings (e.g. +demo,+test)
 *                          treated as testers.
 *   SESSION_DATA_DIR       optional override; default /data/sessions.
 *   SESSION_PROMPTS_DIR    optional override; default /data/prompts.
 *
 * Every function here is best-effort: exceptions are caught and logged but
 * never re-thrown, so a broken volume can never take down the coach.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const usageCost = require('./usageCost');
const pipeline = require('./pipeline');

const SESSIONS_DIR = process.env.SESSION_DATA_DIR || '/data/sessions';
const PROMPTS_DIR = process.env.SESSION_PROMPTS_DIR || '/data/prompts';
const STORE_MODE = (process.env.STORE_MESSAGE_TEXT || 'redacted').toLowerCase();
const TESTER_DOMAINS = (process.env.TESTER_INTERNAL_DOMAINS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const TESTER_MARKERS = (process.env.TESTER_EMAIL_MARKERS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// In-memory cache of session metadata so listSessions can be quick without
// scanning every NDJSON file. Populated on first access.
let sessionsIndex = null;

function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        console.warn('[sessionLog] mkdir failed:', dir, e?.message || e);
    }
}
ensureDir(SESSIONS_DIR);
ensureDir(PROMPTS_DIR);

function sanitizeId(id) {
    return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
}
function sha256(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function isTester({ email, userId, objectId, caller } = {}) {
    // Any admin-driven session is a tester by construction — those never
    // count as real usage in metrics/exports and are what our simulator uses.
    if (caller && String(caller).toLowerCase().includes('simulator')) return true;
    if (email && typeof email === 'string') {
        const low = email.toLowerCase();
        if (TESTER_DOMAINS.some((d) => low.endsWith('@' + d))) return true;
        if (TESTER_MARKERS.some((m) => m && low.includes(m))) return true;
    }
    return false;
}

/**
 * One session per page VISIT (#27). Ids used to be sha256 of the identity,
 * so every visit of a person appended to one file — the Studio's "session"
 * and #17's cost per session were really a person's lifetime. Now each
 * visit gets a random id; a reconnect within the same page resumes it (the
 * client sends its current id to /api/erica-preparation); the person is a
 * separate key used to group visits.
 */
function newSessionId() {
    return 's-v' + crypto.randomBytes(12).toString('base64url');
}

/**
 * Who this is, across visits: userId first (same person on any device, as
 * the coach clipboard keys it), then the browser's CleverTap id, then
 * email. null for an anonymous visit.
 */
function personKeyFor({ userId, objectId, email } = {}) {
    const id = userId || objectId || email;
    return id ? 'p-' + sha256(String(id)).slice(0, 24) : null;
}

/** The first session_start of a file, or null. */
function _readSessionStart(sessionId) {
    try {
        const file = sessionFile(sessionId);
        if (!fs.existsSync(file)) return null;
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            const first = buf.slice(0, n).toString('utf8').split('\n')[0];
            const obj = JSON.parse(first);
            return obj && obj.type === 'session_start' ? obj : null;
        } finally { fs.closeSync(fd); }
    } catch (_) { return null; }
}

function sessionFile(sessionId) {
    return path.join(SESSIONS_DIR, sanitizeId(sessionId) + '.ndjson');
}

function appendLine(file, obj) {
    try {
        fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
    } catch (e) {
        console.warn('[sessionLog] append failed:', file, e?.message || e);
    }
}

/**
 * Persist a prompt snapshot (system instructions Erica received) once,
 * deduplicated by content hash. Returns the hash so callers can reference it
 * from turn entries via prompt_hash.
 */
function savePromptSnapshot(text) {
    if (typeof text !== 'string' || !text.length) return null;
    const h = sha256(text);
    const file = path.join(PROMPTS_DIR, h + '.json');
    if (!fs.existsSync(file)) {
        try {
            fs.writeFileSync(file, JSON.stringify({
                hash: h,
                length: text.length,
                text,
                first_seen: new Date().toISOString()
            }), 'utf8');
        } catch (e) {
            console.warn('[sessionLog] savePromptSnapshot failed:', e?.message || e);
        }
    }
    return h;
}
function readPromptSnapshot(h) {
    try {
        const raw = fs.readFileSync(path.join(PROMPTS_DIR, sanitizeId(h) + '.json'), 'utf8');
        return JSON.parse(raw);
    } catch (_) { return null; }
}

/**
 * Record the session opening. Called from /api/erica-preparation. Returns the
 * session id: the caller's own `resumeSessionId` when it is a per-visit
 * session of the same person (a reconnect within the page — nothing is
 * appended), else a new visit.
 */
function startSession({ email, userId, objectId, caller, url, resumeSessionId = null, identitySource = null, onboarding = null } = {}) {
    const personKey = personKeyFor({ userId, objectId, email });
    if (typeof resumeSessionId === 'string' && /^s-v[A-Za-z0-9_-]{8,40}$/.test(resumeSessionId)) {
        const prior = _readSessionStart(resumeSessionId);
        const priorKey = prior && prior.actor ? (prior.actor.personKey || null) : undefined;
        // Same person only: an anonymous visit that has since picked up an
        // identity (the CleverTap id arrives after the first preparation)
        // also resumes; a different person never does.
        if (prior && (priorKey === personKey || priorKey === null)) {
            if (priorKey === null && personKey) {
                // The visit now knows who it is: say so once, without a
                // second session_start (which would read as another visit).
                appendLine(sessionFile(resumeSessionId), {
                    type: 'session_identity',
                    t: new Date().toISOString(),
                    actor: {
                        personKey, email: email || null, userId: userId || null, objectId: objectId || null,
                        caller: caller || null, url: url || null, tester: isTester({ email, userId, objectId, caller })
                    }
                });
                sessionsIndex = null;
            }
            return resumeSessionId;
        }
    }
    const sessionId = newSessionId();
    const file = sessionFile(sessionId);
    const meta = {
        type: 'session_start',
        t: new Date().toISOString(),
        sessionId,
        idScheme: 'visit',
        actor: {
            personKey,
            // signed | unsigned | guest | none | admin-simulator (#28) — how this visit's identity arrived.
            identitySource: identitySource || null,
            email: email || null,
            userId: userId || null,
            objectId: objectId || null,
            caller: caller || null,
            url: url || null,
            tester: isTester({ email, userId, objectId, caller })
        },
        env: {
            store: STORE_MODE
        }
    };
    // The onboarding variant this visit got and the context it came with
    // (lib/pipeline.js) — so variants can be compared later.
    if (onboarding && typeof onboarding === 'object') meta.onboarding = { variant: onboarding.variant || null, context: onboarding.context || {} };
    appendLine(file, meta);
    // Invalidate index
    sessionsIndex = null;
    return sessionId;
}

function _redactUserText(text, { synthetic = false } = {}) {
    // Synthetic sessions (generated by scripts/gen-synthetic-sessions.js) are
    // marked meta.synthetic=true and store user text RAW even under the
    // redacted default — they are fake conversations and the observatory
    // needs them readable so operators can see what a session actually
    // looks like without waiting for real user traffic.
    if (STORE_MODE === 'raw' || synthetic) return text;
    if (!text) return null;
    const t = String(text);
    return {
        redacted: true,
        length: t.length,
        hash: sha256(t).slice(0, 24)
    };
}

/**
 * Log a user turn. Handles the STORE_MESSAGE_TEXT redaction switch, with
 * an exception for synthetic sessions (meta.synthetic=true) so the
 * observatory always has readable seed content.
 */
function logUserTurn(sessionId, { text, promptHash = null, meta = {} } = {}) {
    if (!sessionId) return;
    const synthetic = !!(meta && meta.synthetic);
    appendLine(sessionFile(sessionId), {
        type: 'turn',
        role: 'user',
        t: new Date().toISOString(),
        text: _redactUserText(text, { synthetic }),
        prompt_hash: promptHash,
        meta
    });
}

/**
 * Log an assistant turn. Assistant text is kept raw because auditing coach
 * behaviour requires knowing what she actually said.
 */
function logBotTurn(sessionId, { text, promptHash = null, meta = {} } = {}) {
    if (!sessionId) return;
    appendLine(sessionFile(sessionId), {
        type: 'turn',
        role: 'bot',
        t: new Date().toISOString(),
        text: (typeof text === 'string') ? text : null,
        prompt_hash: promptHash,
        meta
    });
}

/**
 * Log a tool call. `name`, `args` and `result` are stored as-is (they're
 * function-level, not user speech, so redaction doesn't apply).
 */
function logToolCall(sessionId, { name, args, result, error = null, ms = null } = {}) {
    if (!sessionId) return;
    appendLine(sessionFile(sessionId), {
        type: 'tool_call',
        t: new Date().toISOString(),
        name,
        args: args ?? null,
        result: (typeof result === 'string' && result.length > 4000) ? result.slice(0, 4000) + '…' : (result ?? null),
        error,
        ms
    });
}

// Events the Sessions list summarises per visit: logging one refreshes the index.
const LISTED_EVENTS = new Set(['prep_fallback', 'onboarding_milestone', 'style_overridden', 'style_inferred', 'style_applied', 'visit_context', 'voice_selected', 'voice_step_skipped']);

/** Convenience — log an arbitrary event (connect/disconnect/error). */
function logEvent(sessionId, evt) {
    if (!sessionId) return;
    appendLine(sessionFile(sessionId), Object.assign({
        type: 'event',
        t: new Date().toISOString()
    }, evt || {}));
    if (evt && LISTED_EVENTS.has(evt.name)) sessionsIndex = null;
}

const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

/**
 * Log a usage snapshot the client relayed from OpenAI (kind: 'usage' on
 * /api/session-log). The `usage` object is stored with the API's own field
 * names, untouched; what we add is `priced` — the cost at today's table
 * (lib/usageCost.js) — so history keeps the price it was billed at even if
 * the table changes later. A snapshot whose model has no price is stored
 * and FLAGGED (priced.unpriced), and shouted about in the log: a silent $0
 * is the one outcome this must never produce.
 */
function logUsage(sessionId, snapshot = {}) {
    if (!sessionId) return null;
    const s = snapshot || {};
    const usage = s.usage && typeof s.usage === 'object' ? s.usage : null;
    let usageStored = usage;
    if (usage && JSON.stringify(usage).length > 4000) {
        // Telemetry, not a dump — an unexpectedly huge payload is kept only
        // as a marker so the line stays readable.
        usageStored = { truncated: true, keys: Object.keys(usage).slice(0, 20) };
    }
    const line = {
        type: 'usage',
        t: new Date().toISOString(),
        source: clip(s.source, 64) || 'unknown',
        voiceMode: s.voiceMode === 'live' ? 'live' : (s.voiceMode === 'realtime' ? 'realtime' : null),
        model: clip(s.model, 80),
        modelSource: clip(s.modelSource, 24),
        backendModel: clip(s.backendModel, 80),
        connectionId: s.connectionId ? sanitizeId(s.connectionId) : null,
        responseId: clip(s.responseId, 96),
        itemId: clip(s.itemId, 96),
        delegationId: clip(s.delegationId, 96),
        sessionMinutes: typeof s.sessionMinutes === 'number' && isFinite(s.sessionMinutes) ? s.sessionMinutes : null,
        clientT: clip(s.t, 40),
        reason: clip(s.reason, 40),
        usage: usageStored,
    };
    line.priced = usageCost.priceSnapshot(line);
    if (line.priced.unpriced) {
        console.warn(`[sessionLog] usage NOT priced — ${line.priced.unpriced} (session=${sessionId} source=${line.source} model=${line.model || '?'})`);
    }
    appendLine(sessionFile(sessionId), line);
    // The list view shows $ per session from the index; keep it honest.
    sessionsIndex = null;
    return line.priced;
}

// ---- Read side (for /admin/sessions*) ------------------------------------

function _buildSessionsIndex() {
    const out = [];
    try {
        const files = fs.readdirSync(SESSIONS_DIR);
        for (const f of files) {
            if (!f.endsWith('.ndjson')) continue;
            const sessionId = f.slice(0, -'.ndjson'.length);
            const stat = fs.statSync(path.join(SESSIONS_DIR, f));
            // Read only first + last line to compute cheap metadata.
            let start = null; let firstStart = null; let startCount = 0; let last = null; let turnCount = 0; let identity = null; let prepFallbacks = 0;
            const counter = pipeline.createCounter();
            const usageLines = [];
            try {
                const raw = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8');
                const lines = raw.trim().split('\n');
                for (const ln of lines) {
                    if (!ln) continue;
                    let obj; try { obj = JSON.parse(ln); } catch (_) { continue; }
                    if (obj.type === 'session_start') { start = obj; if (!firstStart) firstStart = obj; startCount++; }
                    if (obj.type === 'session_identity') identity = obj;
                    if (obj.type === 'turn') turnCount++;
                    if (obj.type === 'usage') usageLines.push(obj);
                    if (obj.type === 'event' && obj.name === 'prep_fallback') prepFallbacks++;
                    pipeline.feed(counter, obj);
                    last = obj;
                }
            } catch (_) { /* skip bad file */ }
            if (!start) continue;
            // A per-identity file from before #27 holds every visit of that
            // person (one session_start per visit): flagged as legacy, with
            // its visit count, and grouped under the same person.
            const actor = { ...(start.actor || {}), ...((identity && identity.actor) || {}) };
            if (!actor.personKey) actor.personKey = personKeyFor(actor);
            out.push({
                sessionId,
                startedAt: firstStart ? firstStart.t : start.t,
                lastAt: last?.t || start.t,
                actor,
                personKey: actor.personKey,
                legacy: !(firstStart && firstStart.idScheme === 'visit'),
                visits: startCount,
                turns: turnCount,
                // Connects that ran on the generic preparation (Wix failed).
                prepFallbacks,
                // Onboarding pipeline facts of this visit (lib/pipeline.js).
                pipeline: {
                    variant: (firstStart && firstStart.onboarding && firstStart.onboarding.variant) || null,
                    context: (firstStart && firstStart.onboarding && firstStart.onboarding.context) || {},
                    entryAt: firstStart ? firstStart.t : start.t,
                    userTurns: counter.userTurns,
                    meaningful: counter.meaningful,
                    firstUserAt: counter.firstUserAt,
                    firstMeaningfulAt: counter.firstMeaningfulAt,
                    successAt: counter.successAt,
                    styleInferred: counter.styleInferred,
                    style: counter.styleOverridden || counter.styleApplied || null,
                    styleOverridden: !!counter.styleOverridden,
                    hostPage: counter.hostPage,
                },
                size: stat.size,
                // null = nothing metered (pre-metering session or text-only
                // with no responses); the list shows "—", not $0.00.
                cost: usageLines.length ? usageCost.summarizeSession(usageLines) : null
            });
        }
    } catch (e) {
        console.warn('[sessionLog] index build failed:', e?.message || e);
    }
    out.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
    return out;
}
function getSessionsIndex(force = false) {
    if (force || !sessionsIndex) sessionsIndex = _buildSessionsIndex();
    return sessionsIndex;
}

function listSessions({ tester = 'exclude', limit = 100, since = null } = {}) {
    const idx = getSessionsIndex();
    return idx.filter((s) => {
        if (since && s.lastAt < since) return false;
        if (tester === 'exclude' && s.actor?.tester) return false;
        if (tester === 'only' && !s.actor?.tester) return false;
        return true;
    }).slice(0, limit);
}

function readSession(sessionId) {
    const file = sessionFile(sessionId);
    if (!fs.existsSync(file)) return null;
    const entries = [];
    try {
        const raw = fs.readFileSync(file, 'utf8');
        for (const ln of raw.split('\n')) {
            if (!ln.trim()) continue;
            try { entries.push(JSON.parse(ln)); } catch (_) { /* skip */ }
        }
    } catch (e) {
        console.warn('[sessionLog] readSession failed:', e?.message || e);
        return null;
    }
    return { sessionId, entries };
}

module.exports = {
    startSession,
    logUserTurn,
    logBotTurn,
    logToolCall,
    logEvent,
    logUsage,
    savePromptSnapshot,
    readPromptSnapshot,
    listSessions,
    readSession,
    getSessionsIndex,
    storeMode: () => STORE_MODE,
    personKeyFor,
    // exposed for tests
    _internal: { isTester, sha256 }
};
