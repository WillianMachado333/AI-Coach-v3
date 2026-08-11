// Simple HTTP server for development
// Run with: node server.js
// Then open: http://localhost:8000

// Load environment variables from .env file
// Use __dirname so the correct .env is always found next to server.js,
// regardless of what directory the process was launched from.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// AI-Coach-v3: OpenAI Vector Store helpers for knowledge-search
const vectorStore = require('./lib/vectorStore');
const activity = require('./lib/activity');
// Coach Studio admin — /admin/* login + protected pages (Phase 0 foundation).
const admin = require('./lib/admin');
// Session logger — persists Erica sessions for the Coach Studio observatory.
const sessionLog = require('./lib/sessionLog');
const studioAgent = require('./lib/studioAgent');
const genSessions = require('./lib/genSessions');
const attachments = require('./lib/attachments');
const metrics = require('./lib/metrics');
const simulator = require('./lib/simulator');
const agentHistory = require('./lib/agentHistory');
const runtimeConfig = require('./lib/runtimeConfig');
const injectedDataStore = require('./lib/injectedDataStore');

/**
 * Fire-and-forget helper that extracts the user report body from an
 * ericaPreparation JSON response and uploads it to the user's vector store.
 *
 * Hash-cached in vectorStore.syncUserReport, so calling this on every
 * preparation fetch is safe — repeats are no-ops when content hasn't
 * changed. Does NOT throw; failures log a warning and are swallowed so
 * the client-facing response is never affected.
 */
function syncPreparationToVectorStore(userId, prepJsonText) {
    if (!userId || !prepJsonText) return;

    let parsed;
    try {
        parsed = JSON.parse(prepJsonText);
    } catch (e) {
        logAt('warn', '[SERVER] syncPreparationToVectorStore - could not parse prep response:', e?.message);
        return;
    }

    const message = typeof parsed?.message === 'string' ? parsed.message : '';
    if (!message || message.length < 500) {
        logAt('debug', '[SERVER] syncPreparationToVectorStore - message too short or missing, skipping');
        return;
    }

    // Extract the USER-SPECIFIC portion. The ericaPreparation message is
    // mostly generic boilerplate (Talent Transformation prompt, off-topic
    // handling, resource rules) with the user's actual quiz results / report
    // content interleaved. Uploading the whole thing pollutes retrieval with
    // system-prompt chunks that get returned instead of real user data.
    //
    // Strategy: locate the first quiz/report marker and keep everything from
    // there onward. Fall back to a positional cut if no marker is found.
    const userSpecific = extractUserSpecificReport(message);
    if (!userSpecific || userSpecific.length < 200) {
        logAt('debug', '[SERVER] syncPreparationToVectorStore - no user-specific body found, skipping');
        return;
    }

    // Fire-and-forget — do not await, do not throw. Sync typically finishes
    // in a few seconds; the client already has its response by then.
    Promise.resolve()
        .then(() => vectorStore.syncUserReport(userId, userSpecific))
        .then((res) => {
            if (res.changed) {
                logAt('info', '[SERVER] ✅ user report synced', {
                    userId,
                    storeId: res.storeId,
                    fileId: res.fileId,
                    bytes: userSpecific.length,
                    originalBytes: message.length,
                    trimmedRatio: (userSpecific.length / message.length).toFixed(2)
                });
            } else {
                logAt('debug', '[SERVER] user report sync skipped:', res.reason);
            }
        })
        .catch((err) => {
            logAt('warn', '[SERVER] ⚠️ user report sync failed:', err?.message || err);
        });
}

/**
 * Take a preparation response body (JSON text) and prepend the three
 * canonical Injected Data blocks (courses / quizzes / safety rules) plus
 * a short usage directive to its `customInstructions` field.
 *
 * The prep response is sometimes wrapped: `{ data: <string of JSON> }` or
 * top-level JSON depending on the upstream. We handle both.
 *
 * Idempotent: strips any previously injected block before re-injecting so
 * repeated boots don't stack.
 *
 * Returns the mutated JSON string. If parsing fails, returns the original
 * body unchanged — never take down the preparation path over this.
 */
const CANONICAL_MARKER_START = '=== CANONICAL LISTS (hard data — never invent) ===';
const CANONICAL_MARKER_END = '=== END CANONICAL LISTS ===';
function injectCanonicalBlocksIntoPrep(bodyText) {
    if (typeof bodyText !== 'string' || !bodyText.trim()) return bodyText;
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch (_) { return bodyText; }

    const coursesBlock = injectedDataStore.computeSystemPromptBlock('canonical-courses');
    const quizzesBlock = injectedDataStore.computeSystemPromptBlock('canonical-quizzes');
    const safetyBlock = injectedDataStore.computeSystemPromptBlock('safety-rules');
    if (!coursesBlock && !quizzesBlock && !safetyBlock) return bodyText;

    // Directive supersedes the older Wix preamble line that says "Do not
    // provide URLs to resources" — that predates the canonical lists, and
    // now that we have vetted names + URLs the coach should cite them.
    const parts = [CANONICAL_MARKER_START,
        'The lists below are the ONLY canonical source for course / quiz names',
        'and URLs. This SUPERSEDES any earlier instruction that says "do not',
        'provide URLs" — the URLs in this list are vetted, approved resources.',
        'When you cite one:',
        '- Use the exact name and URL from this list — never invent.',
        '- If a row has an empty URL, cite the name only and say you can share',
        '  the link once it is configured (do not fabricate a URL).',
        '- Only recommend an item when it clearly fits the user\'s goal, skill',
        '  or current situation — do not suggest items just because they exist.',
        '',
        coursesBlock,
        quizzesBlock,
        safetyBlock,
        CANONICAL_MARKER_END
    ].filter(Boolean).join('\n');

    // The Wix preparation exposes the system prompt in the `message` field
    // (10k+ chars of persona guidance + rules). Client reads it as
    // customInstructions. We patch `message` on the top-level object; some
    // response shapes wrap the payload in a `data` string, so walk both.
    const FIELDS = ['message', 'customInstructions'];
    function tryPatchObject(obj) {
        if (!obj || typeof obj !== 'object') return false;
        for (const field of FIELDS) {
            if (typeof obj[field] === 'string') {
                let stripped = obj[field].replace(
                    new RegExp('\\n?' + CANONICAL_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        + '[\\s\\S]*?' + CANONICAL_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g'),
                    ''
                );
                obj[field] = parts + '\n\n' + stripped;
                return true;
            }
        }
        return false;
    }
    let patched = tryPatchObject(parsed);
    if (!patched && parsed && typeof parsed.data === 'string') {
        try {
            const inner = JSON.parse(parsed.data);
            if (tryPatchObject(inner)) {
                parsed.data = JSON.stringify(inner);
                patched = true;
            }
        } catch (_) { /* leave as-is */ }
    }
    if (!patched) return bodyText;
    return JSON.stringify(parsed);
}

/**
 * Fire-and-forget helper that pulls this user's activity from CleverTap (with
 * cache), indexes it as a markdown timeline in their vector store, and logs
 * the outcome. Called from the preparation handler for both cache-hit and
 * cache-miss paths so activity refreshes independently of the prep cache.
 */
function syncActivityForSession(userId, objectId) {
    if (!userId && !objectId) return;
    const identifier = userId || objectId;
    const identifierType = userId ? 'userId' : 'objectId';

    Promise.resolve()
        .then(() => activity.getActivityHistory({ identifier, identifierType }))
        .then((result) => {
            if (!result || !result.events || result.events.length === 0) {
                logAt('debug', '[SERVER] activity sync: no events', { identifierType, identifier });
                return null;
            }
            logAt('info', '[SERVER] ✅ activity fetched', {
                identifierType,
                cached: result.cached,
                delta: result.delta,
                total: result.events.length
            });
            // Push the fresh timeline into the vector store so search_knowledge
            // (scope=user_data) can retrieve activity chunks alongside the
            // quiz report.
            return vectorStore.syncUserActivity({
                identifier,
                identifierType,
                markdown: result.markdown
            });
        })
        .then((vsRes) => {
            if (vsRes && vsRes.changed) {
                logAt('info', '[SERVER] ✅ activity indexed to vector store', {
                    storeId: vsRes.storeId,
                    fileId: vsRes.fileId,
                    purgedCount: vsRes.purgedCount
                });
            }
        })
        .catch((err) => {
            logAt('warn', '[SERVER] ⚠️ activity sync failed:', err?.message || err);
        });
}

/**
 * Extract the user-specific portion of an ericaPreparation `message` string.
 * Looks for well-known markers that reliably indicate the start of user data
 * (quiz report URLs, "This user has taken..." lines, name/goals footer).
 * If none match, falls back to skipping the first ~2500 chars of boilerplate.
 */
function extractUserSpecificReport(message) {
    if (!message) return '';

    // Markers we've observed in real preparation responses that flag the
    // transition from generic prompt to user-specific content.
    const markers = [
        /Report:\s*https?:\/\//i,                          // "Quiz X Report: https://..."
        /This user has taken/i,                            // Positive assessment marker
        /This is a list of quizzes this user has not taken/i, // Metadata footer
        /\n[A-Z][^\n]*Quiz\s*\n/,                          // "Something Quiz" section header
        /^Thge user Name is|^The user Name is/im,          // Name marker (typos in source preserved)
        /The user selected the following goals/i           // Goals marker
    ];

    let earliestIndex = -1;
    for (const re of markers) {
        const m = message.match(re);
        if (m && (earliestIndex === -1 || m.index < earliestIndex)) {
            earliestIndex = m.index;
        }
    }

    if (earliestIndex > 0) {
        // Wrap with a small header so retrieval snippets have anchoring context
        const header = '# User-Specific Report\n\nThe following content is drawn from this user\'s assessment reports and profile metadata. Use it to inform coaching responses.\n\n---\n\n';
        return header + message.slice(earliestIndex).trim();
    }

    // Fallback: no marker found, skip generic prompt boilerplate positionally
    if (message.length > 3000) {
        const header = '# User-Specific Report (positional fallback)\n\n---\n\n';
        return header + message.slice(2500).trim();
    }

    // Message is short and has no markers — probably guest/empty. Skip.
    return '';
}

const PORT = process.env.PORT || 8002;

// ---- Logging helpers ----
// Keep logs readable by default; allow turning on noisier logs when investigating.
// ERICA_LOG_LEVEL: "silent" | "error" | "warn" | "info" | "debug"
const ERICA_LOG_LEVEL = (process.env.ERICA_LOG_LEVEL || 'info').toLowerCase();
const ERICA_LOG_ALL_REQUESTS = String(process.env.ERICA_LOG_ALL_REQUESTS || '').toLowerCase() === 'true';
const ERICA_DEBUG_HISTORY = String(process.env.ERICA_DEBUG_HISTORY || '').toLowerCase() === 'true';

const levelOrder = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const currentLevel = levelOrder[ERICA_LOG_LEVEL] ?? levelOrder.info;
function logAt(level, ...args) {
    if ((levelOrder[level] ?? 999) <= currentLevel) {
        // eslint-disable-next-line no-console
        console[level](...args);
    }
}
function makeReqId(prefix = 'req') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function safePreview(str, maxLen = 220) {
    if (typeof str !== 'string') return '';
    const s = str.replace(/\s+/g, ' ').trim();
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

// ---- OpenAI Realtime model selection ----
// GA API model names (beta names like 'gpt-realtime-mini' no longer work).
// Examples:
//   ERICA_REALTIME_MODEL=gpt-4o-realtime
//   REALTIME_MODEL=gpt-4o-mini-realtime
const REALTIME_MODEL =
    process.env.ERICA_REALTIME_MODEL ||
    process.env.REALTIME_MODEL ||
    'gpt-realtime';

// ---- Preview TTS cache (filesystem) ----
const PREVIEW_TTS_CACHE_DIR =
    process.env.ERICA_PREVIEW_TTS_CACHE_DIR ||
    path.join(__dirname, 'preview_cache');
const PREVIEW_TTS_CACHE_TTL_MS =
    Number(process.env.ERICA_PREVIEW_TTS_CACHE_TTL_MS) ||
    7 * 24 * 60 * 60 * 1000; // 7 days

function ensurePreviewCacheDir() {
    try {
        if (!fs.existsSync(PREVIEW_TTS_CACHE_DIR)) {
            fs.mkdirSync(PREVIEW_TTS_CACHE_DIR, { recursive: true });
        }
    } catch (err) {
        console.warn('[SERVER] preview cache dir error:', err?.message || err);
    }
}

function buildPreviewCacheKey({ model, voice, text, instructions, format }) {
    const hash = crypto.createHash('sha256');
    hash.update(String(model || ''));
    hash.update('|');
    hash.update(String(voice || ''));
    hash.update('|');
    hash.update(String(format || ''));
    hash.update('|');
    hash.update(String(text || ''));
    hash.update('|');
    hash.update(String(instructions || ''));
    return hash.digest('hex');
}

function getPreviewCachePath(key) {
    return path.join(PREVIEW_TTS_CACHE_DIR, `${key}.mp3`);
}

// Store OpenAI API key fetched from external service
let openAIKey = null;
let openAISecondaryKey = null;

// Handle OpenAI web search call
function handleSearch(query, apiKey, res) {
    const https = require('https');

    // Responses API format - use models that support web_search
    // gpt-4.1 and gpt-5.1 support web_search (gpt-5.1 needs reasoning_effort: 'none')
    // Allow overriding via environment variables for cost/quality tuning
    const webSearchModel =
        process.env.ERICA_WEBSEARCH_MODEL ||
        process.env.WEBSEARCH_MODEL ||
        'gpt-4.1'; // default

    const requestData = JSON.stringify({
        model: webSearchModel,  // configurable web_search model
        input: query,
        tools: [
            {
                type: 'web_search',
                external_web_access: true  // Enable live web access
            }
        ],
        tool_choice: 'auto'
    });

    // Validate JSON is valid
    try {
        JSON.parse(requestData);
    } catch (e) {
        console.error('[SERVER] /api/search - Invalid JSON generated:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to generate valid JSON request' }));
        return;
    }

    console.log('[SERVER] /api/search - Calling OpenAI Responses API');

    const requestBuffer = Buffer.from(requestData, 'utf8');

    const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/responses',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': requestBuffer.length,
            'OpenAI-Beta': 'responses=v1'  // May be required for Responses API
        }
    };

    const openaiReq = https.request(options, (openaiRes) => {
        let responseData = '';

        openaiRes.on('data', (chunk) => {
            responseData += chunk;
        });

        openaiRes.on('end', () => {
            console.log('[SERVER] /api/search - OpenAI response status:', openaiRes.statusCode);

            if (openaiRes.statusCode !== 200) {
                console.error('[SERVER] /api/search - OpenAI API error status:', openaiRes.statusCode);
                res.writeHead(openaiRes.statusCode, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(responseData);
                return;
            }

            try {
                const openaiResult = JSON.parse(responseData);

                // Extract the response content from Responses API
                // Structure: output[] -> message -> content[] -> output_text -> text
                let content = '';

                try {
                    if (openaiResult.output && Array.isArray(openaiResult.output)) {
                        for (const item of openaiResult.output) {
                            if (item.type === 'message' && item.content && Array.isArray(item.content)) {
                                for (const part of item.content) {
                                    // Responses API may use either output_text.text or type/text
                                    if (part.output_text && part.output_text.text) {
                                        content = part.output_text.text;
                                        break;
                                    }
                                    if (part.type === 'output_text' && part.text) {
                                        content = part.text;
                                        break;
                                    }
                                }
                            }
                            if (content) break;
                        }
                    }
                } catch (extractErr) {
                    console.warn('[SERVER] /api/search - Could not extract content:', extractErr);
                }

                if (!content && openaiResult.output_text) {
                    content = openaiResult.output_text;
                }

                if (!content && openaiResult.text) {
                    content = openaiResult.text;
                }

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({
                    answer: content,
                    content: content,
                    raw: openaiResult
                }));
            } catch (parseError) {
                console.error('[SERVER] /api/search - Error parsing OpenAI response:', parseError);
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: 'Failed to parse OpenAI response' }));
            }
        });
    });

    openaiReq.on('error', (error) => {
        console.error('[SERVER] /api/search - OpenAI request error:', error);
        res.writeHead(500, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: 'Failed to reach OpenAI Web Search', details: error.message }));
    });

    // Write request body and end
    openaiReq.write(requestBuffer);
    openaiReq.end();
}

