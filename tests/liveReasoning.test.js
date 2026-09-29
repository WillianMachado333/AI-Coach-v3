const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLiveReasoningLog, isReasoningEvent, ANSWER_CAP } = require('../lib/liveReasoning');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// The inner events of one GPT-Live delegation, in the shapes captured on
// staging with reasoning: { summary: 'auto' } (Senior's rs-auto capture).
function reasoningEvents(itemId, text) {
    const half = Math.floor(text.length / 2);
    return [
        { type: 'response.output_item.added', item: { id: itemId, type: 'reasoning', summary: [] } },
        { type: 'response.reasoning_summary_part.added', item_id: itemId, summary_index: 0, part: { type: 'summary_text', text: '' } },
        { type: 'response.reasoning_summary_text.delta', item_id: itemId, summary_index: 0, delta: text.slice(0, half) },
        { type: 'response.reasoning_summary_text.delta', item_id: itemId, summary_index: 0, delta: text.slice(half) },
        { type: 'response.reasoning_summary_text.done', item_id: itemId, summary_index: 0, text },
        { type: 'response.reasoning_summary_part.done', item_id: itemId, summary_index: 0, part: { type: 'summary_text', text } },
        { type: 'response.output_item.done', item: { id: itemId, type: 'reasoning', summary: [{ type: 'summary_text', text }] } }
    ];
}
const completed = (id, reasoningTokens = 0) => ({
    type: 'response.completed',
    response: { id, model: 'gpt-5.6-terra', output: [], usage: { output_tokens: 70, output_tokens_details: { reasoning_tokens: reasoningTokens } } }
});
const textDeltas = (text) => [...text.match(/.{1,7}/gs)].map((delta) => ({ type: 'response.output_text.delta', delta }));

function harness(opts = {}) {
    const posts = [];
    const timers = [];
    const log = createLiveReasoningLog({
        post: (m) => posts.push(m),
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
        ...opts
    });
    return { log, posts, timers };
}

const SUMMARY = '**Formulating a response**\n\nThe user wants to prioritise, so a deeper look is worth it.';

test('a delegation that calls a tool: one record after the continuation, with the tool and the answer', () => {
    const { log, posts } = harness();
    const D = 'item_ETJh1I07DFikC3TH1UuWm';
    for (const ev of reasoningEvents('rs_1', SUMMARY)) {
        assert.equal(log.observe(ev, D).reasoning, true, ev.type + ' is reasoning-only');
    }
    const call = { type: 'response.output_item.done', item: { type: 'function_call', name: 'deep_think', call_id: 'c1', arguments: '{}' } };
    assert.equal(log.observe(call, D).reasoning, false, 'the function call still reaches the tool dispatcher');
    assert.equal(log.observe(completed('resp_1', 12), D).posted, null, 'held: the answer comes in the continuation');
    assert.equal(posts.length, 0);

    log.observe({ type: 'response.created', response: { id: 'resp_2' } }, D);
    for (const ev of textDeltas('Start with the one thing due this week.')) assert.equal(log.observe(ev, D).reasoning, false);
    const done = log.observe(completed('resp_2'), D);
    assert.equal(posts.length, 1);
    assert.deepEqual(done.posted, posts[0]);
    assert.deepEqual(posts[0], {
        source: 'live_backend',
        summarized: true,
        summary: SUMMARY,
        answer: 'Start with the one thing due this week.',
        model: 'gpt-5.6-terra',
        delegationId: D,
        responseId: 'resp_2',
        responseIds: ['resp_1', 'resp_2'],
        toolCalls: ['deep_think'],
        reasoningTokens: 12,
        chars: SUMMARY.length,
        status: 'completed'
    });
    assert.equal(log.openCount, 0);
});

test('a plain delegation posts on its response.completed', () => {
    const { log, posts } = harness();
    for (const ev of [...reasoningEvents('rs_2', SUMMARY), ...textDeltas('Sure — here is a first step.'), completed('resp_3')]) log.observe(ev, 'd2');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].toolCalls, []);
    assert.equal(posts[0].answer, 'Sure — here is a first step.');
});

