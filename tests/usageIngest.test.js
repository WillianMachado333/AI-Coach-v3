// End-to-end of the storage side of cost metering, on a temp volume:
// startSession → logUsage (priced on write) → readSession lines carry
// `priced` → listSessions index row carries `cost` → metrics.compute rolls
// it into buckets/daily/top → toCsv emits one row per metered session.
// Env must be set before the modules load (they read it at require time);
// node --test runs each file in its own process, so this is isolated.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-usage-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');

const test = require('node:test');
const assert = require('node:assert/strict');
const sessionLog = require('../lib/sessionLog');
const metrics = require('../lib/metrics');
const usageCost = require('../lib/usageCost');

const realtimeUsage = (audioOut) => ({
    total_tokens: 1000 + audioOut, input_tokens: 1000, output_tokens: audioOut,
    input_token_details: { text_tokens: 400, audio_tokens: 600, image_tokens: 0, cached_tokens: 0, cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 } },
    output_token_details: { text_tokens: 0, audio_tokens: audioOut },
});

test('usage snapshots are priced on write, flagged when unpriceable, and roll up to the Studio numbers', () => {
    const sidRealtime = sessionLog.startSession({ email: 'someone@example.com', caller: 'app' });
    const sidLive = sessionLog.startSession({ objectId: 'guest-42', caller: 'app' });
    const sidTester = sessionLog.startSession({ email: 'qa+test@talenttransformation.com', caller: 'admin-simulator' });

    // Realtime: two responses + whisper minutes + a disconnect marker.
    sessionLog.logUsage(sidRealtime, { source: 'response.done', voiceMode: 'realtime', model: 'gpt-realtime-2.1', connectionId: 'c1', responseId: 'r1', sessionMinutes: 1, usage: realtimeUsage(1000) });
    sessionLog.logUsage(sidRealtime, { source: 'response.done', voiceMode: 'realtime', model: 'gpt-realtime-2.1', connectionId: 'c1', responseId: 'r2', sessionMinutes: 2.5, usage: realtimeUsage(2000) });
    sessionLog.logUsage(sidRealtime, { source: 'response.done', voiceMode: 'realtime', model: 'gpt-realtime-2.1', connectionId: 'c1', responseId: 'r2', sessionMinutes: 2.5, usage: realtimeUsage(2000) }); // replay
    sessionLog.logUsage(sidRealtime, { source: 'input_audio_transcription.completed', voiceMode: 'realtime', model: 'whisper-1', connectionId: 'c1', itemId: 'i1', usage: { type: 'duration', seconds: 30 } });
    sessionLog.logUsage(sidRealtime, { source: 'disconnect', voiceMode: 'realtime', model: 'gpt-realtime-2.1', connectionId: 'c1', sessionMinutes: 3, usage: null });

    // Live: cumulative seconds, a backend response, and one unpriceable backend model.
    sessionLog.logUsage(sidLive, { source: 'session.usage.updated', voiceMode: 'live', model: 'gpt-live-1', backendModel: 'gpt-5.6-terra', connectionId: 'c1', sessionMinutes: 1, usage: { seconds: 60 } });
    sessionLog.logUsage(sidLive, { source: 'response.completed', voiceMode: 'live', model: 'gpt-5.6-terra', connectionId: 'c1', responseId: 'b1', usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } } });
    sessionLog.logUsage(sidLive, { source: 'response.completed', voiceMode: 'live', model: 'gpt-6-nova', connectionId: 'c1', responseId: 'b2', usage: { input_tokens: 10, output_tokens: 10 } });
    sessionLog.logUsage(sidLive, { source: 'session.closed', voiceMode: 'live', model: 'gpt-live-1', connectionId: 'c1', sessionMinutes: 3, usage: { seconds: 180 }, reason: 'close_requested' });

    // Tester session — must be excluded from the default Studio totals.
    sessionLog.logUsage(sidTester, { source: 'session.usage.updated', voiceMode: 'live', model: 'gpt-live-1', connectionId: 'c1', usage: { seconds: 6000 } });

    // Lines carry priced{} with the table date; the unpriceable one is flagged.
    const live = sessionLog.readSession(sidLive);
    const usageLines = live.entries.filter((e) => e.type === 'usage');
    assert.equal(usageLines.length, 4);
    assert.ok(usageLines.every((l) => l.priced && l.priced.table === usageCost.PRICE_TABLE_DATE));
    assert.equal(usageLines[0].priced.cumulative, true);
    assert.match(usageLines[2].priced.unpriced, /gpt-6-nova/);
    // Raw usage kept with the API's field names.
    assert.equal(usageLines[1].usage.output_tokens_details.reasoning_tokens, 100);

    // Index rows carry a cost summary; the realtime replay is deduped.
    const rows = sessionLog.listSessions({ tester: 'all', limit: 10 });
    const rt = rows.find((r) => r.sessionId === sidRealtime).cost;
    const expectedRealtime = 2 * ((400 * 4.0 + 600 * 32.0) / 1e6) + (1000 + 2000) * 64.0 / 1e6 + (30 / 60) * 0.006;
    assert.equal(rt.usd, Math.round(expectedRealtime * 1e6) / 1e6);
    assert.equal(rt.minutes, 3);
    assert.equal(rt.voiceMode, 'realtime');
    assert.deepEqual(rt.unpriced, []);

    const lv = rows.find((r) => r.sessionId === sidLive).cost;
    assert.equal(lv.liveSeconds, 180);
    assert.equal(lv.parts.voice, Math.round((180 / 60) * 0.05 * 1e6) / 1e6);
    assert.equal(lv.parts.backend, Math.round((4000 * 2.0 + 1000 * 0.2 + 300 * 12.0) / 1e6 * 1e6) / 1e6);
    assert.equal(lv.unpriced.length, 1);

    // Studio metrics: testers excluded, buckets/daily/top populated, flag counted.
    const m = metrics.compute({ includeTesters: false });
    assert.equal(m.volume.last24h.metered, 2);
    assert.equal(Math.round(m.volume.last24h.usd * 1e6) / 1e6, Math.round((rt.usd + lv.usd) * 1e6) / 1e6);
    assert.equal(m.volume.last24h.minutes, 6);
    assert.equal(m.cost.top.length, 2);
    assert.equal(m.cost.top[0].cost.usd >= m.cost.top[1].cost.usd, true);
    assert.equal(m.cost.unpricedSessions, 1);
    const today = m.daily[m.daily.length - 1];
    assert.equal(Math.round(today.usd * 1e6) / 1e6, Math.round((rt.usd + lv.usd) * 1e6) / 1e6);
    assert.equal(m.cost.priceTable.date, usageCost.PRICE_TABLE_DATE);

    // The tester's 100 minutes only show up when asked for.
    const all = metrics.compute({ includeTesters: true });
    assert.equal(all.volume.last24h.metered, 3);
    assert.equal(all.volume.last24h.minutes, 106);

    // CSV: one row per metered session, flag column filled for the Live one.
    const csv = usageCost.toCsv(rows.filter((r) => r.cost && r.cost.snapshots > 0));
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 4);
    const liveRow = lines.find((l) => l.startsWith(sidLive));
    assert.match(liveRow, /gpt-6-nova/);
    assert.match(liveRow, /,live,/);
});

test('a usage snapshot with no model is stored, flagged, and never silently $0', () => {
    const sid = sessionLog.startSession({ email: 'nobody@example.com' });
    const priced = sessionLog.logUsage(sid, { source: 'response.done', voiceMode: 'realtime', model: null, usage: realtimeUsage(100) });
    assert.equal(priced.usd, 0);
    assert.match(priced.unpriced, /unknown/);
    const row = sessionLog.listSessions({ tester: 'all', limit: 50 }).find((r) => r.sessionId === sid);
    assert.equal(row.cost.unpriced.length, 1);
});
