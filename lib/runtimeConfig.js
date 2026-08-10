/*
 * Runtime channels config — declarative inventory of every dynamic data source
 * that reaches Erica at coach-runtime, plus a persistent on/off toggle per
 * channel so admin can control what the coach receives without touching code.
 *
 * The list is the source-of-truth. Toggles overlay it and live at
 *   /data/runtime-config.json  (or RUNTIME_CONFIG_FILE)
 * as { channels: { [id]: { enabled: bool } } }. Missing key -> default enabled.
 *
 * Consumers ask isEnabled(id) — no coupling to file layout.
 */

const fs = require('fs');
const path = require('path');
const audit = require('./audit');

const FILE = process.env.RUNTIME_CONFIG_FILE
    || path.join(process.env.SESSION_DATA_DIR ? path.dirname(process.env.SESSION_DATA_DIR) : '/data', 'runtime-config.json');

// The list is intentionally hard-coded (not user-editable). New channels are
// declared here as they land; the toggle is what admin controls per channel.
const CHANNELS = [
    {
        id: 'preparation',
        name: 'Preparation payload',
        stage: 'boot',
        source: '/api/erica-preparation → upstream Wix ericaPreparation',
        fields: 'companions (persona list), user profile, conversation history bundle, coach config',
        purpose: 'Boots the coach — persona voices, user identity, prior conversation. Turning this off breaks the coach.',
        controllable: false
    },
    {
        id: 'activity_timeline',
        name: 'Activity timeline (CleverTap)',
        stage: 'boot',
        source: 'lib/activity.js → CleverTap Profile API → /data/activity/*.json',
        fields: 'top event names + counts + last-seen dates (last 30d)',
        purpose: 'Lets Erica reference recent user behavior ("I see you just finished the EI quiz").',
        controllable: true
    },
    {
        id: 'user_report',
        name: 'User report sync',
        stage: 'boot',
        source: '/api/erica-preparation → user vector-store file',
        fields: 'user preparation blob written into that user\'s OpenAI vector store',
        purpose: 'Grounds search_knowledge in the user\'s own report data.',
        controllable: true
    },
    {
        id: 'page_context',
        name: 'Page context (bridge.js)',
        stage: 'runtime',
        source: 'bridge.js REQUEST_PAGE_CONTEXT → parent DOM → PAGE_CONTEXT_RESPONSE',
        fields: 'page URL, page type, DOM snapshot / report content',
        purpose: 'Lets Erica see what the user is looking at right now.',
        controllable: true
    },
    {
        id: 'search_knowledge',
        name: 'Vector store search (frameworks/courses/quizzes)',
        stage: 'on-demand',
        source: 'tool call → OpenAI Vector Store API',
        fields: 'framework theory, course pedagogy, quiz semantic content',
        purpose: 'On-demand retrieval when Erica asks about domain knowledge.',
        controllable: true
    },
    {
        id: 'deep_think',
        name: 'Deep think (o4-mini reasoning)',
        stage: 'on-demand',
        source: 'tool call → /api/deep-think',
        fields: 'chain-of-thought reasoning + concise answer',
        purpose: 'On-demand escalation for hard questions requiring structured thinking.',
        controllable: true
    }
];

function ensureDir(p) {
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) { /* ignore */ }
}
ensureDir(path.dirname(FILE));

let cache = null;
function readAll() {
    if (cache) return cache;
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        cache = JSON.parse(raw) || { channels: {} };
    } catch (_) {
        cache = { channels: {} };
    }
    if (!cache.channels) cache.channels = {};
    return cache;
}
function writeAll(next) {
    cache = next;
    try {
        fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {
        console.warn('[runtimeConfig] write failed:', e?.message || e);
    }
}

function listChannels() {
    const cfg = readAll();
    return CHANNELS.map((ch) => {
        const stored = cfg.channels[ch.id];
        const enabled = ch.controllable ? (stored ? stored.enabled !== false : true) : true;
        return { ...ch, enabled };
    });
}

function isEnabled(id) {
    const ch = CHANNELS.find((c) => c.id === id);
    if (!ch) return true;
    if (!ch.controllable) return true;
    const cfg = readAll();
    const stored = cfg.channels[id];
    return stored ? stored.enabled !== false : true;
}

function setEnabled(id, enabled, { actor = 'admin', reason = null } = {}) {
    const ch = CHANNELS.find((c) => c.id === id);
    if (!ch) throw new Error('unknown channel: ' + id);
    if (!ch.controllable) throw new Error('channel is not controllable: ' + id);
    const cfg = readAll();
    const before = cfg.channels[id]?.enabled !== false;
    cfg.channels[id] = { enabled: !!enabled };
    writeAll(cfg);
    audit.append({
        actor,
        action: 'runtime.channel.toggle',
        target: 'runtime/' + id,
        meta: { before, after: !!enabled, reason }
    });
    return { id, enabled: !!enabled };
}

module.exports = {
    listChannels,
    isEnabled,
    setEnabled,
    _channels: CHANNELS,
    _paths: { FILE }
};
