// AgentErica Routes Module
// This can be integrated into your existing Express server
// Usage: app.use('/agentErica/api', require('./agentEricaRoutes'));

const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

// === Model configuration ===
// Configure which OpenAI models to use for each task.
// These can be overridden via environment variables on the server.
//
// Voice realtime model (used for WebRTC / Realtime GA API)
// GA model names (beta names no longer work after May 12, 2026):
// - 'gpt-realtime'          (balanced)
// - 'gpt-realtime-mini'     (cheaper, lower latency)
const REALTIME_MODEL =
    process.env.ERICA_REALTIME_MODEL ||
    process.env.REALTIME_MODEL ||
    'gpt-realtime';

// Web search / tool-calling model (Responses API)
// Examples you might choose:
// - 'gpt-4.1'        (higher quality, higher cost)
// - 'gpt-4.1-mini'   (cheaper, good for many tasks)
const WEBSEARCH_MODEL =
    process.env.ERICA_WEBSEARCH_MODEL ||
    process.env.WEBSEARCH_MODEL ||
    'gpt-4.1';

/**
 * Factory – call once per route prefix to get a router bound to a specific backend host.
 *
 * @param {object} [options={}]
 * @param {string} [options.apiHost]  Wix backend host, e.g. 'awav.com' (dev) or
 *                                    'talenttransformation.com' (prod).
 *                                    Falls back to ERICA_API_HOST env var, then
 *                                    PREP_HOST, then 'talenttransformation.com'.
 *
 * Usage in node_app.js:
 *   const createAgentEricaRoutes = require('./agentEricaRoutes');
 *   app.use('/agentErica/api',     createAgentEricaRoutes({ apiHost: 'talenttransformation.com' }));
 *   app.use('/agentErica-dev/api', createAgentEricaRoutes({ apiHost: 'awav.com' }));
 */
function createRouter(options = {}) {

// === External API host (sandbox / production) ===
// Production: talenttransformation.com  |  Sandbox: awav.com
const ERICA_API_HOST = options.apiHost
    || process.env.ERICA_API_HOST
    || process.env.PREP_HOST
    || 'talenttransformation.com';
const ERICA_API_ORIGIN = `https://www.${ERICA_API_HOST}`;

console.log('[AgentErica] 🌐 External API Host configured:', ERICA_API_HOST, {
    source: options.apiHost ? 'options.apiHost' : (process.env.ERICA_API_HOST ? 'ERICA_API_HOST' : (process.env.PREP_HOST ? 'PREP_HOST' : 'default')),
    origin: ERICA_API_ORIGIN
});

const router = express.Router();

// Log all requests to this router for debugging (FIRST middleware - catches everything)
router.use((req, res, next) => {
    console.log('[AgentErica] 🔍 Router hit - ALL requests:', {
        method: req.method,
        originalUrl: req.originalUrl,
        url: req.url,
        path: req.path,
        baseUrl: req.baseUrl,
        contentType: req.headers['content-type'],
        hasBody: !!req.body,
        bodyKeys: req.body ? Object.keys(req.body) : []
    });
    // Ensure JSON content type for all responses from this router
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

// JSON body parsing middleware (must come before other middleware)
router.use(express.json());

// Middleware to allow iframe embedding and CORS (add before routes)
router.use((req, res, next) => {
    // Get origin from request
    const origin = req.headers.origin;

    // Allow iframe embedding - remove X-Frame-Options if set
    res.removeHeader('X-Frame-Options');

    // Set permissive CSP for iframe embedding (can be restricted in production)
    res.setHeader('Content-Security-Policy', "frame-ancestors *;");

    // CORS headers - allow all origins (including Wix)
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-Requested-With, X-Erica-Voice');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    next();
});

// Store OpenAI API key fetched from external service
let openAIKey = null;
let openAISecondaryKey = null;

// Function to fetch OpenAI key from external service
function fetchOpenAIKey() {
    return new Promise((resolve, reject) => {
        try {
            const postData = JSON.stringify({
                purpose: 'APPChat',
                password: 'ericaKeyPassword'
            });

            const options = {
                hostname: ERICA_API_HOST,
                port: 443,
                path: '/_functions/ericaOpenAiKey',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData, 'utf8')
                }
            };

            const req = https.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        const data = JSON.parse(responseData);
                        openAIKey = data.openAIkey;
                        openAISecondaryKey = data.openAISecondarykey;
                        resolve(data);
                    } catch (error) {
                        console.error('[AgentErica] Error parsing OpenAI key response:', error);
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                console.error('[AgentErica] Error fetching OpenAI key:', error);
                reject(error);
            });

            req.write(postData, 'utf8');
            req.end();
        } catch (error) {
            console.error('[AgentErica] Error in fetchOpenAIKey:', error);
            reject(error);
        }
    });
}

