/**
 * Coach settings (#35 → Eric's onboarding): how the coach looks and sounds
 * for this person, and the coaching style.
 *
 *   companionId      the image card picked (its face and name; see voiceCards.json)
 *   voice            the voice that card carries
 *   voiceStepDone    the first-call voice step is behind them (chosen or skipped)
 *   customNames      { <companionId>: name } the person gave the coach
 *   styleRecommended the in-chat Navigator's style (companionId of the style)
 *   styleOverride    a style the person chose themselves
 *
 * One shape and one validator for both sides. Stored ONLY on the server
 * (lib/userSettings.js): per userId for signed-in people; per CleverTap id
 * and for GUEST_TTL_MIN for guests (Eric: nothing on an anonymous person's
 * device). Exact values, never interpreted: unknown fields are dropped,
 * voices come from a fixed list, names are cleaned and capped.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.coachSettings = api;
})(typeof self !== 'undefined' ? self : this, function () {
    // OpenAI voice ids a person may get. All 8 persona voices were accepted by
    // both gpt-live-1 and gpt-realtime-2.1 (probe, 2026-09-30).
    const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
    const NAME_MAX = 24;
    const CUSTOM_NAMES_MAX = 16;
    const GUEST_TTL_MIN = 30;
    const COMPANION_RE = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
    const ID_FIELDS = ['companionId', 'styleRecommended', 'styleOverride'];

    const EMPTY = () => ({ companionId: null, voice: null, voiceStepDone: false, customNames: {}, styleRecommended: null, styleOverride: null });

    /** A name as a person would say it: letters, spaces, ' . -; trimmed and capped. '' → null. */
    function cleanName(s) {
        if (typeof s !== 'string') return null;
        const t = s.normalize('NFC').replace(/[^\p{L}\p{M}\s'’.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
        return t || null;
    }
    const cleanId = (v) => (typeof v === 'string' && COMPANION_RE.test(v) ? v : null);
    const cleanVoice = (v) => (typeof v === 'string' && VOICES.includes(v.toLowerCase()) ? v.toLowerCase() : null);

    /** Any input → a valid settings object (unknown fields dropped). */
    function normalize(input) {
        const out = EMPTY();
        if (!input || typeof input !== 'object') return out;
        for (const f of ID_FIELDS) out[f] = cleanId(input[f]);
        out.voice = cleanVoice(input.voice);
        out.voiceStepDone = input.voiceStepDone === true;
        const names = input.customNames && typeof input.customNames === 'object' ? input.customNames : {};
        for (const [cid, name] of Object.entries(names)) {
            if (Object.keys(out.customNames).length >= CUSTOM_NAMES_MAX) break;
            const id = cleanId(cid);
            const n = cleanName(name);
            if (id && n) out.customNames[id] = n;
        }
        return out;
    }

    /**
     * Apply a partial update. Fields present in `patch` replace the current
     * ones; customNames merge per coach, and `customNames[id] = null` removes
     * that coach's name. Returns { settings, changed: [field names] }.
     */
    function merge(current, patch) {
        const cur = normalize(current);
        const next = normalize(cur);
        const changed = [];
        if (!patch || typeof patch !== 'object') return { settings: next, changed };
        for (const f of ID_FIELDS) {
            if (!(f in patch)) continue;
            const v = cleanId(patch[f]);
            if (v !== cur[f]) { next[f] = v; changed.push(f); }
        }
        if ('voice' in patch) { const v = cleanVoice(patch.voice); if (v !== cur.voice) { next.voice = v; changed.push('voice'); } }
        if ('voiceStepDone' in patch) { const v = patch.voiceStepDone === true; if (v !== cur.voiceStepDone) { next.voiceStepDone = v; changed.push('voiceStepDone'); } }
        if (patch.customNames && typeof patch.customNames === 'object') {
            for (const [cid, name] of Object.entries(patch.customNames)) {
                const id = cleanId(cid);
                if (!id) continue;
                const n = name === null ? null : cleanName(name);
                if (n === null && name !== null) continue; // an invalid name is ignored, not a delete
                if ((next.customNames[id] || null) === n) continue;
                if (n === null) delete next.customNames[id];
                else {
                    if (!(id in next.customNames) && Object.keys(next.customNames).length >= CUSTOM_NAMES_MAX) continue;
                    next.customNames[id] = n;
                }
                if (!changed.includes('customNames')) changed.push('customNames');
            }
        }
        return { settings: next, changed };
    }

    return { VOICES, NAME_MAX, CUSTOM_NAMES_MAX, GUEST_TTL_MIN, cleanName, normalize, merge, empty: EMPTY };
});
