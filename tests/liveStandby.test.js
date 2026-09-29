const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// GPT-Live bills 15 s for every session it opens, and an idle open tab gets
// its session dropped and re-opened every ~4.5 min (~$0.17/h per tab). The
// page must not open one until the user calls or types.
test('no GPT-Live session on page load', () => {
    const app = read('app.js');
    const auto = app.slice(app.indexOf('    async autoConnect() {'), app.indexOf('    async autoConnect() {') + 3000);
    const liveBranch = auto.slice(auto.indexOf("await this._resolveVoiceApiMode() === 'live'"), auto.indexOf('this.connect({ skipOpeningLine })'));
    assert.ok(liveBranch.length > 0, 'autoConnect resolves the voice API before connecting');
    assert.match(liveBranch, /return;/, 'and returns before connect() on Live');
    assert.doesNotMatch(liveBranch, /this\.connect\(|establishConnection\(/);
    // What costs nothing still happens: preparation (pills, persona) and the report-cache probe.
    assert.match(liveBranch, /this\.fetchEricaPreparation\(/);
    assert.match(liveBranch, /this\.requestReportContextFromParent\(\)/);
    // The first call click and the first typed message connect on demand.
    const toggle = app.slice(app.indexOf('    toggleMicTrack() {'), app.indexOf('    toggleMicTrack() {') + 1500);
    assert.match(toggle, /if \(!this\.isConnected\)[\s\S]*this\.connect\(\)/);
    const send = app.slice(app.indexOf('    sendTextMessage('), app.indexOf('    _buildUserItemMessage('));
    assert.match(send, /this\.connect\(\{ skipOpeningLine: true \}\)/);
});

test('the corner icon shows standby, not "disconnected", before the first session', () => {
    const app = read('app.js');
    assert.match(app, /const state = this\.isConnected \? 'connected' : \(this\._liveStandby \? 'standby' : 'disconnected'\);/);
    assert.match(read('bridge.js'), /case 'standby': colour = /);
});
