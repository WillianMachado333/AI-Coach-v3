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
    assert.match(send, /this\._turns\(\)\.queue\(\{ id: pending\.id \}\)/);
    assert.match(send, /const held = this\._liveBusy\(\);\s*if \(!this\._sendUserItem\(itemMessage\)\)/, 'held is what _sendUserItem will do');
    assert.match(send, /this\._turns\(\)\.send\(\{ id: userMessageId, message: itemMessage, session: this\._sessionSeq, held \}\)/);
    const flush = method('_sendPendingTextMessage');
    assert.match(flush, /if \(!this\._channelOpen\(\)\) \{[\s\S]*this\._pendingTextMessages\.push\(pending\);[\s\S]*return;/);
});

// Review of PR #55 (b211f1e).
test('a queued send shows its bubble at the tap and the send reuses its id; queued messages are not history', () => {
    const send = method('sendTextMessage');
    const queuedPath = send.slice(send.indexOf('if (!this.isConnected || channelDead) {'), send.indexOf('// Clear on-hold flag'));
    assert.match(queuedPath, /this\._pendingTextMessages\.push\(pending\);\s*this\._showUserTextBubble\(pending\.id, displayText, attachments, queuedAt\);/);
    assert.match(send, /const userMessageId = queued \? queued\.id : this\._newUserTextId\(userTimestamp\);/);
    assert.match(send, /if \(queued\) \{ this\._pendingTextMessages\.push\(queued\); return; \}/, 'a queued send that cannot go out goes back in the queue, not to a refusal');
    assert.match(method('_sendPendingTextMessage'), /this\.sendTextMessage\(pending\.text, pending\.attachments, \{ queued: pending\.id \? pending : null \}\)/);
    assert.match(method('_historyWindow'), /const open = includeOpen \? \[\] : \[\.\.\.this\._turns\(\)\.openIds\(\), \.\.\.queued\];/);
});

