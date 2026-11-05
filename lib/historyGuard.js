/**
 * lib/historyGuard.js — who may read or write a conversation history.
 *
 * Port of V2 (AgentErica) commit ac93495. The history endpoints take a
 * userId from the client; with no signed identity, anyone holding an id
 * could read or overwrite that person's conversations. Two speed bumps:
 *
 *   1. Rate limit: N requests per minute per client IP on the preparation and
 *      history endpoints (V2: 30, ERICA_RATE_LIMIT_MAX) → 429 over it.
 *   2. IP ↔ userId binding: the preparation records (ip, userId); history
 *      fetch/save for an UNSIGNED identity is allowed only for a userId
 *      prepared from the same IP within the window (V2: 30 min) → 403
 *      otherwise. A Wix-signed identity (#28) already proves who the user
 *      is, so the server skips the binding for it.
 *
 * Unlike V2, a history call that passes renews the binding: an open coach
 * keeps saving past the 30 minutes after its preparation.
 *
 * Memory is bounded: expired entries are pruned on write (at most once per
 * rate window), and each map is capped — over the cap, the oldest entry goes.
 * No timers, so nothing keeps the process alive and tests drive the clock.
 */

const DEFAULTS = Object.freeze({
    rateLimitMax: 30,
    rateWindowMs: 60 * 1000,
    bindingTtlMs: 30 * 60 * 1000,
    maxEntries: 100000,
});

const positive = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

function createHistoryGuard(opts = {}) {
    const rateLimitMax = Math.floor(positive(opts.rateLimitMax, DEFAULTS.rateLimitMax));
    const rateWindowMs = positive(opts.rateWindowMs, DEFAULTS.rateWindowMs);
    const bindingTtlMs = positive(opts.bindingTtlMs, DEFAULTS.bindingTtlMs);
    const maxEntries = Math.floor(positive(opts.maxEntries, DEFAULTS.maxEntries));
    const now = typeof opts.now === 'function' ? opts.now : Date.now;

    const rates = new Map();    // ip -> { count, resetAt }
    const bindings = new Map(); // ip + '\n' + userId -> last prepared / admitted at
    let lastPrune = now();

    const keyOf = (ip, userId) => `${ip || 'unknown'}\n${userId}`;

    // Re-insert so Map order stays oldest-first, then cap the size.
    function put(map, key, value) {
        map.delete(key);
        map.set(key, value);
        while (map.size > maxEntries) map.delete(map.keys().next().value);
    }

    function prune(t = now()) {
        lastPrune = t;
        for (const [ip, e] of rates) if (t >= e.resetAt) rates.delete(ip);
        for (const [k, ts] of bindings) if (t - ts > bindingTtlMs) bindings.delete(k);
    }

    function maybePrune(t) {
        if (t - lastPrune >= rateWindowMs) prune(t);
    }

    /**
     * Count one request from `ip`. Returns { ok, count, limit, resetInMs };
     * `first` is true on the first refusal of a window (log once, not per hit).
     */
    function hit(ip) {
        const t = now();
        maybePrune(t);
        const k = ip || 'unknown';
        let e = rates.get(k);
        if (!e || t >= e.resetAt) {
            e = { count: 0, resetAt: t + rateWindowMs };
            put(rates, k, e);
        }
        e.count++;
        const ok = e.count <= rateLimitMax;
        return { ok, first: !ok && e.count === rateLimitMax + 1, count: e.count, limit: rateLimitMax, resetInMs: e.resetAt - t };
    }

    /** The preparation for `userId` came from `ip`. */
    function bind(ip, userId) {
        if (!userId) return;
        const t = now();
        maybePrune(t);
        put(bindings, keyOf(ip, userId), t);
    }

    /** True when `userId` was prepared (or admitted) from `ip` within the window. No side effects. */
    function isBound(ip, userId) {
        if (!userId) return false;
        const ts = bindings.get(keyOf(ip, userId));
        return typeof ts === 'number' && now() - ts <= bindingTtlMs;
    }

    /** isBound, and on success renew the window (an active coach keeps its history). */
    function admit(ip, userId) {
        if (!isBound(ip, userId)) {
            bindings.delete(keyOf(ip, userId));
            return false;
        }
        bind(ip, userId);
        return true;
    }

    function stats() {
        return { rates: rates.size, bindings: bindings.size };
    }

    return {
        hit, bind, isBound, admit, prune, stats,
        config: Object.freeze({ rateLimitMax, rateWindowMs, bindingTtlMs, maxEntries }),
    };
}

/** The server's guard: ERICA_RATE_LIMIT_MAX (per minute) and ERICA_HISTORY_BINDING_TTL_MS. */
function fromEnv(env = process.env) {
    return createHistoryGuard({
        rateLimitMax: env.ERICA_RATE_LIMIT_MAX,
        bindingTtlMs: env.ERICA_HISTORY_BINDING_TTL_MS,
    });
}

module.exports = { createHistoryGuard, fromEnv, DEFAULTS };
