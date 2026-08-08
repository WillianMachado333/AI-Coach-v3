/*
 * Content overlay store — writable copies of "content" files (framework
 * markdown, pill defaults, etc.) live on the persistent volume at
 * /data/frameworks/*.md. Readers first check the volume; if absent they
 * fall back to the repo-baked defaults under knowledge-base/frameworks/.
 *
 * This lets Coach Studio admins edit content WITHOUT redeploying — the
 * writes persist across container rebuilds — while the repo defaults still
 * ship as the fallback in case the volume is empty or corrupted.
 *
 * Every write must go through audit.append; callers pass the actor.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const audit = require('./audit');

const DEFAULTS_DIR = path.join(__dirname, '..', 'knowledge-base', 'frameworks');
const OVERLAY_DIR = process.env.FRAMEWORKS_OVERLAY_DIR || '/data/frameworks';

function ensureOverlay() {
    try { if (!fs.existsSync(OVERLAY_DIR)) fs.mkdirSync(OVERLAY_DIR, { recursive: true }); }
    catch (e) { console.warn('[contentStore] mkdir overlay failed:', e?.message || e); }
}
ensureOverlay();

function safeName(name) {
    return String(name || '').replace(/[^A-Za-z0-9_-]/g, '');
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function listFrameworks() {
    const names = new Set();
    try {
        for (const f of fs.readdirSync(DEFAULTS_DIR)) if (f.endsWith('.md')) names.add(f.replace(/\.md$/, ''));
    } catch (_) { /* baked defaults might not exist in some setups */ }
    try {
        for (const f of fs.readdirSync(OVERLAY_DIR)) if (f.endsWith('.md')) names.add(f.replace(/\.md$/, ''));
    } catch (_) { /* empty overlay ok */ }
    return Array.from(names).sort();
}

function readFramework(name) {
    const n = safeName(name);
    if (!n) return null;
    const overlayFile = path.join(OVERLAY_DIR, n + '.md');
    const defaultFile = path.join(DEFAULTS_DIR, n + '.md');
    let source = null; let text = null;
    if (fs.existsSync(overlayFile)) {
        source = 'overlay';
        text = fs.readFileSync(overlayFile, 'utf8');
    } else if (fs.existsSync(defaultFile)) {
        source = 'default';
        text = fs.readFileSync(defaultFile, 'utf8');
    } else {
        return null;
    }
    return { name: n, source, text, hash: sha256(text) };
}

function writeFramework(name, newText, { actor = 'admin', reason = null } = {}) {
    const n = safeName(name);
    if (!n) throw new Error('invalid framework name');
    ensureOverlay();
    const before = readFramework(n);
    const beforeHash = before?.hash || null;
    const afterHash = sha256(newText);
    if (beforeHash === afterHash) {
        return { changed: false, hash: afterHash, source: before?.source || null };
    }
    const overlayFile = path.join(OVERLAY_DIR, n + '.md');
    fs.writeFileSync(overlayFile, newText, 'utf8');
    audit.append({
        actor,
        action: 'framework.write',
        target: 'framework/' + n,
        meta: {
            beforeHash, afterHash,
            beforeSource: before?.source || null,
            beforeLen: before?.text?.length ?? 0,
            afterLen: newText.length,
            reason
        }
    });
    return { changed: true, hash: afterHash, source: 'overlay' };
}

/**
 * Reset a framework to its repo-baked default by removing the overlay file.
 * Audit entry recorded even if no overlay existed (no-op audit trail).
 */
function resetFramework(name, { actor = 'admin', reason = null } = {}) {
    const n = safeName(name);
    if (!n) throw new Error('invalid framework name');
    const overlayFile = path.join(OVERLAY_DIR, n + '.md');
    const existed = fs.existsSync(overlayFile);
    let beforeHash = null;
    if (existed) {
        try { beforeHash = sha256(fs.readFileSync(overlayFile, 'utf8')); } catch (_) {}
        try { fs.unlinkSync(overlayFile); } catch (_) {}
    }
    audit.append({
        actor,
        action: 'framework.reset',
        target: 'framework/' + n,
        meta: { hadOverlay: existed, beforeHash, reason }
    });
    return { existed };
}

/** Return a simple line-diff (context ± 2) for UI display. */
function lineDiff(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a === b) return { changed: false, hunks: [] };
    const aL = a.split('\n'); const bL = b.split('\n');
    // Cheap LCS-free scan: report first mismatched region and its neighbourhood.
    let i = 0;
    while (i < aL.length && i < bL.length && aL[i] === bL[i]) i++;
    let jA = aL.length; let jB = bL.length;
    while (jA > i && jB > i && aL[jA - 1] === bL[jB - 1]) { jA--; jB--; }
    const context = 2;
    const start = Math.max(0, i - context);
    return {
        changed: true,
        hunks: [{
            aStart: start,
            aLines: aL.slice(start, jA + context),
            bLines: bL.slice(start, jB + context)
        }]
    };
}

module.exports = {
    listFrameworks,
    readFramework,
    writeFramework,
    resetFramework,
    lineDiff,
    _paths: { DEFAULTS_DIR, OVERLAY_DIR }
};
