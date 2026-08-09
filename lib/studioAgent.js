/*
 * Coach Studio Agent (Phase 2 — read-only).
 *
 * Eric / Sandra chat with this agent to understand what Erica did in
 * recorded sessions and why. It gets read-only tools that expose:
 *
 *   - list_recent_sessions(limit, tester)   list session index rows
 *   - read_session(sessionId)               full transcript + tools
 *   - read_prompt(hash)                     resolve a prompt hash to text
 *   - read_framework(name)                  read a coaching framework .md
 *   - list_frameworks()                     enumerate framework files
 *   - list_activity_events(id)              activity for a user/objectId
 *
 * The agent is a single OpenAI Responses API call per user turn, iterated
 * server-side (map/reduce style) until tool calls finish. Small model
 * (STUDIO_AGENT_MODEL, default gpt-5-mini) is fine — task is Q&A over text
 * blobs, not deep reasoning.
 */

const sessionLog = require('./sessionLog');
const activity = require('./activity');
const contentStore = require('./contentStore');

let openaiClient = null;
function setClient(client) { openaiClient = client; }

const AGENT_MODEL = process.env.STUDIO_AGENT_MODEL || 'gpt-5-mini';
const MAX_TURNS = 8; // safety cap on tool-call iterations

const CHART_INSTRUCTIONS = [
    '',
    '=== RICH OUTPUT (charts and tables) ===',
    'When a result is easier to grasp visually, append fenced blocks AT THE END of your answer text. The UI parses and renders them.',
    'Trigger rules:',
    '- ≥4 numeric data points spanning a category or time axis → ```chart',
    '- 2–5 items compared across 2–4 attributes → ```table',
    '- single number or 1-2 numbers → prose, do NOT chart',
    '',
    'Chart block schema:',
    '```chart',
    '{"type":"bar"|"line","title":"Short title","xAxis":["label1","label2"],"series":[{"name":"Score","values":[10,20]}]}',
    '```',
    'At most 3 charts per answer, 4 series per chart, 60 points per series.',
    '',
    'Table block schema:',
    '```table',
    '{"title":"Optional","headers":["col1","col2"],"rows":[["a","b"],["c","d"]]}',
    '```',
    'At most 3 tables per answer, 8 cols, 30 rows.',
    '',
    'Emit the prose first, then the fenced blocks. Do NOT read the numbers back verbatim after emitting a chart — the user sees them.'
].join('\n');

const MARKER_INSTRUCTIONS = [
    '',
    '=== MARKED IN THE REPORT ===',
    'If the user turn begins with "MARKED IN THE REPORT", they selected something on the page and want you to focus on THAT specifically. Never ignore the marker to answer something broader — if the marker does not sustain their question, say so.',
    '',
    'Apply the rule matching the marker type:',
    '- CHART: you saw specific data points. Say what the SHAPE shows AND explicitly what it does NOT show (a totals bar chart does not speak to causation; a 30d line says nothing about last hour).',
    '- MODEL-GENERATED SENTENCE (a phrase from a previous answer, a theme, a recommendation): treat it as a CLAIM TO VERIFY, not a fact. Go to the data — sessions, prompts, frameworks — and say whether it holds up.',
    '- USER QUOTE or QUESTION: locate where that exact text appeared before commenting. If STORE_MESSAGE_TEXT=redacted you may only have a hash; say so.',
    '- NUMBER: trace which days, which population, which sample size. If any of those are unclear, name that.',
    '- PLAIN TEXT (fallback): treat as a topic pointer — center the answer on that phrase.'
].join('\n');