test('an answer counts for the messages the model had when it began: reply ids and start times reach the turn watch; held messages count from the flush', () => {
    assert.match(method('updateBotMessage'), /this\._turns\(\)\.output\(\{ key: meta\.turnKey \|\| id \|\| null, startedAt: meta\.replyStartedAt \?\? null, final: !!isFinal && !voiceFiller \}\)/);
    // Outside a call the voice layer's words never answer a turn.
    assert.match(method('updateBotMessage'), /const voiceFiller = !!meta\.voiceLayer && !this\._inCall\(\);/);
    const live = method('handleLiveMessage');
    assert.match(live, /if \(inner\.type === 'response\.created'\) \{[\s\S]{0,200}this\._liveReplyStartedAt\.set\(message\.delegation_id \|\| '', Date\.now\(\)\);/);
    assert.equal((live.match(/\{ replyStartedAt: this\._liveDelegatedStartedAt \}/g) || []).length, 2, 'the delegated bubble, streaming and final');
    assert.match(method('_scheduleLiveTextFallback'), /\{ replyStartedAt: since \}/);
    const flush = method('_flushLiveHeldTurns');
    assert.match(flush, /held\.forEach\(\(message\) => this\.sendMessage\(message\)\);[\s\S]*this\._turns\(\)\.delivered\(held\);\s*if \(held\.length\) this\._liveSplitUtteranceTurn\(\);/);
});

test('in a call, a voice utterance that runs on past a typed message is a new reply for the turn watch from its next word, in the same bubble', () => {
    const live = method('handleLiveMessage');
    assert.match(live, /else if \(this\._liveBotTurnSplit\) \{[\s\S]{0,300}this\._liveBotTurnKey = `\$\{this\._liveBotItemId\}@\$\{Date\.now\(\)\}`;/);
    assert.equal((live.match(/this\.updateBotMessage\(this\._liveBotItemId, shown, (false|true), Date\.now\(\), \{ turnKey: this\._liveBotTurnKey, voiceLayer: true \}\)/g) || []).length, 2, 'the voice bubble, streaming and final, marked as the voice layer');
    assert.match(method('sendTextMessage'), /this\._turns\(\)\.send\(\{[^}]*\}\);[\s\S]{0,120}if \(!held\) this\._liveSplitUtteranceTurn\(\);/);
    assert.match(method('_liveSplitUtteranceTurn'), /if \(this\._liveBotItemId && this\._inCall\(\)\) this\._liveBotTurnSplit = true;/, 'calls only: after a hang-up her trailing words are not a chat answer');
    assert.match(method('_resendOpenTurns'), /resend\.forEach\(\(entry\) => this\._sendUserItem\(entry\.message\)\);\s*(\/\/[^\n]*\n\s*)*this\._liveSplitUtteranceTurn\(\);\s*this\._requestResponse\('re-sent turn'\);/, 'a re-send (Try again mid-utterance) splits too');
});

test('a call reconnects whatever happens to a typed turn, at most 3 times in 2 min; a failed turn never puts a call in standby', () => {
    const end = method('_onSessionEnd');
    assert.match(end, /if \(inCall && !content\) this\._autoReconnectCall\(\);\s*else if \(decision\.action === 'recover'\) this\._recoverTurn\(\);\s*else this\._enterStandby\(\);/);
    const failed = method('_onTurnFailed');
    assert.match(failed, /if \(!this\.pc && !inCall\) this\._enterStandby\(\);/);
    const auto = method('_autoReconnectCall');
    assert.match(auto, /if \(this\._callReconnects\.length >= limits\.callReconnects\) \{ this\._endDroppingCall\(/);
    assert.match(method('_endDroppingCall'), /_logSessionEvent\('call_reconnect_capped'[\s\S]*this\.stopRecording\(\)[\s\S]*showCallEnded\(this, 'dropped'\)/);
    assert.match(method('establishConnection'), /if \(reconnectKind === 'user'\) this\._callReconnects = \[\];/, "the person's connect gives a call its reconnects back");
    assert.match(method('_retryTurn'), /if \(this\.isConnecting \|\| this\._autoReconnecting\) return;/);
    // An automatic reconnect that ends without a session tries again inside
    // the cap, never over a cut.
    assert.equal((auto.match(/this\._afterAutoReconnect\(\);/g) || []).length, 2, 'after the connect resolves and after it throws');
    assert.match(auto, /if \(this\._liveCut\) \{ this\._autoReconnecting = false; return; \}/);
    const after = method('_afterAutoReconnect');
    assert.match(after, /if \(this\.isConnecting \|\| this\._sessionUnderway\(\)\) return;/);
    assert.match(after, /if \(this\._liveCut \|\| this\.isConnected \|\| this\.isConnecting \|\| this\._autoReconnecting\) return;\s*if \(this\._inCall\(\)\) \{ this\._autoReconnectCall\(\); return; \}/);
});

test('a call never freezes, never leaves for maintenance.html on its own reconnects, and its hang-up tap always hangs up', () => {
    // Automatic reconnects are spaced out and bounded by the call cap, not
    // by the maintenance redirect.
    const auto = method('_autoReconnectCall');
    assert.match(auto, /const delays = limits\.callReconnectDelaysMs \|\| \[1500\];\s*const delay = delays\[Math\.min\(this\._callReconnects\.length, delays\.length\) - 1\];/);
    assert.match(auto, /\}, delay\);\s*\}$/);
    const est = method('establishConnection');
    assert.match(est, /const automatic = this\._reconnectKind === 'auto';\s*try \{/);
    assert.ok(est.indexOf('if (automatic) throw error;') > 0 && est.indexOf('if (automatic) throw error;') < est.indexOf('this._openaiFailCount = (this._openaiFailCount || 0) + 1;'), 'not counted toward the redirect');
    // A failed connect leaves no truthy 'connecting' behind; the reconnect's
    // timer asks whether a session came up; a connect of the person's own
    // that ends without a session during a call is followed up.
    const connect = method('connect');
    assert.match(connect, /const automatic = this\._reconnectKind === 'auto';\s*await this\.stopActivePreview/);
    assert.match(connect, /\} catch \(error\) \{\s*(\/\/[^\n]*\n\s*)*if \(!this\._sessionUnderway\(\)\) this\.isConnected = false;/);
    assert.match(connect, /\} finally \{\s*this\.isConnecting = false;\s*(\/\/[^\n]*\n\s*)*if \(!automatic && this\.isRecording && !this\._liveCut && !this\._sessionUnderway\(\)\) this\._afterAutoReconnect\(\);\s*\}/);
    assert.match(auto, /const underway = this\._sessionUnderway\(\);\s*if \(underway \|\| this\.isConnecting \|\| !this\._inCall\(\)\) \{/);
    // The hang-up comes before "not connected, reconnect".
    const toggle = method('toggleMicTrack');
    const hangup = toggle.search(/if \(this\.isRecording\) \{\s*this\.stopRecording\(\);\s*return;\s*\}/);
    assert.ok(hangup > 0 && hangup < toggle.indexOf('if (!this.isConnected) {'), 'hang-up first');
    assert.equal((toggle.match(/this\.stopRecording\(\)/g) || []).length, 1);
});

test('the safety card shows on a content close only: a transport failure (expiry, drop, 500, timeout) is not a crisis', () => {
    const callers = [...app.matchAll(/this\._showSafetyCard\('([a-z_]+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(callers, ['content_close']);
    assert.match(method('_onContentClose'), /this\._showSafetyCard\('content_close'\);/);
    assert.doesNotMatch(method('_onTurnFailed'), /_showSafetyCard/);
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