// Fetch OpenAI key on module load
fetchOpenAIKey().catch((error) => {
    console.warn('[AgentErica] Failed to fetch OpenAI key on startup. Manual key entry will be required.');
    console.warn('[AgentErica] Error:', error.message);
});

// SECURITY: Never expose OpenAI keys to the browser.
// This endpoint is disabled by default. Enable only for local debugging by setting:
//   ALLOW_OPENAI_KEY_ENDPOINT=true
router.get('/openai-key', (req, res) => {
    const allow = String(process.env.ALLOW_OPENAI_KEY_ENDPOINT || '').toLowerCase() === 'true';
    if (!allow) {
        return res.status(404).json({ error: 'Not found' });
    }
    console.log('[AgentErica] /api/openai-key - Request received (ALLOW_OPENAI_KEY_ENDPOINT=true)');
    if (openAIKey) {
        return res.json({ openAIkey: openAIKey, openAISecondarykey: openAISecondaryKey });
    }
    fetchOpenAIKey()
        .then(() => res.json({ openAIkey: openAIKey, openAISecondarykey: openAISecondaryKey }))
        .catch(() => res.status(404).json({ error: 'OpenAI key not available' }));
});

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

// POST /api/erica-preparation
router.post('/erica-preparation', (req, res) => {
    const { userId, email } = req.body || {};

    // Check cache first
    const cacheKey = getPrepCacheKey(userId, email);
    const cached = prepCache.get(cacheKey);
    const now = Date.now();
    const ttl = cacheKey === '__guest__' ? PREP_CACHE_GUEST_TTL_MS : PREP_CACHE_AUTH_TTL_MS;

    if (cached && (now - cached.ts) < ttl) {
        // Cache hit - return immediately
        console.log('[AgentErica] ✅ /api/erica-preparation - Cache HIT:', cacheKey, {
            age: Math.round((now - cached.ts) / 1000) + 's',
            ttl: Math.round(ttl / 1000) + 's'
        });

        const responseHeaders = {
            'Content-Type': cached.headers['content-type'] || 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': cacheKey === '__guest__' ? 'public, max-age=86400' : 'private, max-age=120',
            'X-Cache': 'HIT',
            'X-AgentErica-Host': ERICA_API_HOST
        };

        res.writeHead(cached.statusCode, responseHeaders);
        res.end(cached.data);
        return;
    }

    // Cache miss - proceed with proxy
    if (cached) {
        console.log('[AgentErica] ⏰ /api/erica-preparation - Cache EXPIRED:', cacheKey, {
            age: Math.round((now - cached.ts) / 1000) + 's'
        });
        prepCache.delete(cacheKey);
    } else {
        console.log('[AgentErica] ❌ /api/erica-preparation - Cache MISS:', cacheKey);
    }

    // Accept userId or email; allow guest (empty) payloads
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

    console.log('[AgentErica] 📡 /api/erica-preparation - Proxying to:', `${options.hostname}${options.path}`);

    const externalReq = https.request(options, (externalRes) => {
        let responseData = '';

        console.log('[AgentErica] /api/erica-preparation - External API response status:', externalRes.statusCode);
        console.log('[AgentErica] /api/erica-preparation - External API response headers:', externalRes.headers);

        externalRes.on('data', (chunk) => {
            responseData += chunk;
        });

        externalRes.on('end', () => {
            const statusCode = externalRes.statusCode;

            // FALLBACK: If upstream API returns non-200, use local fallback file
            if (statusCode !== 200) {
                console.warn(`[AgentErica] /api/erica-preparation - Upstream returned ${statusCode}, attempting fallback...`);
                servePrepFallback(res, cacheKey, now, ttl);
                return;
            }

            console.log('[AgentErica] /api/erica-preparation - External API response received, length:', responseData.length);
            console.log('[AgentErica] /api/erica-preparation - Response preview (first 500 chars):', responseData.substring(0, 500));

            // Try to parse and log structure for server-side debugging
            try {
                const parsed = JSON.parse(responseData);
                console.log('[AgentErica] /api/erica-preparation - Parsed response keys:', Object.keys(parsed));
                console.log('[AgentErica] /api/erica-preparation - Has ericaPreparation:', !!parsed.ericaPreparation);
                console.log('[AgentErica] /api/erica-preparation - Has preparation:', !!parsed.preparation);
                console.log('[AgentErica] /api/erica-preparation - Has instructions:', !!parsed.instructions);
                // Log the full response content
                console.log('[AgentErica] /api/erica-preparation - FULL RESPONSE:', JSON.stringify(parsed, null, 2));
            } catch (e) {
                console.log('[AgentErica] /api/erica-preparation - Response is not JSON, type:', typeof responseData);
                // Log full response even if not JSON
                console.log('[AgentErica] /api/erica-preparation - FULL RESPONSE (raw):', responseData);
            }

            // Cache successful responses (200 OK only)
            if (statusCode === 200) {
                prepCache.set(cacheKey, {
                    ts: now,
                    data: responseData,
                    statusCode,
                    headers: externalRes.headers
                });
                console.log('[AgentErica] 💾 /api/erica-preparation - Cached response:', cacheKey, {
                    size: responseData.length,
                    ttl: Math.round(ttl / 1000) + 's'
                });
            }

            const responseHeaders = {
                'Content-Type': externalRes.headers['content-type'] || 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': cacheKey === '__guest__' ? 'public, max-age=86400' : 'private, max-age=120',
                'X-Cache': 'MISS',
                'X-AgentErica-Host': ERICA_API_HOST
            };
            res.writeHead(statusCode, responseHeaders);
            res.end(responseData);
        });
    });

    externalReq.on('error', (error) => {
        console.error('[AgentErica] /api/erica-preparation - Request error:', error);
        // FALLBACK: On network error, use local fallback file
        servePrepFallback(res, cacheKey, now, ttl);
    });

    externalReq.write(postData, 'utf8');
    externalReq.end();
});

