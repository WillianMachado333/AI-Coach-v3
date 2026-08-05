/**
 * lib/vectorStore.js
 * ---------------------------------------------------------------
 * Helpers for OpenAI Vector Store management + retrieval used by
 * the AI-Coach-v3 knowledge-search pipeline.
 *
 * Two kinds of stores:
 *   1. "frameworks-shared" — one global store containing coaching
 *      framework markdowns. Its id lives in FRAMEWORKS_STORE_ID
 *      env var, populated once by scripts/init-frameworks-store.js.
 *   2. "user-<sanitizedUserId>" — one per user. Created lazily on
 *      first access. Contains that user's report file (synced from
 *      Wix ericaPreparation) and future session-summary memory
 *      files. Lookup is stateless: we query OpenAI by name.
 *
 * State kept in-memory only (userId -> storeId, userId -> lastHash).
 * On server restart the cache repopulates lazily as users connect.
 * ---------------------------------------------------------------
 */

const OpenAI = require('openai');
const { toFile } = require('openai/uploads');
const crypto = require('crypto');

let openaiClient = null;

/** Initialise the shared OpenAI client. Call once with a fetched key. */
function initClient(apiKey) {
    if (!apiKey) throw new Error('[vectorStore] initClient: apiKey required');
    openaiClient = new OpenAI({ apiKey });
    return openaiClient;
}

function requireClient() {
    if (!openaiClient) {
        throw new Error('[vectorStore] client not initialised — call initClient(apiKey) first');
    }
    return openaiClient;
}

/** Cache of userId -> vectorStoreId (populated lazily). */
const userStoreCache = new Map();
/** Cache of userId -> sha256(lastReportText) so we skip redundant uploads. */
const userReportHashCache = new Map();

/** Turn arbitrary user identifiers into safe vector-store name suffixes. */
function sanitizeUserId(userId) {
    return String(userId || 'unknown')
        .replace(/[^\w-]/g, '_')
        .slice(0, 100);
}

/**
 * Look up a vector store by its exact name, creating it if missing.
 * Returns the store id.
 */
async function getOrCreateStoreByName(name) {
    const client = requireClient();

    // Paginate through stores. Realistic user counts stay well below the
    // first-page cap; if this ever grows we add proper pagination.
    const page = await client.vectorStores.list({ limit: 100 });
    const hit = (page.data || []).find((s) => s.name === name);
    if (hit) return hit.id;

    const created = await client.vectorStores.create({ name });
    return created.id;
}

/**
 * Resolve (or lazily create) the vector store id for a user.
 * Cached in memory after the first call.
 */
async function getUserVectorStoreId(userId) {
    if (!userId) return null;
    if (userStoreCache.has(userId)) return userStoreCache.get(userId);

    const name = `user-${sanitizeUserId(userId)}`;
    const storeId = await getOrCreateStoreByName(name);
    userStoreCache.set(userId, storeId);
    return storeId;
}

/**
 * Upload the user's current report text to their vector store, if the
 * content changed since the last sync. No-op when unchanged.
 *
 * @returns {Promise<{changed: boolean, storeId?: string, fileId?: string, reason?: string}>}
 */
