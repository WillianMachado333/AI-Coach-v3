// #38 step A: one tool registry for the Studio co-worker and the MCP
// connector, and the co-worker's history per person (it was one file shared
// by every admin).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tools-'));
process.env.AGENT_HISTORY_DIR = path.join(tmp, 'agent-history');
const root = path.join(__dirname, '..');

const sessionLog = require('../lib/sessionLog');
const tools = require('../lib/studioTools');
const agent = require('../lib/studioAgent');
const agentHistory = require('../lib/agentHistory');

const BEFORE = ['list_recent_sessions', 'read_session', 'read_prompt', 'list_frameworks', 'read_framework', 'list_courses', 'read_course_artifact', 'list_activity_events'];

test('registry: the co-worker\'s 8 tools, each with a scope and MCP annotations; anything about a person is read:people', () => {
    assert.deepEqual(tools.TOOLS.map((t) => t.name), BEFORE);
    assert.equal(new Set(tools.TOOLS.map((t) => t.name)).size, tools.TOOLS.length);
    for (const t of tools.TOOLS) {
        assert.ok(tools.SCOPES.includes(t.scope), t.name + ' scope');
        assert.equal(typeof t.readOnly, 'boolean');
        assert.equal(t.parameters.type, 'object');
        assert.equal(typeof t.handler, 'function');
        assert.equal(typeof t.label, 'function');
    }
    const people = tools.TOOLS.filter((t) => t.scope === 'read:people').map((t) => t.name);
    assert.deepEqual(people, ['list_recent_sessions', 'read_session', 'read_prompt', 'list_activity_events'], 'actors, transcripts, prompts with the person\'s report, their CleverTap events');
    assert.deepEqual(tools.list(['read:ops']).map((t) => t.name), ['list_frameworks', 'read_framework', 'list_courses', 'read_course_artifact']);
});

test('the co-worker publishes the same OpenAI tools and task labels as before, now from the registry', async () => {
    assert.deepEqual(agent.TOOLS.map((t) => t.name), BEFORE);
    for (const t of agent.TOOLS) {
        assert.deepEqual(Object.keys(t).sort(), ['description', 'name', 'parameters', 'type']);
        assert.equal(t.type, 'function');
    }
    assert.deepEqual(agent.TOOLS.find((t) => t.name === 'read_course_artifact').parameters.properties.artifact.enum, ['course-content', 'competency-framework', 'quizzes-list']);
    assert.equal(tools.label('read_session', { sessionId: 's-v1234567890abcdefghijk' }), 'Reading session s-v1234567890abcdefg…');
    assert.equal(tools.label('read_framework', { name: 'Supportive' }), 'Reading the Supportive framework');
    assert.equal(tools.label('list_activity_events', {}), 'Fetching activity for that user');
    assert.equal(tools.label('nope', {}), 'Calling nope');
    const src = fs.readFileSync(path.join(root, 'lib/studioAgent.js'), 'utf8');
    assert.ok(!/switch \(name\)|switch \(toolName\)/.test(src), 'no hand-kept switches left');
});

test('exec: results as before; unknown tools and thrown errors come back as { error }', async () => {
    const orig = sessionLog.listSessions;
    sessionLog.listSessions = ({ tester, limit }) => [{ sessionId: 's-v1', startedAt: 't0', lastAt: 't1', turns: 4, actor: { email: 'a@b.c' }, size: 999, cost: { usd: 1 }, tester, limit }];
    try {
        assert.deepEqual(await tools.exec('list_recent_sessions', { limit: 500, tester: 'weird' }), [{ sessionId: 's-v1', startedAt: 't0', lastAt: 't1', turns: 4, actor: { email: 'a@b.c' } }]);
        sessionLog.listSessions = () => { throw new Error('index unreadable'); };
        assert.deepEqual(await tools.exec('list_recent_sessions', {}), { error: 'index unreadable' });
    } finally { sessionLog.listSessions = orig; }
    assert.deepEqual(await tools.exec('drop_tables', {}), { error: 'unknown tool: drop_tables' });
    assert.deepEqual(await tools.exec('read_session', {}), { error: 'sessionId required' });
});

test('co-worker history is per person: separate files keyed by a hash of the email, the same person in any case, clear only touches your own', () => {
    agentHistory.append('Eric@TT.com', { question: 'q-eric', answer: 'a-eric' });
    agentHistory.append('varsha@tt.com', { question: 'q-varsha', answer: 'a-varsha' });
    agentHistory.append('eric@tt.com', { question: 'q2-eric', answer: 'a2-eric' });
    const files = fs.readdirSync(process.env.AGENT_HISTORY_DIR).sort();
    assert.equal(files.length, 2);
    for (const f of files) assert.match(f, /^u-[0-9a-f]{24}\.ndjson$/, 'no email in a file name');
    assert.deepEqual(agentHistory.readAll('eric@tt.com').map((e) => [e.actor, e.question]), [['eric@tt.com', 'q-eric'], ['eric@tt.com', 'q2-eric']]);
    assert.deepEqual(agentHistory.rebuildInput('varsha@tt.com'), [{ role: 'user', content: 'q-varsha' }, { role: 'assistant', content: 'a-varsha' }]);
    agentHistory.clear('ERIC@tt.com');
    assert.equal(agentHistory.readAll('eric@tt.com').length, 0);
    assert.equal(agentHistory.readAll('varsha@tt.com').length, 1, 'someone else\'s history is untouched');
    const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.ok(!/agentHistory\.\w+\(sess\.sub/.test(src), 'no route keys history by the shared subject');
    assert.match(src, /function historyKey\(sess\) \{ return \(sess && \(sess\.actor \|\| sess\.sub\)\) \|\| 'admin'; \}/);
});

test('the co-worker loop runs registry tools end to end (fake model): a tool call, its output fed back, the answer; the running-task line uses the registry label', async () => {
    const contentStore = require('../lib/contentStore');
    const origList = contentStore.listFrameworks;
    contentStore.listFrameworks = () => ['Supportive', 'Directive'];
    const calls = [];
    agent.setClient({ responses: { create: async (req) => {
        calls.push(req);
        if (calls.length === 1) return { output: [{ type: 'function_call', call_id: 'c1', name: 'list_frameworks', arguments: '{}' }] };
        return { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Two frameworks: Supportive and Directive.' }] }] };
    } } });
    const events = [];
    try {
        await agent.runTurnStreamed({ userMessage: 'Which frameworks exist?' }, (e) => { events.push(e); return e.id; });
    } finally { contentStore.listFrameworks = origList; }
    assert.deepEqual(calls[0].tools.map((t) => t.name), BEFORE);
    const fed = calls[1].input.find((i) => i.type === 'function_call_output');
    assert.deepEqual([fed.call_id, JSON.parse(fed.output)], ['c1', ['Supportive', 'Directive']]);
    assert.ok(events.some((e) => e.type === 'task' && e.label === 'Listing coaching frameworks' && e.status === 'running'));
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).text, 'Two frameworks: Supportive and Directive.');
});
