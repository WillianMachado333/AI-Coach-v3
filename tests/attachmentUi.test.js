const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('composer exposes accessible attachment controls and safe file types', () => {
    const html = read('index.html');
    assert.match(html, /id="attachmentButton"[^>]+aria-label="Attach a photo or file"/);
    assert.match(html, /id="attachmentInput"[^>]+accept="image\/\*,/);
    assert.match(html, /id="attachmentPreview"/);
    assert.match(html, /id="attachmentStatus"[^>]+role="status"/);
});

test('the photo picker offers the library, not only the camera', () => {
    // `capture` forces the camera and hides the photo library on phones.
    const input = read('index.html').match(/<input id="attachmentInput"[^>]*>/)[0];
    assert.doesNotMatch(input, /\scapture/);
});

test('attach and remove controls are at least 44px tap targets', () => {
    const css = read('styles.css');
    const block = (selector) => css.match(new RegExp('^' + selector.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}', 'm'))[1];
    for (const selector of ['.attachment-button', '.attachment-tile-remove', '.send-text-button', '.call-control-btn']) {
        const rules = block(selector);
        assert.match(rules, /width:\s*44px/, selector);
        assert.match(rules, /height:\s*44px/, selector);
    }
});

test('chat sends supported Realtime image content and never uses unsupported file content', () => {
    const app = read('app.js');
    assert.match(app, /type: 'input_image'/);
    assert.match(app, /type: 'input_text'/);
    assert.doesNotMatch(app, /type:\s*['"]input_file['"]/);
});

test('an unsendable message is refused before the composer clears', () => {
    const app = read('app.js');
    const send = app.slice(app.indexOf('    sendTextMessage('), app.indexOf('    _buildUserItemMessage('));
    const sizeCheck = send.indexOf('_userMessageFits(');
    const firstClear = send.indexOf('clearAttachments()');
    assert.ok(sizeCheck > 0 && sizeCheck < firstClear, 'size check must run before any clear');
    const realSend = send.indexOf('if (!this._sendUserItem(this._buildUserItemMessage(');
    const bubble = send.indexOf("this.upsertMessage(userMessageId, 'user'");
    assert.ok(realSend > 0 && realSend < bubble, 'the user bubble only appears after the send succeeded');
    assert.match(app, /try \{\s*this\.dataChannel\.send\(messageStr\);\s*\} catch/);
});

test('saved history keeps attachment names, never a photo\'s image', () => {
    const app = read('app.js');
    const history = app.slice(app.indexOf('    getConversationHistory('), app.indexOf('    logConversationHistory('));
    assert.match(history, /msg\.attachments\.map\(\(\{ kind, name \}\) => \(\{ kind, name \}\)\)/);
    assert.doesNotMatch(history, /\bsrc\b|dataUrl/);
});

test('bubble photos and the lightbox close button are 44px tap targets', () => {
    const css = read('styles.css');
    const block = (selector) => css.match(new RegExp('^' + selector.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}', 'm'))[1];
    assert.match(block('.bubble-photo'), /min-width:\s*44px/);
    assert.match(block('.bubble-photo'), /min-height:\s*44px/);
    assert.match(block('.image-lightbox-close'), /width:\s*44px/);
    assert.match(block('.image-lightbox-close'), /height:\s*44px/);
});

test('attachment names render as text, never as HTML', () => {
    // A file named <img src=x onerror=…>.png comes from the user's disk.
    const ui = read('uiLayout.js');
    const fn = ui.slice(ui.indexOf('    function renderBubbleAttachments('), ui.indexOf('    function updateMessageElement('));
    assert.match(fn, /name.textContent = attachment.name/);
    for (const assignment of fn.match(/innerHTML = [^;]+;/g) || []) {
        assert.match(assignment, /^innerHTML = '<svg[^$`]*';$/, 'innerHTML only ever gets a static icon: ' + assignment.slice(0, 60));
    }
});
