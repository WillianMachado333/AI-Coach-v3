// Wiring for the turn watch (Varsha's stall, 2026-10-14), read from the
// source in the style of tests/reconnect.test.js: the pieces the behaviour
// tests (turnWatch.test.js, turnRecovery.test.js) rely on stay connected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');

function method(name) {
    const start = app.search(new RegExp(`^    (async )?${name}\\(`, 'm'));
    assert.ok(start >= 0, `${name} not found`);
    const open = app.indexOf('{', app.indexOf(')', start));
    let depth = 0; let i = open;
    for (; i < app.length; i++) {
        if (app[i] === '{') depth++;
        else if (app[i] === '}') { depth--; if (depth === 0) break; }
    }
    return app.slice(start, i + 1);
}

test('session.closed does more than log: the session is dead and the turn watch decides', () => {
    const live = method('handleLiveMessage');
    const closed = live.slice(live.indexOf("case 'session.closed':"), live.indexOf("case 'session.input_transcript.delta':"));
    assert.match(closed, /_recordLiveSeconds\(message, 'session\.closed', \{ force: true \}\)/, 'still metered');
    assert.match(closed, /_logSessionEvent\('live_closed', \{ reason:[^}]*sessionAgeS[^}]*turnOpen[^}]*hadUsage/);
    assert.match(closed, /this\._onSessionEnd\('session_closed', \{ reason: message\.reason/);
    // An error event is logged, never a teardown on its own.
    const error = live.slice(live.indexOf("case 'error': {"), live.indexOf('default:', live.indexOf("case 'error': {")));
    assert.match(error, /_logSessionEvent\('live_error', \{ code:/);
    assert.doesNotMatch(error, /_onSessionEnd|_teardownWebRTCOnly|connect\(/);
});

test('every session end goes through _onSessionEnd, and a stale connection is ignored', () => {
    const est = method('establishConnection');
    assert.match(est, /const pc = this\.pc;/);
    assert.match(est, /pc\.onconnectionstatechange = \(\) => \{\s*if \(pc !== this\.pc\) return;/, 'events from an old connection change nothing');
    assert.match(est, /this\._onSessionEnd\('pc_' \+ pc\.connectionState, \{ pc \}\)/);
    assert.match(est, /const onDataChannelClose = \(\) => \{\s*if \(this\.pc === pc\) this\._onSessionEnd\('dc_closed', \{ pc \}\);/);
    assert.equal((est.match(/dataChannel\.onclose = onDataChannelClose;/g) || []).length, 2, 'ours and one OpenAI opens');
    const end = method('_onSessionEnd');
    assert.match(end, /if \(!pc \|\| pc !== this\.pc\) return;/);
    assert.match(end, /this\._teardownWebRTCOnly\(\{ keepMic \}\)[\s\S]*this\._turns\(\)\.hardSignal\(/, 'closed before deciding');
    assert.match(end, /cut: !!this\._liveCut/);
});

test('sendTextMessage opens the turn (the loader-removed path is gone) and the queue flush never opens a session itself', () => {
    const send = method('sendTextMessage');
    assert.doesNotMatch(send, /Loader removed as per request/);
    assert.match(send, /this\._turns\(\)\.queue\(\)/);
    assert.match(send, /this\._turns\(\)\.send\(\{ id: userMessageId, message: itemMessage, session: this\._sessionSeq \}\)/);
    const flush = method('_sendPendingTextMessage');
    assert.match(flush, /if \(!this\._channelOpen\(\)\) \{[\s\S]*this\._pendingTextMessages\.push\(pending\);[\s\S]*return;/);
});

test('tool labels and the waiting dots go through the turn watch', () => {
    const exec = method('executeFunction');
    assert.match(exec, /this\._turns\(\)\.toolStart\(toolKey, functionName\)/);
    assert.match(exec, /finally \{\s*this\._turns\(\)\.toolEnd\(toolKey\);/);
    const ui = read('uiLayout.js');
    assert.match(ui, /function setWaitingState\(app, isWaiting\) \{[\s\S]{0,400}const turnOpen = !!\(app && typeof app\._turnOpen === 'function' && app\._turnOpen\(\)\);/);
    assert.match(ui, /if \(state === 'connecting' \|\| state === 'disconnected'\) \{\s*if \(turnOpen\) connectionLoader\.classList\.add\('hidden'\);/, 'no full-panel overlay over an open turn');
    assert.match(method('establishConnection'), /if \(typeof this\.showLoader === 'function' && !this\._turnOpen\(\)\) this\.showLoader\(\);/);
});

test('every tool fetch has a timeout (AbortSignal); the session create too', () => {
    const exec = app.slice(app.search(/^    async executeFunction\(/m), app.indexOf('    _sendFunctionResult('));
    const fetches = [...exec.matchAll(/(\w+)\(([^,()]*Url|this\.apiUrl\('[^']+'\))\s*,/g)].filter((m) => /fetch/i.test(m[1]));
    assert.equal(fetches.length, 5, 'search_web, get_helpful_resources, search_knowledge, deep_think, and the session log');
    for (const m of fetches) {
        if (/session-log/.test(m[2])) assert.equal(m[1], 'fetch', 'the fire-and-forget log is not a tool fetch');
        else assert.equal(m[1], '_fetchWithTimeout', `${m[2]} has no timeout`);
    }
    assert.match(exec, /_fetchWithTimeout\(dtUrl, \{[\s\S]*?\}, limits\.deepThinkMs, 'deep_think'\)/);
    const helper = method('_fetchWithTimeout');
    assert.match(helper, /new AbortController\(\)/);
    assert.match(helper, /signal: controller\.signal/);
    assert.match(method('establishConnection'), /this\._fetchWithTimeout\(this\.apiUrl\(proxyPath\), \{[\s\S]*?\}, this\._turnLimits\(\)\.connectMs, 'session create'\)/);
    const server = read('server.js');
    const proxy = server.slice(server.indexOf("if (req.url.startsWith('/api/proxy/live'))"));
    assert.match(proxy.slice(0, 6000), /signal: AbortSignal\.timeout\(LIVE_CREATE_TIMEOUT_MS\)/);
});

test('history: chat sessions keep user text out of session.input; the backend gets the window after session.update, with no response.create', () => {
    const est = method('establishConnection');
    assert.match(est, /const plan = isLive \? this\._liveHistoryPlan\(\) : null;/);
    assert.match(est, /const liveHistory = plan \? plan\.input : \[\];/);
    const inject = method('_injectHistoryIntoSession');
    assert.match(inject, /if \(this\.voiceApiMode === 'live'\) \{[\s\S]*type: 'response\.item\.create', item/);
    assert.doesNotMatch(inject, /response\.create'/);
    const live = method('handleLiveMessage');
    const started = live.slice(live.indexOf("case 'session.started':"), live.indexOf("case 'session.usage.updated':"));
    const cfg = started.indexOf('this.configureLiveSession();');
    const resend = started.indexOf('this._resendOpenTurns();');
    const pending = started.indexOf('this._sendPendingTextMessage();');
    assert.ok(cfg > 0 && cfg < resend && resend < pending, 'history, then the re-sent turns, then the queue');
});

test('a live cut wins: recover never clears it, on the client or the server', () => {
    const est = method('establishConnection');
    assert.match(est, /const reconnectKind = \(this\._reconnectKind === 'auto' \|\| this\._reconnectKind === 'recover'\) \? this\._reconnectKind : 'user';/);
    assert.match(est, /if \(reconnectKind === 'user'\) this\._clearLiveCut\(\);/);
    assert.match(method('_cutLive'), /this\._turns\(\)\.fail\('cut'\);/);
    const server = read('server.js');
    const proxy = server.slice(server.indexOf("if (req.url.startsWith('/api/proxy/live'))"), server.indexOf("if (req.url.startsWith('/api/proxy/live'))") + 4000);
    assert.match(proxy, /const automatic = reconnectKind === 'auto' \|\| reconnectKind === 'recover';/);
    assert.match(proxy, /if \(!automatic\) liveGuard\.clearCut\(guardSid\);/);
});

test('the content close is sticky and the card is saved with the conversation', () => {
    assert.match(method('saveCurrentState'), /contentClosed: this\._contentClosed \|\| null,\s*safetyCard: this\._safetyCard \|\| null/);
    const load = method('loadSavedState');
    assert.match(load, /this\._contentClosed = state\.contentClosed/);
    assert.match(load, /this\._restoreSafetyCard\(\)/);
    assert.match(method('clearConversation'), /this\._contentClosed = null;\s*this\._safetyCard = null;/);
});

test('the browser loads lib/turnWatch.js before app.js, and both are cache-busted', () => {
    const html = read('index.html');
    const tw = html.indexOf('<script src="lib/turnWatch.js?v=');
    const appTag = html.indexOf('<script src="app.js?v=');
    assert.ok(tw > 0 && tw < appTag);
    assert.doesNotMatch(html, /app\.js\?v=20261003a/, 'app.js changed: its ?v= must too');
    assert.doesNotMatch(html, /uiLayout\.js\?v=20261002a/, 'uiLayout.js changed: its ?v= must too');
    assert.ok(require('../lib/staticPath').PUBLIC_FILES.has('lib/turnWatch.js'));
});

test('package.json has a verify script that runs the whole node --test suite', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.verify, /^node --test\b/);
});
