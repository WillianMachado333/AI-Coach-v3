const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LANGUAGE_RULE } = require('../lib/coachUiRules');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const app = read('app.js');
const server = read('server.js');

// Regression: GPT-Live once opened a call in Norwegian ("Hei! Så hyggelig å møtes…")
// — the old rule was "reply in the language the user is currently speaking; do not
// default to English", and a beep on the mic was enough to pick a language.
test('the rule pins English, switches on clear speech only, and never infers from noise', () => {
    assert.match(LANGUAGE_RULE, /speak English by default/i);
    assert.match(LANGUAGE_RULE, /only after the user has clearly spoken or typed in it/i);
    assert.match(LANGUAGE_RULE, /never infer a language from background noise, breaths, tones or silence/i);
    assert.match(LANGUAGE_RULE, /if you are unsure, use English/i);
    assert.ok(LANGUAGE_RULE.length < 300, 'one short rule');
});

test('the old "do not default to English" rules are gone everywhere', () => {
    for (const [name, source] of [['app.js', app], ['server.js', server]]) {
        assert.doesNotMatch(source, /do not default to English/i, name);
        assert.doesNotMatch(source, /Always (?:reply|respond) in the (?:same )?language/i, name);
    }
});

test('the rule reaches all three prompts', () => {
    // 1. GPT-Live's short session.instructions: built by the client, with the server default as fallback.
    const live = app.slice(app.indexOf('const shortLiveInstructions ='), app.indexOf("headers['X-Erica-Live-Instructions']"));
    assert.match(live, /this\._languageRule\(\)/, 'client-built Live instructions');
    assert.match(server, /'concise\. ' \+ LANGUAGE_RULE/, 'server default Live instructions');
    // 2. The composed instructions: Realtime session.instructions (configureSession)…
    const composed = app.slice(app.indexOf('    _buildComposedInstructions() {'), app.indexOf('    configureSession() {'));
    assert.ok(composed.includes("instructions += '\\n\\n' + this._languageRule();"), 'composed instructions');
    const realtime = app.slice(app.indexOf('    configureSession() {'), app.indexOf('    configureLiveSession() {'));
    assert.match(realtime, /_buildComposedInstructions\(\)/, 'Realtime session.instructions uses the composed instructions');
    // 3. …and the Live delegation.responses.instructions, built from the same composed instructions.
    const liveDelegation = app.slice(app.indexOf('    configureLiveSession() {'));
    assert.match(liveDelegation.slice(0, 1200), /const instructions = this\._buildComposedInstructions\(\);/);
    assert.match(liveDelegation.slice(0, 2500), /instructions: fullInstructions/);
});

test('a missing rule is loud, not a silent prompt without one', () => {
    const accessor = app.slice(app.indexOf('    _languageRule() {'), app.indexOf('    _buildComposedInstructions() {'));
    assert.match(accessor, /console\.error\(/);
});
