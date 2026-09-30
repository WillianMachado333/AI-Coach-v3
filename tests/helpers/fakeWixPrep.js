// Test-only preload (`node -r`): scripted upstreams, so the server's real
// code paths run without touching the network.
//
// FAKE_WIX_PREP = comma list consumed one entry per ericaPreparation call: an
// HTTP status (429, 200, …) or "error" (the request fails). The last entry repeats.
// FAKE_OPENAI_RESPONSES = JSON array of output texts for the in-chat Navigator's
// POST /v1/responses (its json_schema is named navigator_tags); the last repeats.
// Other Responses calls fail, like any other request.
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
            if (p !== prepPath) { req.emit('error', new Error('network disabled in test')); return; }
            const step = script[Math.min(calls, script.length - 1)];
            calls++;
            process.stdout.write(`[fake-wix] prep call ${calls}: ${step}\n`);
            if (step === 'error') { req.emit('error', new Error('ECONNRESET (fake)')); return; }
            let body = '';
            if (Number(step) === 200) {
                let sent = {};
                try { sent = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (_) { /* keep {} */ }
                body = JSON.stringify({ message: 'REAL-PREP for ' + (sent.userId || 'guest') });
            }
            respond(req, cb, Number(step), body);
        });
    };
    return req;
};
