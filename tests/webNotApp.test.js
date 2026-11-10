// The Wix preparation is written for the My Talents app: "You are on the My
// Talents app. Do not provide URLs to resources." and the app's menus. On the
// website Erica sent people to a "Quizzes menu" that does not exist there and
// held back working quiz links (production QA, 10 Nov 2026: Q1, Q2, PLAT-05,
// SEC-12). The same text says "If crisis signals continue, gently end the
// session" (SAF-06). The composer now adapts the preparation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { adaptPreparation, WEB_PARAGRAPH, STAY_LINE } = require('../lib/coachUiRules');
const { createHarness } = require('./helpers/appHarness');

// The live guest preparation, the parts that matter, with Wix's own spacing.
const WIX = [
    'Some opening rules.',
    'You are on the My Talents app. Do not provide URLs to resources. ',
    'Keep conversations active to help users navigate within the app. ',
    'The My Talents App has menus for Quizzes, Well-being, Coaches and My Profile. ',
    ' Mode of Operation: Text Chat',
    '- You are operating in text mode.',
    '"I’m really sorry you’re feeling this way. You’re not alone — please talk to a mental health professional or emergency services. Here’s a resource that might help: https://www.talenttransformation.com/post/finding-mental-health-support"',
    '',
    'If crisis signals continue, gently end the session and encourage seeking help.',
    'This is a list of quizzes this user has not taken yet; when appropriate, recommend the user to take them:',
    '- This user has not taken the Identity Quiz. The link is: https://www.pages.talenttransformation.com/identity/1?type=standard',
].join('\n');

test('on the website: the app paragraph becomes web guidance; everything else stays', () => {
    const out = adaptPreparation(WIX, { inApp: false });
    assert.doesNotMatch(out, /You are on the My Talents app/);
    assert.doesNotMatch(out, /Do not provide URLs/);
    assert.doesNotMatch(out, /has menus for/);
    assert.doesNotMatch(out, /navigate within the app/);
    assert.ok(out.includes(WEB_PARAGRAPH));
    assert.match(out, /Mode of Operation: Text Chat/, 'the next section is untouched');
    assert.match(out, /identity\/1\?type=standard/, 'the quiz links stay');
    assert.match(WEB_PARAGRAPH, /give the exact URL from your lists/);
    assert.match(WEB_PARAGRAPH, /never send the person to an app menu/);
    assert.match(WEB_PARAGRAPH, /Sign Up or Log In/);
    assert.match(WEB_PARAGRAPH, /https:\/\/www\.talenttransformation\.com\/plans-pricing/);
    assert.match(WEB_PARAGRAPH, /never invent a place to find it/, 'courses without a URL');
});

test('in the native app the app paragraph stays', () => {
    const out = adaptPreparation(WIX, { inApp: true });
    assert.match(out, /You are on the My Talents app\. Do not provide URLs to resources\./);
    assert.match(out, /has menus for Quizzes/);
    assert.ok(!out.includes(WEB_PARAGRAPH));
});

test('everywhere: never "gently end the session" — stay, and keep the help in every reply', () => {
    for (const inApp of [true, false]) {
        const out = adaptPreparation(WIX, { inApp });
        assert.doesNotMatch(out, /gently end the session/i, String(inApp));
        assert.ok(out.includes(STAY_LINE));
    }
    assert.match(STAY_LINE, /never end the conversation/);
    assert.match(STAY_LINE, /in every reply/);
});

test('our own fallback preparation (Wix down) is adapted the same way', () => {
    const fallback = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ericaPreparationFallBack.txt'), 'utf8')).message;
    assert.match(fallback, /You are on the My Talents app/, 'the fallback carries the app paragraph');
    const web = adaptPreparation(fallback, { inApp: false });
    assert.doesNotMatch(web, /You are on the My Talents app/);
    assert.ok(web.includes(WEB_PARAGRAPH));
    if (/gently end the session/i.test(fallback)) assert.doesNotMatch(web, /gently end the session/i);
});

test('the composer applies it: the website prompt has web guidance, the app prompt keeps the app paragraph', () => {
    const composed = (search) => {
        const h = createHarness({ search });
        h.app.customInstructions = WIX;
        return h.app._buildComposedInstructions();
    };
    const web = composed('?caller=web');
    assert.ok(web.includes(WEB_PARAGRAPH), 'website');
    assert.doesNotMatch(web, /You are on the My Talents app/);
    assert.doesNotMatch(web, /gently end the session/i);
    const app = composed('?caller=app');
    assert.match(app, /You are on the My Talents app/, 'native app');
    assert.doesNotMatch(app, /gently end the session/i);
});
