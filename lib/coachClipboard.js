/**
 * The coach's clipboard (item #23, CC-02 persistent memory level 1).
 *
 * "É a prancheta do coach onde ele anota as observações sobre a pessoa."
 * One small JSON record per person — goals, blockers, preferences, where
 * they are in the journey, dated notes — that Erica reads at boot and a
 * distillation call updates after each stretch of conversation. The user
 * never sees it; the Studio can view, edit and delete it.
 *
 * Invariants (each has a test in tests/coachClipboard.test.js):
 *   - A write is a list of OPERATIONS applied by applyOps(), never a new
 *     document: anything an operation doesn't name stays exactly as it was.
 *   - Items a human edited in the Studio (by: 'studio') are locked — the
 *     distiller can only `touch` them.
 *   - The rendered block never exceeds BLOCK_ITEMS_MAX_CHARS of items.
 *   - Only distilled facts are stored. Transcripts pass through the model
 *     call and are dropped; contact details and URLs are filtered on write.
 *
 * Keys: `user-<userId>` for signed-in visits, `ctid-<CleverTap objectId>`
 * for guests (the same scheme lib/activity.js uses). Guest records expire
 * GUEST_TTL_DAYS after the last visit; a visit carrying both ids adopts
 * the guest record into the user's.
 *
 * Identity is trusted from the client, exactly like conversation history
 * today — see the design note on PR #23 for why and what hardens it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = path.dirname(process.env.SESSION_DATA_DIR || '/data/sessions');
const DATA_DIR = process.env.CLIPBOARD_DATA_DIR || path.join(DATA_ROOT, 'clipboard');

const KINDS = ['goal', 'blocker', 'preference', 'journey', 'note'];
// Active items rendered per kind (the budget is what gets injected on every
// boot, so it stays small on purpose).
const RENDER_CAPS = { journey: 1, goal: 3, blocker: 3, preference: 3, note: 4 };
// Active items kept per kind. Goals/blockers/preferences refuse a new add at
// the cap (the distiller must resolve one first); notes roll over, oldest out.
const STORE_CAPS = { journey: 1, goal: 3, blocker: 3, preference: 3, note: 10 };
const TEXT_MAX = 160;
const REASON_MAX = 120;
const BLOCK_ITEMS_MAX_CHARS = 1400;
const RESOLVED_KEEP = 20;
const WRITES_KEEP = 30;
const FILE_MAX_BYTES = 16 * 1024;
const STALE_DAYS = 60;
const GUEST_TTL_DAYS = 90;
// One-way hashes of turns already distilled, per person. A new page resends
// the restored history (the client's cursor is per page); without these, old
// turns were re-read on every visit — and a note deleted in the Studio came
// back from history that still mentioned it.
const DISTILLED_HASHES_KEEP = 200;

const LABELS = { goal: 'Goal', blocker: 'Blocker', preference: 'Preference', journey: 'Journey', note: 'Note' };

function ensureDir() {
    try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
    catch (e) { console.warn('[clipboard] could not ensure data dir:', DATA_DIR, e?.message || e); }
}

function sanitize(id) {
    return String(id || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}

/** `user-<id>` when signed in, else `ctid-<objectId>`, else null (no notes). */
function keyFor({ userId, objectId } = {}) {
    if (userId && String(userId).trim()) return 'user-' + sanitize(String(userId).trim());
    if (objectId && String(objectId).trim()) return 'ctid-' + sanitize(String(objectId).trim());
    return null;
}

function isValidKey(key) {
    return typeof key === 'string' && /^(user|ctid)-[A-Za-z0-9_.-]{1,128}$/.test(key);
}

function fileFor(key) {
    if (!isValidKey(key)) throw new Error('clipboard: invalid key');
    return path.join(DATA_DIR, key + '.json');
}

function emptyRecord(key, now = new Date()) {
    const t = now.toISOString();
    return { v: 1, key, createdAt: t, updatedAt: t, lastVisitAt: null, lastCursor: null, items: [], writes: [] };
}

