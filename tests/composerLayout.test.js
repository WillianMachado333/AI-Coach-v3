const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

// Reported: the composer jumped whenever call mode toggled — the pill shrank
// (48->32px, 16->13px text, width clamped to ~220px), the round call button
// vanished, and a separate controls panel floated above the pill row.
// Call mode must only change what's inside the pill.

test('call controls live inside the composer pill, not in a floating panel', () => {
    const html = read('index.html');
    const wrapper = html.indexOf('id="inputWrapper"');
    const panel = html.indexOf('id="callModePanel"');
    const fab = html.indexOf('id="micToggleBtn"');
    assert.ok(wrapper > 0 && wrapper < panel && panel < fab, 'callModePanel must sit inside the pill, before the round button');
    const panelTag = html.slice(panel, html.indexOf('>', panel));
    assert.doesNotMatch(panelTag, /\bfixed\b/);
});

test('call mode never resizes the pill, the textarea, or the chat padding', () => {
    const css = read('styles.css');
    assert.doesNotMatch(css, /voice-mode-active\s*>\s*div:first-child/);
    assert.doesNotMatch(css, /call-panel-open/);
    const layout = read('uiLayout.js');
    const fn = layout.slice(layout.indexOf('function setCallModePanelOpen('), layout.indexOf('function updateCallPanelSpeakerUI('));
    assert.doesNotMatch(fn, /\.style\.(minHeight|fontSize|paddingTop|paddingBottom)/);
    assert.doesNotMatch(fn, /call-panel-open/);
});

test('the round call button stays in place and becomes End call', () => {
    const layout = read('uiLayout.js');
    assert.doesNotMatch(layout, /micToggleButton\.classList\.toggle\('hidden'/);
    const fn = layout.slice(layout.indexOf('function setCallModePanelOpen('), layout.indexOf('function updateCallPanelSpeakerUI('));
    assert.match(fn, /'End call'/);
});

// Reported: "ficamos sem a opção de mandar mensagem de texto" and "estamos
// contando que está em call em 3 pontos diferentes". The textarea stays in a
// call; the dictation slot becomes [mute][speaker]; End call is the only
// in-composer call indicator.
test('in a call the textarea stays and the dictation slot becomes mute + speaker', () => {
    const html = read('index.html');
    const at = (id) => html.indexOf(`id="${id}"`);
    assert.ok(at('attachmentButton') < at('userTextInput'), 'attach, then textarea');
    assert.ok(at('userTextInput') < at('callModePanel') && at('callModePanel') < at('dictationBtn'), 'call controls sit in the dictation slot');
    assert.ok(at('callMicMuteBtn') < at('callSpeakerBtn'), 'mute, then speaker');
    const css = read('styles.css');
    assert.doesNotMatch(css, /voice-mode-active\s+#userTextInput/, 'the textarea must not be hidden in a call');
    assert.match(css, /voice-mode-active\s+#dictationBtn\s*\{\s*display:\s*none/);
});

test('End call is the one in-composer call indicator', () => {
    for (const file of ['index.html', 'styles.css', 'uiLayout.js']) {
        assert.doesNotMatch(read(file), /call-status|>\s*In call\s*</, file);
    }
});
