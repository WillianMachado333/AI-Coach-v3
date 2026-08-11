/*
 * Prompt budget analyzer — computes an honest breakdown of what typically
 * goes into the coach's system prompt at boot time.
 *
 * Two data sources are combined:
 *   1. What we can MEASURE from server-observable files today:
 *      - persona / framework markdown (contentStore)
 *      - the fixed directive blocks the client appends (their exact text
 *        is duplicated here as constants so we don't need a real session
 *        just to introspect them)
 *   2. What is CLIENT-observed and reported by the coach after each
 *      session.configureSession:
 *      - the Wix preparation preamble length
 *      - the activity timeline length
 *      - the page context length
 *      - the element focus marker size
 *      When available, these override our estimates. Absent, we surface
 *      an "estimated" flag so the admin knows.
 *
 * The last-reported client breakdown is cached at
 *   /data/prompt-budget-last.json  (or PROMPT_BUDGET_LAST_FILE)
 * so a fresh admin visit gets the last known real breakdown without
 * needing a live coach connection.
 */

const fs = require('fs');
const path = require('path');
const contentStore = require('./contentStore');
const runtimeConfig = require('./runtimeConfig');

const LAST_FILE = process.env.PROMPT_BUDGET_LAST_FILE
    || path.join(process.env.SESSION_DATA_DIR ? path.dirname(process.env.SESSION_DATA_DIR) : '/data', 'prompt-budget-last.json');

// OpenAI Realtime GA cap ≈ 16,384 tokens; app.js MAX_INSTRUCTION_CHARS = 50000.
// We compute against the same 50k cap (~14k tokens) for consistency.
const MAX_INSTRUCTION_CHARS = 50000;

// Fixed directive blocks the client appends. These are duplicated here so
// we can size them without a live client. Update these when app.js changes.
const FIXED_BLOCKS = {
    languageDetection:
        'Always respond in the same language the user is currently using. ' +
        'Detect the language of the user\'s latest message and reply in that exact language. ' +
        'Do not default to English. Do not carry over the language from previous messages in the conversation history.',
    reinforcement:
        'CRITICAL COACHING STYLE REMINDER: You are <persona>. Your coaching approach is "<style>". ' +
        'Your behavioral guardrails take PRIORITY over the general guidelines above. ' +
        'Stay in character at all times.',
    knowledgeGrounding:
        // Approximate — the real block in app.js is longer; we use a typical
        // measurement (~2800 chars) as an estimate. Populated with real
        // number when the client reports.
        '=== KNOWLEDGE GROUNDING & REASONING (search_knowledge, deep_think, render_chart, render_table) ===\n' +
        '[typical block — full text ~2800 chars — measures visual widget triggers, chart-first discipline, element-level focus rules]'
};
const FIXED_BLOCK_ESTIMATES = {
    languageDetection: FIXED_BLOCKS.languageDetection.length,
    reinforcement: FIXED_BLOCKS.reinforcement.length,
    knowledgeGrounding: 2800   // measured in a recent session
};