async function syncUserReport(userId, reportText) {
    if (!userId || !reportText || !reportText.trim()) {
        return { changed: false, reason: 'missing userId or empty report' };
    }
    const client = requireClient();

    const hash = crypto.createHash('sha256').update(reportText).digest('hex');
    if (userReportHashCache.get(userId) === hash) {
        return { changed: false, reason: 'hash unchanged' };
    }

    const storeId = await getUserVectorStoreId(userId);
    const filename = `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;

    // Purge previous report files from this user's store BEFORE attaching the
    // new one. Without this, every sync accumulates historical report versions
    // (including pre-extractor uploads with full system-prompt boilerplate)
    // which pollute retrieval scores. We only keep "report-*" and "memory-*"
    // shaped files — session memory files (memory-*) survive; only reports
    // rotate. Errors are logged but non-fatal.
    let purgedCount = 0;
    try {
        const existing = await client.vectorStores.files.list(storeId, { limit: 100 });
        for (const f of existing.data || []) {
            // The list endpoint returns VectorStoreFile objects; we need the
            // filename via a separate files.retrieve call to filter by prefix.
            let name = '';
            try {
                const meta = await client.files.retrieve(f.id);
                name = meta?.filename || '';
            } catch (_) { /* ignore */ }

            if (!name.startsWith('report-')) continue; // keep memory-* etc.

            try {
                await client.vectorStores.files.delete(f.id, { vector_store_id: storeId });
                try { await client.files.delete(f.id); } catch (_) { /* orphan cleanup best-effort */ }
                purgedCount++;
            } catch (_) { /* ignore individual delete failures */ }
        }
    } catch (e) {
        // Do not block the sync on cleanup failures — worst case, retrieval
        // has a stale file for one more turn.
    }

    const file = await client.files.create({
        file: await toFile(Buffer.from(reportText, 'utf8'), filename, { type: 'text/markdown' }),
        purpose: 'assistants'
    });

    await client.vectorStores.files.create(storeId, { file_id: file.id });

    userReportHashCache.set(userId, hash);
    return { changed: true, storeId, fileId: file.id, filename, purgedCount };
}

/**
 * Upload a session summary as a "memory" file to the user's store.
 * Used by the session-end curator (future).
 */
async function saveSessionMemory(userId, summaryText, metadata = {}) {
    if (!userId || !summaryText || !summaryText.trim()) {
        return { saved: false, reason: 'missing userId or empty summary' };
    }
    const client = requireClient();
    const storeId = await getUserVectorStoreId(userId);
    const filename = `memory-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;

    const header = [
        '# Session Memory',
        '',
        `- Date: ${new Date().toISOString()}`,
        ...Object.entries(metadata).map(([k, v]) => `- ${k}: ${v}`),
        '',
        '---',
        ''
    ].join('\n');

    const file = await client.files.create({
        file: await toFile(Buffer.from(header + summaryText, 'utf8'), filename, { type: 'text/markdown' }),
        purpose: 'assistants'
    });
    await client.vectorStores.files.create(storeId, { file_id: file.id });
    return { saved: true, storeId, fileId: file.id, filename };
}

/**
 * Run a knowledge search across the requested scope, returning the
 * retrieved chunks and a synthesized answer.
 *
 * @param {object} opts
 * @param {string} opts.query       Natural-language question
 * @param {string} opts.scope       'frameworks' | 'user_data' | 'all'
 * @param {string} [opts.userId]    Required when scope includes user_data
 * @param {string} [opts.model]     Override the synthesis model
 * @param {number} [opts.maxResults]  file_search cap (default 5)
 * @returns {Promise<{chunks: Array, answer: string|null, vectorStoreIds: string[]}>}
 */
async function searchKnowledge({ query, scope = 'all', userId = null, model, maxResults = 5 }) {
    if (!query || !query.trim()) {
        return { chunks: [], answer: null, vectorStoreIds: [], reason: 'empty query' };
    }
    const client = requireClient();

    const vectorStoreIds = [];
    const wantFrameworks = scope === 'frameworks' || scope === 'all';
    const wantUserData = scope === 'user_data' || scope === 'all';

    if (wantFrameworks && process.env.FRAMEWORKS_STORE_ID) {
        vectorStoreIds.push(process.env.FRAMEWORKS_STORE_ID);
    }
    if (wantUserData && userId) {
        const uid = await getUserVectorStoreId(userId);
        if (uid) vectorStoreIds.push(uid);
    }

    if (vectorStoreIds.length === 0) {
        return { chunks: [], answer: null, vectorStoreIds: [], reason: 'no stores available for scope' };
    }

    const searchModel = model || process.env.KNOWLEDGE_SEARCH_MODEL || 'gpt-4.1-mini';

    const response = await client.responses.create({
        model: searchModel,
        input: query,
        tools: [{
            type: 'file_search',
            vector_store_ids: vectorStoreIds,
            max_num_results: maxResults
        }],
        include: ['file_search_call.results']
    });

    const chunks = [];
    let answer = null;

    for (const item of response.output || []) {
        if (item.type === 'file_search_call' && Array.isArray(item.results)) {
            for (const r of item.results) {
                const text = Array.isArray(r.content)
                    ? r.content.map((c) => c.text || '').join('\n')
                    : (r.text || '');
                chunks.push({
                    filename: r.filename,
                    score: r.score,
                    text: text.slice(0, 1500) // clip long chunks for transport efficiency
                });
            }
        }
        if (item.type === 'message' && Array.isArray(item.content)) {
            answer = item.content
                .filter((c) => c.type === 'output_text' || c.type === 'text')
                .map((c) => c.text || '')
                .join('\n')
                .trim();
        }
    }

    return { chunks, answer, vectorStoreIds };
}

