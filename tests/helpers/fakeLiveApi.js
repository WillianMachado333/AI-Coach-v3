// Test-only preload (`node -r`): OpenAI's GPT-Live sessions endpoint, faked
// on the global fetch (what server.js's /api/proxy/live and the #40 guard's
// hang-up use). Every call to api.openai.com/v1/live/sessions… is answered
// here and appended to FAKE_LIVE_LOG (ndjson) so a test can read what the
// server asked for; nothing leaves the machine.
//
//   POST /v1/live/sessions            → { session: { id: 'ls_test_N' }, transport: { sdp } }
//   POST /v1/live/sessions/{id}/hangup → FAKE_LIVE_HANGUP_STATUS (default 200)
const fs = require('fs');

const realFetch = globalThis.fetch;
const log = process.env.FAKE_LIVE_LOG || null;
const hangupStatus = Number(process.env.FAKE_LIVE_HANGUP_STATUS || 200);
let created = 0;

function record(entry) {
    if (log) fs.appendFileSync(log, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
}

globalThis.fetch = async (url, init = {}) => {
    const u = String(url && url.url ? url.url : url);
    if (!u.startsWith('https://api.openai.com/v1/live/sessions')) return realFetch(url, init);
    const hangup = u.match(/\/v1\/live\/sessions\/([^/]+)\/hangup$/);
    if (hangup) {
        record({ kind: 'hangup', id: decodeURIComponent(hangup[1]), auth: /^Bearer \S+/.test(String((init.headers || {}).Authorization || '')) });
        return new Response(hangupStatus < 300 ? '{}' : '{"error":{"message":"not found"}}', { status: hangupStatus, headers: { 'content-type': 'application/json' } });
    }
    created++;
    const id = 'ls_test_' + created;
    record({ kind: 'create', id });
    return new Response(JSON.stringify({ session: { id, model: 'gpt-live-1' }, transport: { type: 'webrtc', sdp: 'v=0\r\n' } }), { status: 200, headers: { 'content-type': 'application/json' } });
};
