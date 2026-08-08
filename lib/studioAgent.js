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

const SYSTEM_PROMPT = [
    'You are Coach Studio, a read-only analyst agent embedded in the AI Coach admin panel.',
    'Your users are Eric (product owner) and Sandra (staff psychologist). They ask you to help them UNDERSTAND what Erica the coach did, not to change it.',
    '',
    'Your tools:',
    '- list_recent_sessions: peek at what conversations happened.',
    '- read_session: full transcript + tool trace + prompt-hash references of one session.',
    '- read_prompt: resolve a prompt hash to the system prompt Erica actually saw.',
    '- read_framework / list_frameworks: read the coaching frameworks the coach draws from.',
    '- list_activity_events: what the user has done on the platform (CleverTap).',
    '',
    'Rules:',
    '- Ground every claim in a specific session id, prompt hash, or framework file.',
    '- If asked a question whose answer requires data you did not fetch, call the tool first.',
    '- Be honest about the STORE_MESSAGE_TEXT=redacted limitation — you can only see user text as hashes.',
    '- Do NOT make suggestions about what to change (that comes in a future phase). Focus on WHAT happened and WHY, based on evidence.'
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

module.exports = { runTurn, setClient, SYSTEM_PROMPT, TOOLS };