test('no reasoning item, no record', () => {
    const { log, posts } = harness();
    for (const ev of [...textDeltas('Hi!'), completed('resp_4')]) log.observe(ev, 'd3');
    assert.equal(posts.length, 0);
    assert.equal(log.openCount, 0, 'nothing left open');
});

// Staging, effort medium: 7-34 reasoning tokens per turn and the summarizer
// returned nothing for ~14 of 15 delegations. The Studio must say so.
test('reasoning the summarizer skipped is still recorded, marked summarized:false', () => {
    const { log, posts } = harness();
    const D = 'd4';
    log.observe({ type: 'response.output_item.added', item: { id: 'rs_4', type: 'reasoning', summary: [] } }, D);
    log.observe({ type: 'response.output_item.done', item: { id: 'rs_4', type: 'reasoning', summary: [], content: [], encrypted_content: 'gAAA' } }, D);
    log.observe({ type: 'response.output_item.done', item: { type: 'function_call', name: 'get_page_context' } }, D);
    log.observe(completed('resp_4a', 7), D);
    for (const ev of [...textDeltas('The page is your Daily Report.'), completed('resp_4b')]) log.observe(ev, D);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].summarized, false);
    assert.equal(posts[0].summary, '');
    assert.equal(posts[0].reasoningTokens, 7);
    assert.deepEqual(posts[0].toolCalls, ['get_page_context']);
    assert.equal(posts[0].answer, 'The page is your Daily Report.');
});

test('a continuation that never completes is still logged, marked incomplete', () => {
    const { log, posts, timers } = harness({ holdMs: 90000 });
    for (const ev of reasoningEvents('rs_5', SUMMARY)) log.observe(ev, 'd5');
    log.observe({ type: 'response.output_item.done', item: { type: 'function_call', name: 'get_page_context' } }, 'd5');
    log.observe(completed('resp_5'), 'd5');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 90000);
    timers[0].fn();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].status, 'incomplete');
    assert.deepEqual(posts[0].toolCalls, ['get_page_context']);
});

test('disconnect flushes a delegation still waiting for its continuation', () => {
    const { log, posts, timers } = harness();
    for (const ev of reasoningEvents('rs_6', SUMMARY)) log.observe(ev, 'd6');
    log.observe({ type: 'response.output_item.done', item: { type: 'function_call', name: 'deep_think' } }, 'd6');
    log.observe(completed('resp_6'), 'd6');
    assert.equal(log.flushAll('reconnect').length, 1);
    assert.equal(posts[0].status, 'reconnect');
    assert.equal(timers[0].cleared, true, 'its hold timer is cleared');
    assert.equal(log.flushAll().length, 0);
});

test('concurrent delegations do not mix, and the answer is capped', () => {
    const { log, posts } = harness();
    const long = 'x'.repeat(ANSWER_CAP + 400);
    for (const ev of reasoningEvents('rs_a', 'Reasoning A')) log.observe(ev, 'dA');
    for (const ev of reasoningEvents('rs_b', 'Reasoning B')) log.observe(ev, 'dB');
    for (const ev of textDeltas(long)) log.observe(ev, 'dA');
    log.observe(completed('resp_b'), 'dB');
    log.observe(completed('resp_a'), 'dA');
    assert.deepEqual(posts.map((p) => [p.delegationId, p.summary]), [['dB', 'Reasoning B'], ['dA', 'Reasoning A']]);
    assert.equal(posts[1].answer.length, ANSWER_CAP);
    assert.ok(posts[1].answer.endsWith('…'));
    assert.equal(posts[0].answer, '');
});

test('only reasoning events are reasoning', () => {
    assert.equal(isReasoningEvent({ type: 'response.output_item.added', item: { type: 'message' } }), false);
    assert.equal(isReasoningEvent({ type: 'response.output_text.delta', delta: 'x' }), false);
    assert.equal(isReasoningEvent({ type: 'response.completed', response: {} }), false);
    assert.equal(isReasoningEvent(null), false);
});

