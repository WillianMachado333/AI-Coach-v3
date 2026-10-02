// GPT-Live cost guardrails (#40).
//
// GPT-Live bills a connection by the second while inbound audio flows,
// whether anyone speaks or not: on 2026-09-29 test tabs with fake mics left
// running cost ~1,760 billed minutes (~$88). Every Live connection ends at
// ERICA_LIVE_MAX_SESSION_MIN (default 30) and after ERICA_LIVE_IDLE_CUT_MIN
// (default 10) with no user or bot turn.
//
// The client cuts first (app.js _liveGuardCheck): it closes the session,
// stops the mic and shows "Call ended — tap to resume". This module is the
// backstop for a client that did not (an old cached app.js, a script):
//   - a minute after a limit, while usage is still flowing, it hangs the
//     session up at OpenAI (POST /v1/live/sessions/{id}/hangup);
//   - it answers a usage snapshot past a limit with { cut: true }, which
//     the client treats as a cut (the tripwire, in case the hang-up is
//     refused);
//   - it refuses the client's AUTOMATIC reconnect right after a cut, so a
//     dropped session does not silently come back. A reconnect the person
//     asked for (a tap, a typed message) always goes through.
// Every cut is logged loudly and as a `live_session_cut` event on the visit.
//
// A connection is "flowing" when its billed seconds went up in the last
// FLOWING_MS (the client relays Live's cumulative seconds every ≥10 s while
// they change; with no inbound audio they stop changing). The registry is in
// memory: after a restart the usage snapshots' own `sessionMinutes` still
// trip the max.
'use strict';

// How long after a limit the server steps in (the client cuts AT the limit).
// ERICA_LIVE_GUARD_GRACE_S only exists so verification runs take seconds.
const graceS = () => positive(process.env.ERICA_LIVE_GUARD_GRACE_S, 60);
const FLOWING_MS = 2 * 60 * 1000;
const RECENT_CUT_MS = 10 * 60 * 1000;
const FORGET_MS = 3 * 60 * 60 * 1000; // Live sessions expire at 2 h

