const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/attachmentRules');

const file = (name, type, size) => ({ name, type, size });

test('accepts supported image and text attachments within limits', () => {
    assert.equal(rules.validateFile(file('moment.jpg', 'image/jpeg', 1200)).ok, true);
    assert.equal(rules.validateFile(file('notes.md', '', 1200)).kind, 'text');
});

test('accepts full-size phone camera photos, which are re-encoded before sending', () => {
    // Regression: a 9.6 MB camera JPEG used to be rejected at a 4 MB cap.
    assert.equal(rules.validateFile(file('IMG_4821.JPG', 'image/jpeg', 9.6 * 1024 * 1024)).ok, true);
    assert.equal(rules.validateFile(file('IMG_4821.HEIC', 'image/heic', 3 * 1024 * 1024)).kind, 'image');
    assert.equal(rules.validateFile(file('IMG_4821.heic', '', 3 * 1024 * 1024)).kind, 'image');
    // Photo size never counts against the running text total.
    assert.equal(rules.validateFile(file('big.jpg', 'image/jpeg', 12 * 1024 * 1024), 0, rules.MAX_TOTAL_BYTES).ok, true);
});

test('rejects unsafe types, oversized files, and attachment limits', () => {
    assert.equal(rules.validateFile(file('secret.pdf', 'application/pdf', 1200)).code, 'type');
    assert.equal(rules.validateFile(file('logo.svg', 'image/svg+xml', 1200)).code, 'type');
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

test('fits photos inside the long-edge cap without upscaling', () => {
    assert.deepEqual(rules.fitWithin(4032, 3024, 1280), { width: 1280, height: 960 });
    assert.deepEqual(rules.fitWithin(3024, 4032, 1280), { width: 960, height: 1280 });
    assert.deepEqual(rules.fitWithin(800, 600, 1280), { width: 800, height: 600 });
});

test('a full set of photos at budget plus text fits one data-channel message', () => {
    // Regression: an 835 KB photo made dataChannel.send() throw
    // "larger than max-message-size" while the bubble showed as sent.
    const budget = rules.imageBudgetFor(262144);
    const photo = 'data:image/jpeg;base64,' + 'A'.repeat(budget - 23);
    const message = JSON.stringify({
        type: 'response.item.create',
        item: {
            type: 'message', role: 'user', content: [
                { type: 'input_text', text: 'x'.repeat(4000) },
                ...Array.from({ length: rules.MAX_ATTACHMENTS }, () => ({ type: 'input_image', image_url: photo, detail: 'auto' }))
            ]
        }
    });
    assert.equal(rules.messageFits(message, 262144), true);
    const unshrunk = JSON.stringify({ image_url: 'data:image/jpeg;base64,' + 'A'.repeat(835 * 1024 * 4 / 3) });
    assert.equal(rules.messageFits(unshrunk, 262144), false);
});

test('photo budget shrinks when a browser negotiates a smaller message cap', () => {
    assert.equal(rules.imageBudgetFor(262144), rules.IMAGE_DATAURL_BUDGET);
    assert.equal(rules.imageBudgetFor(undefined), rules.IMAGE_DATAURL_BUDGET);
    assert.ok(rules.imageBudgetFor(65536) * rules.MAX_ATTACHMENTS < 65536);
    assert.equal(rules.imageBudgetFor(Infinity), rules.IMAGE_DATAURL_BUDGET);
});