function read(key) {
    if (!isValidKey(key)) return null;
    const p = fileFor(key);
    try {
        if (!fs.existsSync(p)) return null;
        const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!rec || typeof rec !== 'object' || !Array.isArray(rec.items)) return null;
        if (!Array.isArray(rec.writes)) rec.writes = [];
        return rec;
    } catch (e) {
        console.warn('[clipboard] read failed:', key, e?.message || e);
        return null;
    }
}

function write(record) {
    ensureDir();
    const p = fileFor(record.key);
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 1), 'utf8');
    fs.renameSync(tmp, p);
    return true;
}

function remove(key) {
    if (!isValidKey(key)) return false;
    const p = fileFor(key);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
}

function list() {
    ensureDir();
    let names = [];
    try { names = fs.readdirSync(DATA_DIR).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
    const out = [];
    for (const n of names) {
        const rec = read(n.slice(0, -5));
        if (rec) out.push(rec);
    }
    return out.sort((a, b) => String(b.lastVisitAt || b.updatedAt).localeCompare(String(a.lastVisitAt || a.updatedAt)));
}

/**
 * The key this visit reads and writes. When a signed-in visit also carries
 * the browser's CleverTap id and only the guest record exists, the guest
 * record becomes the user's (renamed + logged) so notes made before sign-in
 * aren't lost. Never merges two existing records.
 */
function resolveKey({ userId, objectId } = {}, { now = new Date() } = {}) {
    const key = keyFor({ userId, objectId });
    if (!key || !key.startsWith('user-') || !objectId) return { key, adopted: false };
    const guestKey = keyFor({ objectId });
    try {
        if (read(key) || !read(guestKey)) return { key, adopted: false };
        const rec = read(guestKey);
        rec.key = key;
        rec.adoptedFrom = guestKey;
        rec.writes.push({ at: now.toISOString(), by: 'adopt', from: guestKey });
        write(rec);
        remove(guestKey);
        console.log(`[clipboard] adopted guest record ${guestKey} into ${key}`);
        return { key, adopted: true };
    } catch (e) {
        console.warn('[clipboard] adoption failed:', guestKey, '→', key, e?.message || e);
        return { key, adopted: false };
    }
}

/** Guest records not visited for GUEST_TTL_DAYS are deleted. Returns count. */
function sweepExpiredGuests({ now = new Date() } = {}) {
    const cutoff = now.getTime() - GUEST_TTL_DAYS * 86400000;
    let n = 0;
    for (const rec of list()) {
        if (!rec.key.startsWith('ctid-')) continue;
        const last = new Date(rec.lastVisitAt || rec.updatedAt || rec.createdAt).getTime();
        if (isFinite(last) && last < cutoff) {
            try { if (remove(rec.key)) n++; } catch (_) { /* next sweep */ }
        }
    }
    if (n) console.log(`[clipboard] swept ${n} guest record(s) not visited in ${GUEST_TTL_DAYS} days`);
    return n;
}

// ---------------------------------------------------------------------------
// Text hygiene — what the clipboard must never hold.
// ---------------------------------------------------------------------------

/**
 * One line, ≤ TEXT_MAX chars, no contact details or links. Returns '' when
 * nothing usable is left (the caller rejects the operation).
 */
function cleanText(text, max = TEXT_MAX) {
    if (typeof text !== 'string') return '';
    let s = text
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/https?:\/\/\S+|www\.\S+/gi, '')
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '')
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
    return /[A-Za-z0-9À-ɏ]/.test(s) ? s : '';
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, ' ').trim();

function newItemId(existing) {
    let id;
    do { id = 'i' + crypto.randomBytes(3).toString('hex'); } while (existing.has(id));
    existing.add(id);
    return id;
}

// ---------------------------------------------------------------------------
// applyOps — the only way content changes (distiller and Studio alike).
// ---------------------------------------------------------------------------

