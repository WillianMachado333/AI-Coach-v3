/*
 * Injected Data store — the three canonical lists that get baked into the
 * coach's system prompt on every turn.
 *
 *   canonical-courses   {course_id, name, url, one_line}
 *   canonical-quizzes   {quiz_id,   name, url, one_line}
 *   safety-rules        {rule_id,   trigger_hint, prescribed_response, enabled}
 *
 * All three persist to /data/injected/*.json (or INJECTED_DATA_DIR).
 * An upsert is a merge (planUpsert): a field left out keeps its value, a new
 * row needs its required fields. Each write is audited with the row before
 * and after. A `computeSystemPromptBlock()` helper renders the
 * effective text for a given list; consumers can call it from the coach
 * preparation flow later. This module is deliberately generic — no
 * runtime coupling to the coach yet.
 */

const fs = require('fs');
const path = require('path');
const audit = require('./audit');

const ROOT = process.env.INJECTED_DATA_DIR
    || path.join(process.env.SESSION_DATA_DIR ? path.dirname(process.env.SESSION_DATA_DIR) : '/data', 'injected');

function ensureDir() { try { fs.mkdirSync(ROOT, { recursive: true }); } catch (_) { /* ignore */ } }
ensureDir();

// Kinds map: id -> { file, primaryKey, fields, headerLabel }
// primaryKey is the field that gives each row its unique id in the array.
// fields lists all editable field names (validated on write).
// required: a new row must give them; an edit cannot empty them.
// headerLabel is what appears at the top of the system prompt block.
const KINDS = {
    'canonical-courses': {
        file: 'canonical-courses.json',
        primaryKey: 'course_id',
        fields: ['course_id', 'name', 'url', 'one_line'],
        required: ['course_id', 'name'],
        headerLabel: 'CANONICAL COURSES (use these names + URLs; never invent)',
        rowNoun: 'course',
        blurb: 'Course names Erica may cite + their Wix URLs. When the coach mentions a course she is required to use the exact name and URL from this list.'
    },
    'canonical-quizzes': {
        file: 'canonical-quizzes.json',
        primaryKey: 'quiz_id',
        fields: ['quiz_id', 'name', 'url', 'one_line'],
        required: ['quiz_id', 'name'],
        headerLabel: 'CANONICAL QUIZZES (use these names + URLs; never invent)',
        rowNoun: 'quiz',
        blurb: 'Quiz names + URLs. Same rule as courses — Erica cites from this list, never invents a link.'
    },
    'safety-rules': {
        file: 'safety-rules.json',
        primaryKey: 'rule_id',
        fields: ['rule_id', 'trigger_hint', 'prescribed_response', 'enabled'],
        // enabled too: a new rule says whether it is on, never off by omission.
        required: ['rule_id', 'trigger_hint', 'prescribed_response', 'enabled'],
        headerLabel: 'SAFETY RULES (highest priority; apply before any coaching move)',
        rowNoun: 'rule',
        blurb: 'When the user says something matching a trigger, Erica must respond as prescribed. Toggle individual rules on/off. Disabled rules do not enter the prompt.'
    }
};

function kindExists(kind) { return Object.prototype.hasOwnProperty.call(KINDS, kind); }
function kindMeta(kind) { return KINDS[kind]; }
function kindList() { return Object.keys(KINDS).map((id) => ({ id, ...KINDS[id] })); }

function filePath(kind) {
    if (!kindExists(kind)) throw new Error('unknown kind: ' + kind);
    return path.join(ROOT, KINDS[kind].file);
}

