// The coach's clipboard (#23): storage, the ops-not-document merge, locking,
// budgets, distill orchestration, pricing, and the Studio routes' auth.
// Runs against a temp volume — env is set before any lib is required
// (node --test isolates each file in its own process).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erica-clipboard-'));
process.env.SESSION_DATA_DIR = path.join(tmp, 'sessions');
process.env.SESSION_PROMPTS_DIR = path.join(tmp, 'prompts');
process.env.CLIPBOARD_DATA_DIR = path.join(tmp, 'clipboard');
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });

const cb = require('../lib/coachClipboard');
const usageCost = require('../lib/usageCost');
const root = path.join(__dirname, '..');

const T0 = new Date('2026-09-29T12:00:00Z');
const later = (min) => new Date(T0.getTime() + min * 60000);
const ctx = (extra = {}) => ({ by: 'distill', sessionId: 's-test', visitAt: T0.toISOString(), now: T0, ...extra });

function seeded() {
    let r = cb.emptyRecord('user-u1', T0);
    ({ record: r } = cb.applyOps(r, [
        { op: 'add', kind: 'goal', text: 'Preparing for an interview at Acme' },
        { op: 'add', kind: 'blocker', text: 'Freezes on salary questions' },
        { op: 'add', kind: 'preference', text: 'Prefers short practical exercises' },
    ], ctx()));
    return r;
}

test('keys: user- when signed in, ctid- for guests, nothing without identity', () => {
    assert.equal(cb.keyFor({ userId: 'abc', objectId: 'zzz' }), 'user-abc');
    assert.equal(cb.keyFor({ objectId: 'a0074a28ff' }), 'ctid-a0074a28ff');
    assert.equal(cb.keyFor({}), null);
    assert.equal(cb.keyFor({ userId: '../../etc/passwd' }), 'user-.._.._etc_passwd');
    assert.equal(cb.isValidKey('user-abc'), true);
    assert.equal(cb.isValidKey('../x'), false);
    assert.equal(cb.isValidKey('user-a/b'), false);
});

test('cleanText drops links, emails and phone numbers and caps the length', () => {
    assert.equal(cb.cleanText('Call me at +1 (555) 123-4567 or mail jo@acme.com, see https://x.io/a'), 'Call me at or mail , see');
    assert.equal(cb.cleanText('https://only.a/link'), '');
    assert.equal(cb.cleanText('a'.repeat(400)).length, cb.TEXT_MAX);
});

test('add / dedupe / update / resolve / touch — and the diff says what happened', () => {
    const r = seeded();
    assert.equal(r.items.length, 3);
    const goal = r.items.find((i) => i.kind === 'goal');
    assert.deepEqual(goal.source, { sessionId: 's-test', visitAt: T0.toISOString() });
    const { record, diff } = cb.applyOps(r, [
        { op: 'add', kind: 'goal', text: 'preparing for an interview at ACME!' }, // near-duplicate → touch
        { op: 'update', id: goal.id, text: 'Preparing for a second-round interview at Acme' },
        { op: 'resolve', id: r.items.find((i) => i.kind === 'blocker').id, status: 'done', reason: 'Practised and feels ready' },
        { op: 'touch', id: r.items.find((i) => i.kind === 'preference').id },
        { op: 'update', id: 'nope', text: 'x' },
    ], ctx({ now: later(10) }));
    assert.deepEqual({ ...diff, rejected: diff.rejected.length }, { added: 0, updated: 1, resolved: 1, removed: 0, touched: 2, rejected: 1 });
    assert.equal(record.items.find((i) => i.id === goal.id).text, 'Preparing for a second-round interview at Acme');
    assert.equal(record.items.find((i) => i.kind === 'blocker').status, 'done');
});