// Load OpenAI key from OPENAI_API_KEY env var. This function used to fall
// back to a Wix endpoint with a hard-coded shared password — that endpoint
// + password were exposed in this public repo and have been removed. If
// the env var is missing, we fail loudly instead of reaching for a
// legacy credential.
function fetchOpenAIKey() {
    return new Promise((resolve, reject) => {
        if (!process.env.OPENAI_API_KEY) {
            const msg = 'OPENAI_API_KEY not set. Configure it on Railway (or in .env for local) — the legacy Wix key-fetch has been removed for security.';
            console.error('[SERVER]', msg);
            return reject(new Error(msg));
        }
        openAIKey = process.env.OPENAI_API_KEY;
        openAISecondaryKey = process.env.OPENAI_SECONDARY_KEY || openAIKey;
        try {
            vectorStore.initClient(openAIKey);
            studioAgent.setClient(vectorStore.getClientOrNull());
            simulator.setClient(vectorStore.getClientOrNull());
            genSessions.setClient(vectorStore.getClientOrNull());
            console.log('[SERVER] OpenAI key loaded from OPENAI_API_KEY env var; clients initialised');
        } catch (vsErr) {
            console.warn('[SERVER] vectorStore init failed:', vsErr?.message || vsErr);
        }
        resolve({ openAIkey: openAIKey, openAISecondarykey: openAISecondaryKey });
    });
}

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.woff': 'application/font-woff',
    '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'application/font-otf',
    '.wasm': 'application/wasm'
};

// === External API host (sandbox / production) ===
// All calls to the Wix backend use this single host variable.
// Production: talenttransformation.com  |  Sandbox: awav.com
// Override via env var:  ERICA_API_HOST=awav.com
const ERICA_API_HOST = process.env.ERICA_API_HOST || process.env.PREP_HOST || 'talenttransformation.com';
const ERICA_API_ORIGIN = `https://www.${ERICA_API_HOST}`;

// === Preparation response cache (server-side) ===
// Cache guest preparation responses to reduce Wix API load and improve speed
const PREP_CACHE_GUEST_TTL_MS = Number(process.env.ERICA_PREP_GUEST_TTL_MS) || 24 * 60 * 60 * 1000; // 24 hours default
const PREP_CACHE_AUTH_TTL_MS = Number(process.env.ERICA_PREP_AUTH_TTL_MS) || 2 * 60 * 1000; // 2 minutes default
const prepCache = new Map(); // key -> { ts: number, data: string, statusCode: number, headers: object }

// Helper to get cache key from request
function getPrepCacheKey(userId, email) {
    if (userId) return `user:${userId}`;
    if (email) return `email:${email}`;
    return '__guest__';
}

// Individual paths (rarely need overriding, but supported)
const PREP_PATH = process.env.PREP_PATH || '/_functions/ericaPreparation';

