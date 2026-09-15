const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('composer exposes accessible attachment controls and safe file types', () => {
    const html = read('index.html');
    assert.match(html, /id="attachmentButton"[^>]+aria-label="Attach a photo or file"/);
    assert.match(html, /id="attachmentInput"[^>]+accept="[^"]*image\/png/);
    assert.match(html, /id="attachmentPreview"/);
    assert.match(html, /id="attachmentStatus"[^>]+role="status"/);
});

test('chat sends supported Realtime image content and never uses unsupported file content', () => {
    const app = read('app.js');
    assert.match(app, /type: 'input_image'/);
    assert.match(app, /type: 'input_text'/);
    assert.doesNotMatch(app, /type:\s*['"]input_file['"]/);
});
