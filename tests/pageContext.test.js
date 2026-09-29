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
    const live = app.slice(app.indexOf('    _liveFullInstructions() {'), app.indexOf('    _sendPendingTextMessage() {'));
    assert.match(realtime, /this\._buildComposedInstructions\(\)/);
    assert.match(live, /this\._buildComposedInstructions\(\)/);
    assert.match(live, /delegation:[\s\S]*instructions: fullInstructions/);
});

// #31: a mid-session reconfigure on GPT-Live never sends the Realtime-shaped
// session.update ("Unknown parameter: 'session.type'" ~92 s into every call).
function methodBody(name, params) {
    let start = app.indexOf(`    ${name}(${params}) {`);
    if (start < 0) start = app.indexOf(`    async ${name}(${params}) {`);
    assert.ok(start >= 0, 'missing ' + name);
    const open = app.indexOf(`(${params}) {`, start) + params.length + 3;
    let depth = 0; let i = open;
    for (; i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}') { depth--; if (depth === 0) break; } }
    return app.slice(open + 1, i);
}

test('#31: configureSession on GPT-Live refreshes the backend only; Realtime is unchanged', () => {
    const cfg = methodBody('configureSession', '');
    assert.match(cfg.slice(0, 700), /if \(this\.voiceApiMode === 'live'\) return this\._refreshSessionInstructions\('configureSession'\);/);
    // eslint-disable-next-line no-new-func
    const refresh = new Function('reason, { changed = true } = {}', methodBody('_refreshSessionInstructions', "reason, { changed = true } = {}"));
    const sent = []; const calls = [];
    const base = {
        isConnected: true, lastSessionConfig: {}, customInstructions: 'CI', dataChannel: { readyState: 'open' },
        sendMessage: (m) => { sent.push(m); return true; },
        _liveFullInstructions: () => 'FULL',
        _liveDelegationUpdate: (full) => ({ type: 'session.update', session: { delegation: { type: 'responses', responses: { instructions: full, tools: ['t'], reasoning: { summary: 'auto' } } } } }),
        configureSession: () => calls.push('configureSession'),
        _injectHistoryIntoSession: () => calls.push('history'),
        _flushHostEvents: () => calls.push('hostEvents'),
    };
    refresh.call({ ...base, voiceApiMode: 'realtime' }, 'page context');
    assert.deepEqual(calls, ['configureSession'], 'Realtime: the full configure, as before');
    calls.length = 0;
    assert.equal(refresh.call({ ...base, voiceApiMode: 'live' }, 'page context', { changed: false }), false);
    assert.equal(sent.length, 0, 'Live: nothing sent when the page did not change');
    assert.equal(refresh.call({ ...base, voiceApiMode: 'live' }, 'page context', { changed: true }), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].session.type, undefined, 'no Realtime session.type on Live');
    assert.equal(sent[0].session.delegation.responses.instructions, 'FULL');
    assert.deepEqual(calls, [], 'no history replay, no clipboard/host-event re-injection');
    assert.equal(refresh.call({ ...base, voiceApiMode: 'live', isConnected: false }, 'x'), false);
    assert.equal(refresh.call({ ...base, voiceApiMode: 'live', dataChannel: { readyState: 'connecting' } }, 'x'), false, 'before the channel opens, configureLiveSession sends it');
    assert.equal(sent.length, 1);
});

test('#31: page and activity refreshes go through the mode-aware helper, only on a real change; the first configure and every refresh share one delegation builder', () => {
    const page = methodBody('_syncPageContextIntoPrompt', '');
    const activity = methodBody('_syncUserActivityIntoPrompt', '');
    for (const [name, body, reason] of [['page', page, 'page context'], ['activity', activity, 'activity timeline']]) {
        assert.doesNotMatch(body, /this\.configureSession\(\)/, name + ': no direct Realtime configure');
        assert.match(body, new RegExp(String.raw`this\._refreshSessionInstructions\('${reason}', \{ changed: \w+Changed \}\)`), name);
    }
    assert.match(page, /const pageChanged = pageBlock !== this\._lastPageBlock;/);
    const live = methodBody('configureLiveSession', '');
    assert.match(live, /const config = this\._liveDelegationUpdate\(fullInstructions\);/);
    assert.doesNotMatch(app, /this\.configureSession\(\)\.catch\(/, 'configureSession returns no promise');
});
