/*
 * Courses store — artifact-based model.
 *
 * Each course lives in knowledge-base/courses/{course_id}/ and consists of a
 * few well-known artifacts:
 *
 *   course-content.md        pedagogical lesson text (+ inline quizzes)
 *   competency-framework.md  competency definitions / skills / behaviors
 *   quizzes-list.md          index of quizzes with short descriptions
 *   _meta.json               { course_id, title, description, artifacts:[...] }
 *
 * The overlay lives on the persistent volume at /data/courses/{course_id}/
 * with the same file layout. Reader is overlay-first, default-fallback; all
 * writes go to overlay and are audited. This replaces the 24-file per-unit
 * layout: one course = one page-per-artifact, easier to maintain.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('./audit');

const DEFAULTS_ROOT = path.join(__dirname, '..', 'knowledge-base', 'courses');
const OVERLAY_ROOT = process.env.COURSES_OVERLAY_DIR || '/data/courses';

// Quizzes are a PARALLEL top-level category on the platform, not a nested
// artifact of a course — a course points to zero or many quizzes, but the
// quiz catalog is managed elsewhere. See /admin/quizzes + lib/quizzesStore.
const ARTIFACT_KEYS = ['course-content', 'competency-framework'];
const ARTIFACT_LABELS = {
    'course-content': 'Course content',
    'competency-framework': 'Competency framework'
};
const ARTIFACT_FILES = {
    'course-content': 'course-content.md',
    'competency-framework': 'competency-framework.md'
};

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function ensureDir(p) {
    try { fs.mkdirSync(p, { recursive: true }); }
    catch (e) { console.warn('[coursesStore] mkdir ' + p + ' failed:', e?.message || e); }
}
ensureDir(OVERLAY_ROOT);

function isValidCourseId(c) { return /^[a-z0-9][a-z0-9_-]{0,32}$/.test(String(c || '')); }
function isValidArtifactKey(k) { return ARTIFACT_KEYS.includes(String(k || '')); }

function courseDir(root, courseId) { return path.join(root, courseId); }
function artifactPath(root, courseId, key) { return path.join(root, courseId, ARTIFACT_FILES[key]); }
function metaPath(root, courseId) { return path.join(root, courseId, '_meta.json'); }

// Enumerate every course present in either root. Returns [{course_id}].
function listCourses() {
    const set = new Set();
    for (const r of [DEFAULTS_ROOT, OVERLAY_ROOT]) {
        try {
            for (const name of fs.readdirSync(r)) {
                if (isValidCourseId(name) && fs.statSync(path.join(r, name)).isDirectory()) set.add(name);
            }
        } catch (_) { /* dir may not exist */ }
    }
    return Array.from(set).sort().map((course_id) => ({ course_id, meta: readMeta(course_id) }));
}

function readMeta(courseId) {
    if (!isValidCourseId(courseId)) return null;
    // Overlay meta wins if present.
    for (const root of [OVERLAY_ROOT, DEFAULTS_ROOT]) {
        const p = metaPath(root, courseId);
        if (fs.existsSync(p)) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { /* fall through */ }
        }
    }
    return { course_id: courseId, title: courseId, description: '' };
}

function writeMeta(courseId, meta, { actor = 'admin', reason = null } = {}) {
    if (!isValidCourseId(courseId)) throw new Error('invalid course_id');
    ensureDir(courseDir(OVERLAY_ROOT, courseId));
    const before = readMeta(courseId);
    const merged = Object.assign({}, before, meta, { course_id: courseId });
    fs.writeFileSync(metaPath(OVERLAY_ROOT, courseId), JSON.stringify(merged, null, 2), 'utf8');
    audit.append({
        actor,
        action: 'course.meta.write',
        target: 'course/' + courseId + '/_meta',
        meta: { before: before?.title || null, after: merged.title, reason }
    });
    return merged;
}

function readArtifact(courseId, key) {
    if (!isValidCourseId(courseId) || !isValidArtifactKey(key)) return null;
    for (const [root, source] of [[OVERLAY_ROOT, 'overlay'], [DEFAULTS_ROOT, 'default']]) {
        const p = artifactPath(root, courseId, key);
        if (fs.existsSync(p)) {
            const text = fs.readFileSync(p, 'utf8');
            return {
                course_id: courseId,
                key,
                label: ARTIFACT_LABELS[key],
                filename: ARTIFACT_FILES[key],
                source,
                text,
                hash: sha256(text),
                chars: text.length
            };
        }
    }
    return null;
}

function writeArtifact(courseId, key, text, { actor = 'admin', reason = null } = {}) {
    if (!isValidCourseId(courseId)) throw new Error('invalid course_id');
    if (!isValidArtifactKey(key)) throw new Error('invalid artifact key');
    const before = readArtifact(courseId, key);
    const beforeHash = before?.hash || null;
    const afterHash = sha256(text || '');
    if (beforeHash === afterHash && before?.source === 'overlay') {
        return { changed: false, hash: afterHash, source: 'overlay' };
    }
    ensureDir(courseDir(OVERLAY_ROOT, courseId));
    fs.writeFileSync(artifactPath(OVERLAY_ROOT, courseId, key), text || '', 'utf8');
    audit.append({
        actor,
        action: 'course.artifact.write',
        target: 'course/' + courseId + '/' + key,
        meta: {
            beforeHash, afterHash,
            beforeSource: before?.source || null,
            beforeLen: before?.text?.length ?? 0,
            afterLen: (text || '').length,
            reason
        }
    });
    return { changed: true, hash: afterHash, source: 'overlay' };
}

function resetArtifact(courseId, key, { actor = 'admin', reason = null } = {}) {
    if (!isValidCourseId(courseId) || !isValidArtifactKey(key)) throw new Error('invalid course/artifact');
    const p = artifactPath(OVERLAY_ROOT, courseId, key);
    const existed = fs.existsSync(p);
    if (existed) { try { fs.unlinkSync(p); } catch (_) {} }
    audit.append({
        actor,
        action: 'course.artifact.reset',
        target: 'course/' + courseId + '/' + key,
        meta: { hadOverlay: existed, reason }
    });
    return { existed };
}

// Full snapshot for one course: meta + every artifact (overlay-aware).
function readCourse(courseId) {
    const meta = readMeta(courseId);
    if (!meta) return null;
    const artifacts = ARTIFACT_KEYS.map((k) => readArtifact(courseId, k)).filter(Boolean);
    return { ...meta, artifacts };
}

module.exports = {
    listCourses,
    readMeta,
    writeMeta,
    readArtifact,
    writeArtifact,
    resetArtifact,
    readCourse,
    ARTIFACT_KEYS,
    ARTIFACT_LABELS,
    ARTIFACT_FILES,
    isValidCourseId,
    isValidArtifactKey,
    _paths: { DEFAULTS_ROOT, OVERLAY_ROOT }
};
