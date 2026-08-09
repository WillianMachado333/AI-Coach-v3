/*
 * Admin attachments — screenshots/images pasted into the Coach Studio
 * composer so the analyst agent can SEE what the user is pointing at.
 *
 * PADROES 1B.1 lessons applied:
 *   - Bytes on disk, opaque id in memory. Never blob-in-DB.
 *   - Type decided by MAGIC BYTES (Content-Type from client is untrusted).
 *   - Size cap AFTER decoding, not on the base64 string.
 *   - Opaque fixed-size id, regex-validated before touching the filesystem.
 *   - Clearing the conversation removes attachments (see agentHistory.clear
 *     hook — attachments referenced by a cleared thread are pruned).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.ATTACHMENTS_DIR || '/data/admin-attachments';
const MAX_BYTES = parseInt(process.env.ATTACHMENT_MAX_BYTES || '', 10) || 4 * 1024 * 1024; // 4 MiB post-decode
const ID_RE = /^[a-z0-9]{24}$/;

function ensureDir() {
    try { fs.mkdirSync(ROOT, { recursive: true }); }
    catch (e) { console.warn('[attachments] mkdir failed:', e?.message || e); }
}
ensureDir();

// Sniff the first bytes to detect PNG / JPEG / GIF / WEBP. Return null on
// unknown so the caller rejects the upload.
function sniff(buf) {
    if (!buf || buf.length < 12) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return { mime: 'image/png', ext: 'png' };
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
        return { mime: 'image/jpeg', ext: 'jpg' };
    }
    // GIF: 47 49 46 38 (either 37 39 61 or 39 61 for GIF87a/GIF89a)
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return { mime: 'image/gif', ext: 'gif' };
    }
    // WEBP: "RIFF" .... "WEBP" — 4 bytes size in between
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        return { mime: 'image/webp', ext: 'webp' };
    }
    return null;
}

function newId() {
    // 24 lowercase hex chars — the shape ID_RE expects.
    return crypto.randomBytes(12).toString('hex');
}

// Save decoded bytes to disk after sniffing + cap. Throws on invalid.
function saveDecoded(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length === 0) throw new Error('empty attachment');
    if (buf.length > MAX_BYTES) throw new Error('attachment exceeds ' + MAX_BYTES + ' bytes');
    const kind = sniff(buf);
    if (!kind) throw new Error('unsupported image type (accepted: png, jpeg, gif, webp)');
    const id = newId();
    const filepath = path.join(ROOT, id + '.' + kind.ext);
    fs.writeFileSync(filepath, buf);
    return { id, contentType: kind.mime, ext: kind.ext, bytes: buf.length };
}

// Load an attachment by id and return { contentType, buffer } or null.
function load(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    for (const ext of ['png', 'jpg', 'gif', 'webp']) {
        const p = path.join(ROOT, id + '.' + ext);
        if (fs.existsSync(p)) {
            const buf = fs.readFileSync(p);
            const kind = sniff(buf) || { mime: 'image/' + ext };
            return { id, contentType: kind.mime, buffer: buf, path: p };
        }
    }
    return null;
}

function dataUrl(id) {
    const rec = load(id);
    if (!rec) return null;
    return 'data:' + rec.contentType + ';base64,' + rec.buffer.toString('base64');
}

// Delete by id. Returns true if a file was removed.
function remove(id) {
    if (!ID_RE.test(String(id || ''))) return false;
    let removed = false;
    for (const ext of ['png', 'jpg', 'gif', 'webp']) {
        const p = path.join(ROOT, id + '.' + ext);
        try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; } }
        catch (_) { /* ignore */ }
    }
    return removed;
}

module.exports = { saveDecoded, load, dataUrl, remove, ID_RE, MAX_BYTES, ROOT };