const SYSTEM_PROMPT = [
    'You are Coach Studio, a read-only analyst agent embedded in the AI Coach admin panel.',
    'Your users are Eric (product owner) and Sandra (staff psychologist). They ask you to help them UNDERSTAND what Erica the coach did, not to change it.',
    '',
    'Your tools:',
    '- list_recent_sessions: peek at what conversations happened.',
    '- read_session: full transcript + tool trace + prompt-hash references of one session.',
    '- read_prompt: resolve a prompt hash to the system prompt Erica actually saw.',
    '- read_framework / list_frameworks: read the coaching frameworks the coach draws from.',
    '- list_course_units / read_course_unit: pedagogical course content + competency framework + quiz Q&A. Each unit key is section.number, e.g. "1.1" = Trait Awareness. Use these to ground answers about lessons, competencies, misconceptions, quiz questions.',
    '- list_activity_events: what the user has done on the platform (CleverTap).',
    '',
    'Voice + rules:',
    '- Speak to Eric and Sandra directly, executive tone. No engineering jargon in the answer body (never say "the SQL", "row", "NDJSON", "tester=exclude"); those live in the reasoning trace.',
    '- Ground every claim in a specific session id, prompt hash, framework name, or course unit — cite it inline like "(session s-abc123)" or "(course tsb 3.2)".',
    '- Prefer disagreeing with the premise when the data does not support it. Do not concede by reflex. If a number in the question is wrong, correct it before answering.',
    '- When sample is small (< 5 sessions), or when tester filter matters, or when a metric has an alternative reading — say so, do not smooth it over.',
    '- Distinguish "did not happen" from "not measured". Never treat missing data as zero.',
    '- Be honest about the STORE_MESSAGE_TEXT=redacted limitation — user text is often only visible as a hash; bot text is usually visible.',
    '- If asked a question whose answer requires data you did not fetch, call the tool first. Only say "I do not know" AFTER tools returned nothing useful.',
    '- Do NOT propose changes to the coach (that is a future phase). Focus on WHAT happened and WHY, based on evidence.',
    '- Keep answers tight: 3-6 sentences of prose unless the user explicitly asks for a long list.',
    CHART_INSTRUCTIONS,
    MARKER_INSTRUCTIONS
].join('\n');

const TOOLS = [
    {
        type: 'function',
        name: 'list_recent_sessions',
        description: 'List the most recent Erica sessions with light metadata (actor, turn count, timestamps). Use to find candidate sessions matching a description.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'integer', description: 'Max rows to return, 1-100.' },
                tester: { type: 'string', enum: ['exclude', 'only', 'all'], description: 'Filter tester sessions.' }
            }
        }
    },
    {
        type: 'function',
        name: 'read_session',
        description: 'Read the full NDJSON entries for one session. Includes session_start metadata, every turn, tool calls, events.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' }
            },
            required: ['sessionId']
        }
    },
    {
        type: 'function',
        name: 'read_prompt',
        description: 'Resolve a prompt_hash referenced in a session turn to the actual system prompt text Erica saw.',
        parameters: {
            type: 'object',
            properties: {
                hash: { type: 'string' }
            },
            required: ['hash']
        }
    },
    {
        type: 'function',
        name: 'list_frameworks',
        description: 'List the coaching framework markdown files available.',
        parameters: { type: 'object', properties: {} }
    },
    {
        type: 'function',
        name: 'read_framework',
        description: 'Read the full text of one coaching framework .md file.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Base filename without .md, e.g. "Supportive".' }
            },
            required: ['name']
        }
    },
    {
        type: 'function',
        name: 'list_course_units',
        description: 'List every course unit available on disk. Returns [{course_id, unit, title, path}]. Course units carry the pedagogical lesson text + competency framework (Knowledge / Skills / Observable Behaviors / Performance Indicators / Misconceptions / Conversation Starters) + section quiz.',
        parameters: { type: 'object', properties: {} }
    },
    {
        type: 'function',
        name: 'read_course_unit',
        description: 'Read the full markdown of one course unit by course_id + unit (e.g. course_id="tsb", unit="1.1"). Returns raw markdown so you can quote it back.',
        parameters: {
            type: 'object',
            properties: {
                course_id: { type: 'string', description: 'Course slug, e.g. "tsb".' },
                unit: { type: 'string', description: 'Unit key, e.g. "1.1", "3.2", "8.3".' }
            },
            required: ['course_id', 'unit']
        }
    },
    {
        type: 'function',
        name: 'list_activity_events',
        description: 'Fetch CleverTap activity for a given user identifier.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                identifierType: { type: 'string', enum: ['userId', 'objectId'] }
            },
            required: ['id']
        }
    }
];

