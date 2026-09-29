const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Regression: after a mid-call WebRTC drop the auto-reconnect stopped the mic
// tracks and nulled localStream, so the new connection had nothing to send —
// the call stayed "on" but deaf (no outbound RTP, no transcript, no reply).
test('a mid-call reconnect keeps the mic and re-attaches it', () => {
    const teardown = app.slice(app.indexOf('    _teardownWebRTCOnly({ keepMic = false } = {}) {'), app.indexOf('    async disconnect() {'));
    assert.ok(teardown.length > 0, '_teardownWebRTCOnly takes { keepMic }');
    assert.match(teardown, /if \(this\.localStream && !keepMic\)/, 'the mic stream survives when keepMic');
    assert.match(teardown, /if \(!keepMic\) \{[\s\S]*audioContext\.close\(\)[\s\S]*clearInterval\(this\.audioLevelInterval\)/, 'so does the local analyser feeding the level loop');

    const drop = app.slice(app.indexOf("console.log('[Erica] WebRTC dropped — auto-reconnecting silently...');"));
    const handler = drop.slice(0, drop.indexOf('this.connect({ skipOpeningLine: true })'));
    assert.match(handler, /_flushUsageOnDisconnect\('reconnect'\)[\s\S]*const keepMic = !!\(this\.isRecording && this\.localStream\);[\s\S]*_teardownWebRTCOnly\(\{ keepMic \}\)/,
        'metering closes the old connection, then the teardown keeps the mic during a call');

    // The new connection's sender gets the same track, and says so.
    assert.match(app, /reconnect: mic re-attached to the new connection/);
});
