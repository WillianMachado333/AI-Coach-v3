/*
 * Semantic extras — Company info + Website content. Two new corpora under
 * the Semantic Store, parallel to courses / quizzes but for institutional
 * material Erica should ground on when asked "what does Talent
 * Transformation do?" or when citing an article from the site.
 *
 * Layout (mirrors coursesStore/quizzesStore where possible):
 *   /data/{kind}/{doc_id}/_meta.json     { doc_id, title, description, source_url? }
 *   /data/{kind}/{doc_id}/content.md     the body Erica search_knowledge over
 *
 * kind ∈ {'company', 'site'}. No repo-baked defaults yet — content starts
 * empty and admin uploads / pastes.
 *
 * Vector-store indexing wire-up is a follow-up; this module handles storage
 * + admin CRUD only. Coach can already search_knowledge over the disk copy
 * via a later scope='company'/'site' pass.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('./audit');

const KIND_META = {
    company: {
        label: 'Company info',
        blurb: 'Talent Transformation identity — mission, methodology, who Varsha is, tone of voice, case studies. Long-form. Erica searches this when asked institutional questions.',
        defaultDir: null // no repo defaults for now
    },
    site: {
        label: 'Website content',
        blurb: 'Pages, blog posts, articles from talenttransformation.com. Pasted or scraped body — Erica can cite these when the topic came up on the site.',
        defaultDir: null
    }
};

function overlayRoot(kind) {
    const base = process.env.SEMANTIC_EXTRAS_DIR
        || (process.env.SESSION_DATA_DIR ? path.dirname(process.env.SESSION_DATA_DIR) : '/data');
    return path.join(base, kind);
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) { /* ignore */ } }

function isValidKind(kind) { return Object.prototype.hasOwnProperty.call(KIND_META, kind); }
function isValidDocId(id) { return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(id || '')); }

function kindLabel(kind) { return KIND_META[kind] ? KIND_META[kind].label : kind; }
function kindBlurb(kind) { return KIND_META[kind] ? KIND_META[kind].blurb : ''; }

function docDir(kind, docId) { return path.join(overlayRoot(kind), docId); }
function metaPath(kind, docId) { return path.join(docDir(kind, docId), '_meta.json'); }
function contentPath(kind, docId) { return path.join(docDir(kind, docId), 'content.md'); }

function listDocs(kind) {
    if (!isValidKind(kind)) return [];
    const root = overlayRoot(kind);
    ensureDir(root);
    const out = [];
    try {
        for (const name of fs.readdirSync(root)) {
            if (!isValidDocId(name)) continue;
            const p = docDir(kind, name);
            let stat;
            try { stat = fs.statSync(p); } catch (_) { continue; }
            if (!stat.isDirectory()) continue;
            out.push({ doc_id: name, meta: readMeta(kind, name) });
        }
    } catch (_) { /* empty root ok */ }
    return out.sort((a, b) => (a.doc_id > b.doc_id ? 1 : -1));
}

function readMeta(kind, docId) {
    if (!isValidKind(kind) || !isValidDocId(docId)) return null;
    const p = metaPath(kind, docId);
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) { /* fall through */ }
    // Directory exists but no meta: return a bare stub so the caller can
    // still render an editor. Otherwise null.
    try {
        if (fs.statSync(docDir(kind, docId)).isDirectory()) {
            return { doc_id: docId, title: docId, description: '', source_url: '' };
        }
    } catch (_) { /* no dir */ }
    return null;
}

function readContent(kind, docId) {
    if (!isValidKind(kind) || !isValidDocId(docId)) return null;
    const p = contentPath(kind, docId);
    try {
        if (fs.existsSync(p)) {
            const text = fs.readFileSync(p, 'utf8');
            return { doc_id: docId, text, chars: text.length, hash: sha256(text) };
        }
    } catch (_) { /* absent = null */ }
    return null;
}

