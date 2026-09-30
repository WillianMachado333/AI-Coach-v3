/**
 * Onboarding pipeline, phase 1: a baseline on today's flow (Eric's
 * requirements, docs/2026-09-29-eric-flexible-onboarding-requirements.md).
 *
 * Every visit is tagged with the onboarding variant it got (today's flow =
 * `inchat@1`: no step before the conversation) and the context the embed
 * sent, so later variants compare against it. The success measure is
 * meaningful interactions:
 *
 *   one user turn followed by a substantive coach turn (≥ MEANINGFUL_BOT_MIN_CHARS
 *   of text). An opening line (no user turn before it), a tool-only turn (no
 *   text) and a second coach turn after the same user turn don't count;
 *   several user turns before one reply count once.
 *
 * Built from the #30 turn records, so it works on every visit already logged.
 * Stages for inchat@1: entry → coaching started (first user turn) →
 * 1+ meaningful → 10+ meaningful (success).
 */

const VARIANT = 'inchat@1';
const MEANINGFUL_BOT_MIN_CHARS = 30;
const SUCCESS_THRESHOLD = 10;

const STAGE_LABELS = {
    entry: 'Entry (visit opened)',
    coaching_started: 'Coaching started (first user message)',
    meaningful: '1+ meaningful interaction',
    meaningful_10: `${SUCCESS_THRESHOLD}+ meaningful interactions (success)`,
};
const VARIANTS = {
    'inchat@1': { label: 'In-chat onboarding — no step before the conversation', stages: ['entry', 'coaching_started', 'meaningful', 'meaningful_10'] },
};
// Visits logged before variants existed follow today's flow too.
const DEFAULT_STAGES = VARIANTS[VARIANT].stages;

// Context recorded per visit. Only these keys, short plain values. The
// embed's own URL parameters are read too, so if Wix starts sending
// source/entry/audience/campaign they are recorded with no code change.
const CONTEXT_KEYS = ['caller', 'hostPage', 'coach', 'source', 'entry', 'audience', 'campaign', 'utm_source', 'utm_medium', 'utm_campaign'];
const cleanValue = (v) => (typeof v === 'string' ? v.replace(/[^\w .:/@+-]/g, '').trim().slice(0, 120) || null : null);

/** A page address without its query or fragment (never ids or tokens). */
function pageOnly(u) {
    try { const x = new URL(String(u)); return (x.origin + x.pathname).slice(0, 160); } catch (_) { return null; }
}

/**
 * The context of a visit: what the client sent (`raw`), the caller, and the
 * iframe's own URL parameters (the referer of the preparation request).
 */
function sanitizeContext(raw, { caller = null, referer = null } = {}) {
    const out = {};
    const src = raw && typeof raw === 'object' ? raw : {};
    let params = null;
    try { params = referer ? new URL(String(referer)).searchParams : null; } catch (_) { params = null; }
    for (const k of CONTEXT_KEYS) {
        let v = null;
        if (k === 'caller') v = cleanValue(caller);
        else if (k === 'hostPage') v = pageOnly(src.hostPage);
        else v = cleanValue(src[k]) || (params ? cleanValue(params.get(k) || (k === 'coach' ? params.get('aic') : null)) : null);
        if (v) out[k] = v;
    }
    return out;
}

// --- Counting ---------------------------------------------------------------

function createCounter() {
    return { userTurns: 0, meaningful: 0, pending: false, firstUserAt: null, firstMeaningfulAt: null, successAt: null,
        // Coaching style: what the in-chat Navigator read, what was applied, what the person chose.
        styleInferred: null, styleApplied: null, styleOverridden: null, hostPage: null };
}

/**
 * Feed one session-log line. Returns the stages this line reached
 * ('coaching_started' | 'meaningful' | 'meaningful_10'), usually none.
 */
function feed(c, line) {
    const reached = [];
    if (line && line.type === 'event') {
        const m = line.meta || {};
        if (line.name === 'style_inferred' && m.style) c.styleInferred = m.style;
        if (line.name === 'style_applied' && m.to) c.styleApplied = m.to;
        if (line.name === 'style_overridden' && m.to) c.styleOverridden = m.to;
        if (line.name === 'visit_context' && m.hostPage) c.hostPage = m.hostPage;
        return reached;
    }
    if (!line || line.type !== 'turn') return reached;
    if (line.role === 'user') {
        c.userTurns++;
        c.pending = true;
        if (c.userTurns === 1) { c.firstUserAt = line.t || null; reached.push('coaching_started'); }
    } else if (line.role === 'bot') {
        const text = typeof line.text === 'string' ? line.text.trim() : '';
        if (c.pending && text.length >= MEANINGFUL_BOT_MIN_CHARS) {
            c.pending = false;
            c.meaningful++;
            if (c.meaningful === 1) { c.firstMeaningfulAt = line.t || null; reached.push('meaningful'); }
            if (c.meaningful === SUCCESS_THRESHOLD) { c.successAt = line.t || null; reached.push('meaningful_10'); }
        }
    }
    return reached;
}

/** A visit's pipeline facts from its session-log lines. */
function summarize(lines) {
    const c = createCounter();
    let start = null;
    for (const l of lines || []) {
        if (l && l.type === 'session_start' && !start) start = l;
        feed(c, l);
    }
    const ob = (start && start.onboarding) || {};
    return {
        variant: typeof ob.variant === 'string' ? ob.variant : null,
        context: ob.context && typeof ob.context === 'object' ? ob.context : {},
        entryAt: start ? start.t : null,
        userTurns: c.userTurns,
        meaningful: c.meaningful,
        firstUserAt: c.firstUserAt,
        firstMeaningfulAt: c.firstMeaningfulAt,
        successAt: c.successAt,
        styleInferred: c.styleInferred,
        style: c.styleOverridden || c.styleApplied || null,
        styleOverridden: !!c.styleOverridden,
        hostPage: c.hostPage,
    };
}