const server = http.createServer(async (req, res) => {
    // Avoid spamming logs for static assets; focus on API requests.
    const isApi = typeof req.url === 'string' && req.url.startsWith('/api/');
    if (ERICA_LOG_ALL_REQUESTS || isApi) {
        logAt('info', `${req.method} ${req.url}`);
    }

    // Coach Studio admin routes: /admin/* (login, protected pages, JSON
    // endpoints). Handled by lib/admin.js — if it takes the request, we
    // return; otherwise fall through to the rest of the server.
    if (typeof req.url === 'string' && req.url.startsWith('/admin')) {
        try {
            const handled = await admin.handle(req, res);
            if (handled) return;
        } catch (e) {
            console.error('[SERVER] admin.handle error:', e?.message || e);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Admin error');
            }
            return;
        }
    }

    // Session logger ingestion — the client posts turn events here so the
    // Coach Studio observatory (/admin/sessions) can replay them.
    // POST /api/session-log  body: { sessionId, kind, ... }
    //   kind='user_turn'  { text }
    //   kind='bot_turn'   { text, promptSnapshot? }
    //   kind='tool_call'  { name, args, result, error, ms }
    //   kind='event'      { name, meta }
    if (req.url === '/api/session-log' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', () => {
            try {
                const p = body ? JSON.parse(body) : {};
                const sid = p.sessionId;
                if (!sid) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'sessionId required' }));
                    return;
                }
                let promptHash = null;
                if (typeof p.promptSnapshot === 'string' && p.promptSnapshot.length) {
                    promptHash = sessionLog.savePromptSnapshot(p.promptSnapshot);
                } else if (typeof p.promptHash === 'string') {
                    promptHash = p.promptHash;
                }
                switch (p.kind) {
                    case 'user_turn':
                        sessionLog.logUserTurn(sid, { text: p.text, promptHash, meta: p.meta });
                        break;
                    case 'bot_turn':
                        sessionLog.logBotTurn(sid, { text: p.text, promptHash, meta: p.meta });
                        break;
                    case 'tool_call':
                        sessionLog.logToolCall(sid, {
                            name: p.name, args: p.args, result: p.result, error: p.error, ms: p.ms
                        });
                        break;
                    case 'event':
                    default:
                        sessionLog.logEvent(sid, { name: p.name || p.kind, meta: p.meta });
                        // Also feed the prompt-budget analyzer so the admin
                        // home surfaces the exact chars of the last live
                        // session's system prompt breakdown, not just an
                        // estimate.
                        if ((p.name || p.kind) === 'prompt_breakdown' && p.meta && typeof p.meta === 'object') {
                            try {
                                runtimeConfig; // ensure module already loaded
                                const promptBudget = require('./lib/promptBudget');
                                promptBudget.recordBreakdown({
                                    // The id maps to a framework file on disk, so
                                    // the analyzer can read the persona markdown
                                    // directly. Label kept separately for display.
                                    persona: p.meta.personaId || p.meta.persona || null,
                                    personaLabel: p.meta.personaLabel || p.meta.persona || null,
                                    blocks: p.meta.blocks || {},
                                    session: { sessionId: sid, at: new Date().toISOString() }
                                });
                            } catch (err) {
                                console.warn('[SERVER] prompt_breakdown record failed:', err?.message || err);
                            }
                        }
                        break;
                }
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ ok: true, promptHash }));
            } catch (e) {
                console.error('[SERVER] /api/session-log error:', e?.message || e);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e?.message || 'Internal error' }));
            }
        });
        return;
    }

    // Export: assemble a text blob (metrics + top sessions) for the given
    // window, prefixed with the known DATA PITFALLS so whoever the operator
    // pastes this into (ChatGPT, Claude) inherits the caveats — PADROES 1B.7.
    if (req.url.split('?')[0] === '/api/admin/export' && req.method === 'GET') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        try {
            const parsed = new URL(req.url, 'http://x');
            const days = Math.min(30, Math.max(1, parseInt(parsed.searchParams.get('days') || '1', 10)));
            const format = parsed.searchParams.get('format') === 'md' ? 'md' : 'txt';
            const includeTesters = parsed.searchParams.get('include_testers') === '1';
            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
            const m = metrics.compute({ since, includeTesters });
            const sessionLog = require('./lib/sessionLog');
            const rows = sessionLog.listSessions({
                tester: includeTesters ? 'all' : 'exclude',
                limit: 20
            }).filter((s) => new Date(s.lastAt || s.startedAt).getTime() >= Date.now() - days * 24 * 60 * 60 * 1000);
            const preamble = [
                '=== READ ME FIRST — KNOWN PITFALLS OF THIS DATA ===',
                '',
                '1. STORE_MESSAGE_TEXT is currently "' + (process.env.STORE_MESSAGE_TEXT || 'redacted') + '".',
                '   When redacted, user text is stored as a SHA hash — you can count turns',
                '   but you CANNOT read what the user said. Bot text is stored in full.',
                '',
                '2. Testers vs real users. Emails matching "@' + (process.env.TESTER_INTERNAL_DOMAINS || 'talenttransformation.com') + '"',
                '   or containing the markers "' + (process.env.TESTER_EMAIL_MARKERS || '+demo,+test,+qa') + '" are flagged',
                '   as testers. This export ' + (includeTesters ? 'INCLUDES' : 'EXCLUDES') + ' them.',
                '',
                '3. Turns are NOT people. A session with 12 turns is one conversation.',
                '   Do not sum turns to estimate audience size.',
                '',
                '4. Sessions of caller="synthetic" were generated by scripts/gen-synthetic-sessions.js',
                '   to seed the observatory — they are model-produced coach text, not real coaching.',
                '',
                '5. Sample sizes below ~5 sessions are not statistically informative;',
                '   treat any percentage over such a base as illustrative only.',
                '',
                '6. Tool failures listed below are ACTUAL model tool calls that returned an error,',
                '   NOT infra failures. A failed tool call may still have produced a useful answer.',
                '',
                '=== SUMMARY ===',
                '',
                'Window: last ' + days + ' day(s), ending ' + new Date().toISOString(),
                'Testers: ' + (includeTesters ? 'included' : 'excluded'),
                '',
                'Volume:',
                '  24h: ' + m.volume.last24h.sessions + ' sessions, ' + m.volume.last24h.turns + ' turns, ' + m.volume.last24h.tools + ' tool calls',
                '  7d:  ' + m.volume.last7d.sessions + ' sessions, ' + m.volume.last7d.turns + ' turns, ' + m.volume.last7d.tools + ' tool calls',
                '  30d: ' + m.volume.last30d.sessions + ' sessions, ' + m.volume.last30d.turns + ' turns, ' + m.volume.last30d.tools + ' tool calls',
                '',
                'Quality signals:',
                '  Rage close (short session ending on user): ' + m.qualitySignals.rageClose,
                '  Long silence (>90s gap between turns): ' + m.qualitySignals.longSilenceCount,
                '  Tool failure sessions: ' + m.qualitySignals.toolFailureCount,
                '',
                'Top tool usage (all-time, aggregated):',
                // metrics.compute() returns toolUsage as a sorted array of
                // [name, count] tuples — iterate it directly. (Old code did
                // Object.entries on the array, producing numeric-keyed rows
                // like "- 0: my-tool,3 calls" in the export.)
                ...(Array.isArray(m.toolUsage) ? m.toolUsage : Object.entries(m.toolUsage || {})).slice(0, 8).map(([n, c]) => {
                    const errArr = Array.isArray(m.toolErrors) ? m.toolErrors : Object.entries(m.toolErrors || {});
                    const errRow = errArr.find((r) => r[0] === n);
                    const err = errRow ? errRow[1] : 0;
                    return '  - ' + n + ': ' + c + ' calls' + (err ? ' (' + err + ' errors)' : '');
                }),
                '',
                '=== RECENT SESSIONS (up to 20 within window) ===',
                '',
                ...rows.map((s) => [
                    '- ' + s.sessionId + ' (' + s.turns + ' turns, ' + (s.actor?.tester ? 'TESTER — ' : '') + (s.actor?.email || s.actor?.userId || s.actor?.objectId || 'guest') + ')',
                    '  started: ' + s.startedAt,
                    '  last:    ' + s.lastAt
                ].join('\n')),
                '',
                '=== END EXPORT ==='
            ].join('\n');
            const filename = 'coach-studio-export-' + days + 'd-' + new Date().toISOString().slice(0, 10) + '.txt';
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': 'attachment; filename="' + filename + '"'
            });
            res.end(preamble);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e?.message || 'export failed' }));
        }
        return;
    }

    // Attachment GET — serve a stored image by its opaque id so the message
    // bubble can render <img src="/api/admin/attachments/{id}"> without
    // reloading the payload. Admin-only.
    if (req.url.startsWith('/api/admin/attachments/') && req.method === 'GET') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        const id = decodeURIComponent(req.url.slice('/api/admin/attachments/'.length).split('?')[0]);
        const rec = attachments.load(id);
        if (!rec) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': rec.contentType,
            'Content-Length': rec.buffer.length,
            'Cache-Control': 'private, max-age=3600'
        });
        res.end(rec.buffer);
        return;
    }

    // Attachment upload — used by the Coach Studio composer for pasted
    // screenshots. Body: { dataUrl } (base64-encoded image data URL). Server
    // validates by magic bytes, caps size after decoding, stores on the
    // Railway volume, returns { id, contentType, bytes }.
    if (req.url === '/api/admin/attachments' && req.method === 'POST') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        let body = '';
        req.on('data', (c) => {
            body += c.toString();
            // Cap the raw POST body at 8MB (base64 inflation is ~33%,
            // so 8MB base64 ~ 6MB decoded, well over our 4MB decoded cap).
            if (body.length > 8 * 1024 * 1024) { req.destroy(); }
        });
        req.on('end', () => {
            try {
                const p = body ? JSON.parse(body) : {};
                const dataUrl = String(p.dataUrl || '');
                const m = dataUrl.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i);
                if (!m) throw new Error('bad or missing dataUrl');
                const buf = Buffer.from(m[2], 'base64');
                const rec = attachments.saveDecoded(buf);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(rec));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e?.message || 'upload failed' }));
            }
        });
        req.on('error', () => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'upload aborted' }));
        });
        return;
    }

    // Studio agent — SSE streaming variant. Body: { message, page, attachments? }.
    // Server owns history: rebuilds context from disk instead of trusting
    // the client. Client sends only the new message. Attachments referenced
    // by id are pulled from the volume and passed inline as data URLs.
    if (req.url === '/api/admin/agent' && req.method === 'POST') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', async () => {
            let p = {};
            try { p = body ? JSON.parse(body) : {}; } catch (_) { /* defaults */ }
            const originalUserText = String(p.message || '').trim();
            let userMessage = originalUserText;
            const page = typeof p.page === 'string' ? p.page : null;
            const attachmentIds = Array.isArray(p.attachments) ? p.attachments.slice(0, 3) : [];
            const attachmentsForModel = [];
            for (const aid of attachmentIds) {
                const url = attachments.dataUrl(aid);
                if (url) attachmentsForModel.push({ id: aid, dataUrl: url });
            }
            const ALLOWED_MARKER_TYPES = ['chart', 'model_sentence', 'number', 'quote', 'text'];
            const marker = (p.marker && typeof p.marker.text === 'string' && p.marker.text.trim())
                ? {
                    text: p.marker.text.trim().slice(0, 800),
                    source: p.marker.source || null,
                    type: ALLOWED_MARKER_TYPES.includes(p.marker.type) ? p.marker.type : 'text'
                }
                : null;
            if (marker) {
                const typeLabel = {
                    chart: 'CHART',
                    model_sentence: 'MODEL-GENERATED SENTENCE',
                    number: 'NUMBER',
                    quote: 'USER QUOTE',
                    text: 'PLAIN TEXT'
                }[marker.type] || 'TEXT';
                userMessage = 'MARKED IN THE REPORT [type=' + typeLabel + ', from ' + (marker.source || 'unknown page') + ']:\n"' + marker.text + '"\n\n' + userMessage;
            }
            if (!userMessage) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'message required' }));
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            const send = (evt) => {
                try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch (_) {}
            };
            // Ensure OpenAI client is up (external key service may have been
            // down at boot). One retry per request; if it still fails, surface
            // the error to the UI instead of silently returning "not initialised".
            if (!openAIKey) {
                try { await fetchOpenAIKey(); } catch (_) { /* handled below */ }
            }
            if (!openAIKey) {
                send({ type: 'error', message: 'OpenAI key unavailable — external key service unreachable. Retry in a moment.' });
                try { res.end(); } catch (_) {}
                return;
            }
            // Rebuild context from persisted history on disk.
            const history = agentHistory.rebuildInput(sess.sub);
            let finalText = '';
            const wrappedSend = (evt) => {
                if (evt && evt.type === 'done' && typeof evt.text === 'string') finalText = evt.text;
                send(evt);
            };
            try {
                await studioAgent.runTurnStreamed(
                    { history, userMessage, page, attachments: attachmentsForModel },
                    wrappedSend
                );
                // Persist the turn AFTER the model completed so a failure
                // mid-stream doesn't leave a half-answer in the log.
                if (finalText) {
                    agentHistory.append(sess.sub, {
                        question: originalUserText,
                        marker: marker || null,
                        answer: finalText,
                        page,
                        attachments: attachmentsForModel.map((a) => a.id)
                    });
                }
            } catch (e) {
                send({ type: 'error', message: e?.message || 'agent failure' });
            } finally {
                try { res.end(); } catch (_) {}
            }
        });
        return;
    }

    // Suggest 3 follow-up prompts after the last turn — separate cheap call.
    if (req.url === '/api/admin/agent/suggestions' && req.method === 'POST') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', async () => {
            try {
                if (!openAIKey) {
                    try { await fetchOpenAIKey(); } catch (_) { /* handled below */ }
                }
                if (!openAIKey) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ suggestions: [] }));
                    return;
                }
                const p = body ? JSON.parse(body) : {};
                const items = agentHistory.readAll(sess.sub, { limit: 4 });
                const last = items[items.length - 1] || null;
                const suggestions = await studioAgent.suggestFollowups({
                    lastQuestion: last?.question || null,
                    lastAnswer: last?.answer || p.lastAnswer || null
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ suggestions }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e?.message || 'suggestions failed' }));
            }
        });
        return;
    }

    // Load previously-persisted turns for the current actor (page load).
    if (req.url.split('?')[0] === '/api/admin/agent/history' && req.method === 'GET') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        const items = agentHistory.readAll(sess.sub, { limit: 40 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
        return;
    }

    // Dev: rebuild the shared "courses-shared" vector store from the on-disk
    // knowledge-base/courses/ tree. Streams SSE progress. Prints the store id
    // to set as COURSES_STORE_ID. Admin-only.
    if (req.url.split('?')[0] === '/api/admin/dev/init-courses-store' && req.method === 'POST') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        const send = (evt) => { try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch (_) {} };
        (async () => {
            try {
                if (!openAIKey) { try { await fetchOpenAIKey(); } catch (_) {} }
                if (!openAIKey) { send({ type: 'error', message: 'OpenAI key unavailable' }); return; }
                // Reuse the client vectorStore already initialised with.
                const OpenAI = require('openai');
                const client = new OpenAI({ apiKey: openAIKey });
                const path = require('path');
                const fs = require('fs');
                const { toFile } = require('openai/uploads');
                const COURSES_DIR = path.join(__dirname, 'knowledge-base', 'courses');
                const COURSES_OVERLAY_DIR = process.env.COURSES_OVERLAY_DIR || '/data/courses';
                const QUIZZES_DIR = path.join(__dirname, 'knowledge-base', 'quizzes');
                const QUIZZES_OVERLAY_DIR = process.env.QUIZZES_OVERLAY_DIR || '/data/quizzes';
                // Collect all .md files from BOTH courses AND quizzes, defaults
                // and overlays. Overlay wins on collision. Relative path is
                // prefixed with 'courses/' or 'quizzes/' so filenames are unique
                // in the vector store.
                function walkMd(root, prefix) {
                    const out = [];
                    if (!fs.existsSync(root)) return out;
                    function walk(dir) {
                        for (const name of fs.readdirSync(dir)) {
                            const full = path.join(dir, name);
                            const stat = fs.statSync(full);
                            if (stat.isDirectory()) walk(full);
                            else if (name.endsWith('.md')) {
                                out.push({ full, relative: prefix + '/' + path.relative(root, full).replace(/\\/g, '/') });
                            }
                        }
                    }
                    walk(root);
                    return out;
                }
                const STORE_NAME = 'courses-shared';
                const byRel = new Map();
                for (const f of walkMd(COURSES_DIR, 'courses')) byRel.set(f.relative, f);
                for (const f of walkMd(COURSES_OVERLAY_DIR, 'courses')) byRel.set(f.relative, f);
                for (const f of walkMd(QUIZZES_DIR, 'quizzes')) byRel.set(f.relative, f);
                for (const f of walkMd(QUIZZES_OVERLAY_DIR, 'quizzes')) byRel.set(f.relative, f);
                const files = Array.from(byRel.values()).sort((a, b) => a.relative.localeCompare(b.relative)).map((x) => x.full);
                if (files.length === 0) {
                    send({ type: 'error', message: 'no course files on disk — build them first' });
                    return;
                }
                send({ type: 'start', count: files.length });
                const page = await client.vectorStores.list({ limit: 100 });
                let store = (page.data || []).find((s) => s.name === STORE_NAME);
                if (store) send({ type: 'log', text: 'reusing store ' + store.id });
                else { store = await client.vectorStores.create({ name: STORE_NAME }); send({ type: 'log', text: 'created store ' + store.id }); }
                let existing = await client.vectorStores.files.list(store.id, { limit: 100 });
                let purged = 0;
                for (const f of existing.data || []) {
                    try {
                        await client.vectorStores.files.delete(f.id, { vector_store_id: store.id });
                        try { await client.files.delete(f.id); } catch (_) {}
                        purged++;
                    } catch (_) {}
                }
                if (purged > 0) send({ type: 'log', text: 'purged ' + purged + ' old files' });
                let i = 0;
                const merged = Array.from(byRel.entries()).sort((a, b) => a[0].localeCompare(b[0]));
                for (const [relative, meta] of merged) {
                    const content = fs.readFileSync(meta.full, 'utf8');
                    const file = await client.files.create({
                        file: await toFile(Buffer.from(content, 'utf8'), relative, { type: 'text/markdown' }),
                        purpose: 'assistants'
                    });
                    await client.vectorStores.files.create(store.id, { file_id: file.id });
                    i++;
                    send({ type: 'file', i, total: merged.length, relative });
                }
                const start = Date.now();
                while (Date.now() - start < 60000) {
                    const s = await client.vectorStores.retrieve(store.id);
                    const c = s.file_counts || {};
                    if (c.in_progress === 0) { send({ type: 'indexed', completed: c.completed, failed: c.failed }); break; }
                    await new Promise((r) => setTimeout(r, 1500));
                }
                send({ type: 'done', storeId: store.id, hint: 'Set COURSES_STORE_ID=' + store.id + ' on Railway and redeploy.' });
            } catch (e) {
                send({ type: 'error', message: e?.message || 'init failed' });
            } finally {
                try { res.end(); } catch (_) {}
            }
        })();
        return;
    }

    // Dev: generate N synthetic sessions using the server's own OpenAI key.
    // Streams SSE progress events. Admin-only. Idempotent-ish (each run adds
    // fresh sessions with new IDs).
    if (req.url.split('?')[0] === '/api/admin/dev/gen-sessions' && req.method === 'POST') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        const parsed = new URL(req.url, 'http://x');
        const count = Math.min(100, Math.max(1, parseInt(parsed.searchParams.get('count') || '30', 10)));
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        const send = (evt) => { try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch (_) {} };
        (async () => {
            if (!openAIKey) {
                try { await fetchOpenAIKey(); } catch (_) {}
            }
            if (!openAIKey) {
                send({ type: 'error', message: 'OpenAI key unavailable' });
                try { res.end(); } catch (_) {}
                return;
            }
            try {
                await genSessions.run({ count }, send);
            } catch (e) {
                send({ type: 'error', message: e?.message || 'generation failed' });
            } finally {
                try { res.end(); } catch (_) {}
            }
        })();
        return;
    }

    // Purge empty sessions — drops every session on disk that has zero turns
    // and zero tool calls (session_start only). Handy after a failed run of
    // gen-sessions so the observatory doesn't fill up with placeholders.
    if (req.url.split('?')[0] === '/api/admin/dev/purge-empty-sessions' && req.method === 'POST') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        try {
            const fs = require('fs');
            const path = require('path');
            const dir = process.env.SESSION_DATA_DIR || '/data/sessions';
            let deleted = 0, kept = 0;
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.ndjson')) continue;
                const p = path.join(dir, f);
                const raw = fs.readFileSync(p, 'utf8');
                let hasTurn = false;
                for (const ln of raw.split('\n')) {
                    if (!ln.trim()) continue;
                    try {
                        const obj = JSON.parse(ln);
                        if (obj.type === 'turn' || obj.type === 'tool_call') { hasTurn = true; break; }
                    } catch (_) { /* skip bad line */ }
                }
                if (!hasTurn) {
                    try { fs.unlinkSync(p); deleted++; } catch (_) {}
                } else {
                    kept++;
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ deleted, kept }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e?.message || 'purge failed' }));
        }
        return;
    }

    // Clear the actor's conversation history. Also drops any attachments the
    // cleared turns referenced (PADROES 2.21 — apagar conversa apaga o que
    // ela carregava).
    if (req.url.split('?')[0] === '/api/admin/agent/history' && req.method === 'DELETE') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        try {
            const items = agentHistory.readAll(sess.sub, { limit: 10000 });
            let removed = 0;
            for (const it of items) {
                const ids = Array.isArray(it?.attachments) ? it.attachments : [];
                for (const aid of ids) { if (attachments.remove(aid)) removed++; }
            }
            if (removed) console.log('[admin] cleared ' + removed + ' attachments for ' + sess.sub);
        } catch (e) { console.warn('[admin] attachment cleanup failed:', e?.message || e); }
        agentHistory.clear(sess.sub);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // Studio agent chat — protected by admin cookie. Client posts
    // { history: [...], message: '...' }, we run one agent turn and return
    // { text, history } to be echoed back on the next call.
    if (req.url === '/api/admin/studio-chat' && req.method === 'POST') {
        const session = admin.requireAdminSession(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', async () => {
            try {
                const p = body ? JSON.parse(body) : {};
                const userMessage = String(p.message || '').trim();
                if (!userMessage) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'message required' }));
                    return;
                }
                const history = Array.isArray(p.history) ? p.history : [];
                const page = typeof p.page === 'string' ? p.page : null;
                const started = Date.now();
                const out = await studioAgent.runTurn({ history, userMessage, page });
                console.log('[SERVER] /api/admin/studio-chat ->', {
                    ms: Date.now() - started, textLen: (out.text || '').length, historyLen: out.history.length
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(out));
            } catch (e) {
                console.error('[SERVER] /api/admin/studio-chat error:', e?.message || e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e?.message || 'Internal error' }));
            }
        });
        return;
    }

    // Simulator — admin-only. body: { personaName, guardrails, extraDirective,
    // userMessage, priorTurns?, replaySessionId?, replayTurnIndex? }
    // If replaySessionId+replayTurnIndex are provided, we prefill userMessage
    // and priorTurns from that session (if not redacted).
    if (req.url === '/api/admin/simulate' && req.method === 'POST') {
        const session = admin.requireAdminSession(req);
        if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', async () => {
            try {
                const p = body ? JSON.parse(body) : {};
                let userMessage = p.userMessage;
                let priorTurns = Array.isArray(p.priorTurns) ? p.priorTurns : [];
                let originalResponse = null;
                if (p.replaySessionId && Number.isFinite(p.replayTurnIndex)) {
                    const rep = simulator.extractReplayableTurn(p.replaySessionId, p.replayTurnIndex);
                    if (rep.error) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: rep.error, replay: rep }));
                        return;
                    }
                    userMessage = rep.userMessage;
                    priorTurns = rep.priorTurns;
                    originalResponse = rep.originalResponse;
                }
                const out = await simulator.simulate({
                    personaName: p.personaName || 'Erica',
                    guardrails: p.guardrails || '',
                    extraDirective: p.extraDirective || '',
                    userMessage,
                    priorTurns
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, simulated: out, originalResponse, userMessage }));
            } catch (e) {
                console.error('[SERVER] /api/admin/simulate error:', e?.message || e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e?.message || 'Internal error' }));
            }
        });
        return;
    }

    // Simulator: coach presets — one entry per coaching framework file so the
    // operator picks "Supportive" / "Directive" / etc and the guardrails
    // textarea auto-fills with real production framework text.
    if (req.url === '/api/admin/simulator/presets' && req.method === 'GET') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        const contentStore = require('./lib/contentStore');
        const names = contentStore.listFrameworks();
        const presets = names.map((n) => {
            const r = contentStore.readFramework(n);
            return { id: n, name: n, source: r?.source || 'default', guardrails: r?.text || '' };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ presets }));
        return;
    }

    // Simulator: seed candidates — recent real (non-tester, non-synthetic)
    // sessions with their first user turn text as a seed for simulations.
    if (req.url.startsWith('/api/admin/simulator/seeds') && req.method === 'GET') {
        const sess = admin.requireAdminSession(req);
        if (!sess) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        const sessionLog = require('./lib/sessionLog');
        const parsed = new URL(req.url, 'http://x');
        const limit = Math.min(40, Math.max(1, parseInt(parsed.searchParams.get('limit') || '15', 10)));
        const list = sessionLog.listSessions({ tester: 'exclude', limit: 200 });
        const seeds = [];
        for (const row of list) {
            if (seeds.length >= limit) break;
            if (row.actor?.caller === 'synthetic') continue;
            const data = sessionLog.readSession(row.sessionId);
            if (!data) continue;
            const firstUser = data.entries.find((e) => e.type === 'turn' && e.role === 'user' && e.text);
            if (!firstUser) continue;
            const text = typeof firstUser.text === 'string'
                ? firstUser.text
                : (firstUser.text?.redacted ? null : (firstUser.text?.text || null));
            if (!text || text.length < 8) continue;
            seeds.push({
                sessionId: row.sessionId,
                actor: row.actor?.email || row.actor?.userId || row.actor?.objectId || 'guest',
                turns: row.turns,
                startedAt: row.startedAt,
                seed: text.slice(0, 400)
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ seeds }));
        return;
    }

    // Real multi-turn simulator — runs a conversation of `maxTurns` turns
    // between a fake user persona and the coach persona, streaming each
    // turn as it lands via SSE.
    if (req.url === '/api/admin/simulate-conversation' && req.method === 'POST') {
        const sessCheck = admin.requireAdminSession(req);
        if (!sessCheck) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            return;
        }
        let body = '';
        req.on('data', (c) => { body += c.toString(); });
        req.on('end', async () => {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            const send = (evt) => { try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch (_) {} };
            try {
                if (!openAIKey) { try { await fetchOpenAIKey(); } catch (_) {} }
                if (!openAIKey) { send({ type: 'error', message: 'OpenAI key unavailable' }); return; }
                const p = body ? JSON.parse(body) : {};
                await simulator.simulateConversation({
                    coach: {
                        name: p.coachName || 'Erica',
                        guardrails: p.guardrails || '',
                        extraDirective: p.extraDirective || ''
                    },
                    userPersona: p.userPersona || '',
                    seedMessage: p.seedMessage || '',
                    priorTranscript: Array.isArray(p.priorTranscript) ? p.priorTranscript : [],
                    maxTurns: Math.min(20, Math.max(2, parseInt(p.maxTurns, 10) || 8))
                }, send);
            } catch (e) {
                send({ type: 'error', message: e?.message || 'simulation failed' });
            } finally {
                try { res.end(); } catch (_) {}
            }
        });
        return;
    }

    // Handle web search API requests
    if (req.url.startsWith('/api/search')) {
        logAt('info', '[SERVER] /api/search request received:', req.url);

        const url = new URL(req.url, `http://${req.headers.host}`);
        let query = url.searchParams.get('q');
        let apiKey = null;

        // If no query in URL, try to read POST body JSON { query: "...", apiKey?: "..." }
        if (!query && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    if (body && body.trim() !== '') {
                        const parsed = JSON.parse(body);
                        if (!query && parsed.query) query = parsed.query;
                        // Do not accept API keys from the client
                    }
                } catch (e) {
                    console.warn('[SERVER] /api/search - Failed to parse body JSON:', e);
                }

                // Fall back to server-fetched key if none provided
                if (!apiKey && openAIKey) {
                    apiKey = openAIKey;
                    console.log('[SERVER] /api/search - Using server-fetched OpenAI key');
                }

                logAt('debug', '[SERVER] /api/search - Query extracted:', query);

                if (!query) {
                    console.warn('[SERVER] /api/search - No query provided');
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Search query is required' }));
                    return;
                }

                if (!apiKey) {
                    console.warn('[SERVER] /api/search - Server OpenAI key not available');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'OpenAI key not available on server' }));
                    return;
                }

                // proceed with OpenAI call below using query/apiKey
                handleSearch(query, apiKey, res);
            });
            req.on('error', (err) => {
                console.error('[SERVER] /api/search - Request stream error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read request body' }));
            });
            return; // stop further processing; will continue in handler
        }

        // Fall back to server-fetched key if none provided
        if (!apiKey && openAIKey) {
            apiKey = openAIKey;
            logAt('debug', '[SERVER] /api/search - Using server-fetched OpenAI key');
        }

        logAt('debug', '[SERVER] /api/search - Query extracted:', query);

        if (!query) {
            console.warn('[SERVER] /api/search - No query provided');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Search query is required' }));
            return;
        }

        if (!apiKey) {
            console.warn('[SERVER] /api/search - Server OpenAI key not available');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'OpenAI key not available on server' }));
            return;
        }

        // proceed with OpenAI call using query/apiKey
        handleSearch(query, apiKey, res);
        return;
    }

    // Handle helpful resources fetch
    if (req.url.startsWith('/api/helpful-resources')) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        let query = url.searchParams.get('q') || '';
        let type = url.searchParams.get('type') || '';
        let limit = Number.parseInt(url.searchParams.get('limit') || '', 10);

        if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const finalize = () => {
            const filePath = path.join(__dirname, 'resources', 'Helpful_Resources_content.json');
            fs.readFile(filePath, 'utf8', (error, content) => {
                if (error) {
                    console.error('[SERVER] /api/helpful-resources - File read error:', error);
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'Failed to read resources file' }));
                    return;
                }

                try {
                    const parsed = JSON.parse(content);
                    const items = Array.isArray(parsed) ? parsed : [];
                    const normalizedQuery = query.trim().toLowerCase();
                    const normalizedType = type.trim().toLowerCase();
                    const maxLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 10;

                    const filtered = items.filter((item) => {
                        if (!item || typeof item !== 'object') return false;
                        const itemType = String(item.type || '').toLowerCase();
                        if (normalizedType && itemType !== normalizedType) return false;
                        if (!normalizedQuery) return true;
                        const haystack = [
                            item.Name,
                            item.description,
                            item.type,
                            item.link
                        ]
                            .filter(Boolean)
                            .map((value) => String(value).toLowerCase())
                            .join(' ');
                        return haystack.includes(normalizedQuery);
                    });

                    const limited = filtered.slice(0, maxLimit);

                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({
                        items: limited,
                        total: items.length,
                        filtered: filtered.length,
                        limit: maxLimit
                    }));
                } catch (parseError) {
                    console.error('[SERVER] /api/helpful-resources - JSON parse error:', parseError);
                    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'Failed to parse resources file' }));
                }
            });
        };

        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    if (body && body.trim() !== '') {
                        const parsed = JSON.parse(body);
                        if (typeof parsed.query === 'string') query = parsed.query;
                        if (typeof parsed.q === 'string') query = parsed.q;
                        if (typeof parsed.type === 'string') type = parsed.type;
                        if (Number.isFinite(parsed.limit)) limit = parsed.limit;
                    }
                } catch (e) {
                    console.warn('[SERVER] /api/helpful-resources - Failed to parse body JSON:', e);
                }
                finalize();
            });
            req.on('error', (err) => {
                console.error('[SERVER] /api/helpful-resources - Request stream error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Failed to read request body' }));
            });
            return;
        }

        finalize();
        return;
    }

    // SECURITY: Never expose OpenAI keys to the browser.
    // This endpoint is disabled by default. Enable only for local debugging by setting:
    //   ALLOW_OPENAI_KEY_ENDPOINT=true
    if (req.url.startsWith('/api/openai-key')) {
        const allow = String(process.env.ALLOW_OPENAI_KEY_ENDPOINT || '').toLowerCase() === 'true';
        if (!allow) {
            res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }
        // If explicitly enabled, keep legacy behavior (still not recommended for production)
        if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }
        logAt('warn', '[SERVER] /api/openai-key - Request received (ALLOW_OPENAI_KEY_ENDPOINT=true)');
        if (!openAIKey) {
            try {
                fetchOpenAIKey().catch(() => { });
            } catch (_) { }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ openAIkey: openAIKey, openAISecondarykey: openAISecondaryKey }));
        return;
    }

    // Handle summarization requests
    if (req.url.startsWith('/api/summarize')) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            // Basic parsing
            let messages = [];
            try {
                const parsed = JSON.parse(body);
                messages = parsed.messages || [];
            } catch (e) {
                console.warn('[SERVER] /api/summarize - Failed to parse body:', e);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                return;
            }

            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No messages provided to summarize' }));
                return;
            }

            // Ensure we have an API key
            if (!openAIKey) {
                // Try to fetch? relying on periodic fetch usually, but let's just fail fast or wait.
                // Ideally openAIKey is already set by startup or prior requests.
                console.warn('[SERVER] /api/summarize - No OpenAI key available');
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Server not ready (OpenAI key missing)' }));
                return;
            }

            // Call OpenAI for summarization
            const https = require('https');
            const summarySystemPrompt = "You are a helpful assistant. Summarize the following conversation messages into a detailed and comprehensive summary (2-3 paragraphs). Retain all key facts, user preferences, specific details, and important context for a future AI interaction. Do not be too brief; ensure that nuanced information is preserved so the AI does not lose context.";

            // Convert messages to a string block for the prompt to save complexity, or pass as chat messages
            // passing as chat messages is cleaner.
            const apiMessages = [
                { role: "system", content: summarySystemPrompt },
                { role: "user", content: JSON.stringify(messages) }
            ];

            const requestData = JSON.stringify({
                model: "gpt-4o-mini", // Cost-effective model for summarization
                messages: apiMessages,
                temperature: 0.5,
                max_tokens: 1000
            });

            const options = {
                hostname: 'api.openai.com',
                port: 443,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${openAIKey}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestData)
                }
            };

            const openaiReq = https.request(options, (openaiRes) => {
                let responseData = '';
                openaiRes.on('data', chunk => { responseData += chunk; });
                openaiRes.on('end', () => {
                    if (openaiRes.statusCode !== 200) {
                        console.error('[SERVER] /api/summarize - OpenAI error:', openaiRes.statusCode, responseData);
                        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ error: 'Upstream summarization failed' }));
                        return;
                    }

                    try {
                        const result = JSON.parse(responseData);
                        const summary = result.choices?.[0]?.message?.content || null;

                        if (!summary) {
                            throw new Error('No content in OpenAI response');
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ summary }));

                    } catch (e) {
                        console.error('[SERVER] /api/summarize - Parse error:', e);
                        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ error: 'Failed to process summary' }));
                    }
                });
            });

            openaiReq.on('error', (e) => {
                console.error('[SERVER] /api/summarize - Request exception:', e);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Internal server error during summarization' }));
            });

            openaiReq.write(requestData);
            openaiReq.end();
        });
        return;
    }

    // Handle knowledge-search (AI-Coach-v3 grounding pipeline)
    // POST body: { query: string, scope?: 'frameworks'|'user_data'|'all', userId?: string }
    // Returns:   { chunks: [...], answer: string, vectorStoreIds: [...] }
    if (req.url.startsWith('/api/knowledge-search')) {
        logAt('info', '[SERVER] /api/knowledge-search - Request received:', req.method);

        if (req.method !== 'POST') {
            res.writeHead(405, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const requestData = body ? JSON.parse(body) : {};
                const query = String(requestData.query || '').trim();
                const scope = String(requestData.scope || 'all');
                const userId = requestData.userId ? String(requestData.userId) : null;
                const objectId = requestData.objectId ? String(requestData.objectId) : null;

                if (!query) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'query is required' }));
                    return;
                }

                logAt('info', '[SERVER] /api/knowledge-search -', { scope, userId, objectId, queryPreview: safePreview(query, 120) });

                const result = await vectorStore.searchKnowledge({ query, scope, userId, objectId });

                logAt('info', '[SERVER] /api/knowledge-search -> chunks:', result.chunks.length, 'stores:', result.vectorStoreIds.length);

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[SERVER] /api/knowledge-search error:', e?.message || e);
                const isNotReady = /not initialised/i.test(e?.message || '');
                res.writeHead(isNotReady ? 503 : 500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: e?.message || 'Internal error' }));
            }
        });
        return;
    }

    // Debug endpoint — one-shot introspection of everything Erica has for a
    // given user: activity events, vector store contents (file names +
    // previews), preparation cache size. Deliberately GET so Willian can
    // just paste it in a browser tab.
    // GET /api/debug/user?userId=X   or   ?objectId=Y
    if (req.url.startsWith('/api/debug/user')) {
        (async () => {
            try {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const userId = url.searchParams.get('userId') || null;
                const objectId = url.searchParams.get('objectId') || null;
                if (!userId && !objectId) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'userId or objectId required' }));
                    return;
                }
                const identifier = userId || objectId;
                const identifierType = userId ? 'userId' : 'objectId';

                const [activityResult, storeInfo] = await Promise.all([
                    activity.getActivityHistory({ identifier, identifierType }).catch((e) => ({ error: e?.message || String(e) })),
                    (async () => {
                        try {
                            const storeKey = identifierType === 'objectId' ? `guest-${identifier}` : identifier;
                            const storeId = await vectorStore.getUserVectorStoreId(storeKey);
                            if (!storeId) return { storeKey, storeId: null, files: [] };
                            const files = await vectorStore.listUserStoreFiles(storeId).catch(() => []);
                            return { storeKey, storeId, files };
                        } catch (e) {
                            return { error: e?.message || String(e) };
                        }
                    })()
                ]);

                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({
                    identifier,
                    identifierType,
                    activity: activityResult && activityResult.events
                        ? {
                            eventsCount: activityResult.events.length,
                            events: activityResult.events,
                            markdown: activityResult.markdown,
                            meta: activityResult.meta
                        }
                        : activityResult,
                    vectorStore: storeInfo
                }, null, 2));
            } catch (e) {
                console.error('[SERVER] /api/debug/user error:', e?.message || e);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e?.message || 'Internal error' }));
            }
        })();
        return;
    }

    // Handle user activity history fetch (Fase C.2)
    // POST body: { userId?: string, objectId?: string }
    // Returns:   { events: [...], meta: {...}, cached: N, delta: N }
    //
    // Uses cache-first strategy: reads the on-disk timeline for this
    // identifier, fetches delta from CleverTap since the last known event,
    // merges + persists, and returns the full timeline.
    if (req.url.startsWith('/api/user-activity')) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const requestData = body ? JSON.parse(body) : {};
                const userId = requestData.userId;
                const objectId = requestData.objectId;

                if (!userId && !objectId) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'userId or objectId required' }));
                    return;
                }

                const identifier = userId || objectId;
                const identifierType = userId ? 'userId' : 'objectId';

                const result = await activity.getActivityHistory({ identifier, identifierType });

                logAt('info', '[SERVER] /api/user-activity ->', {
                    identifierType,
                    cached: result.cached,
                    delta: result.delta,
                    total: result.events.length
                });

                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({
                    events: result.events,
                    meta: result.meta,
                    cached: result.cached,
                    delta: result.delta
                }));

                // Also index the fresh timeline into the vector store so
                // search_knowledge (scope=user_data) can find activity chunks.
                // Fire-and-forget after the response has been sent.
                if (result.events.length > 0) {
                    vectorStore.syncUserActivity({
                        identifier,
                        identifierType,
                        markdown: result.markdown
                    })
                        .then((vsRes) => {
                            if (vsRes && vsRes.changed) {
                                logAt('info', '[SERVER] ✅ activity indexed to vector store', {
                                    storeId: vsRes.storeId,
                                    fileId: vsRes.fileId,
                                    purgedCount: vsRes.purgedCount
                                });
                            }
                        })
                        .catch((err) => {
                            logAt('warn', '[SERVER] ⚠️ activity vector-store sync failed:', err?.message || err);
                        });
                }
            } catch (e) {
                console.error('[SERVER] /api/user-activity error:', e?.message || e);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e?.message || 'Internal error' }));
            }
        });
        return;
    }

    // Handle follow-up suggestions (dynamic quick-action pills)
    // POST body: { messages: [...], persona?: string }
    // Returns:   { suggestions: string[], model: string }
    if (req.url.startsWith('/api/suggest-followups')) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const requestData = body ? JSON.parse(body) : {};
                const messages = Array.isArray(requestData.messages) ? requestData.messages : [];
                const persona = String(requestData.persona || '');
                // Optional live activity context so starter pills reference
                // what the user actually just did (and continuation pills can
                // ground back into telemetry when relevant).
                const activity = typeof requestData.activity === 'string' ? requestData.activity : null;

                const result = await vectorStore.suggestFollowUps({ messages, persona, activity });

                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[SERVER] /api/suggest-followups error:', e?.message || e);
                const isNotReady = /not initialised/i.test(e?.message || '');
                res.writeHead(isNotReady ? 503 : 500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: e?.message || 'Internal error' }));
            }
        });
        return;
    }

    // Handle deep-think reasoning (AI-Coach-v3 reasoning layer)
    // POST body: { query: string, context?: string }
    // Returns:   { reasoning, answer, model }
    if (req.url.startsWith('/api/deep-think')) {
        logAt('info', '[SERVER] /api/deep-think - Request received:', req.method);

        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const requestData = body ? JSON.parse(body) : {};
                const query = String(requestData.query || '').trim();
                const context = String(requestData.context || '');

                if (!query) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'query is required' }));
                    return;
                }

                logAt('info', '[SERVER] /api/deep-think -', {
                    queryPreview: safePreview(query, 120),
                    contextLength: context.length
                });

                const result = await vectorStore.deepThink({ query, context });

                logAt('info', '[SERVER] /api/deep-think ->', {
                    model: result.model,
                    reasoningChars: (result.reasoning || '').length,
                    reasoningSummaryChars: (result.reasoningSummary || '').length,
                    answerChars: (result.answer || '').length
                });

                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[SERVER] /api/deep-think error:', e?.message || e);
                const isNotReady = /not initialised/i.test(e?.message || '');
                res.writeHead(isNotReady ? 503 : 500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: e?.message || 'Internal error' }));
            }
        });
        return;
    }

    // Handle Erica preparation API requests
    if (req.url.startsWith('/api/erica-preparation')) {
        logAt('info', '[SERVER] /api/erica-preparation - Request received:', req.method, req.url);

        if (req.method !== 'POST') {
            res.writeHead(405, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                logAt('debug', '[SERVER] /api/erica-preparation - Body received:', safePreview(body, 500));

                if (!body || body.trim() === '') {
                    console.error('[SERVER] /api/erica-preparation - Empty body');
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ error: 'Request body is required' }));
                    return;
                }

                const requestData = JSON.parse(body);
                console.log('[SERVER] /api/erica-preparation - Parsed data:', requestData);

                // Accept either userId (preferred) or email; allow empty (guest mode)
                const userId = requestData.userId;
                const email = requestData.email;
                // objectId (CleverTap anonymous ID) bridged from parent page for
                // guest users. When userId is absent, we use objectId to key the
                // activity cache and CleverTap query.
                const objectId = requestData.objectId;

                if (!userId && !email) {
                    console.warn('[SERVER] /api/erica-preparation - No userId/email provided; proceeding in guest mode');
                }

                // Simulator mode: coach embedded in admin simulator (?simulator=1
                // OR caller=admin-simulator). We skip CleverTap activity sync so
                // testing does not read/write anything that could pollute v2.
                const isSimulatorMode = String(requestData.caller || '').toLowerCase().includes('simulator')
                    || String(req.url || '').includes('simulator=1');

                logAt('info', '[SERVER] /api/erica-preparation - Request for:', { userId: userId || null, email: email || null, simulator: isSimulatorMode });

                // Allocate a session id for the Coach Studio observatory.
                // Deterministic on the strongest available identifier so a
                // reconnect within the same browser reuses the same file
                // instead of piling up empty NDJSONs.
                const sessionId = sessionLog.startSession({
                    email, userId, objectId,
                    caller: requestData.caller || null,
                    url: req.headers.referer || null
                });

                // Check cache first
                const cacheKey = getPrepCacheKey(userId, email);
                const cached = prepCache.get(cacheKey);
                const now = Date.now();
                const ttl = cacheKey === '__guest__' ? PREP_CACHE_GUEST_TTL_MS : PREP_CACHE_AUTH_TTL_MS;

                if (cached && (now - cached.ts) < ttl) {
                    // Cache hit - return immediately
                    logAt('info', '[SERVER] ✅ /api/erica-preparation - Cache HIT:', cacheKey, {
                        age: Math.round((now - cached.ts) / 1000) + 's',
                        ttl: Math.round(ttl / 1000) + 's'
                    });

                    const responseHeaders = {
                        'Content-Type': cached.headers['content-type'] || 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Expose-Headers': 'X-Session-Id',
                        'Cache-Control': cacheKey === '__guest__' ? 'public, max-age=86400' : 'private, max-age=120',
                        'X-Cache': 'HIT',
                        'X-Session-Id': sessionId
                    };

                    // Inject canonical Injected Data blocks (courses / quizzes /
                    // safety rules) into customInstructions before returning.
                    // Idempotent — strips prior injection so cache-hit boots
                    // pick up latest admin edits.
                    const patchedData = injectCanonicalBlocksIntoPrep(cached.data);
                    res.writeHead(cached.statusCode, responseHeaders);
                    res.end(patchedData);

                    // Best-effort sync to user's vector store. Cheap when unchanged
                    // (hash cache short-circuits). Never blocks the response.
                    if (runtimeConfig.isEnabled('user_report')) syncPreparationToVectorStore(userId, cached.data);
                    // Activity keeps its own on-disk cache so a repeated cache-hit
                    // here is still cheap. Signed-in users use userId; guest users
                    // use their bridged objectId.
                    if (!isSimulatorMode && runtimeConfig.isEnabled('activity_timeline')) syncActivityForSession(userId, objectId);
                    return;
                }

                // Cache miss - proceed with proxy
                if (cached) {
                    logAt('info', '[SERVER] ⏰ /api/erica-preparation - Cache EXPIRED:', cacheKey, {
                        age: Math.round((now - cached.ts) / 1000) + 's'
                    });
                    prepCache.delete(cacheKey);
                } else {
                    logAt('info', '[SERVER] ❌ /api/erica-preparation - Cache MISS:', cacheKey);
                }

                // Proxy to configurable preparation backend (real mode)
                const https = require('https');

                const payload = {};
                if (userId) payload.userId = userId;
                if (email) payload.email = email;

                const postData = JSON.stringify(payload);

                const options = {
                    hostname: ERICA_API_HOST,
                    port: 443,
                    path: PREP_PATH,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData, 'utf8'),
                        // Emulate a standard browser to avoid aggressive WAF/bot blocking (429s)
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Connection': 'keep-alive',
                        'Origin': ERICA_API_ORIGIN,
                        'Referer': ERICA_API_ORIGIN + '/'
                    }
                };

                logAt('info', '[SERVER] /api/erica-preparation - Proxying to:', `${options.hostname}${options.path}`);

                const externalReq = https.request(options, (externalRes) => {
                    let responseData = '';

                    externalRes.on('data', (chunk) => {
                        responseData += chunk;
                    });

                    externalRes.on('end', () => {
                        const statusCode = externalRes.statusCode || 500;

                        // FALLBACK: If upstream API returns non-200, use local fallback file
                        if (statusCode !== 200) {
                            console.warn(`[SERVER] /api/erica-preparation - Upstream returned ${statusCode}, attempting fallback...`);
                            servePrepFallback(res, cacheKey, now, ttl);
                            return;
                        }

                        // Cache successful responses (200 OK only)
                        if (statusCode === 200) {
                            prepCache.set(cacheKey, {
                                ts: now,
                                data: responseData,
                                statusCode: statusCode,
                                headers: externalRes.headers
                            });
                            logAt('info', '[SERVER] 💾 /api/erica-preparation - Cached response:', cacheKey, {
                                size: responseData.length,
                                ttl: Math.round(ttl / 1000) + 's'
                            });
                        }

                        const responseHeaders = {
                            'Content-Type': externalRes.headers['content-type'] || 'application/json',
                            'Access-Control-Allow-Origin': '*',
                            'Access-Control-Expose-Headers': 'X-Session-Id',
                            'Cache-Control': cacheKey === '__guest__' ? 'public, max-age=86400' : 'private, max-age=120',
                            'X-Cache': 'MISS',
                            'X-Session-Id': sessionId
                        };
                        // Inject canonical Injected Data blocks — same
                        // idempotent helper the cache-hit branch uses.
                        const patchedResponse = injectCanonicalBlocksIntoPrep(responseData);
                        res.writeHead(statusCode, responseHeaders);
                        res.end(patchedResponse);

                        // Best-effort sync to user's vector store (see helper above).
                        if (runtimeConfig.isEnabled('user_report')) syncPreparationToVectorStore(userId, responseData);
                        // And pull latest CleverTap activity delta, index to
                        // vector store. Uses userId when present, otherwise
                        // the guest objectId bridged from the parent page.
                        if (!isSimulatorMode && runtimeConfig.isEnabled('activity_timeline')) syncActivityForSession(userId, objectId);
                    });
                });

                externalReq.on('error', (error) => {
                    console.error('[SERVER] /api/erica-preparation - Upstream request error:', error);
                    // FALLBACK: On network error, use local fallback file
                    servePrepFallback(res, cacheKey, now, ttl);
                });

                externalReq.write(postData, 'utf8');
                externalReq.end();
            } catch (error) {
                console.error('[SERVER] /api/erica-preparation - Handler error:', error);
                // FALLBACK: On handler error, try fallback
                const cacheKeyFallback = getPrepCacheKey(req.userId, req.email);
                const ttlFallback = cacheKeyFallback === '__guest__' ? PREP_CACHE_GUEST_TTL_MS : PREP_CACHE_AUTH_TTL_MS;
                servePrepFallback(res, cacheKeyFallback, Date.now(), ttlFallback);
            }
        });

        req.on('error', (error) => {
            console.error('[SERVER] /api/erica-preparation - Request stream error:', error);
            res.writeHead(500, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: error.message }));
        });

        return;
    }

    // Helper to serve ericaPreparationFallBack.txt
    function servePrepFallback(res, cacheKey, now, ttl) {
        const fallbackPath = path.join(__dirname, 'ericaPreparationFallBack.txt');
        fs.readFile(fallbackPath, 'utf8', (err, data) => {
            if (err) {
                console.error('[SERVER] ❌ /api/erica-preparation - Fallback file error:', err.message);
                res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Service Unavailable (Upstream failed and fallback missing)' }));
                return;
            }

            console.warn('[SERVER] 🛡️ /api/erica-preparation - Serving fallback response for:', cacheKey);

            // Cache the fallback response to avoid thrashing the disk/API
            prepCache.set(cacheKey, {
                ts: now,
                data: data,
                statusCode: 200,
                headers: { 'content-type': 'application/json' }
            });

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'private, max-age=60',
                'X-Erica-Fallback': 'true',
                'X-Cache': 'MISS'
            });
            // Fallback path also gets canonical blocks — Erica still needs
            // the right names/URLs even in degraded mode.
            res.end(injectCanonicalBlocksIntoPrep(data));
        });
    }

    // Handle conversation history save API requests
    if (req.url.startsWith('/api/conversation-history-save')) {
        if (req.method !== 'POST') {
            res.writeHead(405, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const requestData = JSON.parse(body);
                const userId = requestData.userId;
                const text = requestData.text;

                if (!userId || !text) {
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ error: 'userId and text are required' }));
                    return;
                }

                const https = require('https');
                const postData = JSON.stringify({
                    userId: userId,
                    text: text
                });

                const options = {
                    hostname: ERICA_API_HOST,
                    port: 443,
                    path: '/_functions/ericaConversationHistorySave',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData, 'utf8'),
                        // Emulate a standard browser to avoid aggressive WAF/bot blocking (429s)
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Connection': 'keep-alive',
                        'Origin': ERICA_API_ORIGIN,
                        'Referer': ERICA_API_ORIGIN + '/'
                    }
                };

                const externalReq = https.request(options, (externalRes) => {
                    let responseData = '';

                    externalRes.on('data', (chunk) => {
                        responseData += chunk;
                    });

                    externalRes.on('end', () => {
                        const responseHeaders = {
                            'Content-Type': externalRes.headers['content-type'] || 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        };

                        res.writeHead(externalRes.statusCode, responseHeaders);
                        res.end(responseData);
                    });
                });

                externalReq.on('error', (error) => {
                    console.error('[SERVER] /api/conversation-history-save - Request error:', error);
                    res.writeHead(500, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ error: error.message }));
                });

                externalReq.write(postData, 'utf8');
                externalReq.end();
            } catch (error) {
                console.error('[SERVER] /api/conversation-history-save - Parse error:', error);
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: error.message }));
            }
        });

        req.on('error', (error) => {
            console.error('[SERVER] /api/conversation-history-save - Request stream error:', error);
            res.writeHead(500, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: error.message }));
        });

        return;
    }

    // Handle conversation history fetch API requests
    if (req.url.startsWith('/api/conversation-history-fetch')) {
        const reqId = makeReqId('histfetch');
        const startMs = Date.now();
        logAt('info', '[SERVER] /api/conversation-history-fetch - Request received:', { reqId, method: req.method, url: req.url });

        if (req.method !== 'POST') {
            res.writeHead(405, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                if (ERICA_DEBUG_HISTORY) {
                    logAt('debug', '[SERVER] /api/conversation-history-fetch - Body received:', safePreview(body, 400));
                }
                const requestData = JSON.parse(body);
                const userId = requestData.userId;

                if (!userId) {
                    logAt('warn', '[SERVER] /api/conversation-history-fetch - No userId in request:', { reqId });
                    res.writeHead(400, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ error: 'userId is required' }));
                    return;
                }

                if (ERICA_DEBUG_HISTORY) {
                    logAt('debug', '[SERVER] /api/conversation-history-fetch - Request for userId:', { reqId, userId });
                }

                const https = require('https');
                const postData = JSON.stringify({
                    userId: userId
                });

                const options = {
                    hostname: ERICA_API_HOST,
                    port: 443,
                    path: '/_functions/ericaConversationHistoryFetch',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData, 'utf8')
                    }
                };

                if (ERICA_DEBUG_HISTORY) {
                    logAt('debug', '[SERVER] /api/conversation-history-fetch - Proxying to:', options.hostname + options.path);
                }

                const externalReq = https.request(options, (externalRes) => {
                    let responseData = '';

                    const status = externalRes.statusCode;
                    const retryAfter = externalRes.headers?.['retry-after'] || null;
                    const rateLimit = {
                        limit: externalRes.headers?.['x-ratelimit-limit'] || null,
                        remaining: externalRes.headers?.['x-ratelimit-remaining'] || null,
                        reset: externalRes.headers?.['x-ratelimit-reset'] || null
                    };
                    if (status === 429 || ERICA_DEBUG_HISTORY) {
                        logAt('warn', '[SERVER] /api/conversation-history-fetch - External response:', {
                            reqId,
                            status,
                            retryAfter,
                            rateLimit
                        });
                    } else {
                        logAt('info', '[SERVER] /api/conversation-history-fetch - External response status:', status);
                    }

                    externalRes.on('data', (chunk) => {
                        responseData += chunk;
                    });

                    externalRes.on('end', () => {
                        const durationMs = Date.now() - startMs;
                        if (status === 429 || ERICA_DEBUG_HISTORY) {
                            logAt('warn', '[SERVER] /api/conversation-history-fetch - Completed:', {
                                reqId,
                                durationMs,
                                bytes: responseData.length,
                                responsePreview: safePreview(responseData, 260)
                            });
                        } else {
                            logAt('info', '[SERVER] /api/conversation-history-fetch - Completed:', { reqId, durationMs, bytes: responseData.length });
                        }
                        const responseHeaders = {
                            'Content-Type': externalRes.headers['content-type'] || 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        };

                        res.writeHead(externalRes.statusCode, responseHeaders);
                        res.end(responseData);
                    });
                });

                externalReq.on('error', (error) => {
                    logAt('error', '[SERVER] /api/conversation-history-fetch - Request error:', { reqId, message: error.message, code: error.code });
                    res.writeHead(500, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ error: error.message }));
                });

                externalReq.write(postData, 'utf8');
                externalReq.end();
            } catch (error) {
                logAt('error', '[SERVER] /api/conversation-history-fetch - Parse error:', { reqId, message: error.message });
                res.writeHead(500, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ error: error.message }));
            }
        });

        req.on('error', (error) => {
            logAt('error', '[SERVER] /api/conversation-history-fetch - Request stream error:', { reqId, message: error.message, code: error.code });
            res.writeHead(500, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: error.message }));
        });

        return;
    }

    // Handle TTS preview requests (mp3)
    if (req.url.startsWith('/api/preview-tts')) {
        if (req.method !== 'POST') {
            res.writeHead(405, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const text = typeof payload.text === 'string' ? payload.text.trim() : '';
                const voice = typeof payload.voice === 'string' ? payload.voice.trim() : '';
                const instructions = typeof payload.instructions === 'string' ? payload.instructions.trim() : '';

                if (!text) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'text is required' }));
                    return;
                }
                if (!voice) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'voice is required' }));
                    return;
                }

                const model = process.env.ERICA_PREVIEW_TTS_MODEL || 'gpt-4o-mini-tts';
                const format = 'mp3';
                const cacheKey = buildPreviewCacheKey({ model, voice, text, instructions, format });
                const cachePath = getPreviewCachePath(cacheKey);

                ensurePreviewCacheDir();
                try {
                    if (fs.existsSync(cachePath)) {
                        const stat = fs.statSync(cachePath);
                        const ageMs = Date.now() - stat.mtimeMs;
                        if (ageMs <= PREVIEW_TTS_CACHE_TTL_MS) {
                            res.writeHead(200, {
                                'Content-Type': 'audio/mpeg',
                                'Access-Control-Allow-Origin': '*'
                            });
                            fs.createReadStream(cachePath).pipe(res);
                            return;
                        }
                        try {
                            fs.unlinkSync(cachePath);
                        } catch (_) { }
                    }
                } catch (err) {
                    console.warn('[SERVER] /api/preview-tts - Cache check error:', err?.message || err);
                }

                const ensureKey = (cb) => {
                    if (openAIKey) return cb(openAIKey);
                    fetchOpenAIKey()
                        .then(() => cb(openAIKey))
                        .catch((err) => {
                            console.error('[SERVER] /api/preview-tts - OpenAI key not available:', err?.message || err);
                            cb(null);
                        });
                };

                ensureKey((apiKey) => {
                    if (!apiKey) {
                        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ error: 'OpenAI key not available on server' }));
                        return;
                    }

                    const https = require('https');
                    const requestBody = JSON.stringify({
                        model,
                        voice,
                        input: text,
                        format,
                        instructions: instructions || undefined
                    });

                    const options = {
                        hostname: 'api.openai.com',
                        port: 443,
                        path: '/v1/audio/speech',
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(requestBody, 'utf8')
                        }
                    };

                    const openaiReq = https.request(options, (openaiRes) => {
                        const status = openaiRes.statusCode || 500;
                        if (status !== 200) {
                            let errBody = '';
                            openaiRes.on('data', (chunk) => {
                                errBody += chunk.toString();
                            });
                            openaiRes.on('end', () => {
                                res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                                res.end(errBody || JSON.stringify({ error: 'TTS request failed' }));
                            });
                            return;
                        }

                        const chunks = [];
                        openaiRes.on('data', (chunk) => chunks.push(chunk));
                        openaiRes.on('end', () => {
                            const audioBuffer = Buffer.concat(chunks);
                            try {
                                fs.writeFile(cachePath, audioBuffer, (err) => {
                                    if (err) {
                                        console.warn('[SERVER] /api/preview-tts - Cache write failed:', err.message || err);
                                    }
                                });
                            } catch (err) {
                                console.warn('[SERVER] /api/preview-tts - Cache write error:', err?.message || err);
                            }
                            res.writeHead(200, {
                                'Content-Type': 'audio/mpeg',
                                'Access-Control-Allow-Origin': '*'
                            });
                            res.end(audioBuffer);
                        });
                    });

                    openaiReq.on('error', (error) => {
                        console.error('[SERVER] /api/preview-tts - Request error:', error);
                        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ error: error.message }));
                    });

                    openaiReq.write(requestBody, 'utf8');
                    openaiReq.end();
                });
            } catch (error) {
                console.error('[SERVER] /api/preview-tts - Parse error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });

        req.on('error', (error) => {
            console.error('[SERVER] /api/preview-tts - Request stream error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: error.message }));
        });

        return;
    }

    // Handle message quality control requests
    if (req.url.startsWith('/api/message-qc')) {
        if (req.method !== 'POST') {
            res.writeHead(405, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const text = typeof payload.text === 'string' ? payload.text : '';
                logAt('info', '[SERVER] /api/message-qc - Payload', {
                    hasText: typeof payload.text === 'string',
                    textLength: typeof payload.text === 'string' ? payload.text.length : 0
                });

                if (!text) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'text is required', hasText: typeof payload.text === 'string' }));
                    return;
                }

                const ensureKey = (cb) => {
                    if (openAIKey) return cb(openAIKey);
                    fetchOpenAIKey()
                        .then(() => cb(openAIKey))
                        .catch((err) => {
                            console.error('[SERVER] /api/message-qc - OpenAI key not available:', err?.message || err);
                            cb(null);
                        });
                };

                ensureKey((apiKey) => {
                    if (!apiKey) {
                        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ error: 'OpenAI key not available on server' }));
                        return;
                    }

                    const https = require('https');
                    const qcModel = process.env.ERICA_MESSAGE_QC_MODEL || 'gpt-4.1-mini';
                    const prompt =
                        'You are a quality control filter for assistant messages. ' +
                        'Return JSON with keys: ok (boolean), cleanedText (string), issues (array of strings). ' +
                        'Rules: remove code block/markdown formatting, fix bare URLs by adding https://, ' +
                        'remove placeholder artifacts like {coach: erica} or template tags, and remove stray JSON fragments. ' +
                        'If the message is fine, ok=true and cleanedText must match the original text exactly. ' +
                        'Respond with JSON only.';

                    const requestBody = JSON.stringify({
                        model: qcModel,
                        input: `${prompt}\n\nMessage:\n${text}`,
                        temperature: 0
                    });

                    const options = {
                        hostname: 'api.openai.com',
                        port: 443,
                        path: '/v1/responses',
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(requestBody, 'utf8'),
                            'OpenAI-Beta': 'responses=v1'
                        }
                    };

                    const openaiReq = https.request(options, (openaiRes) => {
                        let responseData = '';
                        openaiRes.on('data', (chunk) => {
                            responseData += chunk.toString();
                        });
                        openaiRes.on('end', () => {
                            if (openaiRes.statusCode !== 200) {
                                res.writeHead(openaiRes.statusCode || 500, {
                                    'Content-Type': 'application/json',
                                    'Access-Control-Allow-Origin': '*'
                                });
                                res.end(responseData || JSON.stringify({ error: 'QC request failed' }));
                                return;
                            }

                            try {
                                const openaiResult = JSON.parse(responseData);
                                let content = '';
                                if (openaiResult.output && Array.isArray(openaiResult.output)) {
                                    for (const item of openaiResult.output) {
                                        if (item.type === 'message' && item.content && Array.isArray(item.content)) {
                                            for (const part of item.content) {
                                                if (part.output_text && part.output_text.text) {
                                                    content = part.output_text.text;
                                                    break;
                                                }
                                                if (part.type === 'output_text' && part.text) {
                                                    content = part.text;
                                                    break;
                                                }
                                            }
                                        }
                                        if (content) break;
                                    }
                                }
                                if (!content && openaiResult.output_text) {
                                    content = openaiResult.output_text;
                                }
                                const parsed = JSON.parse(content);
                                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                                res.end(JSON.stringify(parsed));
                            } catch (e) {
                                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                                res.end(JSON.stringify({ ok: true, cleanedText: text, issues: ['qc_parse_failed'] }));
                            }
                        });
                    });

                    openaiReq.on('error', (error) => {
                        console.error('[SERVER] /api/message-qc - Request error:', error);
                        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                        res.end(JSON.stringify({ error: error.message }));
                    });

                    openaiReq.write(requestBody, 'utf8');
                    openaiReq.end();
                });
            } catch (error) {
                console.error('[SERVER] /api/message-qc - Parse error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });

        req.on('error', (error) => {
            console.error('[SERVER] /api/message-qc - Request stream error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: error.message }));
        });

        return;
    }

    // Handle API proxy requests — OpenAI Realtime GA API
    // GA endpoint: POST /v1/realtime/calls with FormData (sdp + session)
    // Beta endpoint (/v1/realtime with raw SDP) was shut down May 12, 2026.
    if (req.url.startsWith('/api/proxy/realtime')) {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            // Use server-held OpenAI key (never provided by client)
            let apiKey = openAIKey;
            if (!apiKey) {
                try {
                    await fetchOpenAIKey();
                    apiKey = openAIKey;
                } catch (err) {
                    console.error('[SERVER] /api/proxy/realtime - OpenAI key not available:', err?.message || err);
                }
            }
            if (!apiKey) {
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'OpenAI key not available on server' }));
                return;
            }

            try {
                // Build FormData for GA endpoint
                // Field 'sdp': raw SDP offer string (NOT Blob)
                // Field 'session': JSON-stringified session config with voice
                const voice = req.headers['x-erica-voice'] || 'marin';
                const formData = new FormData();
                formData.set('sdp', body);
                formData.set('session', JSON.stringify({
                    type: 'realtime',
                    model: REALTIME_MODEL,
                    audio: {
                        input: {
                            transcription: { model: 'whisper-1' }
                        },
                        output: { voice: voice }
                    }
                }));

                const openaiRes = await fetch('https://api.openai.com/v1/realtime/calls', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`
                        // Content-Type auto-set by FormData to multipart/form-data
                    },
                    body: formData
                });

                const responseBody = await openaiRes.text();

                if (openaiRes.status !== 200 && openaiRes.status !== 201) {
                    console.error('OpenAI API Error:', {
                        status: openaiRes.status,
                        body: responseBody.substring(0, 500)
                    });
                }

                res.writeHead(openaiRes.status, {
                    'Content-Type': openaiRes.headers.get('content-type') || 'text/plain',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, X-Erica-Voice'
                });
                res.end(responseBody);
            } catch (error) {
                console.error('Proxy error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
        return;
    }

    // Handle OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Erica-Voice'
        });
        res.end();
        return;
    }

    // Serve static files
    let filePath = '.' + req.url.split('?')[0];
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 - File Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${error.code}`, 'utf-8');
            }
        } else {
            res.writeHead(200, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*'
            });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
    console.log('Press Ctrl+C to stop the server');

    // Fetch OpenAI key on server start
    fetchOpenAIKey().catch((error) => {
        console.warn('[SERVER] Failed to fetch OpenAI key on startup. Manual key entry will be required.');
        console.warn('[SERVER] Error:', error.message);
    });
});
