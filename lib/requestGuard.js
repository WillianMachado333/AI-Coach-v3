// A request's 'data' and 'end' listeners run outside handleRequest's promise,
// so the .catch() safety net in server.js never sees their errors: a throw in
// a plain listener is an uncaughtException, a rejection in an async one is an
// unhandledRejection, and either stops the whole process (NEW-1 was this
// class). guardRequest wraps those listeners on one request so the same
// failure reaches onError instead, which answers 500 and logs it in red.
'use strict';

const GUARDED_EVENTS = new Set(['data', 'end']);

function guardRequest(req, onError) {
    const guard = (listener) => function guardedListener(...args) {
        try {
            const out = listener.apply(this, args);
            if (out && typeof out.then === 'function') out.then(undefined, onError);
            return out;
        } catch (err) {
            onError(err);
            return undefined;
        }
    };
    for (const method of ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']) {
        const original = req[method];
        if (typeof original !== 'function') continue;
        req[method] = function guardedSubscribe(event, listener) {
            const wrapped = GUARDED_EVENTS.has(event) && typeof listener === 'function' ? guard(listener) : listener;
            return original.call(this, event, wrapped);
        };
    }
    return req;
}

module.exports = { guardRequest, GUARDED_EVENTS };
