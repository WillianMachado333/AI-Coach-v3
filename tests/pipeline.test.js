// Onboarding pipeline, phase 1 (lib/pipeline.js): visits tagged with the
// variant (inchat@1) and their context, meaningful interactions counted from
// the #30 turns, milestones logged once as they happen (even across a
// restart), and the funnel the Studio shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-pipeline-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });
const root = path.join(__dirname, '..');
const pipeline = require('../lib/pipeline');

const LONG = 'That sounds like a real step forward — tell me more about it.';
const T = (i) => new Date(Date.UTC(2026, 8, 30, 10, 0, i)).toISOString();
const user = (i) => ({ type: 'turn', role: 'user', t: T(i), text: { redacted: true, length: 12 } });
const bot = (i, text = LONG) => ({ type: 'turn', role: 'bot', t: T(i), text });

test('meaningful interaction: a user turn then a substantive reply; opening lines, short or tool-only replies and second replies do not count', () => {
    const lines = [
        { type: 'session_start', t: T(0), onboarding: { variant: 'inchat@1', context: { caller: 'web' } } },
        bot(1),                  // opening line: nothing before it
        user(2), bot(3, 'Ok!'),  // too short to count…
        bot(4),                  // …but the same user turn still pending → counts (1)
        bot(5),                  // second reply to the same turn: no
        user(6), user(7), bot(8), // two messages, one reply: counts once (2)
        user(9), bot(10, ''),    // tool-only (no text): no
        bot(11, null),
    ];
    const s = pipeline.summarize(lines);
    assert.equal(s.variant, 'inchat@1');
    assert.equal(s.userTurns, 4);
    assert.equal(s.meaningful, 2);
    assert.equal(s.firstUserAt, T(2));
    assert.equal(s.firstMeaningfulAt, T(4));
    assert.equal(s.successAt, null);
    const c = pipeline.createCounter(); const reached = [];
    for (let i = 0; i < 10; i++) { reached.push(...pipeline.feed(c, user(20 + 2 * i)), ...pipeline.feed(c, bot(21 + 2 * i))); }
    assert.deepEqual(reached, ['coaching_started', 'meaningful', 'meaningful_10'], 'each milestone once, the 10th reply reaches success');
    assert.equal(c.successAt, T(39));
});

test('context: a short whitelist from the client, the caller and the frame URL; never ids, tokens or a query string', () => {
    const ctx = pipeline.sanitizeContext(
        { hostPage: 'https://www.talenttransformation.com/quiz-results?memberId=123#top', source: 'newsletter<script>', userId: 'm-1', email: 'a@b.c' },
        { caller: 'web', referer: 'https://web-staging-2c7ff.up.railway.app/?userId=m-1&idt=v1.x.y&aic=Strengths&utm_campaign=fall-26' });
    assert.deepEqual(ctx, { caller: 'web', hostPage: 'https://www.talenttransformation.com/quiz-results', coach: 'Strengths', source: 'newsletterscript', utm_campaign: 'fall-26' });
    assert.deepEqual(pipeline.sanitizeContext(null, {}), {});
});

