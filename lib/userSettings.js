/**
 * Coach settings on the server (#35 → Eric's onboarding): the image card /
 * voice, the voice step, names given to the coach, the coaching style.
 *
 *   /data/user-settings/user-<userId>.json   signed-in: kept, any device
 *   /data/user-settings/ctid-<objectId>.json guest: one visit — gone
 *                                            GUEST_TTL_MIN after the last use
 *   { v: 1, key, settings, createdAt, updatedAt, expiresAt?, writes: [{at, by, fields}] }
 *
 * Nothing about a guest is ever kept on their device (Eric, 2026-09-29);
 * a guest's reload inside the visit (a Wix page change reloads the coach)
 * finds the choice here instead. Validation: ../coachSettings.js. Not the
 * coach clipboard: that holds Erica's private notes, rewritten by a
 * distiller and injected into the prompt; a setting must stay exactly what
 * the person chose.
 */
const fs = require('fs');
const path = require('path');
const coachSettings = require('../coachSettings');

const DATA_ROOT = path.dirname(process.env.SESSION_DATA_DIR || '/data/sessions');
const DATA_DIR = process.env.USER_SETTINGS_DIR || path.join(DATA_ROOT, 'user-settings');
const WRITES_KEEP = 30;
const BY = ['voice_step', 'picker', 'menu', 'tool', 'navigator', 'studio'];

const sanitize = (id) => String(id || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);

/** `user-<id>` when signed in, else `ctid-<objectId>` (one visit), else null. */
function keyFor({ userId = null, objectId = null } = {}) {
    if (userId && String(userId).trim()) return 'user-' + sanitize(String(userId).trim());
    if (objectId && String(objectId).trim()) return 'ctid-' + sanitize(String(objectId).trim());
    return null;
}
const isGuestKey = (key) => String(key).startsWith('ctid-');

function fileFor(key) {
    if (!/^(user|ctid)-[A-Za-z0-9_.-]{1,128}$/.test(String(key))) throw new Error('userSettings: invalid key');
    return path.join(DATA_DIR, key + '.json');
}

function readRecord(key, now = Date.now()) {
    try {
        const p = fileFor(key);
        if (!fs.existsSync(p)) return null;
        const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!rec || typeof rec !== 'object') return null;
        if (isGuestKey(key) && (!rec.expiresAt || Date.parse(rec.expiresAt) <= now)) {
            fs.unlinkSync(p); // a guest's visit is over: nothing stays
            return null;
        }
        rec.settings = coachSettings.normalize(rec.settings);
        if (!Array.isArray(rec.writes)) rec.writes = [];
        return rec;
    } catch (e) {
        console.warn('[settings] read failed:', key, e?.message || e);
        return null;
    }
}

function writeRecord(rec, now) {
    if (isGuestKey(rec.key)) rec.expiresAt = new Date(now + coachSettings.GUEST_TTL_MIN * 60000).toISOString();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const p = fileFor(rec.key);
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 1), 'utf8');
    fs.renameSync(tmp, p);
}

/**
 * This person's settings, or null. A guest's use keeps the visit alive
 * (the 30 minutes count from the last read or write).
 */
function read(ident, { now = Date.now() } = {}) {
    const key = keyFor(ident);
    if (!key) return null;
    const rec = readRecord(key, now);
    if (!rec) return null;
    if (isGuestKey(key)) writeRecord(rec, now);
    return rec.settings;
}

/** Apply a partial update (coachSettings.merge). Writes only on change. Returns { settings, changed, scope }. */
function update(ident, patch, { by = 'picker', now = Date.now() } = {}) {
    const key = keyFor(ident);
    if (!key) throw new Error('userSettings: no identity');
    const t = new Date(now).toISOString();
    const existing = readRecord(key, now);
    const rec = existing || { v: 1, key, settings: coachSettings.empty(), createdAt: t, updatedAt: t, writes: [] };
    const { settings, changed } = coachSettings.merge(rec.settings, patch);
    const scope = isGuestKey(key) ? 'visit' : 'account';
    if (!changed.length) { if (existing && scope === 'visit') writeRecord(rec, now); return { settings, changed, scope }; }
    rec.settings = settings;
    rec.updatedAt = t;
    rec.writes.push({ at: t, by: BY.includes(by) ? by : 'picker', fields: changed });
    if (rec.writes.length > WRITES_KEEP) rec.writes = rec.writes.slice(-WRITES_KEEP);
    writeRecord(rec, now);
    console.log(`[settings] ${key} updated by ${rec.writes[rec.writes.length - 1].by}: ${changed.join(', ')}`);
    return { settings, changed, scope };
}

/** Full record, for the Studio: a userId, else a CleverTap id. */
function record(id) {
    if (!id) return null;
    return readRecord(keyFor({ userId: id })) || readRecord(keyFor({ objectId: id }));
}

/** Guest records past their visit are deleted. Returns how many. */
function sweepExpiredGuests(now = Date.now()) {
    let n = 0;
    try {
        for (const f of fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []) {
            if (!f.startsWith('ctid-') || !f.endsWith('.json')) continue;
            readRecord(f.slice(0, -5), now);
            if (!fs.existsSync(path.join(DATA_DIR, f))) n++;
        }
    } catch (e) { console.warn('[settings] guest sweep failed:', e?.message || e); }
    if (n) console.log(`[settings] swept ${n} guest record(s) whose visit ended`);
    return n;
}

module.exports = { read, update, record, keyFor, sweepExpiredGuests, DATA_DIR, BY };
