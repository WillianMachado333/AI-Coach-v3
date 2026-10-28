// Varsha's 22 'content' closes looked like green cost rows in the Studio:
// the usage row now says why GPT-Live closed the session, and a content
// close stands out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-close-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });

test('the Studio usage row shows the close reason; content in red', () => {
    const sid = 's-close-reason';
    const t = new Date().toISOString();
    const lines = [
        { type: 'session_start', t, sessionId: sid, actor: { objectId: 'x' } },
        { type: 'usage', t, source: 'session.closed', reason: 'content', voiceMode: 'live', model: 'gpt-live-1', usage: { seconds: 15 }, priced: { usd: 0.0125 } },
        { type: 'usage', t, source: 'session.closed', reason: 'expired', voiceMode: 'live', model: 'gpt-live-1', usage: { seconds: 15 }, priced: { usd: 0.0125 } },
        { type: 'usage', t, source: 'session.usage.updated', voiceMode: 'live', model: 'gpt-live-1', usage: { seconds: 60 }, priced: { usd: 0.05 } },
    ];
    fs.writeFileSync(path.join(process.env.SESSION_DATA_DIR, sid + '.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { _internal } = require('../lib/admin');
    const html = _internal.sessionDetailPage(sid, { entries: lines });
    assert.match(html, /15s cumulative voice · <span data-close-reason="content" style="color:#d03b3b;font-weight:600">closed: content \(safety filter\)<\/span>/);
    assert.match(html, /15s cumulative voice · <span data-close-reason="expired">closed: expired<\/span>/);
    assert.equal((html.match(/data-close-reason=/g) || []).length, 2, 'only session.closed rows carry a reason');
});