function safeSlice(obj, keys) {
    const out = {};
    keys.forEach((k) => { if (obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

async function execTool(name, args) {
    try {
        switch (name) {
            case 'list_recent_sessions': {
                const limit = Math.min(100, Math.max(1, args?.limit || 20));
                const tester = ['exclude', 'only', 'all'].includes(args?.tester) ? args.tester : 'exclude';
                const rows = sessionLog.listSessions({ tester, limit });
                return rows.map((r) => safeSlice(r, ['sessionId', 'startedAt', 'lastAt', 'turns', 'actor']));
            }
            case 'read_session': {
                const sid = String(args?.sessionId || '');
                if (!sid) return { error: 'sessionId required' };
                const data = sessionLog.readSession(sid);
                if (!data) return { error: 'session not found' };
                return { sessionId: sid, entries: data.entries };
            }
            case 'read_prompt': {
                const h = String(args?.hash || '');
                if (!h) return { error: 'hash required' };
                const snap = sessionLog.readPromptSnapshot(h);
                if (!snap) return { error: 'prompt not found' };
                return snap;
            }
            case 'list_frameworks': {
                return contentStore.listFrameworks();
            }
            case 'read_framework': {
                const r = contentStore.readFramework(args?.name);
                return r || { error: 'framework not found: ' + (args?.name || '') };
            }
            case 'list_course_units': {
                const path = require('path');
                const fs = require('fs');
                const root = path.join(__dirname, '..', 'knowledge-base', 'courses');
                const out = [];
                if (!fs.existsSync(root)) return out;
                for (const courseId of fs.readdirSync(root)) {
                    const courseDir = path.join(root, courseId);
                    if (!fs.statSync(courseDir).isDirectory()) continue;
                    for (const section of fs.readdirSync(courseDir)) {
                        const sectionDir = path.join(courseDir, section);
                        if (!fs.statSync(sectionDir).isDirectory()) continue;
                        for (const file of fs.readdirSync(sectionDir)) {
                            if (!file.endsWith('.md')) continue;
                            const m = file.match(/^(\d+\.\d+)-(.+)\.md$/);
                            if (!m) continue;
                            out.push({
                                course_id: courseId,
                                unit: m[1],
                                title: m[2].replace(/-/g, ' '),
                                path: courseId + '/' + section + '/' + file
                            });
                        }
                    }
                }
                return out.sort((a, b) => a.unit.localeCompare(b.unit));
            }
            case 'read_course_unit': {
                const path = require('path');
                const fs = require('fs');
                const cid = String(args?.course_id || '');
                const unit = String(args?.unit || '');
                if (!cid || !unit) return { error: 'course_id and unit required' };
                const root = path.join(__dirname, '..', 'knowledge-base', 'courses', cid);
                if (!fs.existsSync(root)) return { error: 'course not found: ' + cid };
                // Walk to find the unit
                for (const section of fs.readdirSync(root)) {
                    const sectionDir = path.join(root, section);
                    if (!fs.statSync(sectionDir).isDirectory()) continue;
                    for (const file of fs.readdirSync(sectionDir)) {
                        if (file.startsWith(unit + '-') && file.endsWith('.md')) {
                            const full = path.join(sectionDir, file);
                            return { course_id: cid, unit, filename: file, text: fs.readFileSync(full, 'utf8') };
                        }
                    }
                }
                return { error: 'unit not found: ' + cid + '/' + unit };
            }
            case 'list_activity_events': {
                const id = String(args?.id || '');
                if (!id) return { error: 'id required' };
                const identifierType = args?.identifierType === 'objectId' ? 'objectId' : 'userId';
                const r = await activity.getActivityHistory({ identifier: id, identifierType });
                return {
                    identifierType,
                    events: (r?.events || []).slice(0, 100),
                    meta: r?.meta || null
                };
            }
            default:
                return { error: 'unknown tool: ' + name };
        }
    } catch (e) {
        return { error: e?.message || String(e) };
    }
}

/**
 * Run one turn of the agent. `history` is an array of previous items in
 * OpenAI Responses API "input" format. Returns the final assistant text plus
 * the updated history so the client can pass it back on the next turn.
 */
async function runTurn({ history = [], userMessage, page = null }) {
    if (!openaiClient) throw new Error('studioAgent: OpenAI client not initialised');
    // Inject a page-context note so the agent knows which admin route the
    // user is looking at when they ask "here" / "this" / "esta página".
    const pageNote = page
        ? { role: 'system', content: 'The user is currently viewing the admin route: ' + page + ' — treat vague pronouns like "here", "this", "esta página" as referring to whatever that route shows.' }
        : null;
    const input = history.concat([
        ...(pageNote ? [pageNote] : []),
        { role: 'user', content: userMessage }
    ]);

    let iter = 0;
    let lastResponseText = null;
    let workingInput = input;
    while (iter++ < MAX_TURNS) {
        const resp = await openaiClient.responses.create({
            model: AGENT_MODEL,
            input: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...workingInput
            ],
            tools: TOOLS,
            tool_choice: 'auto'
        });

        // Collect any function calls in this response and their text.
        const outputs = resp.output || [];
        const toolCalls = outputs.filter((o) => o.type === 'function_call');
        const textParts = outputs
            .filter((o) => o.type === 'message')
            .flatMap((m) => (m.content || []))
            .filter((c) => c.type === 'output_text' || c.type === 'text')
            .map((c) => c.text || '');
        const textThisTurn = textParts.join('\n').trim();
        if (textThisTurn) lastResponseText = textThisTurn;

        if (toolCalls.length === 0) {
            // No tools requested — we're done.
            return {
                text: lastResponseText || '(no response)',
                history: workingInput.concat(outputs)
            };
        }

        // Execute the tools and append their outputs to input.
        const nextInputAdditions = [];
        // First re-append the assistant's message + calls so the model has the
        // continuity handle (Responses API expects call_id refs).
        outputs.forEach((o) => nextInputAdditions.push(o));
        for (const call of toolCalls) {
            let parsed = {};
            try { parsed = JSON.parse(call.arguments || '{}'); } catch (_) { /* keep {} */ }
            const result = await execTool(call.name, parsed);
            nextInputAdditions.push({
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify(result).slice(0, 60000) // hard cap
            });
        }
        workingInput = workingInput.concat(nextInputAdditions);
    }
    return {
        text: lastResponseText || '(agent stopped: max tool iterations reached)',
        history: workingInput
    };
}

// Task label map — turns internal tool names into short executive-facing
// labels for the running-task list. Every user-visible "thinking" line should
// come through this so we never leak `list_recent_sessions` etc.
function taskLabel(toolName, args) {
    switch (toolName) {
        case 'list_recent_sessions':
            return 'Peeking at recent sessions';
        case 'read_session':
            return 'Reading session ' + (args?.sessionId ? String(args.sessionId).slice(0, 20) + '…' : '');
        case 'read_prompt':
            return 'Resolving a prompt snapshot';
        case 'list_frameworks':
            return 'Listing coaching frameworks';
        case 'read_framework':
            return 'Reading the ' + (args?.name || 'coaching') + ' framework';
        case 'list_course_units':
            return 'Listing course units';
        case 'read_course_unit':
            return 'Reading ' + (args?.course_id || 'course') + ' unit ' + (args?.unit || '');
        case 'list_activity_events':
            return 'Fetching activity for ' + (args?.id || 'that user');
        default:
            return 'Calling ' + toolName;
    }
}

/**
 * Streaming variant of runTurn.
 *
 * Consumers pass an `onEvent(evt)` callback that receives typed events:
 *   { type: 'task',   id, label, status: 'running'|'done'|'error', transient?, detail? }
 *   { type: 'delta',  delta: '…' }
 *   { type: 'done',   text, history }
 *   { type: 'error',  message }
 *
 * The runtime is transport-agnostic — server.mjs wraps it in SSE, tests can
 * push events into an array.
 */
async function runTurnStreamed({ history = [], userMessage, page = null, attachments = [] }, onEvent) {
    if (!openaiClient) throw new Error('studioAgent: OpenAI client not initialised');
    if (typeof onEvent !== 'function') throw new Error('runTurnStreamed: onEvent required');

    const pageNote = page
        ? { role: 'system', content: 'The user is currently viewing the admin route: ' + page + ' — treat vague pronouns like "here", "this", "esta página" as referring to whatever that route shows.' }
        : null;
    // Build the user content. When images are attached, use the multimodal
    // content array shape (Responses API `input_image` + `input_text`).
    const validImages = Array.isArray(attachments)
        ? attachments.filter((a) => a && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:image/'))
        : [];
    const userContent = validImages.length === 0
        ? userMessage
        : [
            { type: 'input_text', text: userMessage },
            ...validImages.map((a) => ({ type: 'input_image', image_url: a.dataUrl }))
        ];
    let workingInput = history.concat([
        ...(pageNote ? [pageNote] : []),
        { role: 'user', content: userContent }
    ]);

    let taskCounter = 0;
    const newTask = (label) => {
        const id = 't' + (++taskCounter);
        onEvent({ type: 'task', id, label, status: 'running', transient: true });
        return id;
    };
    const doneTask = (id, detail) => onEvent({ type: 'task', id, status: 'done', detail });
    const errorTask = (id, detail) => onEvent({ type: 'task', id, status: 'error', detail });

    let iter = 0;
    let finalText = '';
    while (iter++ < MAX_TURNS) {
        // Investigation step — non-streaming, low reasoning effort.
        const thinkId = newTask('Thinking');
        let resp;
        try {
            resp = await openaiClient.responses.create({
                model: AGENT_MODEL,
                input: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...workingInput
                ],
                tools: TOOLS,
                tool_choice: 'auto'
            });
        } catch (e) {
            errorTask(thinkId, e?.message || String(e));
            onEvent({ type: 'error', message: 'agent call failed: ' + (e?.message || e) });
            return { text: '', history: workingInput };
        }
        doneTask(thinkId);

        const outputs = resp.output || [];
        const toolCalls = outputs.filter((o) => o.type === 'function_call');
        // Accumulate any assistant text emitted this turn (rare when tools called).
        const textParts = outputs
            .filter((o) => o.type === 'message')
            .flatMap((m) => (m.content || []))
            .filter((c) => c.type === 'output_text' || c.type === 'text')
            .map((c) => c.text || '');
        const textThisTurn = textParts.join('\n').trim();

        if (toolCalls.length === 0) {
            // Stream the final text out as deltas so the UI paints progressively.
            // (The non-streaming call already produced the full text; emit it in
            // small chunks for consistent UI treatment.)
            const text = textThisTurn || '(no response)';
            finalText = text;
            const chunk = 40;
            for (let i = 0; i < text.length; i += chunk) {
                onEvent({ type: 'delta', delta: text.slice(i, i + chunk) });
            }
            const nextHistory = workingInput.concat(outputs);
            onEvent({ type: 'done', text, history: nextHistory });
            return { text, history: nextHistory };
        }

        // Execute tools, each with a visible task line.
        const additions = [];
        outputs.forEach((o) => additions.push(o));
        for (const call of toolCalls) {
            let parsed = {};
            try { parsed = JSON.parse(call.arguments || '{}'); } catch (_) { /* keep {} */ }
            const label = taskLabel(call.name, parsed);
            const tid = onEvent({ type: 'task', id: 'tool-' + call.call_id, label, status: 'running' }) || null;
            let result;
            try {
                result = await execTool(call.name, parsed);
            } catch (e) {
                result = { error: e?.message || String(e) };
            }
            const err = result && result.error;
            onEvent({
                type: 'task',
                id: 'tool-' + call.call_id,
                status: err ? 'error' : 'done',
                detail: err ? String(err).slice(0, 200) : detailOf(call.name, result)
            });
            additions.push({
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify(result).slice(0, 60000)
            });
        }
        workingInput = workingInput.concat(additions);
    }
    onEvent({ type: 'done', text: finalText || '(agent stopped: max tool iterations reached)', history: workingInput });
    return { text: finalText, history: workingInput };
}

function detailOf(toolName, result) {
    try {
        if (Array.isArray(result)) return result.length + ' rows';
        if (result && Array.isArray(result.events)) return result.events.length + ' events';
        if (result && Array.isArray(result.entries)) return result.entries.length + ' entries';
    } catch (_) { /* no-op */ }
    return null;
}

const FOLLOWUP_PROMPT = [
    'You just watched the analyst answer a question about the AI Coach.',
    'Suggest EXACTLY 3 short follow-up questions the analyst might ask NEXT.',
    'Rules:',
    '- Executive voice, first-person from the analyst ("Which sessions had…", "Why did…"). Zero jargon (no "NDJSON", no "SQL", no "row count").',
    '- ≤70 characters each. Pill that wraps three lines is not a pill.',
    '- EXACTLY ONE of the three MUST attack the weakness of the previous answer: small sample, mixed population, single-day snapshot, unverifiable claim, model wording, redacted text, alternative reading of the number, tester filter ambiguity. If the answer had no obvious weakness, ask what would falsify its main claim.',
    '- The other two: drill deeper into a specific claim, or open an adjacent angle.',
    '- No greetings, no filler, no meta ("would you like…").',
    'Return ONLY a JSON array of 3 strings, no code fences.'
].join('\n');

/**
 * Given the last (question, answer) pair, generate 3 executive follow-up
 * prompts. Small model call — cheap. Failures return an empty array.
 */
async function suggestFollowups({ lastQuestion, lastAnswer }) {
    if (!openaiClient) return [];
    if (!lastAnswer) return [];
    try {
        const resp = await openaiClient.responses.create({
            model: AGENT_MODEL,
            input: [
                { role: 'system', content: FOLLOWUP_PROMPT },
                { role: 'user', content: 'Question: ' + (lastQuestion || '(none)') + '\n\nAnswer:\n' + lastAnswer }
            ]
        });
        let text = '';
        for (const item of resp.output || []) {
            if (item.type === 'message' && Array.isArray(item.content)) {
                for (const c of item.content) if (c.type === 'output_text' || c.type === 'text') text += (c.text || '');
            }
        }
        const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3);
    } catch (_) { return []; }
}

module.exports = { runTurn, runTurnStreamed, suggestFollowups, setClient, SYSTEM_PROMPT, TOOLS };
