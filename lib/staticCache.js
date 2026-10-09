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

module.exports = { revalidationHeaders, iconHeaders, isNotModified, REVALIDATED_EXTENSIONS, ICON_MAX_AGE_S };
