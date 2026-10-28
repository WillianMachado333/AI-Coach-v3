const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Regression: after a mid-call WebRTC drop the auto-reconnect stopped the mic
// tracks and nulled localStream, so the new connection had nothing to send —
// the call stayed "on" but deaf (no outbound RTP, no transcript, no reply).
// (Behaviour: tests/turnRecovery.test.js, 'a call that drops ... keeping the mic'.)
test('a mid-call reconnect keeps the mic and re-attaches it', () => {
    const teardown = app.slice(app.indexOf('    _teardownWebRTCOnly({ keepMic = false } = {}) {'), app.indexOf('    async disconnect() {'));
    assert.ok(teardown.length > 0, '_teardownWebRTCOnly takes { keepMic }');
    assert.match(teardown, /if \(this\.localStream && !keepMic\)/, 'the mic stream survives when keepMic');
    assert.match(teardown, /if \(!keepMic\) \{[\s\S]*audioContext\.close\(\)[\s\S]*clearInterval\(this\.audioLevelInterval\)/, 'so does the local analyser feeding the level loop');

    // Every session end (session.closed, the data channel, a pc drop) goes
    // through _onSessionEnd: metering closes the old connection, the teardown
    // keeps the mic during a call (unless the safety filter ended it), then a
    // call reconnects on its own.
    const end = app.slice(app.indexOf('    _onSessionEnd(cause, '), app.indexOf('    _onContentClose(inCall) {'));
    assert.match(end, /_flushUsageOnDisconnect\('reconnect'\)[\s\S]*const keepMic = inCall && !content && !!this\.localStream;[\s\S]*_teardownWebRTCOnly\(\{ keepMic \}\)[\s\S]*this\._autoReconnectCall\(\)/,
        'metering closes the old connection, then the teardown keeps the mic during a call');
    const drop = app.slice(app.indexOf("console.log('[Erica] WebRTC dropped — auto-reconnecting silently...');"));
    assert.match(drop.slice(0, 1200), /this\._reconnectKind = 'auto';\s*this\.connect\(\{ skipOpeningLine: true \}\)/);

    // The new connection's sender gets the same track, and says so.
    assert.match(app, /reconnect: mic re-attached to the new connection/);
});