/**
 * Apply operations to a COPY of the record. Pure: the input is not mutated.
 *
 * ops: [{ op: 'add'|'update'|'resolve'|'touch'|'remove', id?, kind?, text?, status?, reason? }]
 * ctx: { by: 'distill'|'studio', sessionId, visitAt, now: Date, actor? }
 *
 * Returns { record, diff: { added, updated, resolved, removed, touched, rejected: [{op, reason}] } }
 */
function applyOps(input, ops, ctx = {}) {
    const record = JSON.parse(JSON.stringify(input));
    const now = (ctx.now || new Date()).toISOString();
    const by = ctx.by === 'studio' ? 'studio' : 'distill';
    const source = { sessionId: ctx.sessionId || null, visitAt: ctx.visitAt || null };
    const diff = { added: 0, updated: 0, resolved: 0, removed: 0, touched: 0, rejected: [] };
    const ids = new Set(record.items.map((i) => i.id));
    const byId = (id) => record.items.find((i) => i.id === id);
    const reject = (op, reason) => diff.rejected.push({ op: op && op.op, id: op && op.id, reason });
    const lockedFor = (item) => item.by === 'studio' && by !== 'studio';

    for (const op of Array.isArray(ops) ? ops : []) {
        if (!op || typeof op !== 'object') { reject(op, 'not an object'); continue; }
        switch (op.op) {
            case 'add': {
                if (!KINDS.includes(op.kind)) { reject(op, 'unknown kind'); break; }
                const text = cleanText(op.text);
                if (!text) { reject(op, 'empty text after filtering'); break; }
                const active = record.items.filter((i) => i.kind === op.kind && i.status === 'active');
                const dup = active.find((i) => norm(i.text) === norm(text));
                if (dup) { dup.lastSeen = now; diff.touched++; break; }
                if (op.kind === 'journey' && active.length) {
                    // One "where they are" line: a new one replaces the old.
                    const cur = active[0];
                    if (lockedFor(cur)) { reject(op, 'journey is locked (edited in the Studio)'); break; }
                    cur.text = text; cur.lastSeen = now; cur.lastSource = source; cur.by = by;
                    diff.updated++;
                    break;
                }
                if (op.kind !== 'note' && active.length >= STORE_CAPS[op.kind]) {
                    reject(op, `${op.kind} cap (${STORE_CAPS[op.kind]}) reached — resolve one first`);
                    break;
                }
                record.items.push({
                    id: newItemId(ids), kind: op.kind, text, status: 'active',
                    firstSeen: now, lastSeen: now, source, by,
                });
                diff.added++;
                break;
            }
            case 'update': {
                const item = byId(op.id);
                if (!item) { reject(op, 'unknown id'); break; }
                if (lockedFor(item)) { reject(op, 'locked (edited in the Studio)'); break; }
                const text = op.text === undefined || op.text === null ? null : cleanText(op.text);
                if (op.text !== undefined && op.text !== null && !text) { reject(op, 'empty text after filtering'); break; }
                if (text) item.text = text;
                if (by === 'studio' && (op.status === 'active' || op.status === 'done' || op.status === 'dropped')) {
                    item.status = op.status;
                    if (op.status === 'active') delete item.resolvedAt; else item.resolvedAt = now;
                }
                item.lastSeen = now; item.lastSource = source; item.by = by;
                diff.updated++;
                break;
            }
            case 'resolve': {
                const item = byId(op.id);
                if (!item) { reject(op, 'unknown id'); break; }
                if (lockedFor(item)) { reject(op, 'locked (edited in the Studio)'); break; }
                if (item.status !== 'active') { reject(op, 'already resolved'); break; }
                item.status = op.status === 'dropped' ? 'dropped' : 'done';
                item.resolvedAt = now;
                item.resolvedReason = cleanText(op.reason || '', REASON_MAX) || null;
                item.lastSource = source;
                diff.resolved++;
                break;
            }
            case 'touch': {
                const item = byId(op.id);
                if (!item) { reject(op, 'unknown id'); break; }
                item.lastSeen = now;
                diff.touched++;
                break;
            }
            case 'remove': {
                const item = byId(op.id);
                if (!item) { reject(op, 'unknown id'); break; }
                if (lockedFor(item)) { reject(op, 'locked (edited in the Studio)'); break; }
                if (by !== 'studio' && !cleanText(op.reason || '', REASON_MAX)) { reject(op, 'remove needs a reason (the person asked to forget)'); break; }
                record.items = record.items.filter((i) => i !== item);
                diff.removed++;
                break;
            }
            default:
                reject(op, 'unknown op');
        }
    }

    enforceStoreBudget(record);
    if (diff.added || diff.updated || diff.resolved || diff.removed || diff.touched) record.updatedAt = now;
    return { record, diff };
}