function positive(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function config() {
    return {
        maxMin: positive(process.env.ERICA_LIVE_MAX_SESSION_MIN, 30),
        idleMin: positive(process.env.ERICA_LIVE_IDLE_CUT_MIN, 10),
        graceS: graceS(),
    };
}

// A request may only shorten its own limits (verification runs), never lengthen them.
function lowered(header, limit) {
    const n = Number(header);
    return Number.isFinite(n) && n > 0 && n < limit ? n : limit;
}

const _sessions = new Map();   // liveId -> entry
const _recentCuts = new Map(); // visit sessionId -> { reason, at }
const _overrunSeen = new Set(); // connectionIds already reported past the max without a registry entry
let _deps = { hangup: null, logEvent: () => {}, now: () => Date.now() };
let _timer = null;

function configure(deps = {}) { _deps = { ..._deps, ...deps }; }

// auto: the client reconnected on its own (a dropped session). The quiet
// time carries over, or an idle tab reopening its dropped session every
// ~4.5 min would never reach the idle limit.
function register({ liveId, sessionId = null, maxHeader, idleHeader, auto = false }) {
    if (!liveId) return null;
    const cfg = config();
    const now = _deps.now();
    let lastTurnAt = now;
    if (auto && sessionId) {
        let latest = null;
        for (const e of _sessions.values()) if (e.sessionId === sessionId) latest = latest === null ? e.lastTurnAt : Math.max(latest, e.lastTurnAt);
        if (latest !== null) lastTurnAt = latest;
    }
    const entry = {
        liveId, sessionId, startedAt: now, lastTurnAt, lastUsageAt: null, lastSeconds: 0,
        maxMin: lowered(maxHeader, cfg.maxMin), idleMin: lowered(idleHeader, cfg.idleMin),
        cut: null, ended: false, overrunLogged: false,
    };
    _sessions.set(liveId, entry);
    return entry;
}

function noteTurn(sessionId) {
    if (!sessionId) return;
    const now = _deps.now();
    for (const e of _sessions.values()) if (e.sessionId === sessionId && !e.ended) e.lastTurnAt = now;
}

const minutesOf = (e, now) => Math.round(((now - e.startedAt) / 60000) * 100) / 100;
const flowing = (e, now) => !!e.lastUsageAt && now - e.lastUsageAt < FLOWING_MS;

async function cut(e, reason, now = _deps.now()) {
    if (e.cut) return e.cut;
    const minutes = minutesOf(e, now);
    e.cut = { reason, at: now, by: 'server', hangup: null };
    if (e.sessionId) _recentCuts.set(e.sessionId, { reason, at: now });
    const wasFlowing = flowing(e, now);
    let hangup = { status: null, error: 'no hang-up configured' };
    try {
        if (_deps.hangup) hangup = await _deps.hangup(e.liveId);
    } catch (err) {
        hangup = { status: null, error: err && err.message ? err.message : String(err) };
    }
    e.cut.hangup = hangup.status;
    const ok = hangup.status >= 200 && hangup.status < 300;
    if (wasFlowing || ok) {
        console.error(`[liveGuard] ✂️ live_session_cut ${reason} after ${minutes} min · ${e.liveId} · visit ${e.sessionId || '?'} · hang-up ${hangup.status || 'failed'}${ok ? '' : ' — ⚠️ NOT confirmed by OpenAI (' + (hangup.error || hangup.body || '') + '); the usage tripwire and the client must end it'}`);
        if (e.sessionId) {
            _deps.logEvent(e.sessionId, 'live_session_cut', {
                reason, minutes, by: 'server', liveSessionId: e.liveId, hangup: hangup.status || null,
                ...(ok ? {} : { hangupError: String(hangup.error || hangup.body || '').slice(0, 200) }),
                liveSeconds: e.lastSeconds || null,
            });
        }
    } else {
        // No usage seen for a while and OpenAI did not confirm: most likely
        // the client closed it already (pagehide, crash) — nothing was billed.
        console.log(`[liveGuard] ${e.liveId} past its ${reason} limit with no usage flowing; hang-up ${hangup.status || 'failed'} — treated as already closed`);
    }
    return e.cut;
}

// Called for every GPT-Live usage snapshot (/api/session-log kind 'usage').
// Returns { cut: true, reason } when the connection must end now.
function onUsage(p, now = _deps.now()) {
    if (!p || p.voiceMode !== 'live') return { cut: false };
    const cfg = config();
    const e = p.liveSessionId ? _sessions.get(p.liveSessionId) : null;
    if (e) {
        if (p.source === 'disconnect') { e.ended = true; return { cut: false }; }
        const secs = p.usage && typeof p.usage.seconds === 'number' ? p.usage.seconds : null;
        if (secs !== null && secs > e.lastSeconds) { e.lastSeconds = secs; e.lastUsageAt = now; }
        if (!e.cut) {
            if (now - e.startedAt > (e.maxMin * 60 + graceS()) * 1000) cut(e, 'max', now);
            else if (now - e.lastTurnAt > (e.idleMin * 60 + graceS()) * 1000) cut(e, 'idle', now);
        }
        if (e.cut) {
            if (!e.overrunLogged) {
                e.overrunLogged = true;
                console.error(`[liveGuard] ⚠️ usage still arriving for ${e.liveId} after its ${e.cut.reason} cut (${minutesOf(e, now)} min) — telling the client to end it`);
                if (e.sessionId) _deps.logEvent(e.sessionId, 'live_session_overrun', { reason: e.cut.reason, minutes: minutesOf(e, now), liveSessionId: e.liveId, liveSeconds: e.lastSeconds });
            }
            return { cut: true, reason: e.cut.reason };
        }
        return { cut: false };
    }
    // Not registered here (server restarted, or a client without the id):
    // the client's own clock for this connection still trips the max.
    if (p.source !== 'disconnect' && typeof p.sessionMinutes === 'number' && p.sessionMinutes > cfg.maxMin + cfg.graceS / 60) {
        const key = p.connectionId || p.sessionId || '?';
        if (!_overrunSeen.has(key)) {
            _overrunSeen.add(key);
            if (_overrunSeen.size > 2000) _overrunSeen.delete(_overrunSeen.values().next().value);
            console.error(`[liveGuard] ⚠️ live_session_overrun: connection ${key} reports ${p.sessionMinutes} min (max ${cfg.maxMin}) — telling the client to end it`);
            if (p.sessionId) _deps.logEvent(p.sessionId, 'live_session_overrun', { reason: 'max', minutes: p.sessionMinutes, connectionId: p.connectionId || null, unregistered: true });
        }
        if (p.sessionId) _recentCuts.set(p.sessionId, { reason: 'max', at: now });
        return { cut: true, reason: 'max' };
    }
    return { cut: false };
}

// The backstop, every 15 s: cut what is past a limit and still billing;
// at the max, ask OpenAI to hang up even with no usage seen (an old client
// that never sends the session id) — logged only if it was really open.
function sweep(now = _deps.now()) {
    const cuts = [];
    for (const [id, e] of _sessions) {
        if (e.ended || e.cut) {
            if (now - (e.cut ? e.cut.at : e.startedAt) > FORGET_MS) _sessions.delete(id);
            continue;
        }
        const pastMax = now - e.startedAt > (e.maxMin * 60 + graceS()) * 1000;
        const pastIdle = now - e.lastTurnAt > (e.idleMin * 60 + graceS()) * 1000;
        if (pastMax) cuts.push(cut(e, 'max', now));
        else if (pastIdle && flowing(e, now)) cuts.push(cut(e, 'idle', now));
    }
    for (const [sid, c] of _recentCuts) if (now - c.at > RECENT_CUT_MS) _recentCuts.delete(sid);
    return Promise.all(cuts);
}

// Before opening a Live session: a reconnect the client made on its own
// right after a cut is refused (the person taps to resume instead).
function refuseAutoReconnect(sessionId, now = _deps.now()) {
    const c = sessionId ? _recentCuts.get(sessionId) : null;
    return c && now - c.at < RECENT_CUT_MS ? c : null;
}
function clearCut(sessionId) { if (sessionId) _recentCuts.delete(sessionId); }

function start() {
    if (_timer) return;
    _timer = setInterval(() => { sweep().catch((e) => console.error('[liveGuard] sweep failed:', e && e.message)); }, 15000);
    if (_timer.unref) _timer.unref();
}

module.exports = {
    config, configure, register, noteTurn, onUsage, sweep, refuseAutoReconnect, clearCut, start,
    _internal: { reset: () => { _sessions.clear(); _recentCuts.clear(); _overrunSeen.clear(); }, sessions: _sessions, lowered },
};