test('funnel: journeys add up a signed-in person across visits; anonymous visits stand alone; filters; the table math', () => {
    const row = (sessionId, { userId = null, objectId = null, personKey = null, meaningful = 0, userTurns = meaningful, variant = 'inchat@1', at = T(5), tester = false, legacy = false, caller = 'web' } = {}) => ({
        sessionId, legacy, personKey, startedAt: at, actor: { userId, objectId, caller, tester },
        pipeline: { variant, context: { caller }, entryAt: at, userTurns, meaningful },
    });
    const rows = [
        row('s-v1', { userId: 'm-A', personKey: 'pA', meaningful: 6, at: T(1) }),
        row('s-v2', { userId: 'm-A', personKey: 'pA', meaningful: 5, at: T(2) }),   // A: 11 across two visits
        row('s-v3', { objectId: 'ct-1', personKey: 'pG', meaningful: 3 }),
        row('s-v4', { objectId: 'ct-1', personKey: 'pG', meaningful: 0, userTurns: 1 }), // same browser, still two visits
        row('s-v5', { objectId: 'ct-2', personKey: 'pH' }),                          // entry only
        row('s-v6', { objectId: 'ct-3', personKey: 'pI', tester: true, meaningful: 12 }),
        row('s-v7', { objectId: 'ct-4', personKey: 'pJ', variant: null, meaningful: 2 }),
        row('s-old', { userId: 'm-B', personKey: 'pB', legacy: true, meaningful: 40 }),
    ];
    const j = pipeline.compute(rows);
    assert.equal(j.units, 4, 'A + three anonymous visits (tester, untagged and legacy left out)');
    assert.deepEqual(j.table.map((r) => [r.stage, r.reached]), [['entry', 4], ['coaching_started', 3], ['meaningful', 2], ['meaningful_10', 1]]);
    assert.equal(j.table[1].pctOfEntry, 0.75);
    assert.equal(j.table[3].convFromPrev, 0.5);
    assert.deepEqual(j.table.map((r) => r.dropHere), [1, 1, 1, null]);
    const a = j.list.find((u) => u.personKey === 'pA');
    assert.deepEqual([a.meaningful, a.visits.length, a.entryAt, a.stage], [11, 2, T(1), 'meaningful_10']);
    const v = pipeline.compute(rows, { unit: 'visit' });
    assert.equal(v.units, 5);
    assert.equal(v.table[3].reached, 0, 'no single visit reached 10');
    assert.equal(pipeline.compute(rows, { identity: 'signed' }).units, 1);
    assert.equal(pipeline.compute(rows, { variant: 'untagged' }).units, 1);
    assert.equal(pipeline.compute(rows, { testers: 'include' }).table[3].reached, 2);
    assert.equal(pipeline.compute(rows, { since: T(2) }).units, 3, "A's journey entered at T(1), before the period");
});

// --- A real server ---
function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'fakeWixPrep.js'), 'server.js'], { cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve({ child, out: () => out }); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function post(port, urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); req.write(data); req.end();
    });
}
const stop = (child) => new Promise((r) => { child.once('exit', r); child.kill(); });

test('HTTP: a visit is tagged inchat@1 with its context; milestones are logged once as they happen, also after a restart', async () => {
    const dirs = { SESSION_DATA_DIR: path.join(tmp, 'http-sessions'), SESSION_PROMPTS_DIR: path.join(tmp, 'http-prompts'), CLIPBOARD_DATA_DIR: path.join(tmp, 'http-clip'),
        AUDIT_DIR: path.join(tmp, 'http-audit'), ACTIVITY_DATA_DIR: path.join(tmp, 'http-act'), INJECTED_DATA_DIR: path.join(tmp, 'http-inj'), SESSION_SECRET: 'x', FAKE_WIX_PREP: '200' };
    const port = 24000 + Math.floor(Math.random() * 900);
    let srv = await startServer(port, dirs);
    try {
        const prep = await post(port, '/api/erica-preparation', { caller: 'web', userId: 'member-P', context: { hostPage: 'https://www.talenttransformation.com/ai-coach?x=1' } },
            { Referer: `http://127.0.0.1:${port}/?userId=member-P&aic=Strengths&utm_source=email` });
        const sid = prep.headers['x-session-id'];
        assert.match(String(sid), /^s-v/);
        const file = path.join(dirs.SESSION_DATA_DIR, sid + '.ndjson');
        const start = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
        assert.deepEqual(start.onboarding, { variant: 'inchat@1', context: { caller: 'web', hostPage: 'https://www.talenttransformation.com/ai-coach', coach: 'Strengths', utm_source: 'email' } });
        const turn = (kind, text) => post(port, '/api/session-log', { sessionId: sid, kind, text, meta: { messageId: 'm' + Math.random() } });
        await turn('bot_turn', "Hi, I'm Erica. What would you like to work on today?"); // opening line
        for (let i = 0; i < 6; i++) { await turn('user_turn', 'message ' + i); await turn('bot_turn', LONG); }
        await stop(srv.child);
        srv = await startServer(port, dirs); // the counter comes back from the file
        for (let i = 6; i < 11; i++) { await turn('user_turn', 'message ' + i); await turn('bot_turn', LONG); }
        const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'event' && e.name === 'onboarding_milestone');
        assert.deepEqual(events.map((e) => [e.meta.stage, e.meta.meaningful]), [['coaching_started', 0], ['meaningful', 1], ['meaningful_10', 10]]);
        assert.equal(events[2].meta.variant, 'inchat@1');
        assert.ok(events[0].meta.msSinceEntry >= 0);
        const sessionLog = require('../lib/sessionLog');
        const summary = pipeline.summarize(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
        assert.equal(summary.meaningful, 11);
        assert.ok(sessionLog);
    } finally {
        await stop(srv.child);
    }
});