test('INVARIANT: operations never touch items they do not name (no blind overwrite)', () => {
    const r = seeded();
    const [goal, blocker, pref] = ['goal', 'blocker', 'preference'].map((k) => r.items.find((i) => i.kind === k));
    const { record } = cb.applyOps(r, [{ op: 'update', id: goal.id, text: 'New goal text' }, { op: 'add', kind: 'note', text: 'Mentioned a move to Lisbon' }], ctx({ now: later(5) }));
    assert.deepEqual(record.items.find((i) => i.id === blocker.id), blocker);
    assert.deepEqual(record.items.find((i) => i.id === pref.id), pref);
    // An empty op list changes nothing at all.
    assert.deepEqual(cb.applyOps(r, [], ctx({ now: later(9) })).record, r);
    // The input record is never mutated.
    assert.equal(r.items.find((i) => i.id === goal.id).text, 'Preparing for an interview at Acme');
});

test('INVARIANT: Studio-edited items are locked against the distiller (touch only)', () => {
    const r = seeded();
    const goal = r.items.find((i) => i.kind === 'goal');
    const { record: edited } = cb.applyOps(r, [{ op: 'update', id: goal.id, text: 'Interview at Acme on Friday', status: 'active' }], { by: 'studio', now: later(1) });
    assert.equal(edited.items.find((i) => i.id === goal.id).by, 'studio');
    const { record, diff } = cb.applyOps(edited, [
        { op: 'update', id: goal.id, text: 'overwritten' },
        { op: 'resolve', id: goal.id, status: 'dropped', reason: 'x' },
        { op: 'remove', id: goal.id, reason: 'asked to forget' },
        { op: 'touch', id: goal.id },
    ], ctx({ now: later(2) }));
    assert.equal(diff.rejected.length, 3);
    assert.equal(diff.touched, 1);
    const g = record.items.find((i) => i.id === goal.id);
    assert.equal(g.text, 'Interview at Acme on Friday');
    assert.equal(g.status, 'active');
});

test('remove needs a reason from the distiller (only on "forget that"); the Studio can always delete', () => {
    const r = seeded();
    const pref = r.items.find((i) => i.kind === 'preference');
    assert.equal(cb.applyOps(r, [{ op: 'remove', id: pref.id }], ctx()).diff.removed, 0);
    assert.equal(cb.applyOps(r, [{ op: 'remove', id: pref.id, reason: 'The person asked to forget it' }], ctx()).diff.removed, 1);
    assert.equal(cb.applyOps(r, [{ op: 'remove', id: pref.id }], { by: 'studio', now: T0 }).diff.removed, 1);
});

test('caps: goals refuse a 4th, journey is one line (replaced), notes roll over', () => {
    let r = seeded();
    ({ record: r } = cb.applyOps(r, [{ op: 'add', kind: 'goal', text: 'Goal two' }, { op: 'add', kind: 'goal', text: 'Goal three' }], ctx()));
    const over = cb.applyOps(r, [{ op: 'add', kind: 'goal', text: 'Goal four' }], ctx());
    assert.equal(over.diff.added, 0);
    assert.match(over.diff.rejected[0].reason, /cap/);
    ({ record: r } = cb.applyOps(r, [{ op: 'add', kind: 'journey', text: 'Job searching' }], ctx()));
    ({ record: r } = cb.applyOps(r, [{ op: 'add', kind: 'journey', text: 'Two interviews scheduled' }], ctx({ now: later(1) })));
    const journeys = r.items.filter((i) => i.kind === 'journey');
    assert.equal(journeys.length, 1);
    assert.equal(journeys[0].text, 'Two interviews scheduled');
    for (let n = 0; n < 15; n++) ({ record: r } = cb.applyOps(r, [{ op: 'add', kind: 'note', text: `Observation number ${n}` }], ctx({ now: later(10 + n) })));
    const notes = r.items.filter((i) => i.kind === 'note' && i.status === 'active');
    assert.equal(notes.length, cb.STORE_CAPS.note);
    assert.ok(notes.some((i) => i.text === 'Observation number 14'), 'newest kept');
    assert.ok(!notes.some((i) => i.text === 'Observation number 0'), 'oldest rolled out');
});

