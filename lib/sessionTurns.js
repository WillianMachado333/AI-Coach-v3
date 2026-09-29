/**
 * Real session turns in the Studio (#30).
 *
 * The client posts one user_turn / bot_turn per FINAL message (never
 * partial deltas) to /api/session-log. This module is the server's gate
 * for what those posts may carry, and the Studio's arrangement of a
 * session timeline once real turns sit next to reasoning, clipboard and
 * usage lines.
 *
 * Privacy: user text redaction stays in lib/sessionLog.js (STORE_MESSAGE_TEXT,
 * default 'redacted'). Here a client can never switch it off: the
 * `synthetic` flag that stores user text raw for generated sessions is
 * dropped from anything that arrives over HTTP.
 */

const INPUT_TYPES = ['text', 'voice', 'pill', 'photo'];
const VOICE_MODES = ['live', 'realtime'];
const TEXT_MAX = 8000;
const ATTACHMENTS_MAX = 10;

const str = (v, n) => (typeof v === 'string' && v.trim() ? v.slice(0, n) : null);

function sanitizeTurnText(text) {
    return typeof text === 'string' ? text.slice(0, TEXT_MAX) : null;
}

/**
 * Whitelist of what a client may attach to a turn. Attachments are names
 * only — a photo's image never reaches the log.
 */
function sanitizeTurnMeta(raw, kind) {
    const m = raw && typeof raw === 'object' ? raw : {};
    const out = { messageId: str(m.messageId, 120), at: str(m.at, 40) };
    if (kind === 'user_turn') {
        out.inputType = INPUT_TYPES.includes(m.inputType) ? m.inputType : 'text';
        if (Array.isArray(m.attachments)) {
            const names = m.attachments
                .map((a) => str(typeof a === 'string' ? a : a && a.name, 120))
                .filter(Boolean)
                .slice(0, ATTACHMENTS_MAX);
            if (names.length) out.attachments = names;
        }
    } else {
        out.voiceMode = VOICE_MODES.includes(m.voiceMode) ? m.voiceMode : null;
        out.inCall = m.inCall === true;
        out.responseId = str(m.responseId, 80);
        out.delegationId = str(m.delegationId, 80);
    }
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null && v !== undefined));
}

/** A QC correction to a bot turn already logged: event turn_revised. */
function sanitizeRevision(raw) {
    const m = raw && typeof raw === 'object' ? raw : {};
    const messageId = str(m.messageId, 120);
    if (!messageId) return null;
    return { messageId, text: sanitizeTurnText(m.text) || '' };
}

const isReasoning = (e) => e && e.type === 'event'
    && (e.name === 'reasoning_summary' || e.name === 'reasoning_unsummarized')
    && e.meta && e.meta.delegationId;

/**
 * Timeline order for the Studio. File order (server receive time) is kept,
 * with two adjustments:
 *   - a QC revision (event turn_revised) replaces the text of the bot turn
 *     it names, and is not shown on its own;
 *   - Erica's reasoning for a delegation moves to just before the bot turn
 *     that delegation produced (same delegationId), flagged `_anchored` so
 *     the renderer shows the reasoning without repeating the answer.
 * Returns shallow copies; the input is untouched.
 */
function arrangeTimeline(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const revised = new Map();
    for (const e of list) {
        if (e && e.type === 'event' && e.name === 'turn_revised' && e.meta && e.meta.messageId) revised.set(e.meta.messageId, e.meta.text);
    }
    const botTurnForDelegation = new Set();
    for (const e of list) {
        if (e && e.type === 'turn' && e.role === 'bot' && e.meta && e.meta.delegationId) botTurnForDelegation.add(e.meta.delegationId);
    }
    const heldReasoning = new Map(); // delegationId -> [entries]
    const out = [];
    for (const e of list) {
        if (!e) continue;
        if (e.type === 'event' && e.name === 'turn_revised') continue;
        if (isReasoning(e) && botTurnForDelegation.has(e.meta.delegationId)) {
            const d = e.meta.delegationId;
            if (!heldReasoning.has(d)) heldReasoning.set(d, []);
            heldReasoning.get(d).push({ ...e, _anchored: true });
            continue;
        }
        if (e.type === 'turn' && e.role === 'bot') {
            const d = e.meta && e.meta.delegationId;
            if (d && heldReasoning.has(d)) {
                out.push(...heldReasoning.get(d));
                heldReasoning.delete(d);
            }
            const id = e.meta && e.meta.messageId;
            if (id && revised.has(id)) {
                out.push({ ...e, text: revised.get(id), _revised: true });
                continue;
            }
        }
        out.push(e);
    }
    // Reasoning whose answer turn came earlier in the file (the answer was
    // spoken before the backend's record closed): place it right before
    // that turn instead of losing it.
    if (heldReasoning.size) {
        for (const [d, items] of heldReasoning) {
            const idx = out.findIndex((x) => x.type === 'turn' && x.role === 'bot' && x.meta && x.meta.delegationId === d);
            if (idx >= 0) out.splice(idx, 0, ...items); else out.push(...items.map((x) => ({ ...x, _anchored: false })));
        }
    }
    return out;
}

module.exports = { INPUT_TYPES, TEXT_MAX, sanitizeTurnText, sanitizeTurnMeta, sanitizeRevision, arrangeTimeline };