/**
 * Deep-think reasoning call. Invokes a reasoning-first model (o4-mini by
 * default) to think step-by-step about a question and return a structured
 * response. This is the "camera-behind-the-curtain" the admin panel will
 * visualise later.
 *
 * @param {object} opts
 * @param {string} opts.query    The user's question, restated fully.
 * @param {string} [opts.context] Optional grounding material (chunks from
 *                                search_knowledge, user history summary).
 * @param {string} [opts.model]  Override the reasoning model.
 * @returns {Promise<{reasoning: string|null, answer: string, model: string, raw?: object}>}
 */
async function deepThink({ query, context = '', model } = {}) {
    if (!query || !query.trim()) {
        return { reasoning: null, answer: '', model: null, reason: 'empty query' };
    }
    const client = requireClient();
    const reasoningModel = model || process.env.DEEP_THINK_MODEL || 'o4-mini';

    const systemPrompt = [
        'You are a reasoning specialist supporting a life and career coach.',
        'The coach has a user question and needs careful thinking to inform a good coaching response.',
        '',
        'Your job:',
        '1. Reason step-by-step through what the user actually needs (emotionally + practically).',
        '2. Consider psychological safety, coaching best practices, and any grounding material provided.',
        '3. Return a JSON object with exactly two keys:',
        '   - "reasoning": your step-by-step thought process (2-5 short paragraphs, plain text)',
        '   - "answer":    a concise, ready-to-deliver coaching response (2-4 sentences, warm tone)',
        '',
        'Do NOT recite framework text verbatim.',
        'Do NOT mention that you are a reasoning specialist or a separate model.',
        'Return ONLY the JSON object, no code fences, no prose before or after.'
    ].join('\n');

    const userMessage = context && context.trim()
        ? `User question:\n${query}\n\nGrounding context (do not quote verbatim, only use to inform reasoning):\n${context}`
        : `User question:\n${query}`;

    const response = await client.responses.create({
        model: reasoningModel,
        input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
        ],
        reasoning: { effort: 'medium' }
    });

    // Gather the text output and any reasoning summary the model emitted.
    let outputText = '';
    let reasoningTrace = '';
    for (const item of response.output || []) {
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
                if (c.type === 'output_text' || c.type === 'text') {
                    outputText += (c.text || '');
                }
            }
        }
        if (item.type === 'reasoning' && Array.isArray(item.summary)) {
            reasoningTrace += item.summary.map((s) => s.text || '').join('\n');
        }
    }

    // Model was asked for a JSON blob. Try to parse; fall back to raw text.
    let parsedReasoning = null;
    let parsedAnswer = null;
    try {
        const cleaned = outputText.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        const obj = JSON.parse(cleaned);
        if (obj && typeof obj === 'object') {
            if (typeof obj.reasoning === 'string') parsedReasoning = obj.reasoning;
            if (typeof obj.answer === 'string') parsedAnswer = obj.answer;
        }
    } catch (_) {
        // Not JSON — that's fine, we still have raw output as answer fallback.
    }

    return {
        reasoning: parsedReasoning || reasoningTrace || null,
        answer: parsedAnswer || outputText.trim(),
        model: reasoningModel
    };
}

module.exports = {
    initClient,
    getOrCreateStoreByName,
    getUserVectorStoreId,
    syncUserReport,
    saveSessionMemory,
    searchKnowledge,
    deepThink,
    // exposed for tests / diagnostics
    _cache: { userStoreCache, userReportHashCache }
};