test('INVARIANT: the rendered block stays inside its budget; order, rules and staleness', () => {
    let r = cb.emptyRecord('user-big', T0);
    const long = (w) => `${w} `.repeat(40);
    ({ record: r } = cb.applyOps(r, [
        ...['a', 'b', 'c'].map((w) => ({ op: 'add', kind: 'goal', text: long('goal' + w) })),
        ...['a', 'b', 'c'].map((w) => ({ op: 'add', kind: 'blocker', text: long('block' + w) })),
        ...['a', 'b', 'c'].map((w) => ({ op: 'add', kind: 'preference', text: long('pref' + w) })),
        { op: 'add', kind: 'journey', text: long('journey') },
        ...['a', 'b', 'c', 'd', 'e'].map((w) => ({ op: 'add', kind: 'note', text: long('note' + w) })),
    ], ctx()));
    const out = cb.render(r, { now: T0 });
    const itemLines = out.text.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(itemLines.join('\n').length <= cb.BLOCK_ITEMS_MAX_CHARS, 'items within budget');
    assert.ok(out.omitted > 0, 'something was left out and it says so');
    assert.match(itemLines[0], /^- Journey/);
    assert.match(out.text, /^=== COACH CLIPBOARD/);
    assert.match(out.text, /not a knowledge source/);
    assert.match(out.text, /Never read this list aloud/);
    // Stale: not seen for 60+ days.
    const old = cb.render(seeded(), { now: new Date(T0.getTime() + 61 * 86400000) });
    assert.match(old.text, /check if still relevant/);
    assert.deepEqual(cb.render(cb.emptyRecord('user-x', T0)), { text: '', lines: 0, omitted: 0 });
});

test('the file stays under its byte ceiling however much history piles up', () => {
    let r = seeded();
    for (let n = 0; n < 200; n++) {
        ({ record: r } = cb.applyOps(r, [{ op: 'add', kind: 'note', text: 'x'.repeat(150) + n }], ctx({ now: later(n) })));
        r.writes.push({ at: later(n).toISOString(), by: 'distill', sessionId: 's-' + 'y'.repeat(40), added: 1 });
        const note = r.items.find((i) => i.kind === 'note' && i.status === 'active');
        ({ record: r } = cb.applyOps(r, [{ op: 'resolve', id: note.id, status: 'done', reason: 'z'.repeat(100) }], ctx({ now: later(n) })));
    }
    cb.enforceStoreBudget(r);
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= cb.FILE_MAX_BYTES);
    assert.ok(r.items.some((i) => i.kind === 'goal' && i.status === 'active'), 'active facts survive');
});

function fakeClient(ops, { fail = false, calls = [] } = {}) {
    return {
        calls,
        responses: {
            create: async (req) => {
                calls.push(req);
                if (fail) throw new Error('503 upstream');
                return {
                    id: 'resp_' + calls.length, model: 'gpt-4.1-mini-2025-04-14',
                    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ ops: ops.map((o) => ({ id: null, kind: null, text: null, status: null, reason: null, ...o })) }) }] }],
                    usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 90, output_tokens_details: { reasoning_tokens: 0 } },
                };
            },
        },
    };
}

function fakeLog() {
    const events = []; const usage = [];
    return { events, usage, logEvent: (sid, e) => events.push({ sid, ...e }), logUsage: (sid, u) => usage.push({ sid, ...u }) };
}

const TURNS = [
    { role: 'assistant', text: 'Hi, I am Erica. What brings you here today?' },
    { role: 'user', text: "I'm preparing for an interview at Acme and I freeze on salary questions." },
    { role: 'assistant', text: 'That is very common. Let us practise.' },
];

