// A link at the end of a sentence must not carry the sentence's punctuation
// into its href. Willian, 3 Nov 2026: the privacy answer ended with
// "…Privacy Policy: https://talenttransformation.com/privacy-policy." and the
// full stop became part of the link, a 404 a person would not know to fix.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/appHarness');

const formatText = () => createHarness().ctx.uiLayout.formatText;
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

test('trailing sentence punctuation stays outside the link', () => {
    const fmt = formatText();
    for (const tail of ['.', ',', '!', '?', ':', '...', '."', "'.", '…']) {
        const html = fmt(`See the Privacy Policy: https://www.talenttransformation.com/privacy-policy${tail}`);
        assert.deepEqual(hrefs(html), ['https://www.talenttransformation.com/privacy-policy'], JSON.stringify(tail));
        assert.ok(html.includes(`</a>${tail}`), `the punctuation is still shown, right after the link: ${html}`);
    }
});

test('punctuation inside a URL is kept; query strings and fragments survive', () => {
    const fmt = formatText();
    assert.deepEqual(hrefs(fmt('Read https://example.com/a.b/c.html?x=1&y=2#top now')), ['https://example.com/a.b/c.html?x=1&y=2#top']);
    assert.deepEqual(hrefs(fmt('Two: https://a.example/x, and https://b.example/y.')), ['https://a.example/x', 'https://b.example/y']);
});