/** Notes roll over; resolved history and the write log are bounded. */
function enforceStoreBudget(record) {
    const activeNotes = record.items.filter((i) => i.kind === 'note' && i.status === 'active')
        .sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
    const dropNotes = new Set(activeNotes.slice(STORE_CAPS.note).filter((n) => n.by !== 'studio'));
    const resolved = record.items.filter((i) => i.status !== 'active')
        .sort((a, b) => String(b.resolvedAt || b.lastSeen).localeCompare(String(a.resolvedAt || a.lastSeen)));
    const dropResolved = new Set(resolved.slice(RESOLVED_KEEP));
    if (dropNotes.size || dropResolved.size) {
        record.items = record.items.filter((i) => !dropNotes.has(i) && !dropResolved.has(i));
    }
    if (record.writes.length > WRITES_KEEP) record.writes = record.writes.slice(-WRITES_KEEP);
    if (Array.isArray(record.distilledHashes) && record.distilledHashes.length > DISTILLED_HASHES_KEEP) {
        record.distilledHashes = record.distilledHashes.slice(-DISTILLED_HASHES_KEEP);
    }
    // Hard ceiling: shed the oldest resolved, then the oldest write entries.
    while (Buffer.byteLength(JSON.stringify(record)) > FILE_MAX_BYTES) {
        const oldestResolved = record.items.filter((i) => i.status !== 'active')
            .sort((a, b) => String(a.resolvedAt || a.lastSeen).localeCompare(String(b.resolvedAt || b.lastSeen)))[0];
        if (oldestResolved) { record.items = record.items.filter((i) => i !== oldestResolved); continue; }
        if (record.writes.length > 1) { record.writes.shift(); continue; }
        break;
    }
    return record;
}

// ---------------------------------------------------------------------------
// render — the block Erica gets after the history replay.
// ---------------------------------------------------------------------------

const RENDER_ORDER = ['journey', 'goal', 'blocker', 'preference', 'note'];

function day(iso) { return String(iso || '').slice(0, 10); }

/**
 * The active items as hard-fact lines + the usage rules, or '' when there is
 * nothing to say. Items beyond RENDER_CAPS or the char budget are left out
 * (most recent first within a kind) — `omitted` says how many.
 */
function render(record, { now = new Date() } = {}) {
    if (!record || !Array.isArray(record.items)) return { text: '', lines: 0, omitted: 0 };
    const staleBefore = now.getTime() - STALE_DAYS * 86400000;
    const lines = [];
    let used = 0; let omitted = 0;
    for (const kind of RENDER_ORDER) {
        const items = record.items.filter((i) => i.kind === kind && i.status === 'active')
            .sort((a, b) => String(b.lastSeen || b.firstSeen).localeCompare(String(a.lastSeen || a.firstSeen)));
        items.forEach((item, idx) => {
            if (idx >= RENDER_CAPS[kind]) { omitted++; return; }
            const seen = new Date(item.lastSeen || item.firstSeen).getTime();
            const when = kind === 'note' ? ` ${day(item.firstSeen)}` : ` (since ${day(item.firstSeen)})`;
            const stale = isFinite(seen) && seen < staleBefore ? ` (from ${day(item.lastSeen || item.firstSeen)} — check if still relevant)` : '';
            const line = `- ${LABELS[kind]}${when}: ${item.text}${stale}`;
            if (used + line.length + 1 > BLOCK_ITEMS_MAX_CHARS) { omitted++; return; }
            lines.push(line); used += line.length + 1;
        });
    }
    if (!lines.length) return { text: '', lines: 0, omitted };
    const text = [
        '=== COACH CLIPBOARD — your private notes about this person from earlier sessions (context about them, not a knowledge source) ===',
        ...lines,
        'Use: early in this conversation, check in on the most recent active goal or blocker in your own words, without waiting to be asked.',
        'Never read this list aloud or mention notes, a clipboard or memory. If the user asks what you remember about them, say it plainly in one or two sentences. If something seems outdated, ask.',
        'Courses, quizzes and resources still come ONLY from the canonical lists and search_knowledge; a preference here shapes which one you pick, never what exists.',
        '=== END COACH CLIPBOARD ===',
    ].join('\n');
    return { text, lines: lines.length, omitted };
}

