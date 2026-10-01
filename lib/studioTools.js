/*
 * Coach Studio tools: one registry, two transports.
 *
 * The Studio co-worker (lib/studioAgent.js, OpenAI Responses function tools)
 * and the remote MCP connector (#38) call the same tools. Each entry says:
 *
 *   name, description, parameters   the JSON schema both transports publish
 *   scope                           read:ops | read:people | write:content | write:people
 *                                   (an MCP token only sees the tools its scopes allow;
 *                                   the scopes a person can grant are capped by their
 *                                   Studio role, lib/studioAccess.js)
 *   readOnly, destructive           MCP annotations (readOnlyHint / destructiveHint)
 *   label(args)                     the executive-facing line in the co-worker's task list
 *   handler(args, ctx)              ctx = { actor, role, via: 'studio' | 'mcp' }
 *
 * Anything that identifies or quotes a person is read:people: session rows
 * carry the actor (email / ids), transcripts carry what was said, prompt
 * snapshots carry the person's report and activity, CleverTap events are
 * theirs.
 */
'use strict';

const sessionLog = require('./sessionLog');
const activity = require('./activity');
const contentStore = require('./contentStore');

function safeSlice(obj, keys) {
    const out = {};
    keys.forEach((k) => { if (obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
}

const TOOLS = [
    {
        name: 'list_recent_sessions',
        scope: 'read:people',
        readOnly: true,
        description: 'List the most recent Erica sessions with light metadata (actor, turn count, timestamps). Use to find candidate sessions matching a description.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'integer', description: 'Max rows to return, 1-100.' },
                tester: { type: 'string', enum: ['exclude', 'only', 'all'], description: 'Filter tester sessions.' }
            }
        },
        label: () => 'Peeking at recent sessions',
        handler: async (args) => {
            const limit = Math.min(100, Math.max(1, args?.limit || 20));
            const tester = ['exclude', 'only', 'all'].includes(args?.tester) ? args.tester : 'exclude';
            const rows = sessionLog.listSessions({ tester, limit });
            return rows.map((r) => safeSlice(r, ['sessionId', 'startedAt', 'lastAt', 'turns', 'actor']));
        }
    },
    {
        name: 'read_session',
        scope: 'read:people',
        readOnly: true,
        description: 'Read the full NDJSON entries for one session. Includes session_start metadata, every turn, tool calls, events.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string' }
            },
            required: ['sessionId']
        },
        label: (args) => 'Reading session ' + (args?.sessionId ? String(args.sessionId).slice(0, 20) + '…' : ''),
        handler: async (args) => {
            const sid = String(args?.sessionId || '');
            if (!sid) return { error: 'sessionId required' };
            const data = sessionLog.readSession(sid);
            if (!data) return { error: 'session not found' };
            return { sessionId: sid, entries: data.entries };
        }
    },
    {
        name: 'read_prompt',
        scope: 'read:people',
        readOnly: true,
        description: 'Resolve a prompt_hash referenced in a session turn to the actual system prompt text Erica saw.',
        parameters: {
            type: 'object',
            properties: {
                hash: { type: 'string' }
            },
            required: ['hash']
        },
        label: () => 'Resolving a prompt snapshot',
        handler: async (args) => {
            const h = String(args?.hash || '');
            if (!h) return { error: 'hash required' };
            const snap = sessionLog.readPromptSnapshot(h);
            if (!snap) return { error: 'prompt not found' };
            return snap;
        }
    },
    {
        name: 'list_frameworks',
        scope: 'read:ops',
        readOnly: true,
        description: 'List the coaching framework markdown files available.',
        parameters: { type: 'object', properties: {} },
        label: () => 'Listing coaching frameworks',
        handler: async () => contentStore.listFrameworks()
    },
    {
        name: 'read_framework',
        scope: 'read:ops',
        readOnly: true,
        description: 'Read the full text of one coaching framework .md file.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Base filename without .md, e.g. "Supportive".' }
            },
            required: ['name']
        },
        label: (args) => 'Reading the ' + (args?.name || 'coaching') + ' framework',
        handler: async (args) => contentStore.readFramework(args?.name) || { error: 'framework not found: ' + (args?.name || '') }
    },
    {
        name: 'list_courses',
        scope: 'read:ops',
        readOnly: true,
        description: 'List every course available. Returns [{course_id, title, description, artifacts:[{key,label,chars,source}]}]. Each course has three artifacts: course-content (pedagogical lessons + quizzes), competency-framework (competency definitions / skills / behaviors / performance indicators), and quizzes-list (short index of quizzes and what each measures).',
        parameters: { type: 'object', properties: {} },
        label: () => 'Listing courses',
        handler: async () => {
            const coursesStore = require('./coursesStore');
            return coursesStore.listCourses().map((c) => {
                const artifacts = coursesStore.ARTIFACT_KEYS.map((k) => {
                    const a = coursesStore.readArtifact(c.course_id, k);
                    return a ? { key: k, label: a.label, chars: a.chars, source: a.source } : { key: k, label: coursesStore.ARTIFACT_LABELS[k], missing: true };
                });
                return {
                    course_id: c.course_id,
                    title: c.meta?.title || c.course_id,
                    description: c.meta?.description || '',
                    artifacts
                };
            });
        }
    },
    {
        name: 'read_course_artifact',
        scope: 'read:ops',
        readOnly: true,
        description: 'Read one artifact of a course. artifact key is one of "course-content", "competency-framework", or "quizzes-list". Returns raw markdown so you can quote it back.',
        parameters: {
            type: 'object',
            properties: {
                course_id: { type: 'string', description: 'Course slug, e.g. "tsb".' },
                artifact: { type: 'string', enum: ['course-content', 'competency-framework', 'quizzes-list'] }
            },
            required: ['course_id', 'artifact']
        },
        label: (args) => 'Reading ' + (args?.course_id || 'course') + ' · ' + (args?.artifact || 'artifact'),
        handler: async (args) => {
            const coursesStore = require('./coursesStore');
            const cid = String(args?.course_id || '');
            const key = String(args?.artifact || '');
            if (!cid || !key) return { error: 'course_id and artifact required' };
            const a = coursesStore.readArtifact(cid, key);
            if (!a) return { error: 'artifact not found: ' + cid + '/' + key };
            return { course_id: cid, artifact: key, source: a.source, chars: a.chars, text: a.text };
        }
    },
    {
        name: 'list_activity_events',
        scope: 'read:people',
        readOnly: true,
        description: 'Fetch CleverTap activity for a given user identifier.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                identifierType: { type: 'string', enum: ['userId', 'objectId'] }
            },
            required: ['id']
        },
        label: (args) => 'Fetching activity for ' + (args?.id || 'that user'),
        handler: async (args) => {
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
    }
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const SCOPES = ['read:ops', 'read:people', 'write:content', 'write:people'];

function get(name) { return BY_NAME.get(name) || null; }

// The tools a set of scopes allows (MCP tokens); no argument = all of them
// (the Studio co-worker).
function list(scopes) {
    return scopes ? TOOLS.filter((t) => scopes.includes(t.scope)) : TOOLS.slice();
}

// OpenAI Responses function tools, as the co-worker publishes them.
function forOpenAI(scopes) {
    return list(scopes).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
}

function label(name, args) {
    const t = get(name);
    return t ? t.label(args || {}) : 'Calling ' + name;
}

// Unknown tools and thrown errors come back as { error } for the model to read.
async function exec(name, args, ctx = {}) {
    const t = get(name);
    if (!t) return { error: 'unknown tool: ' + name };
    try {
        return await t.handler(args || {}, ctx);
    } catch (e) {
        return { error: e?.message || String(e) };
    }
}

module.exports = { TOOLS, SCOPES, get, list, forOpenAI, label, exec };
