const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { personaAssetKey } = require('../lib/coachUiRules');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

// Regression: switching to Steve left Erica on the host-page corner icon —
// bridge.js hardcoded Erica's still and clips.
test('the host corner icon follows the persona the iframe announces', () => {
    const bridge = read('bridge.js');
    assert.match(bridge, /event\.data\.type === 'CT_ICON_PERSONA'/);
    assert.doesNotMatch(bridge, /companions\/(?:idle|speaking|waving)\/(?:84p\/)?Erica\./, 'no hardcoded Erica clip');
    assert.doesNotMatch(bridge, /Erica-thumb\.png/, 'no hardcoded Erica still');
    const app = read('app.js');
    assert.match(app, /postMessage\(\{ type: 'CT_ICON_PERSONA', key, thumb/);
    // Announced on both paths a persona becomes active.
    const announces = app.match(/this\._announcePersonaToHost\(\);/g) || [];
    assert.ok(announces.length >= 2, `announced from ${announces.length} place(s)`);
});

test('every persona has the still and the three clips the icon asks for', () => {
    const profiles = JSON.parse(read('voiceProfiles.json'));
    assert.ok(profiles.length >= 8);
    for (const profile of profiles) {
        const key = personaAssetKey(profile);
        assert.ok(key, `${profile.companionId}: no asset key`);
        const thumb = path.basename(profile.configuration.thumb);
        for (const rel of [thumb, `idle/84p/${key}.webm`, `speaking/84p/${key}.webm`, `waving/${key}.mp4`]) {
            // Exact case: Railway serves from a case-sensitive filesystem.
            const dir = path.join(root, 'companions', path.dirname(rel));
            assert.ok(fs.readdirSync(dir).includes(path.basename(rel)), `${profile.companionId}: companions/${rel}`);
        }
    }
});

test('call-mode clips are keyed off the persona, never the OpenAI voice', () => {
    const ui = read('uiLayout.js');
    const build = ui.slice(ui.indexOf('const buildCandidates = (type) =>'), ui.indexOf('const idleCandidates = buildCandidates('));
    assert.match(build, /personaAssetKey/);
    assert.doesNotMatch(build, /app\.selectedVoice/, 'Marin.webm / marin.webm were 404s');
});
