/*
 * Hash-chained audit log for Coach Studio.
 *
 * Every state-changing admin action appends one JSON line to
 * /data/audit/audit.ndjson. Each entry embeds the sha256 of the previous
 * entry, so an attacker (or a bad bug) can't quietly remove or reorder
 * entries without breaking the chain.
 *
 * Shape:
 *   { t, actor, action, target, meta?, prev_hash, hash }
 *
 * - actor: 'admin' (single role for now; RBAC extension later)
 * - action: string tag ('framework.write' | 'framework.reset' | ...)
 * - target: path or entity the action affected
 * - meta: arbitrary JSON detail (before_hash, after_hash, diff excerpt, etc.)
 * - prev_hash: sha256 of the previous entry, hex; '0'.repeat(64) for genesis
 * - hash: sha256 of the canonical JSON of {t, actor, action, target, meta, prev_hash}
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_DIR = process.env.AUDIT_DIR || '/data/audit';
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.ndjson');
const GENESIS = '0'.repeat(64);

function ensureDir() {
    try { if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true }); }
    catch (e) { console.warn('[audit] mkdir failed:', e?.message || e); }
}
ensureDir();

function _sha256Hex(s) {
    return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function _readLastLine() {
    try {
        if (!fs.existsSync(AUDIT_FILE)) return null;
        const raw = fs.readFileSync(AUDIT_FILE, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim());
        if (lines.length === 0) return null;
        return JSON.parse(lines[lines.length - 1]);
    } catch (e) {
        console.warn('[audit] read last line failed:', e?.message || e);
        return null;
    }
}

function append({ actor = 'admin', action, target, meta = null } = {}) {
    if (!action) throw new Error('audit.append: action required');
    ensureDir();
    const prev = _readLastLine();
    const prev_hash = prev?.hash || GENESIS;
    const t = new Date().toISOString();
    const core = { t, actor, action, target: target || null, meta, prev_hash };
    const hash = _sha256Hex(JSON.stringify(core));
    const entry = { ...core, hash };
    try {
        fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
        console.error('[audit] append failed:', e?.message || e);
        throw e;
    }
    return entry;
}

function list({ limit = 200 } = {}) {
    try {
        if (!fs.existsSync(AUDIT_FILE)) return [];
        const raw = fs.readFileSync(AUDIT_FILE, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim());
        // Newest first — take the last `limit` entries.
        const tail = lines.slice(Math.max(0, lines.length - limit));
        return tail.map((l) => JSON.parse(l)).reverse();
    } catch (e) {
        console.warn('[audit] list failed:', e?.message || e);
        return [];
    }
}

/**
 * Recompute the chain to verify integrity. Returns { ok, brokenAt } — brokenAt
 * is the line number (0-indexed) where the chain first diverges, or null if ok.
 */
function verify() {
    try {
        if (!fs.existsSync(AUDIT_FILE)) return { ok: true, brokenAt: null };
        const raw = fs.readFileSync(AUDIT_FILE, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim());
        let prev_hash = GENESIS;
        for (let i = 0; i < lines.length; i++) {
            const e = JSON.parse(lines[i]);
            if (e.prev_hash !== prev_hash) return { ok: false, brokenAt: i, reason: 'prev_hash mismatch' };
            const expected = _sha256Hex(JSON.stringify({
                t: e.t, actor: e.actor, action: e.action, target: e.target, meta: e.meta, prev_hash: e.prev_hash
            }));
            if (expected !== e.hash) return { ok: false, brokenAt: i, reason: 'hash mismatch' };
            prev_hash = e.hash;
        }
        return { ok: true, brokenAt: null, count: lines.length };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

module.exports = { append, list, verify, _internal: { GENESIS, AUDIT_FILE } };
