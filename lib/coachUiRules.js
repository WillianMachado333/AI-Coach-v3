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

    // The recent conversation to replay into a fresh model session: the last
    // `maxMessages` finished user/coach messages, each clipped, then oldest
    // dropped until the whole fits `maxChars`. Roles are the API's
    // (user / assistant).
    function recentHistory(messages, { maxMessages = 12, maxChars = 6000, maxPerMessage = 1500 } = {}) {
        const turns = (Array.isArray(messages) ? messages : [])
            .filter((m) => m && (m.role === 'user' || m.role === 'bot' || m.role === 'assistant') && m.final !== false)
            .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: String(m.text ?? m.content ?? '').trim() }))
            .filter((t) => t.text)
            .slice(-maxMessages)
            .map((t) => (t.text.length > maxPerMessage ? { ...t, text: t.text.slice(0, maxPerMessage - 1) + '…' } : t));
        let total = turns.reduce((sum, t) => sum + t.text.length, 0);
        while (turns.length && total > maxChars) total -= turns.shift().text.length;
        return turns;
    }

    const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic|heif|avif|bmp)$/i;

    // What a user bubble shows: the message text without the "[Attached: …]"
    // line sendTextMessage appends (it stays in the saved text so history and
    // the model know what was shared), plus one entry per attachment. Entries
    // come from the message's own attachment list when it has one — photos
    // carry their image while the page lives — otherwise from the names in
    // the marker (history saved before attachment lists existed).
    function userBubbleParts(message) {
        const raw = String((message && message.text) || '');
        const marker = raw.match(/(?:^|\n\n)\[Attached: ([^\]\n]*)\]\s*$/);
        const text = marker ? raw.slice(0, marker.index).trim() : raw;
        const own = message && Array.isArray(message.attachments) ? message.attachments : null;
        const attachments = (own && own.length ? own : (marker ? marker[1].split(', ') : []).map((name) => ({ name })))
            .map((a) => {
                const name = String(a.name || '').trim();
                const kind = a.kind === 'image' || a.kind === 'text' ? a.kind : (IMAGE_NAME.test(name) ? 'image' : 'text');
                const src = kind === 'image' && typeof a.src === 'string' && /^(data:image\/|blob:)/.test(a.src) ? a.src : null;
                return { kind, name, src };
            })
            .filter((a) => a.name);
        return { text, attachments };
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
        spokenCovers,
        recentHistory,
        userBubbleParts
    };
});