// Helper to serve ericaPreparationFallBack.txt
function servePrepFallback(res, cacheKey, now, ttl) {
    const fallbackPath = path.join(__dirname, 'ericaPreparationFallBack.txt');
    fs.readFile(fallbackPath, 'utf8', (err, data) => {
        if (err) {
            console.error('[AgentErica] ❌ /api/erica-preparation - Fallback file error:', err.message);
            res.status(503).json({ error: 'Service Unavailable (Upstream failed and fallback missing)' });
            return;
        }

        console.warn('[AgentErica] 🛡️ /api/erica-preparation - Serving fallback response for:', cacheKey);

        // Cache the fallback response to avoid thrashing the disk/API
        prepCache.set(cacheKey, {
            ts: now,
            data: data,
            statusCode: 200,
            headers: { 'content-type': 'application/json' }
        });

        res.set({
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'private, max-age=60',
            'X-Erica-Fallback': 'true',
            'X-Cache': 'MISS'
        }).status(200).send(data);
    });
}

// GET/POST /api/helpful-resources
// Returns a filtered list from local resources/Helpful_Resources_content.json
router.all('/helpful-resources', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    let query = '';
    let type = '';
    let limit;

    if (req.method === 'GET') {
        query = typeof req.query.q === 'string' ? req.query.q : '';
        type = typeof req.query.type === 'string' ? req.query.type : '';
        if (typeof req.query.limit === 'string') {
            const parsedLimit = Number.parseInt(req.query.limit, 10);
            if (Number.isFinite(parsedLimit)) limit = parsedLimit;
        }
    } else if (req.method === 'POST') {
        query = typeof req.body?.query === 'string' ? req.body.query : '';
        if (!query && typeof req.body?.q === 'string') query = req.body.q;
        type = typeof req.body?.type === 'string' ? req.body.type : '';
        if (Number.isFinite(req.body?.limit)) limit = req.body.limit;
    }

    const filePath = path.join(__dirname, 'resources', 'Helpful_Resources_content.json');
    fs.readFile(filePath, 'utf8', (error, content) => {
        if (error) {
            console.error('[AgentErica] /api/helpful-resources - File read error:', error);
            return res.status(500).json({ error: 'Failed to read resources file' });
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

            return res.json({
                items: limited,
                total: items.length,
                filtered: filtered.length,
                limit: maxLimit
            });
        } catch (parseError) {
            console.error('[AgentErica] /api/helpful-resources - JSON parse error:', parseError);
            return res.status(500).json({ error: 'Failed to parse resources file' });
        }
    });
});