test('runDistill: writes ops, logs the write and a priced usage line, sends no transcript to disk', async () => {
    cb._reset();
    const log = fakeLog();
    const client = fakeClient([{ op: 'add', kind: 'goal', text: 'Preparing for an interview at Acme' }, { op: 'add', kind: 'blocker', text: 'Freezes on salary questions' }]);
    const res = await cb.runDistill({ objectId: 'guestabc', sessionId: 's-1', turns: TURNS, cursor: 'm3', visitAt: T0.toISOString() }, { client, model: 'gpt-4.1-mini', sessionLog: log, now: T0 });
    assert.equal(res.ok, true);
    assert.equal(res.key, 'ctid-guestabc');
    assert.deepEqual(res.diff, { added: 2, updated: 0, resolved: 0, removed: 0, touched: 0, rejected: 0 });
    assert.equal(res.text, undefined, 'the endpoint never returns clipboard text');
    const rec = cb.read('ctid-guestabc');
    assert.equal(rec.items.length, 2);
    assert.equal(rec.lastCursor, 'm3');
    assert.equal(rec.items[0].source.sessionId, 's-1');
    assert.ok(!JSON.stringify(rec).includes('Let us practise'), 'the transcript is not stored');
    assert.equal(log.events[0].name, 'clipboard_write');
    assert.equal(log.usage[0].source, 'clipboard.distill');
    // The model was asked with a strict json_schema and saw the turns.
    const req = client.calls[0];
    assert.equal(req.text.format.type, 'json_schema');
    assert.equal(req.text.format.strict, true);
    assert.match(req.input[1].content, /freeze on salary/);
});

test('runDistill: duplicate cursor, throttle, no identity, simulator and no user turns are skipped without a model call', async () => {
    cb._reset();
    const calls = [];
    const client = fakeClient([{ op: 'add', kind: 'note', text: 'n' }], { calls });
    const base = { objectId: 'guestdup', sessionId: 's-2', turns: TURNS, cursor: 'c1' };
    assert.equal((await cb.runDistill(base, { client, model: 'm', now: T0 })).ok, true);
    assert.equal((await cb.runDistill(base, { client, model: 'm', now: later(5) })).skipped, 'duplicate');
    assert.equal((await cb.runDistill({ ...base, cursor: 'c2' }, { client, model: 'm', now: new Date(T0.getTime() + 5000) })).skipped, 'throttled');
    assert.equal((await cb.runDistill({ ...base, objectId: null }, { client, model: 'm', now: later(9) })).skipped, 'no_identity');
    assert.equal((await cb.runDistill({ ...base, caller: 'admin-simulator' }, { client, model: 'm', now: later(9) })).skipped, 'simulator');
    assert.equal((await cb.runDistill({ ...base, cursor: 'c3', turns: [{ role: 'assistant', text: 'hello' }] }, { client, model: 'm', now: later(9) })).skipped, 'no_user_turns');
    assert.equal(calls.length, 1);
});

test('runDistill: a failed model call writes NOTHING and logs clipboard_error loudly', async () => {
    cb._reset();
    const log = fakeLog();
    const before = cb.read('ctid-guestabc');
    const res = await cb.runDistill({ objectId: 'guestabc', sessionId: 's-3', turns: TURNS, cursor: 'm9' }, { client: fakeClient([], { fail: true }), model: 'gpt-4.1-mini', sessionLog: log, now: later(60) });
    assert.equal(res.ok, false);
    assert.deepEqual(cb.read('ctid-guestabc'), before);
    assert.equal(log.events[0].name, 'clipboard_error');
    assert.match(log.events[0].meta.reason, /503/);
});

test('blockForVisit renders the block and keeps the guest alive; adoption moves guest notes to the user', () => {
    const b = cb.blockForVisit({ objectId: 'guestabc' }, { now: later(120) });
    assert.equal(b.key, 'ctid-guestabc');
    assert.match(b.text, /Goal \(since 2026-09-29\): Preparing for an interview at Acme/);
    assert.equal(cb.read('ctid-guestabc').lastVisitAt, later(120).toISOString());
    assert.equal(cb.blockForVisit({ objectId: 'guestabc', caller: 'admin-simulator' }).text, '');
    // Signs in on the same browser: the guest record becomes the user's.
    const a = cb.blockForVisit({ userId: 'member-9', objectId: 'guestabc' }, { now: later(130) });
    assert.equal(a.key, 'user-member-9');
    assert.equal(a.adopted, true);
    assert.equal(cb.read('ctid-guestabc'), null);
    assert.equal(cb.read('user-member-9').adoptedFrom, 'ctid-guestabc');
});

