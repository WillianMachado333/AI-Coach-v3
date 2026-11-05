// Revalidation headers for the app's own code: .html, .js (bridge.js included)
// and .css.
//
// The static handler used to send no Cache-Control / ETag / Last-Modified, so
// browsers cached index.html and friends heuristically and the Wix embed kept
// serving stale versions after a deploy. `no-cache` does not mean "don't
// store": it means "revalidate every time", and a strong ETag makes that
// revalidation a 304 with no body. Media (companion videos, images) is left
// alone — it doesn't change per deploy and is big.
const crypto = require('crypto');

const REVALIDATED_EXTENSIONS = new Set(['.html', '.js', '.css']);

function validators(content, mtime) {
    const etag = '"' + crypto.createHash('sha1').update(content).digest('base64url') + '"';
    const modified = mtime instanceof Date && !Number.isNaN(mtime.getTime()) ? mtime : new Date();
    return { 'ETag': etag, 'Last-Modified': modified.toUTCString() };
}

// Returns the headers to send with the file, or null for types we don't touch.
function revalidationHeaders(extname, content, mtime) {
    if (!REVALIDATED_EXTENSIONS.has(String(extname).toLowerCase())) return null;
    return { 'Cache-Control': 'no-cache', ...validators(content, mtime) };
}

// The brand icons (lib/brandIcons.js) keep fixed names, so a day in any cache
// and then a 304: not `immutable`, or a new logo would never reach anyone.
const ICON_MAX_AGE_S = 24 * 60 * 60;
function iconHeaders(content, mtime) {
    return { 'Cache-Control': 'public, max-age=' + ICON_MAX_AGE_S, ...validators(content, mtime) };
}

// RFC 9110 §13.1.3: If-None-Match wins over If-Modified-Since, and uses weak
// comparison (a `W/` prefix on either side still matches).
function isNotModified(requestHeaders, headers) {
    if (!headers) return false;
    const ifNoneMatch = requestHeaders && requestHeaders['if-none-match'];
    if (ifNoneMatch) {
        const wanted = String(ifNoneMatch).split(',').map((tag) => tag.trim());
        if (wanted.includes('*')) return true;
        const bare = (tag) => tag.replace(/^W\//, '');
        return wanted.some((tag) => bare(tag) === bare(headers.ETag));
    }
    const ifModifiedSince = requestHeaders && requestHeaders['if-modified-since'];
    if (ifModifiedSince) {
        const since = Date.parse(ifModifiedSince);
        return !Number.isNaN(since) && Date.parse(headers['Last-Modified']) <= since;
    }
    return false;
}

// gzip for the app's own text (.html/.js/.css): nothing compressed them, so
// app.js went out at 647 KB and bridge.js, on every site page view, at 49 KB
// (V3 production prep, 4 Nov 2026). The gzip copy has its own ETag (a
// different representation) and both copies say Vary: Accept-Encoding.
const zlib = require('zlib');
const GZIP_MIN_BYTES = 1024;
const gzipMemo = new Map(); // gzip ETag -> Buffer (bounded: the app has a few dozen files)
const GZIP_MEMO_MAX = 200;

function acceptsGzip(requestHeaders) {
    const accepted = String((requestHeaders && requestHeaders['accept-encoding']) || '');
    return accepted.split(',').some((part) => {
        const [coding, ...params] = part.trim().toLowerCase().split(';');
        if (coding !== 'gzip' && coding !== '*') return false;
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        return !q || Number(q.slice(2)) > 0;
    });
}

// { headers, body } to send: the gzip copy when the client takes it and the
// file is ours (revalidated text) and big enough, else the file as is.
// `headers` is what revalidationHeaders returned (null for media, left alone).
function negotiate(requestHeaders, headers, content) {
    if (!headers || headers['Cache-Control'] !== 'no-cache' || content.length < GZIP_MIN_BYTES) return { headers, body: content };
    const vary = { ...headers, Vary: 'Accept-Encoding' };
    if (!acceptsGzip(requestHeaders)) return { headers: vary, body: content };
    const etag = headers.ETag.replace(/"$/, '-gz"');
    let body = gzipMemo.get(etag);
    if (!body) {
        body = zlib.gzipSync(content, { level: 6 });
        if (gzipMemo.size >= GZIP_MEMO_MAX) gzipMemo.delete(gzipMemo.keys().next().value);
        gzipMemo.set(etag, body);
    }
    return { headers: { ...vary, ETag: etag, 'Content-Encoding': 'gzip' }, body };
}

module.exports = { revalidationHeaders, iconHeaders, isNotModified, negotiate, acceptsGzip, REVALIDATED_EXTENSIONS, ICON_MAX_AGE_S, GZIP_MIN_BYTES };