// POST /api/conversation-history-save
router.post('/conversation-history-save', (req, res) => {
    const userId = req.body.userId;
    const text = req.body.text;

    if (!userId || !text) {
        return res.status(400).json({ error: 'userId and text are required' });
    }

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
        console.error('[AgentErica] /api/conversation-history-save - Request error:', error);
        res.status(500).json({ error: error.message });
    });

    externalReq.write(postData, 'utf8');
    externalReq.end();
});

// POST /api/conversation-history-fetch
router.post('/conversation-history-fetch', (req, res) => {
    const userId = req.body.userId;

    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

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
        console.error('[AgentErica] /api/conversation-history-fetch - Request error:', error);
        res.status(500).json({ error: error.message });
    });

    externalReq.write(postData, 'utf8');
    externalReq.end();
});

// POST /api/proxy/realtime — OpenAI Realtime GA API
// GA endpoint: POST /v1/realtime/calls with multipart/form-data (sdp + session)
// Beta endpoint (/v1/realtime with raw SDP) was shut down May 12, 2026.
// Uses raw https.request with manual multipart body for Node.js < 18 compatibility.
router.post('/proxy/realtime', (req, res) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        // Use server-held OpenAI key (never provided by client). Fetch if missing.
        if (!openAIKey) {
            try {
                await fetchOpenAIKey();
            } catch (_) {
                // ignore
            }
        }
        const apiKey = openAIKey;
        if (!apiKey) {
            return res.status(500).json({ error: 'OpenAI key not available on server' });
        }

        // Build multipart/form-data body manually (works on any Node version)
        const voice = req.headers['x-erica-voice'] || 'marin';
        const boundary = '----EricaFormBoundary' + Date.now().toString(36);
        const sessionJson = JSON.stringify({ type: 'realtime', model: REALTIME_MODEL, audio: { input: { transcription: { model: 'whisper-1' } }, output: { voice: voice } } });

        const multipartBody =
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="sdp"\r\n\r\n` +
            `${body}\r\n` +
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="session"\r\n\r\n` +
            `${sessionJson}\r\n` +
            `--${boundary}--\r\n`;

        const options = {
            hostname: 'api.openai.com',
            port: 443,
            path: '/v1/realtime/calls',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': Buffer.byteLength(multipartBody, 'utf8')
            }
        };

        const proxyReq = https.request(options, (proxyRes) => {
            let responseBody = '';
            proxyRes.on('data', (chunk) => {
                responseBody += chunk;
            });

            proxyRes.on('end', () => {
                if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 201) {
                    console.error('[AgentErica] OpenAI API Error:', {
                        status: proxyRes.statusCode,
                        body: responseBody.substring(0, 500)
                    });
                }

                res.writeHead(proxyRes.statusCode, {
                    'Content-Type': proxyRes.headers['content-type'] || 'text/plain',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                res.end(responseBody);
            });
        });

        proxyReq.on('error', (error) => {
            console.error('[AgentErica] Proxy error:', error);
            res.status(500).json({ error: error.message });
        });

        proxyReq.write(multipartBody);
        proxyReq.end();
    });
});

