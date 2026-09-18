/* Pure rules shared by the browser UI and Node regression tests. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.coachUiRules = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const STARTER_CONTEXTS = [
        {
            test: /decision|choose|choice|option/i,
            suggestions: [
                'Help me compare my options',
                'What matters most here?'
            ]
        },
        {
            test: /goal|task|work|lesson|course|quiz|learn|completed|started/i,
            suggestions: [
                'Turn this into a next step',
                'What did this reveal about me?'
            ]
        },
        {
            test: /reflect|feeling|journal|mind|wellbeing|stress/i,
            suggestions: [
                'Help me name what is happening',
                'What might be underneath this?'
            ]
        }
    ];

    function hasSendableText(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    function messageAlignment(role) {
        return role === 'user' ? 'justify-end' : 'justify-start';
    }

    function isNearBottom(scrollHeight, scrollTop, clientHeight, threshold = 80) {
        return Number(scrollHeight) - Number(scrollTop) - Number(clientHeight) <= threshold;
    }

    function shouldAnimateCoach(level, isSoundEnabled, audioOutputGate) {
        return Number(level) > 0.04 && !!isSoundEnabled && !audioOutputGate;
    }

    function streamingHighlightParts(value, phraseSize = 4) {
        const text = String(value || '');
        if (!text) return { before: '', highlight: '' };

        const words = [...text.matchAll(/\S+/g)];
        if (!words.length) return { before: '', highlight: text };
        const count = Math.max(1, Math.min(8, Number(phraseSize) || 4));
        const startWord = words[Math.max(0, words.length - count)];
        return {
            before: text.slice(0, startWord.index),
            highlight: text.slice(startWord.index)
        };
    }

    function contextualStarterSuggestions(activity, fallback) {
        const safeActivity = typeof activity === 'string' ? activity.trim() : '';
        if (safeActivity) {
            const match = STARTER_CONTEXTS.find((entry) => entry.test.test(safeActivity));
            if (match) return [...match.suggestions];
        }
        return Array.isArray(fallback) ? [...fallback] : [];
    }

    function isSafeSuggestion(value) {
        const text = String(value || '').trim();
        if (!text || text.length > 120 || /https?:\/\/|www\.|@|\b\d{6,}\b/i.test(text)) return false;
        return text.split(/\s+/).length <= 12;
    }

    function filterSuggestions(values, fallback) {
        const cleaned = (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').replace(/[\r\n]+/g, ' ').trim())
            .filter(isSafeSuggestion)
            .slice(0, 2);
        return cleaned.length === 2 ? cleaned : (Array.isArray(fallback) ? [...fallback] : []);
    }

    return {
        hasSendableText,
        messageAlignment,
        isNearBottom,
        shouldAnimateCoach,
        streamingHighlightParts,
        contextualStarterSuggestions,
        filterSuggestions,
        isSafeSuggestion
    };
});
