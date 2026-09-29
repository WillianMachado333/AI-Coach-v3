const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const method = (name) => {
    const start = app.search(new RegExp(`^    (async )?${name}\\(`, 'm'));
    assert.ok(start >= 0, `${name} not found`);
    const next = app.slice(start + 1).search(/^    (async )?[_a-zA-Z]+\([^)]*\) \{/m);
    return app.slice(start, next < 0 ? undefined : start + 1 + next);
};

// Regression: GPT-Live rejects response.create while a delegated function
// call is waiting for its output (function_call_outputs_required) and drops
// that turn. Every user-turn path must go through the gate.
test('user-turn paths never send response.create directly', () => {
    for (const name of ['sendTextMessage', 'speakOneShot', 'sendOpeningLinePrompt', 'regenerateResponse']) {
        const body = method(name);
        assert.doesNotMatch(body, /sendMessage\(\{\s*type:\s*'response\.create'/, `${name} bypasses _requestResponse`);
        assert.match(body, /_requestResponse\(/, `${name} should ask via _requestResponse`);
    }
    for (const name of ['sendTextMessage', 'speakOneShot', 'sendOpeningLinePrompt']) {
        assert.match(method(name), /_sendUserItem\(/, `${name} should send its item via _sendUserItem`);
    }
});

test('a Live function call is tracked before it runs, and its output releases held turns', () => {
    const live = method('handleLiveMessage');
    const track = live.indexOf('_trackLiveFunctionCall(item.call_id');
    const run = live.indexOf('this.executeFunction(item.name');
    assert.ok(track > 0 && track < run, 'call must be tracked before executeFunction');
    assert.match(live, /case 'session\.started':[\s\S]{0,200}_resetLiveTurnGate\(\)/);
    assert.match(method('_sendFunctionResult'), /_afterLiveFunctionOutput\(callId\)/);
    // Held turns wait for the reply that continues after the tool output;
    // sending them with it made the model merge two questions into one answer.
    const after = method('_afterLiveFunctionOutput');
    assert.match(after, /_liveAwaitingContinuation = true/);
    assert.doesNotMatch(after, /held\.forEach|_flushLiveHeldTurns/);
    assert.match(live, /_onLiveResponseEvent\(inner/);
    assert.match(method('_onLiveResponseEvent'), /_flushLiveHeldTurns\(/);
    const flushFn = method('_flushLiveHeldTurns');
    const flush = flushFn.indexOf('held.forEach');
    const create = flushFn.indexOf("type: 'response.create'");
    assert.ok(flush > 0 && flush < create, 'held turns go out before their single response.create');
});