test('guest records expire 90 days after the last visit; signed-in records do not', () => {
    const old = cb.emptyRecord('ctid-oldguest', T0); old.lastVisitAt = T0.toISOString(); cb.write(old);
    const user = cb.emptyRecord('user-olduser', T0); user.lastVisitAt = T0.toISOString(); cb.write(user);
    const guestsBefore = cb.list().filter((r) => r.key.startsWith('ctid-')).length;
    assert.equal(cb.sweepExpiredGuests({ now: new Date(T0.getTime() + 91 * 86400000) }), guestsBefore, 'every guest last seen 91 days ago');
    assert.equal(cb.read('ctid-oldguest'), null);
    assert.ok(cb.read('user-olduser'));
});

test('Studio: edits lock the item and are audited with counts only; wipe deletes and logs', () => {
    const audits = [];
    const audit = { append: (e) => audits.push(e) };
    const rec = cb.read('user-member-9');
    const goal = rec.items.find((i) => i.kind === 'goal');
    const { diff } = cb.studioApply('user-member-9', [{ op: 'update', id: goal.id, text: 'Interview at Acme moved to Monday' }], { actor: 'admin', audit, now: later(200) });
    assert.equal(diff.updated, 1);
    assert.equal(cb.read('user-member-9').items.find((i) => i.id === goal.id).by, 'studio');
    assert.equal(audits[0].action, 'clipboard.edit');
    assert.ok(!JSON.stringify(audits[0]).includes('Monday'), 'audit carries counts, not content');
    assert.match(cb.blockForVisit({ userId: 'member-9' }, { now: later(210) }).text, /moved to Monday/);
    const w = cb.wipe('user-member-9', { actor: 'admin', audit });
    assert.deepEqual(w, { removed: true, items: 2 });
    assert.equal(audits[1].action, 'clipboard.wipe');
    assert.equal(cb.blockForVisit({ userId: 'member-9' }).text, '');
});

test('pricing: clipboard.distill is priced as Responses tokens and shows as its own cost part', () => {
    const u = { input_tokens: 5000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 400, output_tokens_details: { reasoning_tokens: 0 } };
    const p = usageCost.priceSnapshot({ source: 'clipboard.distill', model: 'gpt-4.1-mini-2025-04-14', usage: u });
    assert.equal(p.unpriced, null);
    assert.equal(Math.round(p.usd * 1e6), Math.round((5000 * 0.40 + 400 * 1.60)));
    const s = usageCost.summarizeSession([{ type: 'usage', t: T0.toISOString(), source: 'clipboard.distill', model: 'gpt-4.1-mini', responseId: 'r1', usage: u }]);
    assert.equal(s.parts.clipboard, 0.00264);
    assert.equal(s.usd, 0.00264);
    assert.match(usageCost.toCsv([{ sessionId: 's', cost: s }]).split('\r\n')[0], /usd_clipboard$/);
});

test('client: the block rides the host-event gate, as a system item with no response.create; triggers are wired', () => {
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const flush = src.slice(src.indexOf('    _flushHostEvents() {'), src.indexOf('    _flushHostEvents() {') + 200);
    assert.match(flush, /_flushHostEvents\(\) \{\s*this\._injectClipboardIntoSession\(\);/, 'first line, before the empty-queue return');
    const inject = src.slice(src.indexOf('    _injectClipboardIntoSession() {'), src.indexOf('    _clipboardNoteActivity() {'));
    assert.match(inject, /this\._historyInjectedFor !== this\.pc/);
    assert.match(inject, /role: 'system'/);
    assert.doesNotMatch(inject, /response\.create|_requestResponse|this\.messages/);
    assert.match(src, /saveConversationHistory\(\{ preferSoon = false \} = \{\}\) \{\s*this\._clipboardNoteActivity\(\);/, 'guests too: before the userId early return');
    assert.match(src, /setTimeout\(\(\) => this\._scheduleClipboardDistill\('hangup'\), 4000\)/);
    assert.match(src, /addEventListener\('pagehide', \(\) => this\._scheduleClipboardDistill\('pagehide'\)\)/);
});

// --- Studio routes over a real socket: unauthenticated writes are refused ---
function startServer(port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: root,
            env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', SESSION_SECRET: 'test-secret-for-clipboard' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start:\n${out}`)); }, 20000);
        const onData = (c) => { out += String(c); if (/Server running at http:/.test(out)) { clearTimeout(timer); resolve(child); } };
        child.stdout.on('data', onData); child.stderr.on('data', onData); child.on('error', reject);
    });
}
function request(port, urlPath, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); if (body) req.write(body); req.end();
    });
}

