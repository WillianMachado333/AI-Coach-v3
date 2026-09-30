const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// Regression: after a reload or reconnect the UI restored the old bubbles
// but the model session started empty — "I don't have that earlier context".
test('each new session gets the recent conversation, in both voice APIs', () => {
    const app = read('app.js');
    // Realtime: replayed right after session.update, never with a response.create.
    const realtime = app.slice(app.indexOf('    configureSession() {'), app.indexOf('    configureLiveSession() {'));
    assert.match(realtime, /this\._injectHistoryIntoSession\(/);
    const inject = app.slice(app.indexOf('    _injectHistoryIntoSession('), app.indexOf('     * Queue a save of the current conversation history.'));
    assert.match(inject, /conversation\.item\.create/);
    assert.doesNotMatch(inject, /response\.create/);
    assert.match(inject, /this\._historyInjectedFor === this\.pc/, 'once per session');
    // GPT-Live: session.input at creation — its voice layer never sees items added later.
    const connect = app.slice(app.indexOf("const proxyPath = isLive ? '/api/proxy/live' : '/api/proxy/realtime';"));
    assert.match(connect.slice(0, 3000), /JSON\.stringify\(\{ sdp: body, input: liveHistory \}\)/);
    const server = read('server.js');
    const proxy = server.slice(server.indexOf("if (req.url.startsWith('/api/proxy/live'))"));
    assert.match(proxy.slice(0, 5000), /input = liveSessionInput\(parsed\.input\)/);
    assert.match(proxy.slice(0, 5000), /\.\.\.\(input\.length \? \{ input \} : \{\}\)/);
});
