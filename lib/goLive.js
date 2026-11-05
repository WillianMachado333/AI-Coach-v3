/**
 * lib/goLive.js — the V3 go-live switch.
 *
 * ERICA_GO_LIVE on the service that serves bridge.js decides whether V3
 * shows on talenttransformation.com pages for everyone (and hides V2's
 * "Ask Erica" button), or only behind the preview gate (?erica=preview,
 * /playground) as before. Default off. Rollback: set it off.
 *
 * The server writes the flag into bridge.js as it serves the file, so a page
 * view costs no extra request. bridge.js carries the marker line below; a
 * missing marker with the flag on is reported loudly at startup.
 */

const FLAG = 'ERICA_GO_LIVE';
const MARKER = 'var GO_LIVE = false;';
const ON_LINE = 'var GO_LIVE = true; ';

function isOn(env = process.env) {
    return /^(1|true|on|yes)$/i.test(String(env[FLAG] || '').trim());
}

/** bridge.js as served: the marker set to true when the flag is on. */
function bridgeSource(content, env = process.env) {
    if (!isOn(env)) return content;
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    if (!text.includes(MARKER)) return content;
    // ON_LINE has the marker's length, so nothing else in the file moves.
    const out = text.replace(MARKER, ON_LINE);
    return Buffer.isBuffer(content) ? Buffer.from(out, 'utf8') : out;
}

/** Startup check: { on, markerFound } for bridge.js text. */
function status(bridgeText, env = process.env) {
    return { on: isOn(env), markerFound: String(bridgeText || '').includes(MARKER) };
}

module.exports = { FLAG, MARKER, isOn, bridgeSource, status };