// GET /api/test - Simple test endpoint to verify routes are working
router.get('/test', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
        status: 'ok',
        message: 'AgentErica API routes are working',
        timestamp: new Date().toISOString(),
        path: req.path,
        url: req.url
    });
});

// POST /api/search - Simple secure proxy for web search
router.post('/search', (req, res) => {
    console.log('[AgentErica] 🔍 POST /search route hit');
    console.log('[AgentErica] 🔍 Request body:', JSON.stringify(req.body));
    console.log('[AgentErica] 🔍 Request headers:', req.headers['content-type']);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        const query = req.body.query || req.body.q;

        console.log('[AgentErica] 🔍 Extracted query:', query);

        if (!query) {
            console.error('[AgentErica] ❌ Missing query in request body. Body keys:', Object.keys(req.body || {}));
            return res.status(400).json({ error: 'Query parameter "query" or "q" is required in request body' });
        }

        // Get API key from server (never exposed to client)
        const apiKey = openAIKey;
        if (!apiKey) {
            console.error('[AgentErica] ❌ OpenAI key not available for search');
            return res.status(500).json({ error: 'OpenAI key not available on server' });
        }

        console.log('[AgentErica] 🔍 Web search request:', { query: query.substring(0, 100) });

        // Make OpenAI Responses API call from server
        const requestData = JSON.stringify({
            model: WEBSEARCH_MODEL,
            input: [
                {
                    role: 'user',
                    content: query
                }
            ],
            tools: [
                {
                    type: 'web_search'
                }
            ],
            tool_choice: 'required'
        });

        const options = {
            hostname: 'api.openai.com',
            port: 443,
            path: '/v1/responses',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'responses=v1',
                'Content-Length': Buffer.byteLength(requestData, 'utf8')
            }
        };

        const openaiReq = https.request(options, (openaiRes) => {
            let responseData = '';

            openaiRes.on('data', (chunk) => {
                responseData += chunk;
            });

            openaiRes.on('end', () => {
                if (openaiRes.statusCode !== 200) {
                    console.error('[AgentErica] ❌ OpenAI API error:', {
                        status: openaiRes.statusCode,
                        body: responseData.substring(0, 500)
                    });
                    return res.status(openaiRes.statusCode).json({
                        error: 'OpenAI API error',
                        status: openaiRes.statusCode,
                        details: responseData.substring(0, 500)
                    });
                }

                try {
                    const openaiResult = JSON.parse(responseData);

                    // Extract the answer from the Responses API format
                    let answer = '';

                    if (openaiResult.output && Array.isArray(openaiResult.output)) {
                        for (const outputItem of openaiResult.output) {
                            if (outputItem.content && Array.isArray(outputItem.content)) {
                                for (const contentItem of outputItem.content) {
                                    if (contentItem.text) {
                                        answer = contentItem.text;
                                        break;
                                    }
                                }
                            }
                            if (answer) break;
                        }
                    }

                    if (!answer) {
                        answer = `A web search was performed for "${query}" but no results were returned.`;
                    }

                    console.log('[AgentErica] ✅ Search completed, answer length:', answer.length);

                    // Return only the answer to the client (no API key exposed)
                    res.json({
                        answer: answer,
                        source: 'OpenAI Responses API web_search'
                    });

                } catch (error) {
                    console.error('[AgentErica] ❌ Error parsing OpenAI response:', error);
                    res.status(500).json({ error: 'Failed to parse OpenAI response', details: error.message });
                }
            });
        });

        openaiReq.on('error', (error) => {
            console.error('[AgentErica] ❌ Error calling OpenAI API:', error);
            res.status(500).json({ error: error.message });
        });

        openaiReq.write(requestData, 'utf8');
        openaiReq.end();

    } catch (error) {
        console.error('[AgentErica] ❌ Error in search route:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

// POST /api/message-qc
router.post('/message-qc', (req, res) => {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'text is required' });
    }

    const ensureKey = (cb) => {
        if (openAIKey) return cb(openAIKey);
        fetchOpenAIKey()
            .then(() => cb(openAIKey))
            .catch((err) => {
                console.error('[AgentErica] /api/message-qc - OpenAI key not available:', err?.message || err);
                cb(null);
            });
    };

    ensureKey((apiKey) => {
        if (!apiKey) {
            return res.status(500).json({ error: 'OpenAI key not available' });
        }

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
                    return res.status(openaiRes.statusCode || 500).send(responseData || JSON.stringify({ error: 'QC request failed' }));
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
                    return res.status(200).json(parsed);
                } catch (e) {
                    return res.status(200).json({ ok: true, cleanedText: text, issues: ['qc_parse_failed'] });
                }
            });
        });

        openaiReq.on('error', (error) => {
            console.error('[AgentErica] /api/message-qc - Request error:', error);
            res.status(500).json({ error: error.message });
        });

        openaiReq.write(requestBody, 'utf8');
        openaiReq.end();
    });
});