function readLast() {
    try {
        const raw = fs.readFileSync(LAST_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* absent = ok */ }
    return null;
}
function writeLast(payload) {
    try {
        fs.mkdirSync(path.dirname(LAST_FILE), { recursive: true });
        fs.writeFileSync(LAST_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
        console.warn('[promptBudget] writeLast failed:', e?.message || e);
    }
}

/**
 * Compose the budget for a specific persona (or the default first available).
 * Returns { persona, blocks: [{key, name, chars, source, note}], total, budget, percentUsed, lastRealSession }
 *
 * `source` per block: 'measured' when we opened the file, 'reported' when
 * the client reported a real number for the last session, 'estimated'
 * otherwise. UI badges show these so operators know the confidence level.
 */
function compute({ personaName = null } = {}) {
    const last = readLast();
    const frameworks = contentStore.listFrameworks();
    // Prefer a persona explicitly requested, then the last-reported one,
    // then a friendly default (Supportive is Erica's default in TT).
    let chosen = personaName;
    if (!chosen && last && last.persona) chosen = last.persona;
    if (!chosen && frameworks.includes('Supportive')) chosen = 'Supportive';
    if (!chosen && frameworks.length) chosen = frameworks[0];
    // The client may report a human-facing label (e.g. "Calm, Reassuring
    // Coach") which doesn't correspond to a framework file on disk.
    // Try progressively looser matches: exact, then a fuzzy contains match
    // against known framework names, then fall back to Supportive.
    let personaRead = chosen ? contentStore.readFramework(chosen) : null;
    let displayName = chosen;
    if (!personaRead && chosen) {
        const key = String(chosen).toLowerCase();
        // Map common labels used by TT personas to their framework files.
        // (Extend as new personas ship — cheap alias table.)
        const labelAlias = {
            'calm, reassuring coach': 'Supportive',
            'reassuring coach': 'Supportive',
            'supportive coach': 'Supportive',
            'directive coach': 'Directive',
            'discovery coach': 'Discovery',
            'nurturing coach': 'Nurturing',
            'exploratory coach': 'Exploratory',
            'guidance coach': 'Guidance',
            'empowering coach': 'Empowering'
        };
        const aliased = labelAlias[key];
        if (aliased && frameworks.includes(aliased)) {
            personaRead = contentStore.readFramework(aliased);
        }
        // Last resort: any framework name that appears as a substring.
        if (!personaRead) {
            const fuzzy = frameworks.find((n) => key.includes(n.toLowerCase()));
            if (fuzzy) personaRead = contentStore.readFramework(fuzzy);
        }
    }
    const personaChars = personaRead ? personaRead.text.length : 0;

    // Channels currently enabled — informs whether activity/pageContext are
    // typically present or not.
    const channelState = {};
    for (const ch of runtimeConfig.listChannels()) channelState[ch.id] = ch.enabled;

    const blocks = [];
    blocks.push({
        key: 'persona',
        name: 'Persona identity (' + (chosen || '?') + ')',
        chars: personaChars || (last && last.blocks && last.blocks.persona) || 0,
        source: personaRead ? 'measured' : ((last && last.blocks && last.blocks.persona) ? 'reported' : 'missing'),
        note: personaRead
            ? 'From ' + (personaRead.source === 'overlay' ? 'edited overlay' : 'repo default') + ' (' + personaRead.name + '.md)'
            : (last && last.blocks && last.blocks.persona ? 'Reported by last session; no matching framework file on disk' : 'Persona file not found — client reports label only')
    });
    blocks.push({
        key: 'voiceStyle',
        name: 'Voice style guardrails',
        chars: (last && last.blocks && last.blocks.voiceStyle) || Math.round(personaChars * 0.20),
        source: (last && last.blocks && last.blocks.voiceStyle) ? 'reported' : 'estimated',
        note: 'Derived from persona guardrails at session boot'
    });
    blocks.push({
        key: 'wixPreamble',
        name: 'Wix preparation preamble',
        chars: (last && last.blocks && last.blocks.wixPreamble) || 17000,
        source: (last && last.blocks && last.blocks.wixPreamble) ? 'reported' : 'estimated',
        note: 'Global rules/scope/resources — same for every coach. To be migrated → Injected Data.'
    });
    blocks.push({
        key: 'knowledgeGrounding',
        name: 'Knowledge grounding + visual widgets',
        chars: (last && last.blocks && last.blocks.knowledgeGrounding) || FIXED_BLOCK_ESTIMATES.knowledgeGrounding,
        source: (last && last.blocks && last.blocks.knowledgeGrounding) ? 'reported' : 'estimated',
        note: 'Chart-first + search_knowledge + deep_think + element focus rules'
    });
    blocks.push({
        key: 'activity',
        name: 'Activity timeline',
        chars: (last && last.blocks && last.blocks.activity)
            || (channelState.activity_timeline ? 900 : 0),
        source: (last && last.blocks && last.blocks.activity) ? 'reported' : (channelState.activity_timeline ? 'estimated' : 'off'),
        note: channelState.activity_timeline
            ? 'CleverTap recent events, injected on boot'
            : 'Channel currently OFF — no activity block'
    });
    blocks.push({
        key: 'pageContext',
        name: 'Page context (live)',
        chars: (last && last.blocks && last.blocks.pageContext)
            || (channelState.page_context ? 1500 : 0),
        source: (last && last.blocks && last.blocks.pageContext) ? 'reported' : (channelState.page_context ? 'estimated' : 'off'),
        note: channelState.page_context
            ? 'Snapshot of the parent page the user is on'
            : 'Channel currently OFF'
    });
    blocks.push({
        key: 'languageDetection',
        name: 'Language detection',
        chars: FIXED_BLOCK_ESTIMATES.languageDetection,
        source: 'measured',
        note: 'Fixed constant appended after global block'
    });
    blocks.push({
        key: 'reinforcement',
        name: 'Persona reinforcement (recency)',
        chars: FIXED_BLOCK_ESTIMATES.reinforcement,
        source: 'measured',
        note: 'Repeats persona rules at the very end for recency effect'
    });

    const total = blocks.reduce((s, b) => s + (b.chars || 0), 0);
    return {
        // What to show as the chip label — prefer the user-facing label
        // from the reported session, fall back to the resolved id.
        persona: (last && last.personaLabel) || chosen,
        // What to link to in the persona editor.
        personaId: personaRead ? personaRead.name : chosen,
        personaSource: personaRead ? personaRead.source : null,
        blocks,
        total,
        budget: MAX_INSTRUCTION_CHARS,
        percentUsed: Math.round((total / MAX_INSTRUCTION_CHARS) * 100),
        approxTokens: Math.round(total / 3.5),
        lastRealSession: last && last.session ? {
            sessionId: last.session.sessionId,
            at: last.session.at
        } : null,
        channelsEnabled: channelState,
        channelsList: runtimeConfig.listChannels()
    };
}

/**
 * Called by the /api/session-log ingestion when the client posts a
 * `prompt_breakdown` event. Persist to /data/prompt-budget-last.json so
 * the admin surfaces real numbers on next visit.
 * Shape: { persona, blocks: {persona, voiceStyle, wixPreamble, knowledgeGrounding, activity, pageContext, ...}, session: {sessionId, at} }
 */
function recordBreakdown(payload) {
    if (!payload || typeof payload !== 'object') return;
    writeLast(payload);
}

module.exports = {
    compute,
    recordBreakdown,
    MAX_INSTRUCTION_CHARS,
    _paths: { LAST_FILE }
};