// ---------------------------------------------------------------------------
// distill — the model call that turns new conversation into operations.
// ---------------------------------------------------------------------------

const OPS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['ops'],
    properties: {
        ops: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['op', 'id', 'kind', 'text', 'status', 'reason'],
                properties: {
                    op: { type: 'string', enum: ['add', 'update', 'resolve', 'touch', 'remove'] },
                    id: { type: ['string', 'null'] },
                    kind: { type: ['string', 'null'], enum: [...KINDS, null] },
                    text: { type: ['string', 'null'] },
                    status: { type: ['string', 'null'], enum: ['done', 'dropped', null] },
                    reason: { type: ['string', 'null'] },
                },
            },
        },
    },
};

const DISTILL_SYSTEM = [
    'You keep a career coach\'s private clipboard about ONE person: short notes the coach reads before the next conversation.',
    'You receive the current clipboard (items with ids) and the newest conversation turns. Return operations that keep the clipboard true and useful.',
    '',
    'Item kinds:',
    '- goal: something the person is working toward (e.g. "Preparing for an interview at Acme").',
    '- blocker: what gets in their way (e.g. "Freezes on salary questions").',
    '- preference: how they like to be coached or learn (e.g. "Prefers short practical exercises over reading").',
    '- journey: where they are right now, one line (e.g. "Job searching; two interviews scheduled this month").',
    '- note: any other dated observation worth remembering next time.',
    '',
    'Operations:',
    '- add {kind, text}: a NEW fact the person stated or clearly showed. Check the existing items first — prefer update/touch over a near-duplicate add.',
    '- update {id, text}: the fact changed or got more precise.',
    '- resolve {id, status: "done"|"dropped", reason}: the person achieved it, or said it no longer applies.',
    '- touch {id}: the PERSON brought the item up again in these turns and it is still true (not when only the coach mentioned it).',
    '- remove {id, reason}: ONLY when the person explicitly asked the coach to forget it.',
    'Items not discussed need NO operation — leave them alone. Do not resolve a goal just because it wasn\'t mentioned.',
    'Items marked (locked) were edited by a human: you may only touch them.',
    '',
    'Rules:',
    '- Facts about the person only. Never record what the coach said, suggested or taught, and never small talk.',
    '- Give priority to anything the person explicitly asked the coach to remember.',
    '- Each text: a short third-person fragment, at most 120 characters, in English whatever language the conversation used. Paraphrase; never quote.',
    '- Never store contact details, links, account or ID numbers, or other people\'s names (use roles: "their manager").',
    '- Never store health, religion, sexuality, political views or immigration status unless the person framed it as a coaching goal or blocker AND asked the coach to remember it.',
    '- Use null for fields an operation does not need. Return {"ops": []} when nothing new was learned.',
].join('\n');

function formatClipboardForPrompt(record, now = new Date()) {
    const active = (record && record.items || []).filter((i) => i.status === 'active');
    if (!active.length) return '(empty)';
    return active.map((i) => {
        const age = Math.max(0, Math.round((now.getTime() - new Date(i.lastSeen || i.firstSeen).getTime()) / 86400000));
        return `${i.id} · ${i.kind} · since ${day(i.firstSeen)} · last seen ${age}d ago${i.by === 'studio' ? ' · (locked)' : ''} · ${i.text}`;
    }).join('\n');
}

