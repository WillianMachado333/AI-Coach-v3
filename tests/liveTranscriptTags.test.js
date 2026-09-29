const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// The tag filter is pure and tested in coachUiRules.test.js; this pins that
// BOTH Live transcript handlers go through it before anything is rendered,
// synced or counted, on every delta and at finalize.
test('Live input and output transcripts are filtered before they render', () => {
    const at = (needle) => {
        const i = app.indexOf(needle);
        assert.ok(i > 0, needle);
        return i;
    };
    const input = app.slice(at("case 'session.input_transcript.delta':"), at("case 'session.output_transcript.delta':"));
    const output = app.slice(at("case 'session.output_transcript.delta':"), at("case 'response.event':"));
    for (const [name, block, update, raw] of [
        ['input', input, 'updateUserMessage', '_liveUserTranscript'],
        ['output', output, 'updateBotMessage', '_liveBotTranscript']
    ]) {
        const updates = block.split(`this.${update}(`).slice(1).map((rest) => rest.slice(0, rest.indexOf(')')));
        assert.equal(updates.length, 2, `${name}: two render sites (delta, finalize)`);
        for (const args of updates) assert.ok(!args.includes(raw), `${name}: the raw transcript must never reach ${update}: ${args}`);
        const filtered = block.match(/_nonSpeechFiltered\(/g) || [];
        assert.equal(filtered.length, 2, `${name}: filtered on every delta and at finalize`);
        assert.match(block, /if \(shown\) this\.update(User|Bot)Message\(/, `${name}: nothing renders when only tags arrived`);
    }
});
