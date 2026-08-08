/*
 * Coach Studio Simulator (Phase 3).
 *
 * "What would Erica have said if her persona/instructions were different?"
 *
 * Two modes:
 *   1. Standalone — admin composes a persona (name + guardrails) + user
 *      message, we run one turn against the Responses API and return the
 *      text. Fast, no session dependency.
 *   2. Session-replay — admin picks a real session and a specific user
 *      turn; we substitute the persona instructions and get the alt
 *      response. Only works when the session was recorded with
 *      STORE_MESSAGE_TEXT=raw (otherwise user text is a hash).
 *
 * Uses the OpenAI Responses API with a small model. This is TEXT ONLY —
 * we intentionally do not attempt a full audio replay through the
 * Realtime API (too fragile, and the goal is behavioural comparison, not
 * timing fidelity).
 */

const sessionLog = require('./sessionLog');

let openaiClient = null;
function setClient(client) { openaiClient = client; }

const SIM_MODEL = process.env.SIMULATOR_MODEL || 'gpt-5-mini';

function buildInstructions({ personaName, guardrails, extraDirective }) {
    const parts = [];
    if (personaName) {
        parts.push(`You are ${personaName}, a life and career coach at Talent Transformation. Speak in the first person as a coach — brief, warm, grounded.`);
    }
    if (guardrails) {
        parts.push('\n=== BEHAVIOURAL GUARDRAILS ===\n' + String(guardrails).trim());
    }
    if (extraDirective) {
        parts.push('\n=== ADDITIONAL DIRECTIVE ===\n' + String(extraDirective).trim());
    }
    parts.push('\nRespond in the same language as the user message. Keep it to 3–6 sentences unless the user explicitly asks for more.');
    return parts.join('\n');
}

/**
 * Run one simulated response.
 *
 *   personaName    e.g. "Erica"
 *   guardrails     free-form text — the persona's behavioural rules
 *   extraDirective free-form text — any extra system instructions
 *   userMessage    the message we want to see her respond to
 *   priorTurns     optional [{role:'user'|'assistant', content:'...'}, ...]
 *                  to give the model conversational context
 */
async function simulate({ personaName, guardrails, extraDirective, userMessage, priorTurns = [] }) {
    if (!openaiClient) throw new Error('simulator: OpenAI client not initialised');
    if (!userMessage || !String(userMessage).trim()) {
        throw new Error('userMessage required');
    }
    const instructions = buildInstructions({ personaName, guardrails, extraDirective });
    const started = Date.now();
    const input = [{ role: 'system', content: instructions }];
    for (const t of priorTurns) {
        if (t && t.role && t.content) input.push({ role: t.role, content: String(t.content) });
    }
    input.push({ role: 'user', content: String(userMessage) });

    const resp = await openaiClient.responses.create({
        model: SIM_MODEL,
        input
    });
    let text = '';
    for (const item of resp.output || []) {
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
                if (c.type === 'output_text' || c.type === 'text') text += (c.text || '');
            }
        }
    }
    return {
        text: text.trim(),
        model: SIM_MODEL,
        ms: Date.now() - started,
        instructionsPreview: instructions.slice(0, 500)
    };
}

/**
 * Preload one user turn from a real session for replay UI. Returns the
 * turn text only if it was recorded raw (redacted hashes can't drive a
 * replay). Also returns the coach response that immediately followed, so
 * the UI can render "original vs simulated" side by side.
 */
function extractReplayableTurn(sessionId, turnIndex) {
    const data = sessionLog.readSession(sessionId);
    if (!data) return { error: 'session not found' };
    const turns = data.entries.filter((e) => e.type === 'turn');
    if (turnIndex < 0 || turnIndex >= turns.length) {
        return { error: 'turn out of range', totalTurns: turns.length };
    }
    const t = turns[turnIndex];
    if (t.role !== 'user') return { error: 'selected turn is not a user turn', turn: t };
    if (t.text && typeof t.text === 'object' && t.text.redacted) {
        return { error: 'user text redacted — cannot replay', hash: t.text.hash };
    }
    // Find the immediately-following bot turn as the "original" response.
    let original = null;
    for (let i = turnIndex + 1; i < turns.length; i++) {
        if (turns[i].role === 'bot' && turns[i].text) { original = turns[i].text; break; }
    }
    // Prior turns (up to 6) for conversational context.
    const prior = turns.slice(0, turnIndex).slice(-6).map((x) => ({
        role: x.role === 'bot' ? 'assistant' : 'user',
        content: (x.text && typeof x.text === 'object' && x.text.redacted)
            ? `[redacted, ${x.text.length} chars]`
            : (x.text || '')
    })).filter((x) => x.content);
    return {
        userMessage: t.text,
        originalResponse: original,
        priorTurns: prior
    };
}

module.exports = { simulate, extractReplayableTurn, setClient };