/** Bound and shape the client's turns: user/assistant text only. */
function sanitizeTurns(turns, { maxTurns = 60, maxChars = 24000, maxPerTurn = 2000 } = {}) {
    const out = [];
    let chars = 0;
    const list = (Array.isArray(turns) ? turns : []).slice(-maxTurns);
    for (const t of list) {
        if (!t || typeof t.text !== 'string') continue;
        const role = t.role === 'user' ? 'user' : (t.role === 'assistant' || t.role === 'coach' ? 'assistant' : null);
        if (!role) continue;
        const text = t.text.replace(/\s+/g, ' ').trim().slice(0, maxPerTurn);
        if (!text) continue;
        out.push({ role, text });
        chars += text.length;
    }
    while (chars > maxChars && out.length) chars -= out.shift().text.length;
    return out;
}

/** Short one-way hash of a turn (role + normalised text); no content kept. */
function turnHash(t) {
    return crypto.createHash('sha256').update((t.role === 'user' ? 'u' : 'a') + '|' + norm(t.text)).digest('hex').slice(0, 12);
}

/**
 * Split the client's turns into what this person's clipboard has already
 * read (context, at most 2 turns right before the first unseen one) and
 * what is new. Returns { fresh, context, hashes }.
 */
function splitSeenTurns(record, turns) {
    const seen = new Set((record && record.distilledHashes) || []);
    const hashes = turns.map(turnHash);
    const firstNew = hashes.findIndex((h) => !seen.has(h));
    if (firstNew < 0) return { fresh: [], context: [], hashes };
    const fresh = turns.slice(firstNew).filter((_, i) => !seen.has(hashes[firstNew + i]));
    const context = turns.slice(Math.max(0, firstNew - 2), firstNew);
    return { fresh, context, hashes };
}

function outputText(response) {
    let s = '';
    for (const item of (response && response.output) || []) {
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) if (c.type === 'output_text' || c.type === 'text') s += c.text || '';
        }
    }
    return s;
}

/**
 * Ask the model for operations. Throws on API or parse failure — the caller
 * logs loudly and writes nothing.
 */
async function distill({ client, model, record, turns, context = [], now = new Date() }) {
    if (!client) throw new Error('OpenAI client not initialised');
    const fmt = (list) => list.map((t) => `${t.role === 'user' ? 'Person' : 'Coach'}: ${t.text}`).join('\n');
    const transcript = (context.length ? `(Earlier turns, already noted — context only:)\n${fmt(context)}\n\n(New turns:)\n` : '') + fmt(turns);
    const response = await client.responses.create({
        model,
        input: [
            { role: 'system', content: DISTILL_SYSTEM },
            { role: 'user', content: `Today: ${day(now.toISOString())}\n\nCurrent clipboard:\n${formatClipboardForPrompt(record, now)}\n\nNewest conversation turns (oldest first):\n${transcript}` },
        ],
        text: { format: { type: 'json_schema', name: 'clipboard_ops', schema: OPS_SCHEMA, strict: true } },
    });
    const raw = outputText(response);
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw new Error('distill output is not JSON: ' + raw.slice(0, 200)); }
    if (!parsed || !Array.isArray(parsed.ops)) throw new Error('distill output has no ops array');
    // Strip the nulls strict mode requires, so applyOps sees plain optional fields.
    const ops = parsed.ops.map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)));
    return { ops, usage: response.usage || null, model: response.model || model, responseId: response.id || null };
}

// ---------------------------------------------------------------------------
// Orchestration — one distill per (person, cursor), logged either way.
// ---------------------------------------------------------------------------

const DISTILL_MIN_INTERVAL_MS = 30 * 1000;
const inFlight = new Set();          // key
const lastRunAt = new Map();         // key -> ms