function readAll(kind) {
    try {
        const raw = fs.readFileSync(filePath(kind), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
}
function writeAll(kind, rows) {
    ensureDir();
    fs.writeFileSync(filePath(kind), JSON.stringify(rows, null, 2), 'utf8');
}

function cleanValue(field, v) {
    if (field === 'enabled') return v === true || v === 'true' || v === '1' || v === 'on';
    return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
}

function sanitizeRow(kind, incoming) {
    const out = {};
    for (const f of kindMeta(kind).fields) out[f] = cleanValue(f, incoming[f]);
    return out;
}

/**
 * What an upsert writes: the row as it is now, with the fields given on top.
 * A field left out (undefined) keeps its value, so changing one field is the
 * id plus that field; '' or null empties it. A new row needs every required
 * field, an edit cannot empty one, and an unknown field is refused rather
 * than dropped. The MCP preview and the write both run this, so a preview
 * shows exactly what will be written.
 * Returns { id, isNew, before, row, changed }.
 */
function planUpsert(kind, incoming) {
    if (!kindExists(kind)) throw new Error('unknown kind: ' + kind);
    const meta = kindMeta(kind);
    const noun = meta.rowNoun;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('row must be an object with ' + meta.fields.join(', '));
    const unknown = Object.keys(incoming).filter((k) => !meta.fields.includes(k));
    if (unknown.length) throw new Error('unknown field' + (unknown.length > 1 ? 's' : '') + ': ' + unknown.join(', ') + ' (a ' + noun + ' has ' + meta.fields.join(', ') + ')');
    const id = cleanValue(meta.primaryKey, incoming[meta.primaryKey]);
    if (!id) throw new Error(meta.primaryKey + ' is required');
    // Basic id charset guard.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
        throw new Error(meta.primaryKey + ' must be alphanumeric (with dash/underscore), max 64 chars');
    }
    const given = meta.fields.filter((f) => incoming[f] !== undefined);
    const before = readAll(kind).find((r) => r[meta.primaryKey] === id) || null;
    const merged = { ...(before || {}) };
    for (const f of given) merged[f] = incoming[f];
    merged[meta.primaryKey] = id;
    const row = sanitizeRow(kind, merged);
    const empty = (f) => f !== 'enabled' && row[f] === '';
    const required = meta.required || [meta.primaryKey];
    if (!before) {
        const missing = required.filter((f) => !given.includes(f) || empty(f));
        if (missing.length) throw new Error('A new ' + noun + ' needs ' + missing.join(', ') + ' (send the whole ' + noun + ': ' + meta.fields.join(', ') + ')');
    } else {
        const emptied = required.filter((f) => given.includes(f) && empty(f));
        if (emptied.length) throw new Error(emptied.join(', ') + ' cannot be empty');
    }
    const changed = meta.fields.filter((f) => !before || before[f] !== row[f]);
    return { id, isNew: !before, before, row, changed };
}

// The audit keeps the row as it was and as it became, so a change can be put
// back by hand.
function upsertRow(kind, incoming, { actor = 'admin', reason = null, via = 'studio' } = {}) {
    const meta = kindMeta(kind);
    const plan = planUpsert(kind, incoming);
    const rows = readAll(kind);
    const idx = rows.findIndex((r) => r[meta.primaryKey] === plan.id);
    if (idx < 0) rows.push(plan.row); else rows[idx] = plan.row;
    writeAll(kind, rows);
    audit.append({
        actor,
        via,
        action: 'injected.' + kind + '.' + (plan.isNew ? 'create' : 'update'),
        target: kind + '/' + plan.id,
        meta: { row: Object.keys(plan.row), reason, before: plan.before, after: plan.row, changed: plan.changed }
    });
    return plan.row;
}

function deleteRow(kind, id, { actor = 'admin', reason = null, via = 'studio' } = {}) {
    const meta = kindMeta(kind);
    const rows = readAll(kind);
    const before = rows.find((r) => r[meta.primaryKey] === id) || null;
    const next = rows.filter((r) => r[meta.primaryKey] !== id);
    if (next.length === rows.length) return { deleted: false };
    writeAll(kind, next);
    audit.append({
        actor,
        via,
        action: 'injected.' + kind + '.delete',
        target: kind + '/' + id,
        meta: { reason, before }
    });
    return { deleted: true };
}

/**
 * Compose the text block that would be injected into the coach's system
 * prompt for a given kind. Consumers (coach preparation) call this to
 * embed the list. Returns '' when the list is empty so we never inject
 * an empty header.
 */
function computeSystemPromptBlock(kind) {
    if (!kindExists(kind)) return '';
    const meta = kindMeta(kind);
    const rows = readAll(kind);
    // Safety rules only count when enabled=true.
    const active = kind === 'safety-rules' ? rows.filter((r) => r.enabled) : rows;
    if (!active.length) return '';
    const header = '=== ' + meta.headerLabel + ' ===';
    const body = active.map((r) => {
        if (kind === 'safety-rules') {
            return '- IF the user says something like [' + r.trigger_hint + '] THEN ' + r.prescribed_response;
        }
        // canonical lists
        const parts = ['- ' + r.name];
        if (r.url) parts.push('(' + r.url + ')');
        if (r.one_line) parts.push('— ' + r.one_line);
        return parts.join(' ');
    }).join('\n');
    return header + '\n' + body + '\n=== END ' + meta.headerLabel.split(' (')[0] + ' ===';
}

/**
 * Small helper: how many chars each list would add to the system prompt.
 * Used by the coach identity card to show effective budget.
 */
function computeChars() {
    const out = {};
    for (const kind of Object.keys(KINDS)) {
        out[kind] = computeSystemPromptBlock(kind).length;
    }
    return out;
}

module.exports = {
    kindExists,
    kindMeta,
    kindList,
    readAll,
    planUpsert,
    upsertRow,
    deleteRow,
    computeSystemPromptBlock,
    computeChars,
    KINDS,
    _paths: { ROOT }
};