// --- Live milestones ----------------------------------------------------------
// The session-log route asks, for each new turn, which stage it reaches, so the
// visit's timeline records the milestone when it happens. The counter per
// visit is rebuilt from the file once after a restart (the pipeline itself is
// always computed from turns, so a repeated milestone line changes nothing).
const LIVE_MAX = 5000;
const live = new Map();

function trackTurn(sessionId, line, readLines) {
    if (!sessionId || !line) return { reached: [], counter: null, entryAt: null };
    let st = live.get(sessionId);
    if (!st) {
        const prior = (typeof readLines === 'function' ? readLines(sessionId) : null) || [];
        const c = createCounter();
        let entryAt = null; let variant = null;
        for (const l of prior) {
            if (l && l.type === 'session_start' && !entryAt) { entryAt = l.t || null; variant = (l.onboarding && l.onboarding.variant) || null; }
            feed(c, l);
        }
        st = { c, entryAt, variant };
        live.set(sessionId, st);
        if (live.size > LIVE_MAX) live.delete(live.keys().next().value);
    } else {
        live.delete(sessionId); live.set(sessionId, st); // most recent last
    }
    const reached = feed(st.c, { ...line, t: line.t || new Date().toISOString() });
    return { reached, counter: { ...st.c }, entryAt: st.entryAt, variant: st.variant };
}

// --- The funnel -------------------------------------------------------------

const isSignedIn = (row) => !!(row.actor && (row.actor.userId || row.actor.email));

/**
 * Units reaching each stage. `unit`:
 *   'journey' (default): a signed-in person across their visits (entry = first
 *     visit, meaningful interactions add up); an anonymous visit stands alone —
 *     never a persistent profile (Eric, US 9).
 *   'visit': every visit on its own.
 * Filters: variant ('inchat@1' | 'untagged' | 'all'), identity ('all' |
 * 'signed' | 'guest'), caller, since (ISO), testers ('exclude' | 'include').
 */
function compute(rows, { unit = 'journey', variant = VARIANT, identity = 'all', caller = null, since = null, testers = 'exclude' } = {}) {
    const visits = (rows || []).filter((r) => {
        if (r.legacy) return false; // pre-#27 files hold many visits in one
        if (testers === 'exclude' && r.actor && r.actor.tester) return false;
        const p = r.pipeline || {};
        if (variant === 'untagged' ? p.variant : variant !== 'all' && p.variant !== variant) return false;
        if (identity === 'signed' && !isSignedIn(r)) return false;
        if (identity === 'guest' && isSignedIn(r)) return false;
        if (caller && (r.actor && r.actor.caller) !== caller) return false;
        return true;
    });
    const units = new Map();
    for (const r of visits) {
        const p = r.pipeline || {};
        const key = unit === 'journey' && isSignedIn(r) && r.personKey ? 'p:' + r.personKey : 'v:' + r.sessionId;
        const u = units.get(key) || { key, signedIn: isSignedIn(r), personKey: r.personKey || null, visits: [], entryAt: null, meaningful: 0, userTurns: 0, variant: null, context: {}, style: null, styleInferred: null, styleOverridden: false };
        u.visits.push(r.sessionId);
        const at = p.entryAt || r.startedAt;
        if (!u.entryAt || (at && at < u.entryAt)) { u.entryAt = at; u.variant = p.variant || null; u.context = p.context || {}; }
        u.meaningful += p.meaningful || 0;
        u.userTurns += p.userTurns || 0;
        if (p.style) u.style = p.style;
        if (p.styleInferred) u.styleInferred = p.styleInferred;
        if (p.styleOverridden) u.styleOverridden = true;
        if (p.hostPage && u.context && !String(u.context.hostPage || '').replace(/^https?:\/\/[^/]+\/?/, '')) u.context = { ...u.context, hostPage: p.hostPage };
        units.set(key, u);
    }
    let list = [...units.values()];
    if (since) list = list.filter((u) => u.entryAt && u.entryAt >= since);
    for (const u of list) {
        u.stage = u.meaningful >= SUCCESS_THRESHOLD ? 'meaningful_10' : u.meaningful >= 1 ? 'meaningful' : u.userTurns >= 1 ? 'coaching_started' : 'entry';
    }
    const stages = (VARIANTS[variant] && VARIANTS[variant].stages) || DEFAULT_STAGES;
    const rank = (s) => stages.indexOf(s);
    const counts = stages.map((s) => list.filter((u) => rank(u.stage) >= rank(s)).length);
    const entry = counts[0] || 0;
    const table = stages.map((s, i) => ({
        stage: s,
        label: STAGE_LABELS[s] || s,
        reached: counts[i],
        pctOfEntry: entry ? counts[i] / entry : null,
        convFromPrev: i === 0 ? null : (counts[i - 1] ? counts[i] / counts[i - 1] : null),
        // Stopped here: reached this stage and not the next one.
        dropHere: i < stages.length - 1 ? counts[i] - counts[i + 1] : null,
    }));
    list.sort((a, b) => String(b.entryAt || '').localeCompare(String(a.entryAt || '')));
    return { unit, variant, identity, caller, since, testers, units: list.length, visits: visits.length, table, list };
}

module.exports = {
    VARIANT, VARIANTS, STAGE_LABELS, CONTEXT_KEYS, MEANINGFUL_BOT_MIN_CHARS, SUCCESS_THRESHOLD,
    sanitizeContext, pageOnly, createCounter, feed, summarize, trackTurn, compute, _live: live,
};
