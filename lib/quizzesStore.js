/*
 * Quizzes store — top-level catalog, parallel to courses.
 *
 * Talent Transformation has ~19 quizzes (Emotional Intelligence, etc). Each
 * quiz is a standalone assessment with its own purpose, questions, and
 * interpretation guide. Courses may point at quizzes ("take the EI quiz
 * before this unit") but the quiz catalog lives here, not nested under a
 * course.
 *
 * Layout:
 *   knowledge-base/quizzes/
 *     _catalog.json            (list index — id, title, description, source)
 *     {quiz_id}/
 *       _meta.json             (per-quiz metadata)
 *       content.md             (the actual quiz text — questions + answers + notes)
 *
 * Overlay on /data/quizzes/. Overlay wins on read, all writes are audited.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('./audit');

const DEFAULTS_ROOT = path.join(__dirname, '..', 'knowledge-base', 'quizzes');
const OVERLAY_ROOT = process.env.QUIZZES_OVERLAY_DIR || '/data/quizzes';

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function ensureDir(p) {
    try { fs.mkdirSync(p, { recursive: true }); }
    catch (e) { console.warn('[quizzesStore] mkdir ' + p + ' failed:', e?.message || e); }
}
ensureDir(OVERLAY_ROOT);

function isValidQuizId(q) { return /^[a-z0-9][a-z0-9_-]{0,32}$/.test(String(q || '')); }

function quizDir(root, quizId) { return path.join(root, quizId); }
function contentPath(root, quizId) { return path.join(root, quizId, 'content.md'); }
function metaPath(root, quizId) { return path.join(root, quizId, '_meta.json'); }

function listQuizzes() {
    const set = new Set();
    for (const r of [DEFAULTS_ROOT, OVERLAY_ROOT]) {
        try {
            for (const name of fs.readdirSync(r)) {
                if (isValidQuizId(name) && fs.statSync(path.join(r, name)).isDirectory()) set.add(name);
            }
        } catch (_) { /* may not exist */ }
    }
    return Array.from(set).sort().map((quiz_id) => ({ quiz_id, meta: readMeta(quiz_id) }));
}

function readMeta(quizId) {
    if (!isValidQuizId(quizId)) return null;
    for (const root of [OVERLAY_ROOT, DEFAULTS_ROOT]) {
        const p = metaPath(root, quizId);
        if (fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* fall through */ }
        }
    }
    // Missing _meta.json: only stub when the quiz dir itself exists in
    // either root. Otherwise return null so callers can render "not found".
    for (const root of [OVERLAY_ROOT, DEFAULTS_ROOT]) {
        try {
            if (fs.statSync(quizDir(root, quizId)).isDirectory()) {
                return { quiz_id: quizId, title: quizId, description: '', purpose: '' };
            }
        } catch (_) { /* dir doesn't exist */ }
    }
    return null;
}

function writeMeta(quizId, meta, { actor = 'admin', reason = null } = {}) {
    if (!isValidQuizId(quizId)) throw new Error('invalid quiz_id');
    ensureDir(quizDir(OVERLAY_ROOT, quizId));
    const before = readMeta(quizId);
    const merged = Object.assign({}, before, meta, { quiz_id: quizId });
    fs.writeFileSync(metaPath(OVERLAY_ROOT, quizId), JSON.stringify(merged, null, 2), 'utf8');
    audit.append({
        actor,
        action: 'quiz.meta.write',
        target: 'quiz/' + quizId + '/_meta',
        meta: { before: before?.title || null, after: merged.title, reason }
    });
    return merged;
}

function readContent(quizId) {
    if (!isValidQuizId(quizId)) return null;
    for (const [root, source] of [[OVERLAY_ROOT, 'overlay'], [DEFAULTS_ROOT, 'default']]) {
        const p = contentPath(root, quizId);
        if (fs.existsSync(p)) {
            const text = fs.readFileSync(p, 'utf8');
            return { quiz_id: quizId, source, text, hash: sha256(text), chars: text.length };
        }
    }
    return null;
}

function writeContent(quizId, text, { actor = 'admin', reason = null } = {}) {
    if (!isValidQuizId(quizId)) throw new Error('invalid quiz_id');
    const before = readContent(quizId);
    const beforeHash = before?.hash || null;
    const afterHash = sha256(text || '');
    if (beforeHash === afterHash && before?.source === 'overlay') {
        return { changed: false, hash: afterHash, source: 'overlay' };
    }
    ensureDir(quizDir(OVERLAY_ROOT, quizId));
    fs.writeFileSync(contentPath(OVERLAY_ROOT, quizId), text || '', 'utf8');
    audit.append({
        actor,
        action: 'quiz.content.write',
        target: 'quiz/' + quizId + '/content',
        meta: { beforeHash, afterHash, beforeLen: before?.text?.length ?? 0, afterLen: (text || '').length, reason }
    });
    return { changed: true, hash: afterHash, source: 'overlay' };
}

function resetContent(quizId, { actor = 'admin', reason = null } = {}) {
    if (!isValidQuizId(quizId)) throw new Error('invalid quiz_id');
    const p = contentPath(OVERLAY_ROOT, quizId);
    const existed = fs.existsSync(p);
    if (existed) { try { fs.unlinkSync(p); } catch (_) {} }
    audit.append({
        actor,
        action: 'quiz.content.reset',
        target: 'quiz/' + quizId + '/content',
        meta: { hadOverlay: existed, reason }
    });
    return { existed };
}

// Create a new quiz — sets meta with title + description, writes an empty
// content.md so it shows up as an editable overlay from the start.
function createQuiz(quizId, meta, { actor = 'admin', reason = null } = {}) {
    if (!isValidQuizId(quizId)) throw new Error('invalid quiz_id (a-z0-9 dash/underscore, max 33 chars)');
    if (fs.existsSync(quizDir(OVERLAY_ROOT, quizId)) || fs.existsSync(quizDir(DEFAULTS_ROOT, quizId))) {
        throw new Error('quiz already exists: ' + quizId);
    }
    ensureDir(quizDir(OVERLAY_ROOT, quizId));
    writeMeta(quizId, Object.assign({ title: quizId, description: '', purpose: '' }, meta || {}), { actor, reason });
    writeContent(quizId, '# ' + (meta?.title || quizId) + '\n\n> Add the quiz questions, expected answers, and interpretation guide here.\n', { actor, reason });
    return readQuiz(quizId);
}

function readQuiz(quizId) {
    const meta = readMeta(quizId);
    if (!meta) return null;
    const content = readContent(quizId);
    return { ...meta, content };
}

module.exports = {
    listQuizzes,
    readMeta,
    writeMeta,
    readContent,
    writeContent,
    resetContent,
    createQuiz,
    readQuiz,
    isValidQuizId,
    _paths: { DEFAULTS_ROOT, OVERLAY_ROOT }
};
