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

    // The persona's asset name ("Steve"), read from the files its profile
    // points at. Never the OpenAI voice ("marin" has no video) and never the
    // display name, which the user can rename. Asset files are TitleCase:
    // companions/Steve-thumb.png, companions/idle/84p/Steve.webm.
    function personaAssetKey(profile) {
        if (!profile || typeof profile !== 'object') return null;
        const config = profile.configuration && typeof profile.configuration === 'object' ? profile.configuration : profile;
        for (const value of [config.thumb, config.idleVideo, config.speakingVideo]) {
            const match = typeof value === 'string'
                && value.match(/(?:^|\/)([A-Za-z]{2,24})(?:-thumb)?\.(?:png|jpe?g|webp|webm|mp4)(?:[?#].*)?$/);
            if (match) return match[1].charAt(0).toUpperCase() + match[1].slice(1);
        }
        return null;
    }

    // Did the voice layer actually say the backend's answer? Call mode shows
    // the spoken transcript as the reply, so a backend answer the voice layer
    // never says would vanish. "Something was spoken" is not enough: the
    // greeting can still be playing when a typed turn's answer lands. The
    // voice layer paraphrases and shortens, so the test is the overlap of
    // content words over the smaller of the two sets, at a third or more.
    const FILLER_WORDS = new Set(('the and you your you\'re i\'m i\'ll i\'ve it\'s that this with for are was '
        + 'but not can can\'t now right just what how have has all any our out get got let let\'s there here '
        + 'okay sure yes yeah mhm one moment about from into like will would could should its see able '
        + 'checking check quickly').split(' '));
    function spokenCovers(backendText, spokenText) {
        const words = (value) => new Set(String(value || '').toLowerCase().replace(/[’‘`]/g, "'")
            .split(/[^a-z0-9']+/).map((w) => w.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
            .filter((w) => w.length >= 3 && !FILLER_WORDS.has(w)));
        const answer = words(backendText);
        if (!answer.size) return String(spokenText || '').trim().length > 0;
        const spoken = words(spokenText);
        if (!spoken.size) return false;
        let shared = 0;
        answer.forEach((w) => { if (spoken.has(w)) shared++; });
        return shared / Math.min(answer.size, spoken.size) >= 1 / 3;
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
        isSafeSuggestion,
        personaAssetKey,
        spokenCovers
    };
});