// POST /api/preview-tts (mp3)
router.post('/preview-tts', (req, res) => {
    const { text, voice, instructions } = req.body || {};
    if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'text is required' });
    }
    if (!voice || typeof voice !== 'string') {
        return res.status(400).json({ error: 'voice is required' });
    }

    const ensureKey = (cb) => {
        if (openAIKey) return cb(openAIKey);
        fetchOpenAIKey()
            .then(() => cb(openAIKey))
            .catch((err) => {
                console.error('[AgentErica] /api/preview-tts - OpenAI key not available:', err?.message || err);
                cb(null);
            });
    };

    ensureKey((apiKey) => {
        if (!apiKey) {
            return res.status(500).json({ error: 'OpenAI key not available' });
        }

        const model = process.env.ERICA_PREVIEW_TTS_MODEL || 'gpt-4o-mini-tts';
        const requestBody = JSON.stringify({
            model,
            voice: String(voice).trim(),
            input: String(text),
            format: 'mp3',
            instructions: typeof instructions === 'string' && instructions.trim() ? instructions.trim() : undefined
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
                    res.status(status).send(errBody || JSON.stringify({ error: 'TTS request failed' }));
                });
                return;
            }

            const chunks = [];
            openaiRes.on('data', (chunk) => chunks.push(chunk));
            openaiRes.on('end', () => {
                const audioBuffer = Buffer.concat(chunks);
                res.writeHead(200, {
                    'Content-Type': 'audio/mpeg',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(audioBuffer);
            });
        });

        openaiReq.on('error', (error) => {
            console.error('[AgentErica] /api/preview-tts - Request error:', error);
            res.status(500).json({ error: error.message });
        });

        openaiReq.write(requestBody, 'utf8');
        openaiReq.end();
    });
});

