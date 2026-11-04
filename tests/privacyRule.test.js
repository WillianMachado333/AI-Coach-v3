// Varsha's review (29 Oct 2026): asked about privacy, the coach said it could
// not confirm how the data is handled and sent her to the terms, an answer
// "legally correct but leaves the user feeling uncertain"; the earlier version
// said the data is kept secure and used for coaching. One fixed rule now
// gives the coach the facts to say, in every prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PRIVACY_RULE } = require('../lib/coachUiRules');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('the rule says what is true and reassuring, and points to the policy', () => {
    assert.match(PRIVACY_RULE, /kept secure/i);
    assert.match(PRIVACY_RULE, /only to support (?:their|your) coaching/i);
    assert.match(PRIVACY_RULE, /small Talent Transformation team can review/i);
    assert.match(PRIVACY_RULE, /forget something/i);
    assert.match(PRIVACY_RULE, /https:\/\/www\.talenttransformation\.com\/privacy-policy/);
    assert.match(PRIVACY_RULE, /never say you cannot confirm/i, 'no more "I can\'t verify" hedging');
    assert.ok(PRIVACY_RULE.length < 700, 'one short rule');
});

test('the rule reaches the composed instructions (Realtime and the Live backend) and the Live voice layer', () => {
    const composed = app.slice(app.indexOf('    _buildComposedInstructions() {'), app.indexOf('    configureSession() {'));
    assert.ok(composed.includes("instructions += '\\n\\n' + this._privacyRule();"), 'composed instructions');
    const live = app.slice(app.indexOf('const shortLiveInstructions ='), app.indexOf("headers['X-Erica-Live-Instructions']"));
    assert.match(live, /this\._privacyRule\(\)/, 'Live short instructions');
    const accessor = app.slice(app.indexOf('    _privacyRule() {'), app.indexOf('    _buildComposedInstructions() {'));
    assert.match(accessor, /console\.error\(/, 'a missing rule is loud');
});
