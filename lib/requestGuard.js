// The safety net for one request (NEW-1 and the QA review of #77, 10 Nov 2026).
//
// A route reads its body in req.on('data'/'end') listeners, which run outside
// handleRequest's promise: a throw there (or a rejection in an async
// listener) used to stop the whole process. guardRequest wraps those
// listeners, and failRequest handles the failure ONCE:
//   - it logs one red line, saying whether the client got a 500 or had
//     already been answered, and counts it (lib/failureStats.js → /api/health);
//   - it answers 500 when nothing was sent yet;
//   - the request's remaining listeners do not run, and whatever the route
//     still writes (an upstream callback answering after the 500) is dropped
//     instead of throwing ERR_HTTP_HEADERS_SENT outside any guard;
//   - a body still arriving is not read: the request is destroyed once the
//     answer has gone out.
// A write after the end ('error' on the response, with no listener) is
// handled the same way.
//
// Listener bookkeeping stays intact: one wrapper per listener, whose
// .listener is the original, so removeListener / off / pipe / unpipe /
// stream.finished / events.once find it, and once() fires one wrapper once.
'use strict';

const failureStats = require('./failureStats');

const GUARDED_EVENTS = new Set(['data', 'end']);
const STATE = Symbol('ericaRequestGuard');

const stateOf = (req) => req[STATE] || (req[STATE] = { failed: false });
const isFailed = (req) => !!(req[STATE] && req[STATE].failed);
const routeOf = (req) => `${req.method} ${String(req.url).split('?')[0]}`;

function failRequest(req, res, err, { log = console } = {}) {
    if (isFailed(req)) return; // logged and answered once
    const route = routeOf(req);
    const detail = (err && err.stack) || err;
    if (res.headersSent) {
        failureStats.note('afterResponse');
        log.error(`[SERVER] 🔴 Error after the response was sent (${res.statusCode}; process kept running): ${route}:`, detail);
    } else {
        failureStats.note('requestFailed');
        log.error(`[SERVER] 🔴 Request failed → 500 (process kept running): ${route}:`, detail);
    }
    closeRequest(req, res, 500, { error: 'internal error' }, { log });
}

/**
 * End a request here, once: answer `status` with `payload` if nothing was
 * sent yet, stop its route (its guarded listeners return early), drop
 * whatever it still writes, and stop reading a body still arriving.
 * failRequest (500) and the body limit (413) both end requests this way.
 */
function closeRequest(req, res, status, payload, { log = console } = {}) {
    const st = stateOf(req);
    if (st.failed) return;
    st.failed = true;
    const route = routeOf(req);
    const writeHead = res.writeHead;
    const end = res.end;
    try {
        if (!res.headersSent) writeHead.call(res, status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        if (!res.writableEnded) end.call(res, JSON.stringify(payload));
    } catch (_) { /* the socket is gone */ }

    // From here on, what the route still writes is dropped (said once).
    let dropped = false;
    const drop = (ret) => function droppedWrite(...args) {
        if (!dropped) { dropped = true; log.warn(`[SERVER] ⚠️ ${route}: a write after the failure was dropped`); }
        const cb = args.reverse().find((a) => typeof a === 'function');
        if (cb) process.nextTick(cb);
        return ret === 'self' ? this : ret;
    };
    res.writeHead = drop('self');
    res.setHeader = drop('self');
    res.removeHeader = drop(undefined);
    res.flushHeaders = drop(undefined);
    res.write = drop(true); // true: a pipe into it keeps draining instead of waiting forever
    res.end = drop('self');

    // Stop holding a body nobody will use (it grew to ~512 MB before this):
    // what still arrives is discarded, not kept, so the client can finish
    // sending and read the answer; one that keeps sending past DRAIN_MS is cut.
    const stopReading = () => {
        if (req.complete || req.destroyed) return;
        req.resume();
        const t = setTimeout(() => { if (!req.complete && !req.destroyed) req.destroy(); }, DRAIN_MS);
        if (t.unref) t.unref();
    };
    if (res.writableFinished || res.destroyed) stopReading();
    else { res.once('finish', stopReading); res.once('close', stopReading); }
}

const DRAIN_MS = 3000;

function guardRequest(req, res, { log = console } = {}) {
    const onError = (err) => failRequest(req, res, err, { log });

    const guard = (listener) => {
        const guarded = function guardedListener(...args) {
            if (isFailed(req)) return undefined; // the request already failed: its route stops here
            try {
                const out = listener.apply(this, args);
                if (out && typeof out.then === 'function') out.then(undefined, onError);
                return out;
            } catch (err) {
                onError(err);
                return undefined;
            }
        };
        guarded.listener = listener; // removeListener(original) finds it
        return guarded;
    };
    const wants = (event, listener) => GUARDED_EVENTS.has(event) && typeof listener === 'function';

    const on = req.on;
    const prependListener = req.prependListener;
    const once = req.once;
    const prependOnceListener = req.prependOnceListener;

    const add = (original) => function guardedAdd(event, listener) {
        return original.call(this, event, wants(event, listener) ? guard(listener) : listener);
    };
    // once / prependOnceListener: a single wrapper that removes itself, not a
    // onceWrapper inside a guard (which removeListener(original) cannot find).
    const addOnce = (originalAdd, originalOnce) => function guardedAddOnce(event, listener) {
        if (!wants(event, listener)) return originalOnce.call(this, event, listener);
        const self = this;
        const inner = guard(listener);
        let fired = false;
        function onceGuarded(...args) {
            if (fired) return undefined;
            fired = true;
            self.removeListener(event, onceGuarded);
            return inner.apply(this, args);
        }
        onceGuarded.listener = listener;
        return originalAdd.call(this, event, onceGuarded);
    };

    req.on = add(on);
    req.addListener = req.on;
    req.prependListener = add(prependListener);
    req.once = addOnce(on, once);
    req.prependOnceListener = addOnce(prependListener, prependOnceListener);

    // A write after the end emits 'error' on the response; with no listener
    // that stopped the process too.
    res.on('error', onError);
    return req;
}

module.exports = { guardRequest, failRequest, closeRequest, isFailed, GUARDED_EVENTS };
