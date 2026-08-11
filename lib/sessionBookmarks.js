/*
 * Session bookmarks — lets Varsha (or any reviewer) mark a coach session
 * as "exemplar", "problem", or clear the mark, and attach a short note.
 * Persisted to /data/session-bookmarks.json (or SESSION_BOOKMARKS_FILE).
 *
 * Kinds:
 *   'exemplar' — good session, worth citing back / studying
 *   'problem'  — something went wrong; worth reviewing
 *   ''         — clear the bookmark
 *
 * Shape on disk:
 *   { "s-abc…": { kind, note, actor, updatedAt } }
 *
 * Every state change is audited so we have a trail of who marked what.
 */

const fs = require('fs');
const path = require('path');
const audit = require('./audit');

const FILE = process.env.SESSION_BOOKMARKS_FILE
    || path.join(process.env.SESSION_DATA_DIR ? path.dirname(process.env.SESSION_DATA_DIR) : '/data', 'session-bookmarks.json');

const KINDS = ['exemplar', 'problem', ''];
const NOTE_MAX = 200;

function ensureDir() {
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch (_) { /* ignore */ }
}
ensureDir();

let cache = null;
function readAll() {
    if (cache) return cache;
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        const parsed = JSON.parse(raw);
        cache = (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) {
        cache = {};
    }
    return cache;
}
function writeAll(next) {
    cache = next;
    try {
        fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {
        console.warn('[sessionBookmarks] write failed:', e?.message || e);
    }
}

function get(sessionId) {
    if (!sessionId) return null;
    const all = readAll();
    return all[sessionId] || null;
}

function getMany(sessionIds) {
    const all = readAll();
    const out = {};
    for (const id of sessionIds || []) if (all[id]) out[id] = all[id];
    return out;
}

/**
 * Set a bookmark. `kind` in KINDS; empty string clears. `note` capped at 200.
 */
function set(sessionId, { kind = '', note = '', actor = 'admin' } = {}) {
    if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId required');
    if (!KINDS.includes(kind)) throw new Error('invalid kind: ' + kind);
    const all = readAll();
    const before = all[sessionId] || null;
    if (!kind && !note) {
        // Clear
        if (all[sessionId]) delete all[sessionId];
        writeAll(all);
        if (before) {
            audit.append({
                actor,
                action: 'session.bookmark.clear',
                target: 'session/' + sessionId,
                meta: { beforeKind: before.kind, beforeNote: before.note ? before.note.slice(0, 80) : null }
            });
        }
        return null;
    }
    const cleanNote = String(note || '').slice(0, NOTE_MAX).replace(/[\r\n]+/g, ' ').trim();
    const entry = {
        kind: kind || (before && before.kind) || 'exemplar',
        note: cleanNote,
        actor,
        updatedAt: new Date().toISOString()
    };
    all[sessionId] = entry;
    writeAll(all);
    audit.append({
        actor,
        action: 'session.bookmark.set',
        target: 'session/' + sessionId,
        meta: {
            beforeKind: before ? before.kind : null,
            afterKind: entry.kind,
            noteLen: cleanNote.length
        }
    });
    return entry;
}

/**
 * List bookmarks, most recent first, optionally filtered by kind.
 * Returns [{sessionId, kind, note, actor, updatedAt}]
 */
function list({ kind = null, limit = 100 } = {}) {
    const all = readAll();
    const rows = Object.entries(all)
        .map(([sessionId, v]) => ({ sessionId, ...v }))
        .filter((r) => (kind ? r.kind === kind : true))
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return rows.slice(0, limit);
}

module.exports = {
    get,
    getMany,
    set,
    list,
    KINDS,
    NOTE_MAX,
    _paths: { FILE }
};
