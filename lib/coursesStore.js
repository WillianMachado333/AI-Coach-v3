/*
 * Courses overlay store — analog of contentStore for course/quiz markdown
 * units. Repo-baked defaults live under knowledge-base/courses/{course_id}/
 * section-{N}/{unit}-{slug}.md; overlay lives on the persistent volume so
 * admins can edit without redeploy.
 *
 * Every write goes through audit.append.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('./audit');

const DEFAULTS_ROOT = path.join(__dirname, '..', 'knowledge-base', 'courses');
const OVERLAY_ROOT = process.env.COURSES_OVERLAY_DIR || '/data/courses';

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function ensureDir(p) {
    try { fs.mkdirSync(p, { recursive: true }); }
    catch (e) { console.warn('[coursesStore] mkdir ' + p + ' failed:', e?.message || e); }
}
ensureDir(OVERLAY_ROOT);

function safeSlug(s) {
    return String(s || '').toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function isValidUnitKey(u) { return /^\d+\.\d+$/.test(String(u || '')); }
function isValidCourseId(c) { return /^[a-z0-9][a-z0-9_-]{0,32}$/.test(String(c || '')); }

// Walk one course dir and return every {section, unit, title, filename} unit.
function scanCourseDir(root, courseId) {
    const out = [];
    const courseDir = path.join(root, courseId);
    if (!fs.existsSync(courseDir)) return out;
    for (const sectionDir of fs.readdirSync(courseDir)) {
        const full = path.join(courseDir, sectionDir);
        if (!fs.statSync(full).isDirectory()) continue;
        const secMatch = sectionDir.match(/^section-(\d+)$/);
        if (!secMatch) continue;
        for (const file of fs.readdirSync(full)) {
            if (!file.endsWith('.md')) continue;
            const m = file.match(/^(\d+\.\d+)-(.+)\.md$/);
            if (!m) continue;
            out.push({
                courseId,
                section: parseInt(secMatch[1], 10),
                unit: m[1],
                slug: m[2],
                title: m[2].replace(/-/g, ' '),
                filename: file,
                path: courseId + '/' + sectionDir + '/' + file
            });
        }
    }
    return out;
}

function listCourses() {
    const set = new Set();
    try { for (const c of fs.readdirSync(DEFAULTS_ROOT)) if (isValidCourseId(c)) set.add(c); } catch (_) {}
    try { for (const c of fs.readdirSync(OVERLAY_ROOT)) if (isValidCourseId(c)) set.add(c); } catch (_) {}
    return Array.from(set).sort();
}

// List every unit across default + overlay, overlay winning on collision.
function listUnits(courseId) {
    if (!isValidCourseId(courseId)) return [];
    const byKey = new Map();
    for (const u of scanCourseDir(DEFAULTS_ROOT, courseId)) byKey.set(u.unit, { ...u, source: 'default' });
    for (const u of scanCourseDir(OVERLAY_ROOT, courseId)) byKey.set(u.unit, { ...u, source: 'overlay' });
    return Array.from(byKey.values()).sort((a, b) => a.unit.localeCompare(b.unit, undefined, { numeric: true }));
}

// Find the on-disk file for a unit (overlay first, then default).
function findUnitFile(courseId, unit) {
    if (!isValidCourseId(courseId) || !isValidUnitKey(unit)) return null;
    for (const [root, source] of [[OVERLAY_ROOT, 'overlay'], [DEFAULTS_ROOT, 'default']]) {
        for (const u of scanCourseDir(root, courseId)) {
            if (u.unit === unit) return { ...u, source, absolutePath: path.join(root, courseId, 'section-' + u.section, u.filename) };
        }
    }
    return null;
}

function readUnit(courseId, unit) {
    const rec = findUnitFile(courseId, unit);
    if (!rec) return null;
    const text = fs.readFileSync(rec.absolutePath, 'utf8');
    return { ...rec, text, hash: sha256(text) };
}

// Write (or create) the overlay version. If the unit doesn't exist anywhere
// yet, requires title + section so we can compute the on-disk path.
function writeUnit({ courseId, unit, section, title, text, actor = 'admin', reason = null }) {
    if (!isValidCourseId(courseId)) throw new Error('invalid course_id');
    if (!isValidUnitKey(unit)) throw new Error('invalid unit key (expected N.N)');
    const before = readUnit(courseId, unit);
    const beforeHash = before?.hash || null;
    const afterHash = sha256(text || '');
    if (beforeHash === afterHash && before?.source === 'overlay') {
        return { changed: false, hash: afterHash, source: 'overlay' };
    }
    let filename, sectionN;
    if (before) {
        filename = before.filename;
        sectionN = before.section;
    } else {
        if (!Number.isFinite(section) || section < 1 || section > 99) throw new Error('section required for new unit');
        if (!title || !title.trim()) throw new Error('title required for new unit');
        sectionN = section;
        filename = unit + '-' + safeSlug(title) + '.md';
    }
    const dir = path.join(OVERLAY_ROOT, courseId, 'section-' + sectionN);
    ensureDir(dir);
    const outPath = path.join(dir, filename);
    fs.writeFileSync(outPath, text || '', 'utf8');
    audit.append({
        actor,
        action: before ? 'course.write' : 'course.create',
        target: 'course/' + courseId + '/' + unit,
        meta: {
            beforeHash, afterHash,
            beforeSource: before?.source || null,
            beforeLen: before?.text?.length ?? 0,
            afterLen: (text || '').length,
            filename,
            reason
        }
    });
    return { changed: true, hash: afterHash, source: 'overlay', filename };
}

// Remove overlay for a unit — falls back to default (or unit disappears if
// only overlay existed).
function resetUnit(courseId, unit, { actor = 'admin', reason = null } = {}) {
    if (!isValidCourseId(courseId) || !isValidUnitKey(unit)) throw new Error('invalid course/unit');
    // Find any overlay file for this unit and unlink.
    const overlayDir = path.join(OVERLAY_ROOT, courseId);
    let existed = false;
    if (fs.existsSync(overlayDir)) {
        for (const sec of fs.readdirSync(overlayDir)) {
            const full = path.join(overlayDir, sec);
            if (!fs.statSync(full).isDirectory()) continue;
            for (const f of fs.readdirSync(full)) {
                if (f.startsWith(unit + '-') && f.endsWith('.md')) {
                    try { fs.unlinkSync(path.join(full, f)); existed = true; } catch (_) {}
                }
            }
        }
    }
    audit.append({
        actor,
        action: 'course.reset',
        target: 'course/' + courseId + '/' + unit,
        meta: { hadOverlay: existed, reason }
    });
    return { existed };
}

// Delete: remove overlay copy AND, if the unit exists only in overlay,
// remove it entirely. Cannot remove default-only units (those live in the
// git-tracked repo tree).
function deleteUnit(courseId, unit, { actor = 'admin', reason = null } = {}) {
    if (!isValidCourseId(courseId) || !isValidUnitKey(unit)) throw new Error('invalid course/unit');
    const rec = findUnitFile(courseId, unit);
    if (!rec) return { existed: false };
    if (rec.source === 'default') {
        throw new Error('cannot delete default (repo-baked) unit — use reset to remove overlay only');
    }
    try { fs.unlinkSync(rec.absolutePath); } catch (_) {}
    audit.append({
        actor,
        action: 'course.delete',
        target: 'course/' + courseId + '/' + unit,
        meta: { filename: rec.filename, reason }
    });
    return { existed: true };
}

module.exports = {
    listCourses,
    listUnits,
    readUnit,
    writeUnit,
    resetUnit,
    deleteUnit,
    isValidCourseId,
    isValidUnitKey,
    _paths: { DEFAULTS_ROOT, OVERLAY_ROOT }
};