/**
 * Distil the client's newest turns into the person's clipboard.
 *
 * deps: { client, model, sessionLog, now }
 * Returns { ok, skipped?, key?, diff?, error? } — never the clipboard text:
 * this runs from an unauthenticated endpoint.
 */
async function runDistill(req, deps = {}) {
    const { userId, objectId, sessionId, cursor, visitAt, caller } = req || {};
    const now = deps.now || new Date();
    const log = deps.sessionLog || null;
    const logEvent = (name, meta) => { try { if (log && sessionId) log.logEvent(sessionId, { name, meta }); } catch (_) {} };

    if (String(caller || '').toLowerCase().includes('simulator')) return { ok: true, skipped: 'simulator' };
    const { key } = resolveKey({ userId, objectId }, { now });
    if (!key) return { ok: true, skipped: 'no_identity' };
    const turns = sanitizeTurns(req.turns);
    if (!turns.some((t) => t.role === 'user')) return { ok: true, skipped: 'no_user_turns', key };
    const record = read(key) || emptyRecord(key, now);
    if (cursor && record.lastCursor === cursor) return { ok: true, skipped: 'duplicate', key };
    const { fresh, context, hashes } = splitSeenTurns(record, turns);
    if (!fresh.some((t) => t.role === 'user')) return { ok: true, skipped: 'no_new_turns', key };
    if (inFlight.has(key)) return { ok: true, skipped: 'in_flight', key };
    const last = lastRunAt.get(key);
    if (last && now.getTime() - last < DISTILL_MIN_INTERVAL_MS) return { ok: true, skipped: 'throttled', key };

    inFlight.add(key);
    lastRunAt.set(key, now.getTime());
    try {
        let result;
        try {
            result = await distill({ client: deps.client, model: deps.model, record, turns: fresh, context, now });
        } catch (e) {
            const reason = String(e && e.message || e).slice(0, 300);
            console.warn(`[clipboard] ⚠️ distill FAILED for ${key} (session ${sessionId || '?'}) — nothing written: ${reason}`);
            logEvent('clipboard_error', { key, reason, model: deps.model || null, turns: turns.length });
            return { ok: false, error: 'distill_failed', key };
        }
        if (log && sessionId && result.usage) {
            try {
                log.logUsage(sessionId, { source: 'clipboard.distill', model: result.model, responseId: result.responseId, usage: result.usage });
            } catch (e) { console.warn('[clipboard] usage log failed:', e?.message || e); }
        }
        // Re-read: a Studio edit may have landed while the model was thinking.
        const latest = read(key) || record;
        const before = Buffer.byteLength(JSON.stringify(latest));
        const { record: next, diff } = applyOps(latest, result.ops, { by: 'distill', sessionId, visitAt, now });
        next.lastCursor = cursor || next.lastCursor || null;
        next.distilledHashes = [...new Set([...(next.distilledHashes || []), ...hashes])];
        next.lastVisitAt = now.toISOString();
        const after = Buffer.byteLength(JSON.stringify(next));
        next.writes.push({
            at: now.toISOString(), by: 'distill', sessionId: sessionId || null, visitAt: visitAt || null,
            added: diff.added, updated: diff.updated, resolved: diff.resolved, removed: diff.removed, touched: diff.touched,
            rejected: diff.rejected.length, bytes: after - before, model: result.model,
        });
        enforceStoreBudget(next);
        write(next);
        const meta = {
            key, model: result.model, turns: fresh.length, contextTurns: context.length, ops: result.ops.length,
            added: diff.added, updated: diff.updated, resolved: diff.resolved, removed: diff.removed, touched: diff.touched,
            rejected: diff.rejected, bytesBefore: before, bytesAfter: after,
        };
        logEvent('clipboard_write', meta);
        if (diff.rejected.length) console.warn(`[clipboard] ${key}: ${diff.rejected.length} op(s) rejected:`, JSON.stringify(diff.rejected).slice(0, 400));
        console.log(`[clipboard] ${key} ← session ${sessionId || '?'}: +${diff.added} ~${diff.updated} ✓${diff.resolved} −${diff.removed} ·${diff.touched} (${before}→${after} bytes)`);
        return { ok: true, key, diff: { added: diff.added, updated: diff.updated, resolved: diff.resolved, removed: diff.removed, touched: diff.touched, rejected: diff.rejected.length } };
    } finally {
        inFlight.delete(key);
    }
}