test('Studio: the pipeline page shows the funnel; the timeline shows milestones and style choices; the person page shows the stage', () => {
    const sessionLog = require('../lib/sessionLog');
    const sid = sessionLog.startSession({ userId: 'member-S', caller: 'web', onboarding: { variant: 'inchat@1', context: { caller: 'web' } } });
    for (let i = 0; i < 3; i++) { sessionLog.logUserTurn(sid, { text: 'hello ' + i }); sessionLog.logBotTurn(sid, { text: LONG }); }
    sessionLog.logEvent(sid, { name: 'onboarding_milestone', meta: { stage: 'meaningful', variant: 'inchat@1', meaningful: 1, msSinceEntry: 42000 } });
    sessionLog.logEvent(sid, { name: 'style_overridden', meta: { from: null, to: 'Strengths', via: 'picker' } });
    sessionLog.startSession({ objectId: 'ct-anon', caller: 'web', onboarding: { variant: 'inchat@1', context: { caller: 'web' } } });

    const { _internal } = require('../lib/admin');
    const res = pipeline.compute(sessionLog.getSessionsIndex(true), { testers: 'include' });
    const html = _internal.pipelinePage(res, { variant: 'inchat@1', unit: 'journey', identity: 'all', period: '30', testers: 'include' });
    const reached = [...html.matchAll(/data-stage="(\w+)"[\s\S]*?data-reached>(\d+)</g)].map((m) => [m[1], Number(m[2])]);
    assert.deepEqual(reached, [['entry', 2], ['coaching_started', 1], ['meaningful', 1], ['meaningful_10', 0]]);
    assert.match(html, /Meaningful interaction<\/b>: one message from the person followed by a coach reply of at least 30 characters/);

    const detail = _internal.sessionDetailPage(sid, sessionLog.readSession(sid));
    assert.match(detail, /✅ <b>First meaningful interaction<\/b>/);
    assert.match(detail, /42 s after entry · inchat@1/);
    assert.match(detail, /Coaching style chosen by the person<\/b> — default → Strengths/);

    const person = _internal.pipelineLine('member-S');
    assert.match(person, /Stage <b>1\+ meaningful interaction<\/b>/);
    assert.match(person, /<b>3<\/b> meaningful interactions/);
    assert.match(person, /7 to success/);
    assert.equal(_internal.pipelineLine('nobody'), '');
});

test('client: the preparation sends the host page (address only); a picker switch logs style_overridden', () => {
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    assert.match(app, /context: \{ hostPage: \(\(\) => \{ try \{ const r = new URL\(document\.referrer\); return r\.origin \+ r\.pathname;/);
    const ui = fs.readFileSync(path.join(root, 'uiLayout.js'), 'utf8');
    assert.match(ui, /app\._logSessionEvent\('style_overridden', \{ from: prevCompanionId \|\| null, to: companionId \|\| null, via: 'picker' \}\)/);
});
