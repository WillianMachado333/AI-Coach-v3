// Test-only preload (`node -r`): scripted upstreams, so the server's real
// code paths run without touching the network.
//
// FAKE_WIX_PREP = comma list consumed one entry per ericaPreparation call: an
// HTTP status (429, 200, …) or "error" (the request fails). The last entry repeats.
// FAKE_OPENAI_RESPONSES = JSON array of output texts for the in-chat Navigator's
// POST /v1/responses (its json_schema is named navigator_tags); the last repeats.
// Other Responses calls fail, like any other request.
// FAKE_WIX_PREP_MESSAGE_FILE = a file whose text is the 200 preparation's
// `message` (e.g. Wix's generic guest text, which an unknown id gets).
// FAKE_OPENAI_VECTOR_STORES = JSON array of the account's stores [{ id, name }],
// oldest first. GET /v1/vector_stores pages through it (limit / after / has_more),
// POST /v1/vector_stores creates one, and a file_search Responses call returns one
// chunk per store searched. Each call prints a [fake-openai] line.
// Any other https.request fails too: the test never leaves the machine.
const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const script = String(process.env.FAKE_WIX_PREP || '200').split(',').map((s) => s.trim());
const prepPath = process.env.PREP_PATH || '/_functions/ericaPreparation';
let openaiScript = null;
try { openaiScript = process.env.FAKE_OPENAI_RESPONSES ? JSON.parse(process.env.FAKE_OPENAI_RESPONSES) : null; } catch (_) { openaiScript = null; }
let calls = 0;
let openaiCalls = 0;
const prepMessage = process.env.FAKE_WIX_PREP_MESSAGE_FILE ? require('fs').readFileSync(process.env.FAKE_WIX_PREP_MESSAGE_FILE, 'utf8') : null;
let stores = null;
try { stores = process.env.FAKE_OPENAI_VECTOR_STORES ? JSON.parse(process.env.FAKE_OPENAI_VECTOR_STORES) : null; } catch (_) { stores = null; }

// The vector-store calls of the OpenAI SDK (lib/vectorStore.js). null: not one of them.
function fakeVectorStores(options, bodyText) {
    if (!stores) return null;
    const url = new URL(options.path || '/', 'https://api.openai.com');
    const method = String(options.method || 'GET').toUpperCase();
    if (url.pathname === '/v1/vector_stores' && method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 20;
        const after = url.searchParams.get('after');
        const list = url.searchParams.get('order') === 'desc' ? [...stores].reverse() : stores;
        const start = after ? list.findIndex((s) => s.id === after) + 1 : 0;
        const data = list.slice(start, start + limit).map((s) => ({ object: 'vector_store', ...s }));
        process.stdout.write(`[fake-openai] vector_stores.list after=${after || '-'} order=${url.searchParams.get('order') || '-'} -> ${data.length}
`);
        return { object: 'list', data, first_id: data[0] ? data[0].id : null, last_id: data.length ? data[data.length - 1].id : null, has_more: start + limit < list.length };
    }
    if (url.pathname === '/v1/vector_stores' && method === 'POST') {
        let name = '';
        try { name = JSON.parse(bodyText || '{}').name || ''; } catch (_) { /* keep '' */ }
        const s = { id: 'vs_created_' + (stores.length + 1), name };
        stores.push(s);
        process.stdout.write(`[fake-openai] vector_stores.create name=${name}
`);
        return { object: 'vector_store', ...s };
    }
    if (url.pathname === '/v1/responses' && method === 'POST' && bodyText.includes('"file_search"')) {
        let ids = [];
        try { ids = JSON.parse(bodyText).tools[0].vector_store_ids || []; } catch (_) { ids = []; }
        process.stdout.write(`[fake-openai] file_search stores=${ids.join(',')}
`);
        return {
            id: 'resp_fs', object: 'response', status: 'completed', model: 'gpt-4.1-mini',
            output: [
                { type: 'file_search_call', id: 'fs_1', status: 'completed', queries: [], results: ids.map((id) => ({ file_id: 'file_' + id, filename: 'from-' + id + '.md', score: 0.9, text: 'chunk from ' + id })) },
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
            ],
        };
    }
    return null;
}

function respond(req, cb, status, body, headers = { 'content-type': 'application/json' }) {
    const res = new PassThrough();
    res.statusCode = status;
    res.statusMessage = status === 200 ? 'OK' : 'Error';
    res.headers = headers;
    res.rawHeaders = Object.entries(headers).flat();
    if (cb) cb(res);
    req.emit('response', res); // node-fetch listens here instead of the callback
    res.end(body || '');
}

https.request = function fakeRequest(options, cb) {
    if (typeof options === 'string' || options instanceof URL) options = new URL(options);
    const req = new EventEmitter();
    const chunks = [];
    req.write = (c) => { chunks.push(Buffer.from(c)); return true; };
    req.setTimeout = () => req;
    req.destroy = () => req;
    // Other clients (node-fetch inside the OpenAI SDK) call these on the
    // failed request; without them the server process crashes.
    req.abort = () => req;
    for (const m of ['setHeader', 'removeHeader', 'setNoDelay', 'setSocketKeepAlive', 'flushHeaders']) req[m] = () => {};
    req.getHeader = () => undefined;
    req.end = (c) => {
        if (c) chunks.push(Buffer.from(c));
        setImmediate(() => {
            const p = options && (options.path || options.pathname) || '';
            const vs = fakeVectorStores(options || {}, Buffer.concat(chunks).toString());
            if (vs) return respond(req, cb, 200, JSON.stringify(vs));
            if (openaiScript && /\/responses$/.test(p) && String(options.method || 'GET').toUpperCase() === 'POST' && Buffer.concat(chunks).toString().includes('"navigator_tags"')) {
                const text = openaiScript[Math.min(openaiCalls, openaiScript.length - 1)];
                openaiCalls++;
                process.stdout.write(`[fake-openai] responses call ${openaiCalls}\n`);
                return respond(req, cb, 200, JSON.stringify({
                    id: 'resp_fake_' + openaiCalls, object: 'response', model: 'gpt-4.1-mini-2025-04-14', status: 'completed',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
                    usage: { input_tokens: 420, input_tokens_details: { cached_tokens: 0 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 460 },
                }));
            }
            // Which Wix site was asked, and whether the API secret went with it (#61).
            const host = options && (options.hostname || options.host) || '';
            const hdrs = (options && options.headers) || {};
            const auth = hdrs.Authorization || hdrs.authorization ? 'yes' : 'no';
            if (/^\/_functions\/ericaConversationHistory(Fetch|Save)$/.test(p)) {
                process.stdout.write(`[fake-wix] ${p.split('/').pop()} host=${host} auth=${auth}\n`);
                return respond(req, cb, 200, JSON.stringify({ ok: true, host }));
            }
            if (p !== prepPath) { req.emit('error', new Error('network disabled in test')); return; }
            const step = script[Math.min(calls, script.length - 1)];
            calls++;
            process.stdout.write(`[fake-wix] prep call ${calls}: ${step} host=${host} auth=${auth}\n`);
            if (step === 'error') { req.emit('error', new Error('ECONNRESET (fake)')); return; }
            let body = '';
            if (Number(step) === 200) {
                let sent = {};
                try { sent = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (_) { /* keep {} */ }
                body = JSON.stringify({ message: prepMessage !== null ? prepMessage : 'REAL-PREP for ' + (sent.userId || 'guest') + ' from ' + host });
            }
            respond(req, cb, Number(step), body);
        });
    };
    return req;
};
