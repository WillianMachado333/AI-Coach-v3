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
 * Allocate a new sessionId. Deterministic from the caller-provided seed when
 * given (so the same browser session reuses the id across reconnects); random
 * otherwise.
 */
function newSessionId(seed) {
    if (seed) return sanitizeId('s-' + sha256(seed).slice(0, 24));
    return 's-' + crypto.randomBytes(9).toString('base64url');
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
 * new session id.
 */
function startSession({ email, userId, objectId, caller, url } = {}) {
    const seed = objectId || userId || email || (Date.now() + '-' + Math.random());
    const sessionId = newSessionId(seed);
    const file = sessionFile(sessionId);
    const meta = {
        type: 'session_start',
        t: new Date().toISOString(),
        sessionId,
        actor: {
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

/** Convenience — log an arbitrary event (connect/disconnect/error). */
function logEvent(sessionId, evt) {
    if (!sessionId) return;
    appendLine(sessionFile(sessionId), Object.assign({
        type: 'event',
        t: new Date().toISOString()
    }, evt || {}));
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
            let start = null; let last = null; let turnCount = 0;
            try {
                const raw = fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8');
                const lines = raw.trim().split('\n');
                for (const ln of lines) {
                    if (!ln) continue;
                    let obj; try { obj = JSON.parse(ln); } catch (_) { continue; }
                    if (obj.type === 'session_start') start = obj;
                    if (obj.type === 'turn') turnCount++;
                    last = obj;
                }
            } catch (_) { /* skip bad file */ }
            if (!start) continue;
            out.push({
                sessionId,
                startedAt: start.t,
                lastAt: last?.t || start.t,
                actor: start.actor || {},
                turns: turnCount,
                size: stat.size
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
    savePromptSnapshot,
    readPromptSnapshot,
    listSessions,
    readSession,
    getSessionsIndex,
    // exposed for tests
    _internal: { isTester, sha256 }
};
