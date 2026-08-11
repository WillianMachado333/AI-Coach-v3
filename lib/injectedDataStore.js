/*
 * Injected Data store — the three canonical lists that get baked into the
 * coach's system prompt on every turn.
 *
 *   canonical-courses   {course_id, name, url, one_line}
 *   canonical-quizzes   {quiz_id,   name, url, one_line}
 *   safety-rules        {rule_id,   trigger_hint, prescribed_response, enabled}
 *
 * All three persist to /data/injected/*.json (or INJECTED_DATA_DIR).
 * Each write is audited. A `computeSystemPromptBlock()` helper renders the
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
// headerLabel is what appears at the top of the system prompt block.
const KINDS = {
    'canonical-courses': {
        file: 'canonical-courses.json',
        primaryKey: 'course_id',
        fields: ['course_id', 'name', 'url', 'one_line'],
        headerLabel: 'CANONICAL COURSES (use these names + URLs; never invent)',
        rowNoun: 'course',
        blurb: 'Course names Erica may cite + their Wix URLs. When the coach mentions a course she is required to use the exact name and URL from this list.'
    },
    'canonical-quizzes': {
        file: 'canonical-quizzes.json',
        primaryKey: 'quiz_id',
        fields: ['quiz_id', 'name', 'url', 'one_line'],
        headerLabel: 'CANONICAL QUIZZES (use these names + URLs; never invent)',
        rowNoun: 'quiz',
        blurb: 'Quiz names + URLs. Same rule as courses — Erica cites from this list, never invents a link.'
    },
    'safety-rules': {
        file: 'safety-rules.json',
        primaryKey: 'rule_id',
        fields: ['rule_id', 'trigger_hint', 'prescribed_response', 'enabled'],
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

function sanitizeRow(kind, incoming) {
    const meta = kindMeta(kind);
    const out = {};
    for (const f of meta.fields) {
        const v = incoming[f];
        if (f === 'enabled') {
            out[f] = v === true || v === 'true' || v === '1' || v === 'on';
        } else {
            out[f] = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
        }
    }
    return out;
}

function upsertRow(kind, incoming, { actor = 'admin', reason = null } = {}) {
    const meta = kindMeta(kind);
    const row = sanitizeRow(kind, incoming);
    if (!row[meta.primaryKey]) throw new Error(meta.primaryKey + ' is required');
    // Basic id charset guard.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(row[meta.primaryKey])) {
        throw new Error(meta.primaryKey + ' must be alphanumeric (with dash/underscore), max 64 chars');
    }
    const rows = readAll(kind);
    const idx = rows.findIndex((r) => r[meta.primaryKey] === row[meta.primaryKey]);
    const isNew = idx < 0;
    if (isNew) rows.push(row); else rows[idx] = row;
    writeAll(kind, rows);
    audit.append({
        actor,
        action: 'injected.' + kind + '.' + (isNew ? 'create' : 'update'),
        target: kind + '/' + row[meta.primaryKey],
        meta: { row: Object.keys(row), reason }
    });
    return row;
}

function deleteRow(kind, id, { actor = 'admin', reason = null } = {}) {
    const meta = kindMeta(kind);
    const rows = readAll(kind);
    const next = rows.filter((r) => r[meta.primaryKey] !== id);
    if (next.length === rows.length) return { deleted: false };
    writeAll(kind, next);
    audit.append({
        actor,
        action: 'injected.' + kind + '.delete',
        target: kind + '/' + id,
        meta: { reason }
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
    upsertRow,
    deleteRow,
    computeSystemPromptBlock,
    computeChars,
    KINDS,
    _paths: { ROOT }
};
