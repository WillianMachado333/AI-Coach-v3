// One session per page visit (#27): ids are random per visit, a reconnect
// in the same page resumes its own visit (never someone else's), visits
// group by person, and pre-#27 per-identity files read as legacy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-visits-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });

const sessionLog = require('../lib/sessionLog');
const root = path.join(__dirname, '..');
const lines = (sid) => fs.readFileSync(path.join(process.env.SESSION_DATA_DIR, sid + '.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('each visit of the same person gets its own session; both carry the same person key', () => {
    const a = sessionLog.startSession({ objectId: 'guest-A', caller: 'web' });
    const b = sessionLog.startSession({ objectId: 'guest-A', caller: 'web' });
    assert.notEqual(a, b);
    assert.match(a, /^s-v[A-Za-z0-9_-]{16}$/);
    const [la] = lines(a); const [lb] = lines(b);
    assert.equal(la.idScheme, 'visit');
    assert.equal(la.actor.personKey, lb.actor.personKey);
    assert.equal(la.actor.personKey, sessionLog.personKeyFor({ objectId: 'guest-A' }));
    // userId wins over the browser id, as the clipboard keys a person.
    assert.equal(sessionLog.personKeyFor({ userId: 'u1', objectId: 'guest-A' }), sessionLog.personKeyFor({ userId: 'u1' }));
    assert.equal(sessionLog.personKeyFor({}), null);
});

test('a reconnect in the same page resumes its visit; another person or a made-up id never does', () => {
    const mine = sessionLog.startSession({ objectId: 'guest-B' });
    assert.equal(sessionLog.startSession({ objectId: 'guest-B', resumeSessionId: mine }), mine);
    assert.equal(lines(mine).length, 1, 'a resume appends nothing');
    const other = sessionLog.startSession({ objectId: 'guest-C', resumeSessionId: mine });
    assert.notEqual(other, mine, "someone else's id starts a new visit");
    assert.notEqual(sessionLog.startSession({ objectId: 'guest-B', resumeSessionId: 's-vDoesNotExist0000' }), 's-vDoesNotExist0000');
    assert.notEqual(sessionLog.startSession({ objectId: 'guest-B', resumeSessionId: '../../etc/passwd' }), '../../etc/passwd');
    // A legacy per-identity id is not resumable (it is someone's whole history).
    const legacyId = 's-' + require('node:crypto').createHash('sha256').update('guest-B').digest('hex').slice(0, 24);
    assert.notEqual(sessionLog.startSession({ objectId: 'guest-B', resumeSessionId: legacyId }), legacyId);
});

test('an anonymous visit that learns who it is resumes, and the Studio sees the person', () => {
    const anon = sessionLog.startSession({ caller: 'web' });
    assert.equal(lines(anon)[0].actor.personKey, null);
    assert.equal(sessionLog.startSession({ objectId: 'guest-D', resumeSessionId: anon }), anon, 'the CleverTap id arrived after the first preparation');
    const ls = lines(anon);
    assert.equal(ls.filter((l) => l.type === 'session_start').length, 1, 'still one visit');
    assert.equal(ls[1].type, 'session_identity');
    const row = sessionLog.getSessionsIndex(true).find((r) => r.sessionId === anon);
    assert.equal(row.actor.objectId, 'guest-D');
    assert.equal(row.personKey, sessionLog.personKeyFor({ objectId: 'guest-D' }));
    assert.equal(row.legacy, false);
    assert.equal(row.visits, 1);
});

