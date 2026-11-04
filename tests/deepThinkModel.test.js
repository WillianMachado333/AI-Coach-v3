// OpenAI retired o4-mini on 23 Oct 2026; every deep_think call on staging
// then failed with "404 The model `o4-mini` does not exist". The reasoning
// step now defaults to the model the GPT-Live backend already runs on, and
// DEEP_THINK_MODEL still overrides it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('deep_think defaults to a model the account can reach, still overridable', () => {
    assert.match(read('lib/vectorStore.js'), /model \|\| process\.env\.DEEP_THINK_MODEL \|\| 'gpt-5\.6-terra'/);
});

test('o4-mini is gone from the code and from what the model and Studio read', () => {
    for (const name of ['app.js', 'server.js', 'lib/vectorStore.js', 'lib/runtimeConfig.js']) {
        assert.doesNotMatch(read(name), /o4-mini/, name);
    }
});
