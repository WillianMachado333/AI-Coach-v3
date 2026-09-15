const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/attachmentRules');

const file = (name, type, size) => ({ name, type, size });

test('accepts supported image and text attachments within limits', () => {
    assert.equal(rules.validateFile(file('moment.jpg', 'image/jpeg', 1200)).ok, true);
    assert.equal(rules.validateFile(file('notes.md', '', 1200)).kind, 'text');
});

test('rejects unsafe types, oversized files, and attachment limits', () => {
    assert.equal(rules.validateFile(file('secret.pdf', 'application/pdf', 1200)).code, 'type');
    assert.equal(rules.validateFile(file('large.png', 'image/png', rules.MAX_IMAGE_BYTES + 1)).code, 'size');
    assert.equal(rules.validateFile(file('fourth.txt', 'text/plain', 10), rules.MAX_ATTACHMENTS).code, 'too_many');
    assert.equal(rules.validateFile(file('over-total.txt', 'text/plain', 10), 0, rules.MAX_TOTAL_BYTES).code, 'total_size');
});

test('truncates text payloads without changing safe short content', () => {
    assert.deepEqual(rules.truncateText('hello'), { text: 'hello', truncated: false });
    const result = rules.truncateText('x'.repeat(rules.MAX_TEXT_CHARS + 10));
    assert.equal(result.text.length, rules.MAX_TEXT_CHARS);
    assert.equal(result.truncated, true);
});
