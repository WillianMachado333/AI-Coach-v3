const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Regression: hanging up a GPT-Live call sent input_audio_buffer.clear, a
// Realtime-only event, and Live answered every call with
//   invalid_request_error: Invalid value: 'input_audio_buffer.clear'.
// Harmless, but an error line in every call log.
test('hang-up sends input_audio_buffer.clear only outside GPT-Live', () => {
    // Everything before PreviewSession, which is its own Realtime connection
    // (voice previews) and never runs on Live.
    const main = app.slice(0, app.indexOf('class PreviewSession'));
    const sends = main.match(/type: 'input_audio_buffer\.clear'/g) || [];
    assert.equal(sends.length, 1, 'the one hang-up send');
    const cancel = main.slice(main.indexOf('    cancelActiveResponses() {'));
    assert.match(
        cancel,
        /if \(this\.voiceApiMode !== 'live'\) \{\s*this\.sendMessage\(\{\s*type: 'input_audio_buffer\.clear'\s*\}\);\s*\}/,
        'the clear must sit inside the not-Live guard'
    );
});
