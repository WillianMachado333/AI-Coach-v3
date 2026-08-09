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

/**
 * Run a real multi-turn conversation. A "user persona" system prompt drives
 * a fake user, the "coach persona" system prompt drives Erica, and the
 * two take turns via Responses API. Emits streaming events so the UI can
 * render the conversation as it happens.
 *
 *   opts.coach       { name, guardrails, extraDirective }   — the coach side
 *   opts.userPersona string — description of the simulated user
 *   opts.seedMessage string — first user turn to start the conversation
 *   opts.maxTurns    number — total turns (user + coach counted), default 8
 *   opts.model       optional model override
 *
 *   onEvent(evt) is called with:
 *     { type: 'start', maxTurns }
 *     { type: 'user_turn',  idx, text }
 *     { type: 'coach_turn', idx, text, ms }
 *     { type: 'done', turns }
 *     { type: 'error', message }
 */
async function simulateConversation(opts, onEvent) {
    if (!openaiClient) throw new Error('simulator: OpenAI client not initialised');
    const model = opts.model || SIM_MODEL;
    const maxTurns = Math.min(20, Math.max(2, opts.maxTurns || 8));
    const coach = opts.coach || {};
    const userPersona = String(opts.userPersona || 'A user coming to a coaching conversation. Speak naturally, in 1-3 sentences, in the same language you started in.').trim();
    const seed = String(opts.seedMessage || '').trim();
    // priorTranscript is a list of [{role: 'user'|'coach', text}] the caller
    // wants us to continue from — used for regen / fork-from-turn. When
    // provided we skip the seed and pick up where they left off.
    const prior = Array.isArray(opts.priorTranscript) ? opts.priorTranscript.filter(t => t && t.role && t.text) : [];
    if (!seed && prior.length === 0) throw new Error('seedMessage or priorTranscript required');

    const coachSystem = buildInstructions({
        personaName: coach.name || 'Erica',
        guardrails: coach.guardrails || '',
        extraDirective: coach.extraDirective || ''
    });
    const userSystem = [
        userPersona,
        '',
        'You are the USER in this exchange, not the coach. Do NOT coach back — you are being coached. Respond naturally (1-3 sentences) in the same language you started in. If the coach has genuinely helped you land on a next step and there is nothing more to explore right now, you may end by saying so briefly instead of asking another question.'
    ].join('\n');

    onEvent({ type: 'start', maxTurns });
    // Conversation is stored as {role, content}. From the coach's perspective:
    //   user   = the simulated user
    //   assistant = the coach itself
    // From the user's perspective the roles flip — we swap when calling.
    const convo = [];
    const turns = [];
    // Bootstrap from priorTranscript when the caller wants to fork/regen.
    for (const t of prior) {
        turns.push({ role: t.role, text: t.text });
        convo.push({
            role: t.role === 'coach' ? 'assistant' : 'user',
            content: t.text
        });
        onEvent({ type: t.role === 'coach' ? 'coach_turn' : 'user_turn', idx: turns.length - 1, text: t.text, replay: true });
    }
    // Fresh run → first turn is the seed (user side). Continuation → depends
    // on which side spoke last in the prior transcript.
    //   empty prior           → expectingCoach = false → user speaks first (seed)
    //   prior ends on user    → expectingCoach = true  → coach responds
    //   prior ends on coach   → expectingCoach = false → user goes again
    let expectingCoach = prior.length > 0 && prior[prior.length - 1].role === 'user';
    let currentUserText = prior.length === 0 ? seed : null;
    const startIdx = prior.length;
    for (let i = startIdx; i < startIdx + maxTurns; i++) {
        if (!expectingCoach) {
            // User turn (either the seed, a generated follow-up, or a fork-in).
            turns.push({ role: 'user', text: currentUserText });
            convo.push({ role: 'user', content: currentUserText });
            onEvent({ type: 'user_turn', idx: i, text: currentUserText });
            expectingCoach = true;
        } else {
            // Coach turn — generate.
            const t0 = Date.now();
            const resp = await openaiClient.responses.create({
                model,
                input: [{ role: 'system', content: coachSystem }, ...convo]
            });
            let coachText = '';
            for (const item of resp.output || []) {
                if (item.type === 'message' && Array.isArray(item.content)) {
                    for (const c of item.content) if (c.type === 'output_text' || c.type === 'text') coachText += (c.text || '');
                }
            }
            coachText = coachText.trim() || '(no response)';
            const ms = Date.now() - t0;
            turns.push({ role: 'coach', text: coachText, ms });
            convo.push({ role: 'assistant', content: coachText });
            onEvent({ type: 'coach_turn', idx: i, text: coachText, ms, model });
            expectingCoach = false;
            // If the coach was the last of our budget, stop here.
            if (i + 1 >= startIdx + maxTurns) break;
            // Generate the user's next message using the user-persona system.
            // From user's POV, roles flip: coach messages become "user" (i.e.
            // things the user is hearing), user messages become "assistant"
            // (things the user has already said).
            const userView = convo.map((m) => ({
                role: m.role === 'user' ? 'assistant' : 'user',
                content: m.content
            }));
            const resp2 = await openaiClient.responses.create({
                model,
                input: [{ role: 'system', content: userSystem }, ...userView]
            });
            let nextUser = '';
            for (const item of resp2.output || []) {
                if (item.type === 'message' && Array.isArray(item.content)) {
                    for (const c of item.content) if (c.type === 'output_text' || c.type === 'text') nextUser += (c.text || '');
                }
            }
            currentUserText = nextUser.trim();
            if (!currentUserText) break; // user "left"
        }
    }
    onEvent({ type: 'done', turns });
    return { turns };
}

module.exports = { simulate, simulateConversation, extractReplayableTurn, setClient };