test('a pre-#27 per-identity file reads as legacy: its visits counted, grouped under the same person, first start kept', () => {
    const legacyId = 's-' + 'a'.repeat(24);
    const f = path.join(process.env.SESSION_DATA_DIR, legacyId + '.ndjson');
    const actor = { email: null, userId: 'member-7', objectId: null, caller: 'web', tester: false };
    fs.writeFileSync(f, [
        { type: 'session_start', t: '2026-09-20T10:00:00.000Z', sessionId: legacyId, actor },
        { type: 'turn', role: 'bot', t: '2026-09-20T10:00:05.000Z', text: 'Hi' },
        { type: 'session_start', t: '2026-09-25T09:00:00.000Z', sessionId: legacyId, actor },
        { type: 'turn', role: 'bot', t: '2026-09-25T09:00:05.000Z', text: 'Welcome back' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const row = sessionLog.getSessionsIndex(true).find((r) => r.sessionId === legacyId);
    assert.equal(row.legacy, true);
    assert.equal(row.visits, 2);
    assert.equal(row.startedAt, '2026-09-20T10:00:00.000Z', 'first visit, not the last');
    assert.equal(row.personKey, sessionLog.personKeyFor({ userId: 'member-7' }));
    // The same person's new visits group with it.
    const fresh = sessionLog.startSession({ userId: 'member-7' });
    assert.equal(sessionLog.getSessionsIndex(true).find((r) => r.sessionId === fresh).personKey, row.personKey);
});

test('Studio: sessions list grouped by person — header with visits and total cost, visits under it; anonymous visits stand alone; flat list on ?group=0', () => {
    const { _internal } = require('../lib/admin');
    const cost = (usd) => ({ usd, snapshots: 1, minutes: 1, usdPerMinute: usd, voiceMode: 'live', unpriced: [] });
    const P = 'p-person1';
    const items = [
        { sessionId: 's-v1', startedAt: '2026-09-29T12:00:00Z', lastAt: '2026-09-29T12:05:00Z', personKey: P, actor: { objectId: 'guestaaaaaa1' }, turns: 4, cost: cost(0.2), legacy: false, visits: 1 },
        { sessionId: 's-anon', startedAt: '2026-09-29T11:00:00Z', lastAt: '2026-09-29T11:01:00Z', personKey: null, actor: {}, turns: 1, cost: null, legacy: false, visits: 1 },
        { sessionId: 's-v2', startedAt: '2026-09-28T12:00:00Z', lastAt: '2026-09-28T12:05:00Z', personKey: P, actor: { objectId: 'guestaaaaaa1' }, turns: 2, cost: cost(0.1), legacy: false, visits: 1 },
        { sessionId: 's-old', startedAt: '2026-09-20T10:00:00Z', lastAt: '2026-09-25T09:00:00Z', personKey: P, actor: { objectId: 'guestaaaaaa1' }, turns: 2, cost: null, legacy: true, visits: 3 },
    ];
    const html = _internal.sessionsPage({ items, tester: 'exclude', limit: 100, bookmarkFilter: '', bookmarks: {} });
    const personRows = html.match(/<tr class="bk-person"/g) || [];
    assert.equal(personRows.length, 1);
    assert.match(html, /👤 <b>guest guesta<\/b>/);
    assert.match(html, /· 5 visits · \$0\.300/, '2 visits + a legacy file holding 3');
    assert.match(html, /legacy file, 3 visits/);
    assert.ok(html.indexOf('s-v1') < html.indexOf('s-v2') && html.indexOf('s-v2') < html.indexOf('s-old'), 'visits under their person, newest first');
    assert.equal((html.match(/bk-row bk-visit/g) || []).length, 3);
    assert.equal((html.match(/<tr class="bk-row">/g) || []).length, 1, 'the anonymous visit stands alone');
    const flat = _internal.sessionsPage({ items, tester: 'exclude', limit: 100, bookmarkFilter: '', bookmarks: {}, group: false });
    assert.equal((flat.match(/<tr class="bk-person"/g) || []).length, 0);
    assert.match(flat, /Group by person/);
});

test('client + server: the preparation request carries the page\'s own visit id; the server passes it as the resume id', () => {
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    assert.match(app, /\.\.\.\(this\.sessionId && \/\^s-v\/\.test\(this\.sessionId\) \? \{ sessionId: this\.sessionId \} : \{\}\),/);
    const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(server, /resumeSessionId: typeof requestData\.sessionId === 'string' \? requestData\.sessionId : null/);
});