test('app.js asks for the summary and keeps it out of the console and the chat', () => {
    const app = read('app.js');
    // The delegation object is built once for the first configure and every refresh (#31).
    const cfg = app.slice(app.indexOf('    _liveDelegationUpdate(fullInstructions) {'), app.indexOf('    _liveDelegationUpdate(fullInstructions) {') + 1500);
    assert.match(cfg, /reasoning: \{ summary: 'auto' \}/);
    const handler = app.slice(app.indexOf("            case 'response.event': {"), app.indexOf('            // Temporary field-debug instrumentation'));
    const observe = handler.indexOf('this._liveReasoningLog().observe(inner');
    const guard = handler.indexOf('if (reasoning.reasoning) {');
    const unhandled = handler.indexOf("console.log('[Erica][Live] response.event (unhandled inner):'");
    assert.ok(observe > 0 && guard > observe && unhandled > guard, 'reasoning is consumed before the catch-all prints');
    assert.match(handler.slice(guard, guard + 200), /\} else if \(inner\.type === 'response\.output_text\.delta'/, 'the guard heads the dispatch chain');
    const post = app.slice(app.indexOf('    _postReasoningSummary(meta) {'), app.indexOf('    _recordLiveBackendUsage('));
    const logLine = post.slice(0, post.indexOf('fetch('));
    assert.doesNotMatch(logLine, /meta\.summary|meta\.answer|JSON\.stringify\(meta\)/, 'the console line carries no reasoning or answer text');
    assert.ok(post.includes("name: meta.summarized ? 'reasoning_summary' : 'reasoning_unsummarized'"));
    assert.match(post, /keepalive: true/);
    assert.match(app, /_flushUsageOnDisconnect\(reason = 'disconnect'\) \{\s+if \(this\._liveReasoning\) this\._liveReasoning\.flushAll\(reason\);/);
    assert.doesNotMatch(post, /updateBotMessage|addMessage/, 'never rendered to the user');
});

test("the Studio shows Erica's reasoning with its tools and answer, escaped", () => {
    const { _internal } = require('../lib/admin');
    const html = _internal.sessionDetailPage('s-test', { entries: [
        { type: 'session_start', t: '2026-09-29T10:00:00.000Z' },
        { type: 'event', t: '2026-09-29T10:00:05.000Z', name: 'reasoning_summary', meta: {
            source: 'live_backend', summary: 'Weigh <script>alert(1)</script> options', answer: 'Start with <b>one</b> thing.',
            model: 'gpt-5.6-terra', toolCalls: ['deep_think'], chars: 38, status: 'completed' } },
        { type: 'event', t: '2026-09-29T10:00:09.000Z', name: 'reasoning_summary', meta: {
            source: 'live_backend', summary: 'Tool first.', model: 'gpt-5.6-terra', toolCalls: ['get_page_context'], status: 'incomplete' } }
    ] });
    assert.match(html, /Erica's reasoning/);
    assert.match(html, /tools: <span class="font-mono">deep_think<\/span>/);
    assert.match(html, /Start with &lt;b&gt;one&lt;\/b&gt; thing\./);
    assert.match(html, /Weigh &lt;script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, />incomplete</, 'a delegation that never finished says so');
});

test('the Studio says when Erica reasoned but no summary came back', () => {
    const { _internal } = require('../lib/admin');
    const html = _internal.sessionDetailPage('s-test', { entries: [
        { type: 'session_start', t: '2026-09-29T10:00:00.000Z' },
        { type: 'event', t: '2026-09-29T10:00:05.000Z', name: 'reasoning_unsummarized', meta: {
            source: 'live_backend', summarized: false, summary: '', answer: 'It is your <i>Daily Report</i>.',
            model: 'gpt-5.6-terra', toolCalls: ['get_page_context'], reasoningTokens: 7, status: 'completed' } }
    ] });
    assert.ok(html.includes('Erica\'s reasoning · <span class="text-gray-600">no summary returned (7 reasoning tokens)'));
    assert.match(html, /get_page_context/);
    assert.ok(html.includes('It is your &lt;i&gt;Daily Report&lt;/i&gt;.'));
    assert.doesNotMatch(html, /<i>Daily Report<\/i>/);
});