test('HTTP: Studio clipboard routes need an admin session; the public route returns only the claimed identity block (identity is unsigned — same boundary as history)', async () => {
    cb.write(cb.applyOps(cb.emptyRecord('user-victim', T0), [{ op: 'add', kind: 'goal', text: 'Secret goal' }], ctx()).record);
    const port = 19000 + Math.floor(Math.random() * 900);
    const server = await startServer(port);
    try {
        const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
        for (const p of ['/admin/users/clipboard/wipe', '/admin/users/clipboard/item', '/admin/users/clipboard/add']) {
            const r = await request(port, p, { method: 'POST', headers: form, body: 'key=user-victim&q=victim&id=x&action=delete' });
            assert.ok([302, 401, 403].includes(r.status), `${p} → ${r.status}`);
            if (r.status === 302) assert.match(r.headers.location, /login/);
        }
        assert.ok(cb.read('user-victim'), 'still there');
        const page = await request(port, '/admin/users');
        assert.ok([302, 401].includes(page.status));
        // Public block route: only the caller's own key, and only rendered text.
        const own = await request(port, '/api/clipboard/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'victim' }) });
        assert.equal(own.status, 200);
        assert.match(JSON.parse(own.body).text, /Secret goal/);
        const other = await request(port, '/api/clipboard/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objectId: 'someone-else' }) });
        assert.equal(JSON.parse(other.body).text, '');
        const noKey = await request(port, '/api/clipboard/distill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turns: TURNS }) });
        assert.equal(JSON.parse(noKey.body).skipped, 'no_identity');
    } finally {
        server.kill();
    }
});

test('GPT-Live: the block reaches the VOICE layer via session.instructions.append (≤ 500 tokens per event), and the backend via an item', () => {
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const inject = src.slice(src.indexOf('    _injectClipboardIntoSession() {'), src.indexOf('    _clipboardNoteActivity() {'));
    assert.match(inject, /type: 'session\.instructions\.append', delegation_id: null, content/);
    assert.match(inject, /type: 'response\.item\.create', item/);
    assert.match(inject, /type: 'conversation\.item\.create', item/);
    const { splitForLiveAppend } = require('../lib/coachUiRules');
    assert.deepEqual(splitForLiveAppend(''), []);
    assert.deepEqual(splitForLiveAppend('short\nblock'), ['short\nblock']);
    // The largest block the budget allows still fits in ≤ 1,800-char appends, whole lines only.
    let r = cb.emptyRecord('user-live', T0);
    const long = (w) => `${w} `.repeat(40);
    ({ record: r } = cb.applyOps(r, [
        ...['a', 'b', 'c'].map((w) => ({ op: 'add', kind: 'goal', text: long('goal' + w) })),
        ...['a', 'b', 'c'].map((w) => ({ op: 'add', kind: 'blocker', text: long('block' + w) })),
        ...['a', 'b', 'c'].map((w) => ({ op: 'add', kind: 'preference', text: long('pref' + w) })),
        { op: 'add', kind: 'journey', text: long('journey') },
    ], ctx()));
    const block = cb.render(r, { now: T0 }).text;
    const parts = splitForLiveAppend(block);
    assert.ok(parts.every((p) => p.length <= 1800), parts.map((p) => p.length).join(','));
    assert.equal(parts.join('\n'), block);
});