/** The block this visit gets at boot ('' when none), plus bookkeeping. */
function blockForVisit({ userId, objectId, caller } = {}, { now = new Date() } = {}) {
    if (String(caller || '').toLowerCase().includes('simulator')) return { key: null, text: '', lines: 0 };
    const { key, adopted } = resolveKey({ userId, objectId }, { now });
    if (!key) return { key: null, text: '', lines: 0 };
    const rec = read(key);
    if (!rec) return { key, text: '', lines: 0, adopted };
    try {
        // A visit keeps a guest record alive (the 90-day expiry counts from here).
        rec.lastVisitAt = now.toISOString();
        write(rec);
    } catch (e) { console.warn('[clipboard] lastVisitAt write failed:', key, e?.message || e); }
    return { key, adopted, ...render(rec, { now }) };
}

/** Studio: apply human operations (locked from then on) and audit counts. */
function studioApply(key, ops, { actor = 'admin', audit = null, now = new Date() } = {}) {
    if (!isValidKey(key)) throw new Error('invalid key');
    const rec = read(key) || emptyRecord(key, now);
    const { record, diff } = applyOps(rec, ops, { by: 'studio', sessionId: null, visitAt: null, now });
    record.writes.push({ at: now.toISOString(), by: 'studio', actor, added: diff.added, updated: diff.updated, resolved: diff.resolved, removed: diff.removed, rejected: diff.rejected.length });
    enforceStoreBudget(record);
    write(record);
    const action = diff.removed ? 'clipboard.delete' : diff.added ? 'clipboard.add' : 'clipboard.edit';
    if (audit) audit.append({ actor, action, target: key, meta: { added: diff.added, updated: diff.updated, removed: diff.removed, rejected: diff.rejected.length } });
    return { record, diff };
}

/** Studio: delete everything about the person. Logged with a count, no content. */
function wipe(key, { actor = 'admin', audit = null, now = new Date() } = {}) {
    if (!isValidKey(key)) throw new Error('invalid key');
    const rec = read(key);
    const items = rec ? rec.items.length : 0;
    let removed = false;
    if (rec) {
        // Every note and the write log go. What stays is a tombstone: the
        // one-way hashes of turns already read (no readable content), so the
        // person's old conversation history can't recreate the notes, and
        // the visit date the guest expiry counts from.
        const t = now.toISOString();
        write({
            v: 1, key, createdAt: rec.createdAt || t, updatedAt: t, wipedAt: t, lastVisitAt: rec.lastVisitAt || null,
            lastCursor: rec.lastCursor || null, items: [], writes: [{ at: t, by: 'wipe', actor, items }],
            distilledHashes: rec.distilledHashes || [],
        });
        removed = items > 0;
    }
    if (audit) audit.append({ actor, action: 'clipboard.wipe', target: key, meta: { items, existed: !!rec } });
    console.log(`[clipboard] wiped ${key} (${items} items) by ${actor}`);
    return { removed, items };
}

module.exports = {
    DATA_DIR, KINDS, RENDER_CAPS, STORE_CAPS, TEXT_MAX, BLOCK_ITEMS_MAX_CHARS, STALE_DAYS, GUEST_TTL_DAYS, FILE_MAX_BYTES,
    keyFor, isValidKey, resolveKey, emptyRecord, read, write, remove, list, sweepExpiredGuests,
    cleanText, applyOps, enforceStoreBudget, render, sanitizeTurns, distill, formatClipboardForPrompt,
    runDistill, blockForVisit, studioApply, wipe, turnHash, splitSeenTurns,
    OPS_SCHEMA, DISTILL_SYSTEM,
    _reset: () => { inFlight.clear(); lastRunAt.clear(); },
};
