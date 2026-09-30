/**
 * AI Navigator routing: the three tags (mood, readiness, clarity) → the
 * coaching style most likely to help, and a second one.
 *
 * The one implementation of the Navigator's selection logic
 * (navigatorData.json: the 36-route table first, per-option weights as the
 * fallback). Used by the Navigator form (navigator.js) and by the in-chat
 * Navigator on the server (lib/navigatorInfer.js), so the two can never
 * disagree.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.EricaNavigatorRouting = api;
})(typeof self !== 'undefined' ? self : this, function () {
    const TAG_ORDER = ['mood', 'readiness', 'clarity'];

    /**
     * @param data   navigatorData.json ({ questions, routes })
     * @param tags   { mood?, readiness?, clarity? } — option values
     * @returns { primary, autonomy, scores, tags, via: 'table' | 'weights' | 'none' }
     */
    function route(data, tags) {
        const t = {};
        for (const q of (data && data.questions) || []) {
            const v = tags && tags[q.id];
            if (typeof v === 'string' && (q.options || []).some((o) => o.value === v)) t[q.id] = v;
        }
        // Flat lookup table first (guaranteed correct for known combinations).
        if (data && data.routes) {
            const key = TAG_ORDER.map((k) => t[k]).filter(Boolean).join('|');
            const r = data.routes[key];
            if (Array.isArray(r) && r.length >= 2) return { primary: r[0], autonomy: r[1], scores: {}, tags: t, via: 'table' };
        }
        // Weighted scoring (a partial answer, or new questions/options not in the table).
        const scores = {};
        for (const q of (data && data.questions) || []) {
            const opt = (q.options || []).find((o) => o.value === t[q.id]);
            if (opt && opt.weights) for (const [style, w] of Object.entries(opt.weights)) scores[style] = (scores[style] || 0) + w;
        }
        const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        if (!ranked.length) return { primary: null, autonomy: null, scores, tags: t, via: 'none' };
        return { primary: ranked[0][0], autonomy: ranked[1] ? ranked[1][0] : null, scores, tags: t, via: 'weights' };
    }

    return { route, TAG_ORDER };
});
