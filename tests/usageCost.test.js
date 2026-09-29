const test = require('node:test');
const assert = require('node:assert/strict');
const cost = require('../lib/usageCost');

// Fixtures use the APIs' own field names. Numbers are chosen so each part is
// easy to check by hand against the price table in lib/usageCost.js.

test('realtime response.done: modality split, cached tokens at the cached rate', () => {
    const usage = {
        total_tokens: 1300,
        input_tokens: 1000,
        output_tokens: 300,
        input_token_details: {
            text_tokens: 400, audio_tokens: 600, image_tokens: 0,
            cached_tokens: 300,
            cached_tokens_details: { text_tokens: 200, audio_tokens: 100, image_tokens: 0 },
        },
        output_token_details: { text_tokens: 50, audio_tokens: 250 },
    };
    const p = cost.priceRealtimeUsage('gpt-realtime', usage);
    assert.equal(p.unpriced, null);
    // text: 200 uncached @4 + 200 cached @0.40 ; audio: 500 uncached @32 + 100 cached @0.40
    // out: 50 text @16 + 250 audio @64  (all per 1M)
    const expected = (200 * 4 + 200 * 0.4 + 500 * 32 + 100 * 0.4 + 50 * 16 + 250 * 64) / 1e6;
    assert.equal(p.usd, Math.round(expected * 1e6) / 1e6);
    assert.equal(p.tokens.cached_in, 300);
    assert.equal(p.tokens.audio_out, 250);
});

test('realtime 2.1 charges the text-output premium, mini charges mini rates', () => {
    const usage = { input_tokens: 0, output_tokens: 1000, output_token_details: { text_tokens: 1000, audio_tokens: 0 }, input_token_details: { text_tokens: 0, audio_tokens: 0 } };
    assert.equal(cost.priceRealtimeUsage('gpt-realtime-2.1', usage).usd, 0.024);
    assert.equal(cost.priceRealtimeUsage('gpt-realtime', usage).usd, 0.016);
    assert.equal(cost.priceRealtimeUsage('gpt-realtime-2.1-mini', usage).usd, 0.0024);
});

test('unknown model is flagged, never priced at zero silently', () => {
    const p = cost.priceRealtimeUsage('gpt-realtime-9000', { input_tokens: 10, output_tokens: 10 });
    assert.equal(p.usd, 0);
    assert.match(p.unpriced, /gpt-realtime-9000/);
    const q = cost.priceSnapshot({ source: 'response.completed', model: 'mystery-backend', usage: { input_tokens: 1 } });
    assert.match(q.unpriced, /mystery-backend/);
    const r = cost.priceSnapshot({ source: 'something.new', usage: {} });
    assert.match(r.unpriced, /unknown usage source/);
});

test('dated snapshots and suffixed names resolve to the table key', () => {
    assert.equal(cost.normalizeModel('gpt-5.6-terra-2026-07-30'), 'gpt-5.6-terra');
    assert.equal(cost.normalizeModel('GPT-Realtime'), 'gpt-realtime');
    assert.equal(cost.normalizeModel('gpt-realtime-2.1-mini-2026-05-01'), 'gpt-realtime-2.1-mini');
    assert.equal(cost.normalizeModel('gpt-realtime-mini'), 'gpt-realtime-mini');
    assert.equal(cost.normalizeModel('nope'), null);
});

test('live voice seconds are per-second prorated at $0.05/min', () => {
    const p = cost.priceSeconds('gpt-live-1', 128);
    assert.equal(p.usd, Math.round((128 / 60) * 0.05 * 1e6) / 1e6);
    assert.equal(p.unpriced, null);
});

test('live backend response.completed: cached input, reasoning inside output, long-context tier', () => {
    const usage = {
        input_tokens: 10000, input_tokens_details: { cached_tokens: 4000 },
        output_tokens: 500, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 10500,
    };
    const p = cost.priceResponsesUsage('gpt-5.6-terra', usage);
    const expected = (6000 * 2.0 + 4000 * 0.2 + 500 * 12.0) / 1e6;
    assert.equal(p.usd, Math.round(expected * 1e6) / 1e6);
    assert.equal(p.tokens.reasoning, 200);
    assert.equal(p.longContext, undefined);

    const big = cost.priceResponsesUsage('gpt-5.6-terra', { input_tokens: 300000, output_tokens: 100 });
    assert.equal(big.longContext, true);
    assert.equal(big.usd, Math.round((300000 * 4.0 + 100 * 18.0) / 1e6 * 1e6) / 1e6);
});