// GET /api/search (legacy - redirects to POST)
router.get('/search', (req, res) => {
    // Log immediately to verify route is hit - THIS MUST APPEAR IN SERVER LOGS
    console.log('[AgentErica] 🔍🔍🔍 SEARCH GET ROUTE HIT - URL:', req.url, 'Query:', req.query);

    // Set CORS and Content-Type headers FIRST, before ANY processing
    // This ensures we always return JSON, even if there's an error
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        console.log('[AgentErica] 🔍 SEARCH ROUTE HIT - Request received at /search');
        console.log('[AgentErica] 🔍 Full request details:', {
            method: req.method,
            originalUrl: req.originalUrl,
            url: req.url,
            path: req.path,
            baseUrl: req.baseUrl,
            query: req.query,
            headers: {
                'x-api-key': !!req.headers['x-api-key'],
                'X-API-Key': !!req.headers['X-API-Key'],
                'content-type': req.headers['content-type']
            }
        });

        // If this is just a test request, return immediately
        if (req.query.test === 'true') {
            return res.json({
                status: 'ok',
                message: 'Search route is accessible',
                path: req.path,
                url: req.url,
                query: req.query
            });
        }

        const query = req.query.q;

        // Use server-stored API key (secure - never exposed to client)
        const apiKey = openAIKey;

        if (!query) {
            console.error('[AgentErica] ❌ Search: Missing query parameter');
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        if (!apiKey) {
            console.error('[AgentErica] ❌ Search: OpenAI key not available on server');
            return res.status(500).json({ error: 'OpenAI key not available on server' });
        }

        console.log('[AgentErica] 🔍 Search request received:', {
            query: query,
            model: WEBSEARCH_MODEL,
            apiKeyLength: apiKey ? apiKey.length : 0,
            apiKeyPrefix: apiKey ? apiKey.substring(0, 10) : 'none'
        });

        // Validate WEBSEARCH_MODEL is defined
        if (!WEBSEARCH_MODEL) {
            console.error('[AgentErica] ❌ WEBSEARCH_MODEL is not defined!');
            if (!res.headersSent) {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Content-Type', 'application/json');
            }
            return res.status(500).json({ error: 'Server configuration error: WEBSEARCH_MODEL not defined' });
        }

        // Use OpenAI Responses API with web_search tool
        const requestData = JSON.stringify({
            // Use configurable web search model
            model: WEBSEARCH_MODEL,
            input: [
                {
                    role: "user",
                    content: query
                }
            ],
            tools: [
                {
                    type: "web_search"
                }
            ],
            tool_choice: "required"
        });

        console.log('[AgentErica] 🔍 Request data prepared:', {
            model: WEBSEARCH_MODEL,
            queryLength: query.length,
            requestDataLength: requestData.length,
            hasApiKey: !!apiKey
        });

        const options = {
            hostname: 'api.openai.com',
            port: 443,
            path: '/v1/responses',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'responses=v1',
                'Content-Length': Buffer.byteLength(requestData, 'utf8')
            }
        };

        console.log('[AgentErica] 🔍 Making OpenAI API request...');
        const openaiReq = https.request(options, (openaiRes) => {
            let responseData = '';

            console.log('[AgentErica] 🔍 OpenAI API response status:', openaiRes.statusCode);

            openaiRes.on('data', (chunk) => {
                responseData += chunk;
            });

            openaiRes.on('end', () => {
                console.log('[AgentErica] 🔍 OpenAI API response received, length:', responseData.length);
                console.log('[AgentErica] 🔍 OpenAI API response preview (first 500 chars):', responseData.substring(0, 500));

                // Check for errors first
                if (openaiRes.statusCode !== 200) {
                    console.error('[AgentErica] ❌ OpenAI API error response:', {
                        status: openaiRes.statusCode,
                        body: responseData.substring(0, 1000)
                    });
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Content-Type', 'application/json');
                    res.status(openaiRes.statusCode).json({
                        error: 'OpenAI API error',
                        status: openaiRes.statusCode,
                        details: responseData.substring(0, 500)
                    });
                    return;
                }

                try {
                    const openaiResult = JSON.parse(responseData);
                    console.log('[AgentErica] 🔍 OpenAI response parsed. Keys:', Object.keys(openaiResult));
                    console.log('[AgentErica] 🔍 OpenAI response has output:', !!openaiResult.output);
                    console.log('[AgentErica] 🔍 OpenAI response output type:', Array.isArray(openaiResult.output) ? 'array' : typeof openaiResult.output);

                    // Extract the answer from the nested structure
                    let answer = '';
                    if (openaiResult.output && Array.isArray(openaiResult.output)) {
                        console.log('[AgentErica] 🔍 Processing output array, length:', openaiResult.output.length);
                        for (let i = 0; i < openaiResult.output.length; i++) {
                            const outputItem = openaiResult.output[i];
                            console.log(`[AgentErica] 🔍 Output[${i}]:`, {
                                type: outputItem.type,
                                hasContent: !!outputItem.content,
                                contentType: Array.isArray(outputItem.content) ? 'array' : typeof outputItem.content
                            });

                            if (outputItem.content && Array.isArray(outputItem.content)) {
                                for (let j = 0; j < outputItem.content.length; j++) {
                                    const contentItem = outputItem.content[j];
                                    console.log(`[AgentErica] 🔍 Content[${j}]:`, {
                                        type: contentItem.type,
                                        hasText: !!contentItem.text,
                                        textLength: contentItem.text ? contentItem.text.length : 0
                                    });
                                    if (contentItem.text) {
                                        answer = contentItem.text;
                                        break;
                                    }
                                }
                            }
                            if (answer) break;
                        }
                    } else {
                        console.warn('[AgentErica] ⚠️ OpenAI response has no output array:', openaiResult);
                    }

                    console.log('[AgentErica] 🔍 Extracted answer length:', answer.length);
                    console.log('[AgentErica] 🔍 Extracted answer preview:', answer.substring(0, 200));

                    const result = {
                        answer: answer || 'No answer found',
                        source: 'OpenAI Responses API web_search',
                        fullData: openaiResult
                    };

                    // Ensure CORS headers are set for the response
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.json(result);
                } catch (error) {
                    console.error('[AgentErica] ❌ Error parsing OpenAI response:', error);
                    console.error('[AgentErica] ❌ Raw response:', responseData.substring(0, 1000));
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Content-Type', 'application/json');
                    res.status(500).json({ error: 'Failed to parse OpenAI response', details: error.message });
                }
            });
        });

        openaiReq.on('error', (error) => {
            console.error('[AgentErica] ❌ Error calling OpenAI API:', error);
            if (!res.headersSent) {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Content-Type', 'application/json');
                res.status(500).json({ error: error.message });
            }
        });

        openaiReq.write(requestData, 'utf8');
        openaiReq.end();
    } catch (error) {
        // Catch any synchronous errors in the route handler
        console.error('[AgentErica] ❌ Error in search route handler:', error);
        console.error('[AgentErica] ❌ Error stack:', error.stack);
        console.error('[AgentErica] ❌ Error name:', error.name);
        console.error('[AgentErica] ❌ Error message:', error.message);
        // Ensure headers are set even on error - CRITICAL to prevent HTML error page
        if (!res.headersSent) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');
            res.status(500).json({
                error: 'Internal server error in search route',
                message: error.message,
                name: error.name,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        } else {
            // If headers already sent, log but can't change response
            console.error('[AgentErica] ❌ CRITICAL: Headers already sent, cannot return JSON error');
        }
    }
});

// Error handler for this router - catches any errors in route handlers
router.use((err, req, res, next) => {
    console.error('[AgentErica] ❌ Router error handler caught:', err);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({
        error: 'Internal server error in AgentErica router',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Debug: Log all unmatched routes in this router
router.use((req, res, next) => {
    console.log('[AgentErica] ⚠️ Unmatched route in router:', req.method, req.path, req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.status(404).json({
        error: 'Route not found in AgentErica router',
        method: req.method,
        path: req.path,
        url: req.url
    });
});

    return router;
}

// ─── Export ───────────────────────────────────────────────────────────────────
//
// module.exports IS the default router — identical to the original export, so
// every existing line in node_app.js keeps working with NO changes:
//
//   app.use('/agentErica/api', agentEricaRoutes);              // unchanged ✓
//
// To point a specific prefix at a different host, use .create():
//
//   app.use('/agentErica-dev/api', agentEricaRoutes.create({ apiHost: 'awav.com' }));
//
// ─────────────────────────────────────────────────────────────────────────────
const _defaultRouter = createRouter();
_defaultRouter.create = createRouter;

module.exports = _defaultRouter;
