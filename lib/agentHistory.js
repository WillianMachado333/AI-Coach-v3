/*
 * Server-owned Coach Studio agent history.
 *
 * Rationale (from daily-report): the client sends only { question, marker },
 * NOT the full message array. Server pulls the last N turns from disk and
 * rebuilds context for the model. This prevents:
 *   - F5-amnesia (reload wipes chat)
 *   - Client-side context drift (browser tabs disagreeing about history)
 *   - Large POST bodies as history grows
 *
 * Storage: /data/agent-history/{actor}.ndjson  (one file per admin actor)
 * Each turn is one JSON line:
 *   { t, actor, question, answer, page?, taskEvents?, promptSnapshotHash? }
 *
 * We keep the last N turns for context reconstruction (last 12 by default —
 * matches daily-report). The full log stays for audit.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.AGENT_HISTORY_DIR || '/data/agent-history';
const CONTEXT_TURNS = Number(process.env.AGENT_HISTORY_CONTEXT_TURNS) || 12;

function ensureDir() {
    try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
    catch (e) { console.warn('[agentHistory] mkdir failed:', e?.message || e); }
}
ensureDir();

function safeActor(a) { return String(a || 'admin').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'admin'; }
function fileFor(actor) { return path.join(DIR, safeActor(actor) + '.ndjson'); }

function append(actor, entry) {
    ensureDir();
    try {
        fs.appendFileSync(fileFor(actor), JSON.stringify({
            t: new Date().toISOString(),
            actor: safeActor(actor),
            ...entry
        }) + '\n', 'utf8');
    } catch (e) {
        console.warn('[agentHistory] append failed:', e?.message || e);
    }
}

function readAll(actor, { limit = 200 } = {}) {
    const file = fileFor(actor);
    if (!fs.existsSync(file)) return [];
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim());
        return lines.slice(Math.max(0, lines.length - limit))
            .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
            .filter(Boolean);
    } catch (e) {
        console.warn('[agentHistory] read failed:', e?.message || e);
        return [];
    }
}

/**
 * Rebuild the Responses API `input` array from the last N turns. Every past
 * turn becomes one user message + one assistant message. Tool-call traces are
 * NOT replayed (they were internal deliberation; the assistant text alone is
 * what shapes future turns).
 */
function rebuildInput(actor, { limit = CONTEXT_TURNS } = {}) {
    const all = readAll(actor, { limit: limit * 2 });
    const recent = all.slice(-limit);
    const out = [];
    for (const t of recent) {
        if (t.question) out.push({ role: 'user', content: t.question });
        if (t.answer) out.push({ role: 'assistant', content: t.answer });
    }
    return out;
}

function clear(actor) {
    const file = fileFor(actor);
    if (fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch (_) {}
    }
}

module.exports = { append, readAll, rebuildInput, clear, _paths: { DIR } };
