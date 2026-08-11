/*
 * Server-side synthetic session generator.
 *
 * Same idea as scripts/gen-synthetic-sessions.js, but runs inline in the
 * server process using the already-initialised OpenAI client and the
 * sessionLog module directly — no HTTP hops, no need for the caller to
 * hold OPENAI_API_KEY locally.
 *
 * Emits per-session progress events via an onEvent callback (SSE-friendly).
 */

const sessionLog = require('./sessionLog');

let openaiClient = null;
function setClient(client) { openaiClient = client; }

const MODEL = process.env.SYNTHETIC_MODEL || 'gpt-4.1-mini';

const PERSONAS = [
    { id: 'Supportive', character: 'Erica', style: 'Calm, reassuring. Emotional safety before action.' },
    { id: 'Directive', character: 'Steve', style: 'Sharp, decisive. Cuts through noise, names the next step.' },
    { id: 'Discovery', character: 'Emma', style: 'Curious. Asks the question the user has been avoiding.' },
    { id: 'Empowering', character: 'Jasmine', style: 'Reflects the user own strengths back to them. Ownership-first.' },
    { id: 'Exploratory', character: 'Evan', style: 'Looks for patterns and unspoken connections.' },
    { id: 'Guidance', character: 'Michael', style: 'Practical, teacher-mode. Shows examples and options.' },
    { id: 'Nurturing', character: 'Sarah', style: 'Slow, tender. Names feelings before problem-solving.' },
    { id: 'Strengths', character: 'Sean', style: 'Anchors every reflection on what is working.' },
    { id: 'Supportive', character: 'Erica', style: 'Same persona, different user profile.' },
    { id: 'Directive', character: 'Steve', style: 'Same persona, different user profile.' }
];
const TOPICS = [
    { topic: 'career-decision', opening: 'I am torn between staying in my job and taking a risky offer at a startup.' },
    { topic: 'burnout', opening: 'I have been feeling drained for weeks. Even weekends do not restore me.' },
    { topic: 'quiz-results', opening: 'I just did the Emotional Intelligence quiz. My self-regulation score was way lower than I expected. What does that mean for me?' }
];
const TESTER_MARKERS = ['+demo', '+test'];

const NAMES = ['ana', 'bruno', 'carla', 'diego', 'elena', 'felipe', 'gabi', 'hugo', 'iris', 'joao'];
const SURNAMES = ['silva', 'costa', 'martins', 'ribeiro', 'gomes', 'lima', 'rocha', 'melo'];

function synthEmail(i) {
    const n = NAMES[i % NAMES.length];
    const s = SURNAMES[Math.floor(i / NAMES.length) % SURNAMES.length];
    return n + '.' + s + '+syn' + i + '@example.com';
}

async function openaiChat({ system, messages }) {
    if (!openaiClient) throw new Error('genSessions: OpenAI client not initialised');
    const resp = await openaiClient.responses.create({
        model: MODEL,
        input: [{ role: 'system', content: system }, ...messages]
    });
    let out = '';
    for (const item of resp.output || []) {
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) if (c.type === 'output_text' || c.type === 'text') out += (c.text || '');
        }
    }
    return out.trim() || '(no response)';
}

async function runConversation({ sessionId, persona, topic }) {
    const systemPrompt = 'You are ' + persona.character + ', a ' + persona.id + ' coach at Talent Transformation. Style: ' + persona.style + '. Respond in 3-5 sentences of first-person coach voice.';
    const turnCount = 3 + Math.floor(Math.random() * 3);
    let userText = topic.opening;
    const conv = [];
    let turns = 0;
    for (let t = 0; t < turnCount; t++) {
        sessionLog.logUserTurn(sessionId, { text: userText, meta: { synthetic: true } });
        conv.push({ role: 'user', content: userText });

        const coachText = await openaiChat({ system: systemPrompt, messages: conv });
        conv.push({ role: 'assistant', content: coachText });

        const rand = Math.random();
        if (rand < 0.35) {
            sessionLog.logToolCall(sessionId, {
                name: 'search_knowledge',
                args: { query: topic.topic + ' framework guidance', scope: 'frameworks' },
                result: { chunks: 4 },
                ms: 800 + Math.floor(Math.random() * 900)
            });
        } else if (rand < 0.45) {
            sessionLog.logToolCall(sessionId, {
                name: 'render_chart',
                args: { type: 'bar', title: 'Sample' },
                result: { success: true },
                ms: 40
            });
        }
        if (Math.random() < 0.08) {
            sessionLog.logToolCall(sessionId, {
                name: 'deep_think',
                args: { query: 'complex reasoning' },
                result: null,
                error: 'timeout after 8s',
                ms: 8000
            });
        }

        sessionLog.logBotTurn(sessionId, { text: coachText, meta: { synthetic: true } });
        turns++;

        if (Math.random() < 0.2 && t >= 1) break;

        userText = await openaiChat({
            system: 'You are a user in a coaching conversation. Reply naturally to the coach in 1-2 sentences, either going deeper on the topic or shifting slightly. Do NOT ask "what next" — you drive.',
            messages: conv
        });
    }
    return turns;
}

// Run generation. onEvent is called with { type, ... } for progress.
// count defaults to 30. Aborts if openaiClient is not initialised.
async function run({ count = 30 } = {}, onEvent = () => {}) {
    if (!openaiClient) {
        onEvent({ type: 'error', message: 'OpenAI client not initialised on server' });
        return { ok: 0, fail: 0 };
    }
    onEvent({ type: 'start', count });
    let ok = 0, fail = 0;
    for (let i = 0; i < count; i++) {
        const persona = PERSONAS[i % PERSONAS.length];
        const topic = TOPICS[i % TOPICS.length];
        const isTester = (i % 10) === 0;
        const email = isTester
            ? 'qa' + TESTER_MARKERS[i % TESTER_MARKERS.length] + '@talenttransformation.com'
            : synthEmail(i);
        try {
            // sessionLog.startSession returns the sessionId string directly —
            // NOT an { sessionId } object. Old destructuring silently produced
            // undefined and every subsequent logUserTurn/logBotTurn no-op'd,
            // leaving the synthetic runs with only their session_start marker
            // and zero turns visible in the observatory.
            const sessionId = sessionLog.startSession({ email, caller: 'synthetic' });
            const turns = await runConversation({ sessionId, persona, topic });
            onEvent({ type: 'session', i: i + 1, total: count, sessionId, persona: persona.id, topic: topic.topic, turns, tester: isTester });
            ok++;
        } catch (e) {
            fail++;
            onEvent({ type: 'session_error', i: i + 1, total: count, message: e?.message || String(e) });
        }
    }
    onEvent({ type: 'done', ok, fail });
    return { ok, fail };
}

module.exports = { setClient, run };
