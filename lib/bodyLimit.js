// Request body size limits (QA review of #77, 10 Nov 2026, and SEC-09).
//
// Most routes read their whole body into a string with no limit: a ~560 MB
// body on /api/session-log grew to a ~512 MB string, and a few of those at
// once could take the container's memory. The routes that had a limit cut
// the socket (the client saw a reset, not an answer).
//
// Now every request has a limit, and going over it gets a 413 the client can
// read: at once when Content-Length says so, or as soon as the bytes that
// arrived pass the limit (chunked uploads, a wrong Content-Length). The
// route never sees the rest: its listeners stop, and the body is not read.
// The counting watches the request's own 'data' emits, so it never starts
// the stream flowing before the route is listening.
'use strict';

const { closeRequest } = require('./requestGuard');

const KB = 1024;
const MB = 1024 * KB;

// The limits routes already had (now answered with a 413), then the default.
const ROUTE_LIMITS = [
    ['/api/user-settings', 8 * KB],
    ['/api/navigator/infer', 32 * KB],
    ['/api/clipboard/', 96 * KB],
    ['/api/admin/attachments', 8 * MB], // base64 of a 4 MiB file
    ['/oauth/', 64 * KB],
    ['/mcp', 1 * MB],
];

function defaultLimit() {
    const n = Number(process.env.ERICA_MAX_BODY_BYTES);
    return Number.isFinite(n) && n > 0 ? n : 5 * MB;
}

function limitFor(url) {
    const p = String(url || '').split('?')[0];
    for (const [prefix, max] of ROUTE_LIMITS) if (p === prefix || p.startsWith(prefix)) return max;
    return defaultLimit();
}

const human = (n) => (n >= MB ? `${+(n / MB).toFixed(1)} MB` : `${Math.round(n / KB)} KB`);

/**
 * Watch one request's body size. Returns false when the request was already
 * refused (Content-Length over the limit): do not route it.
 */
function enforceBodyLimit(req, res, { log = console } = {}) {
    const max = limitFor(req.url);
    const route = `${req.method} ${String(req.url).split('?')[0]}`;
    const refuse = (what) => {
        log.warn(`[SERVER] ⚠️ 413 ${route}: body over the ${human(max)} limit (${what})`);
        closeRequest(req, res, 413, { error: 'Request body too large', limitBytes: max }, { log });
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
        refuse(`Content-Length ${declared}`);
        return false;
    }
    let seen = 0;
    let refused = false;
    const emit = req.emit;
    req.emit = function emitWithinLimit(event, ...args) {
        if (refused && (event === 'data' || event === 'end')) return false;
        if (event === 'data' && args[0]) {
            seen += args[0].length;
            if (seen > max) {
                refused = true;
                refuse(`${seen} bytes received`);
                return false;
            }
        }
        return emit.call(this, event, ...args);
    };
    return true;
}

module.exports = { enforceBodyLimit, limitFor, ROUTE_LIMITS, defaultLimit };