function createDoc(kind, docId, meta, { actor = 'admin', reason = null } = {}) {
    if (!isValidKind(kind)) throw new Error('invalid kind: ' + kind);
    if (!isValidDocId(docId)) throw new Error('invalid doc_id (a-z 0-9 dash/underscore, max 64)');
    if (fs.existsSync(docDir(kind, docId))) throw new Error('doc already exists: ' + docId);
    ensureDir(docDir(kind, docId));
    const merged = {
        doc_id: docId,
        title: String((meta && meta.title) || docId),
        description: String((meta && meta.description) || ''),
        source_url: String((meta && meta.source_url) || '')
    };
    fs.writeFileSync(metaPath(kind, docId), JSON.stringify(merged, null, 2), 'utf8');
    const placeholder = '# ' + merged.title + '\n\n_Empty. Paste or upload content._\n';
    fs.writeFileSync(contentPath(kind, docId), placeholder, 'utf8');
    audit.append({
        actor,
        action: 'semantic.' + kind + '.create',
        target: kind + '/' + docId,
        meta: { title: merged.title, reason }
    });
    return { doc_id: docId, meta: merged };
}

function writeMeta(kind, docId, incoming, { actor = 'admin', reason = null } = {}) {
    if (!isValidKind(kind) || !isValidDocId(docId)) throw new Error('invalid kind or doc_id');
    if (!fs.existsSync(docDir(kind, docId))) throw new Error('doc does not exist: ' + docId);
    const before = readMeta(kind, docId) || {};
    const merged = Object.assign({}, before, {
        title: String(incoming.title || before.title || docId),
        description: String(incoming.description || ''),
        source_url: String(incoming.source_url || '')
    }, { doc_id: docId });
    fs.writeFileSync(metaPath(kind, docId), JSON.stringify(merged, null, 2), 'utf8');
    audit.append({
        actor,
        action: 'semantic.' + kind + '.meta',
        target: kind + '/' + docId,
        meta: { before: before.title || null, after: merged.title, reason }
    });
    return merged;
}

function writeContent(kind, docId, text, { actor = 'admin', reason = null } = {}) {
    if (!isValidKind(kind) || !isValidDocId(docId)) throw new Error('invalid kind or doc_id');
    ensureDir(docDir(kind, docId));
    const before = readContent(kind, docId);
    const beforeHash = before?.hash || null;
    const afterHash = sha256(text || '');
    if (beforeHash === afterHash) return { changed: false, hash: afterHash };
    fs.writeFileSync(contentPath(kind, docId), text || '', 'utf8');
    audit.append({
        actor,
        action: 'semantic.' + kind + '.content',
        target: kind + '/' + docId,
        meta: { beforeHash, afterHash, beforeLen: before?.chars || 0, afterLen: (text || '').length, reason }
    });
    return { changed: true, hash: afterHash };
}

function deleteDoc(kind, docId, { actor = 'admin', reason = null } = {}) {
    if (!isValidKind(kind) || !isValidDocId(docId)) throw new Error('invalid kind or doc_id');
    const dir = docDir(kind, docId);
    if (!fs.existsSync(dir)) return { deleted: false };
    try {
        for (const f of fs.readdirSync(dir)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
        }
        fs.rmdirSync(dir);
    } catch (e) {
        console.warn('[semanticExtras] delete cleanup failed:', e?.message || e);
    }
    audit.append({
        actor,
        action: 'semantic.' + kind + '.delete',
        target: kind + '/' + docId,
        meta: { reason }
    });
    return { deleted: true };
}

function totalChars(kind) {
    let total = 0;
    for (const d of listDocs(kind)) {
        const c = readContent(kind, d.doc_id);
        if (c) total += c.chars;
    }
    return total;
}

module.exports = {
    listDocs,
    readMeta,
    readContent,
    writeMeta,
    writeContent,
    createDoc,
    deleteDoc,
    totalChars,
    kindLabel,
    kindBlurb,
    isValidKind,
    isValidDocId,
    KIND_META,
    _paths: { overlayRoot }
};
