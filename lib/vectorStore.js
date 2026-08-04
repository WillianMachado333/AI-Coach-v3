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

    const file = await client.files.create({
        file: await toFile(Buffer.from(reportText, 'utf8'), filename, { type: 'text/markdown' }),
        purpose: 'assistants'
    });

    await client.vectorStores.files.create(storeId, { file_id: file.id });

    userReportHashCache.set(userId, hash);
    return { changed: true, storeId, fileId: file.id, filename };
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

module.exports = {
    initClient,
    getOrCreateStoreByName,
    getUserVectorStoreId,
    syncUserReport,
    saveSessionMemory,
    searchKnowledge,
    // exposed for tests / diagnostics
    _cache: { userStoreCache, userReportHashCache }
};
