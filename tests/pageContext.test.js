const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Reported: Erica never looked at the page on her own ("I have to tell her
// she can"), and when she did, three instructions told her never to use what
// it returned — so answers about "this report" stayed generic.
test('Erica looks at the page herself and uses what it shows', () => {
    assert.doesNotMatch(app, /never source facts from the page/i);
    assert.doesNotMatch(app, /NOT your source of substance/);
    const rule = app.slice(app.indexOf("'PAGE AWARENESS (get_page_context)"), app.indexOf("'VISUAL WIDGETS (render_chart"));
    assert.match(rule, /without asking permission/);
    assert.match(rule, /name the specifics/);
    const tool = app.slice(app.indexOf("name: 'get_page_context'"), app.indexOf("name: 'render_chart'"));
    assert.match(tool, /without asking permission/);
    // GPT-Live's voice layer must hand page questions to the backend that can see the page.
    assert.match(app, /never say you cannot see their screen/);
});

test('the same rule reaches Realtime and GPT-Live delegation instructions', () => {
    const realtime = app.slice(app.indexOf('    configureSession() {'), app.indexOf('    configureLiveSession() {'));
    const live = app.slice(app.indexOf('    configureLiveSession() {'), app.indexOf('    _sendPendingTextMessage() {'));
    assert.match(realtime, /this\._buildComposedInstructions\(\)/);
    assert.match(live, /this\._buildComposedInstructions\(\)/);
    assert.match(live, /delegation:[\s\S]*instructions: fullInstructions/);
});