test('transcription usage: duration shape priced per minute, token shape needs a token model', () => {
    const d = cost.priceTranscriptionUsage('whisper-1', { type: 'duration', seconds: 30 });
    assert.equal(d.usd, 0.003);
    const t = cost.priceTranscriptionUsage('gpt-4o-transcribe', { type: 'tokens', input_tokens: 100, output_tokens: 10 });
    assert.match(t.unpriced, /gpt-4o-transcribe/);
});

test('summarizeSession: realtime sums per response, dedupes replays, tracks minutes', () => {
    const rt = (id, audioOut) => ({
        type: 'usage', t: '2026-09-28T10:00:00.000Z', source: 'response.done', voiceMode: 'realtime',
        model: 'gpt-realtime', connectionId: 'c1', responseId: id, sessionMinutes: 3,
        usage: { input_tokens: 0, output_tokens: audioOut, input_token_details: { text_tokens: 0, audio_tokens: 0 }, output_token_details: { text_tokens: 0, audio_tokens: audioOut } },
    });
    const lines = [rt('r1', 1000), rt('r2', 1000), rt('r2', 1000)]; // r2 replayed
    // priced on write normally; here we let summarizeSession price them.
    const s = cost.summarizeSession(lines);
    assert.equal(s.snapshots, 3);
    assert.equal(s.usd, 0.128); // 2 × 1000 audio-out tokens @ $64/1M
    assert.equal(s.parts.realtime, 0.128);
    assert.equal(s.minutes, 3);
    assert.equal(s.usdPerMinute, Math.round((0.128 / 3) * 1e6) / 1e6);
    assert.deepEqual(s.unpriced, []);
    assert.equal(s.voiceMode, 'realtime');
});

test('summarizeSession: live seconds are cumulative per connection, backend tokens summed, flags propagate', () => {
    const secs = (conn, seconds, t) => ({
        type: 'usage', t, source: 'session.usage.updated', voiceMode: 'live', model: 'gpt-live-1',
        backendModel: 'gpt-5.6-terra', connectionId: conn, usage: { seconds },
    });
    const backend = (id, model) => ({
        type: 'usage', t: '2026-09-28T10:01:00.000Z', source: 'response.completed', voiceMode: 'live',
        model, connectionId: 'c1', responseId: id,
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } },
    });
    const lines = [
        secs('c1', 12, '2026-09-28T10:00:12.000Z'),
        secs('c1', 60, '2026-09-28T10:01:00.000Z'),
        secs('c1', 128, '2026-09-28T10:02:08.000Z'),   // latest for c1 → 128, not 200
        secs('c2', 30, '2026-09-28T10:05:00.000Z'),    // reconnect: its own counter
        backend('b1', 'gpt-5.6-terra'),
        backend('b2', 'gpt-5.6-terra'),
        backend('b3', 'gpt-5.9-nova'),                 // not in table → flagged
    ];
    const s = cost.summarizeSession(lines);
    assert.equal(s.liveSeconds, 158);
    assert.equal(s.parts.voice, Math.round((158 / 60) * 0.05 * 1e6) / 1e6);
    assert.equal(s.parts.backend, Math.round(2 * (1000 * 2.0 + 100 * 12.0) / 1e6 * 1e6) / 1e6);
    assert.equal(s.unpriced.length, 1);
    assert.match(s.unpriced[0], /gpt-5.9-nova/);
    assert.equal(s.tokens.reasoning, 0);
    // no sessionMinutes sent → span of timestamps (10:00:12 → 10:05:00 = 4.8 min)
    assert.equal(s.minutes, 4.8);
    assert.equal(s.voiceMode, 'live');
});

test('summarizeSession with no usage lines is a well-formed zero, and toCsv is quoted correctly', () => {
    const s = cost.summarizeSession([{ type: 'turn' }]);
    assert.equal(s.usd, 0);
    assert.equal(s.usdPerMinute, null);
    const csv = cost.toCsv([{ sessionId: 's-1', startedAt: 'a', lastAt: 'b', actor: { email: 'x@y.z, "q"' }, cost: s }]);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0].split(',')[0], 'sessionId');
    assert.ok(lines[1].includes('"x@y.z, ""q"""'));
});

test('fmtUsd scales precision to the amount', () => {
    assert.equal(cost.fmtUsd(0), '$0.00');
    assert.equal(cost.fmtUsd(0.00421), '$0.0042');
    assert.equal(cost.fmtUsd(0.421), '$0.421');
    assert.equal(cost.fmtUsd(12.345), '$12.35');
});
