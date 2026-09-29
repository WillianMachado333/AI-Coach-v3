const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Regression: a message typed during a GPT-Live call was answered by the
// backend ("BANANA") and never shown — call mode only logged backend text,
// and the voice layer never says a tool-less delegated answer.
test('call mode renders a backend answer the voice layer never said', () => {
    const branch = app.slice(app.indexOf("inner.type === 'response.output_text.done' || inner.type === 'response.completed'"));
    const held = branch.slice(0, branch.indexOf('} else if (inner.type ==='));
    assert.match(held, /this\._scheduleLiveTextFallback\(/, 'held backend text must get a fallback');
    const fallback = app.slice(app.indexOf('    _scheduleLiveTextFallback('), app.indexOf('    _flushLiveHeldTurns('));
    assert.match(fallback, /spokenCovers/);
    assert.match(fallback, /_liveDelegationToolAt/);
    assert.match(fallback, /backend text rendered — voice layer stayed silent for/, 'the degradation is logged, never silent');
    assert.match(fallback, /this\.updateBotMessage\(/);
});
