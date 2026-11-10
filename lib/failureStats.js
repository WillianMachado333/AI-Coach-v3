// What went wrong without stopping the process, so it is never silent.
// A request the safety net answered with a 500, an error after a response was
// already sent, an unhandled promise rejection: each is counted here and
// /api/health says "degraded" for DEGRADED_WINDOW_MS after the last one
// (QA review of #77, 10 Nov 2026: the safety net turned a crash, which
// Railway restarts and reports, into one log line while /api/health kept
// saying "ok").
'use strict';

const KINDS = ['requestFailed', 'afterResponse', 'unhandledRejection'];
const windowMs = () => {
    const n = Number(process.env.ERICA_DEGRADED_WINDOW_MS);
    return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
};

let nowFn = Date.now;
let counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
let last = null; // { kind, at }

function note(kind) {
    if (!KINDS.includes(kind)) throw new Error('failureStats: unknown kind ' + kind);
    counts[kind]++;
    last = { kind, at: nowFn() };
}

/** Counts since the process started, the last failure, and whether it is recent. */
function snapshot() {
    const w = windowMs();
    return {
        degraded: !!last && nowFn() - last.at < w,
        windowMinutes: Math.round(w / 60000),
        ...counts,
        last: last ? { kind: last.kind, at: new Date(last.at).toISOString() } : null,
    };
}

module.exports = {
    note, snapshot, KINDS,
    _reset: () => { counts = Object.fromEntries(KINDS.map((k) => [k, 0])); last = null; },
    _setNow: (fn) => { nowFn = typeof fn === 'function' ? fn : Date.now; },
};
