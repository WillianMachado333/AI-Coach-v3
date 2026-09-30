/**
 * In-chat AI Navigator (#35 → Eric's onboarding, phase 2'a).
 *
 * The three Navigator questions (navigatorData.json: mood, readiness,
 * clarity) are no longer a form. After each of the first few messages, the
 * client sends this visit's opening exchanges; a small model says which
 * option the person would most likely pick for each question, with a
 * confidence, from what they actually said. The tags go through the one
 * routing implementation (navigatorRouting.js: the 36-route table, weights
 * as fallback) to a coaching style, which the client applies to the session
 * without ever announcing it. When a tag is still unclear, the result names
 * the question to ask, once, naturally.
 *
 * Nothing is stored except the result, on the visit's timeline
 * (style_inferred) and its cost (usage source 'navigator.infer').
 */
const navigatorData = require('../navigatorData.json');
const routing = require('../navigatorRouting');

const READY_CONFIDENCE = 0.6;
const TURNS_MAX = 8;
const TEXT_MAX = 800;
const CALLS_PER_VISIT_MAX = 4;

function questions(data = navigatorData) {
    return (data.questions || []).map((q) => ({ id: q.id, title: q.title, options: (q.options || []).map((o) => ({ value: o.value, text: o.text })) }));
}

function schemaFor(data = navigatorData) {
    const qs = questions(data);
    const props = {};
    for (const q of qs) props[q.id] = { anyOf: [{ type: 'string', enum: q.options.map((o) => o.value) }, { type: 'null' }] };
    const conf = {};
    for (const q of qs) conf[q.id] = { type: 'number' };
    props.confidence = { type: 'object', additionalProperties: false, required: qs.map((q) => q.id), properties: conf };
    return { type: 'object', additionalProperties: false, required: [...qs.map((q) => q.id), 'confidence'], properties: props };
}

function systemPrompt(data = navigatorData) {
    const qs = questions(data).map((q) => `- ${q.id}: "${q.title}"\n${q.options.map((o) => `    ${o.value} = "${o.text}"`).join('\n')}`).join('\n');
    return [
        'You read the opening of a coaching conversation and judge which answer the PERSON would most likely give to each of three intake questions, from what they themselves said.',
        'Questions and their possible answers:',
        qs,
        'Rules:',
        '- Use only the person\'s own words and what they clearly imply. Never infer from the coach\'s words.',
        '- If there is no real evidence for a question, answer null for it.',
        '- confidence per question, 0 to 1: 0 = no evidence, 0.5 = a hint, 0.8+ = they said it plainly.',
        '- Answer with the JSON object only.',
    ].join('\n');
}

/** Client turns → [{ role: 'user' | 'coach', text }], the last TURNS_MAX, cleaned. */
function sanitizeTurns(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((t) => ({ role: t && t.role === 'user' ? 'user' : 'coach', text: typeof (t && t.text) === 'string' ? t.text.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX) : '' }))
        .filter((t) => t.text)
        .slice(-TURNS_MAX);
}

function outputText(response) {
    if (typeof response.output_text === 'string') return response.output_text;
    const parts = [];
    for (const item of response.output || []) for (const c of item.content || []) if (typeof c.text === 'string') parts.push(c.text);
    return parts.join('');
}

/** The model's answer → valid tags, clamped confidences, the route, readiness and what to ask. */
function interpret(parsed, data = navigatorData) {
    const qs = questions(data);
    const tags = {};
    const confidence = {};
    for (const q of qs) {
        const v = parsed && parsed[q.id];
        if (typeof v === 'string' && q.options.some((o) => o.value === v)) tags[q.id] = v;
        const c = Number(parsed && parsed.confidence && parsed.confidence[q.id]);
        confidence[q.id] = tags[q.id] && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
    }
    const r = routing.route(data, tags);
    const ready = qs.every((q) => tags[q.id] && confidence[q.id] >= READY_CONFIDENCE);
    const weakest = qs.slice().sort((a, b) => confidence[a.id] - confidence[b.id])[0];
    return {
        tags, confidence, style: r.primary, autonomy: r.autonomy, via: r.via, ready,
        ask: ready || !weakest ? null : { id: weakest.id, title: weakest.title, options: weakest.options.map((o) => o.text) },
    };
}

async function infer({ client, model, turns, data = navigatorData }) {
    if (!client) throw new Error('OpenAI client not initialised');
    const clean = sanitizeTurns(turns);
    if (!clean.some((t) => t.role === 'user')) throw new Error('no user turn to read');
    const transcript = clean.map((t) => `${t.role === 'user' ? 'Person' : 'Coach'}: ${t.text}`).join('\n');
    const response = await client.responses.create({
        model,
        input: [
            { role: 'system', content: systemPrompt(data) },
            { role: 'user', content: `Conversation so far (oldest first):\n${transcript}` },
        ],
        text: { format: { type: 'json_schema', name: 'navigator_tags', schema: schemaFor(data), strict: true } },
    });
    const raw = outputText(response);
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error('navigator output is not JSON: ' + String(raw).slice(0, 200)); }
    return { ...interpret(parsed, data), usage: response.usage || null, model: response.model || model, responseId: response.id || null };
}

// One visit asks a bounded number of times (the client stops earlier once ready).
const callsBySession = new Map();
function allowCall(sessionId) {
    const n = callsBySession.get(sessionId) || 0;
    if (n >= CALLS_PER_VISIT_MAX) return false;
    callsBySession.set(sessionId, n + 1);
    if (callsBySession.size > 5000) callsBySession.delete(callsBySession.keys().next().value);
    return true;
}

module.exports = { infer, interpret, sanitizeTurns, schemaFor, systemPrompt, questions, allowCall, READY_CONFIDENCE, CALLS_PER_VISIT_MAX, _calls: callsBySession };
