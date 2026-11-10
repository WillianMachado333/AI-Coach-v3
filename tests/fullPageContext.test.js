// GUEST-01 (production QA, 10 Nov 2026): on a report page Erica saw only the
// first 8,000 characters (bridge.js capturePageContext). A Life Satisfaction
// report runs to ~20,600 characters and its Community section starts at
// character 9,855, so asked for the weakest area she named the wrong one and
// said Community and Career were "not in the part I can access". The bridge
// now sends the whole page (up to 40,000 characters) and says when it is cut;
// the coach says so too instead of guessing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runBridge } = require('./helpers/bridgeHarness');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// A report shaped like the QA's: four areas, Community well past 8,000 chars.
function report() {
    const filler = (n) => ' Lorem ipsum dolor sit amet, reflection and growth.'.repeat(n);
    return 'Life Satisfaction Report. Self: 27. Relationships: 24.' + filler(190)
        + ' Community: 17. Your results suggest substantial dissatisfaction with your community.' + filler(120)
        + ' Career: 33. You feel strongly satisfied with your career.' + filler(40);
}

function snapshot(text) {
    const b = runBridge();
    b.doc.body.innerText = text;
    b.advance(1000);
    const replies = [];
    b.postToBridge({ type: 'REQUEST_PAGE_CONTEXT' }, undefined, replies);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].type, 'PAGE_CONTEXT_RESPONSE');
    return replies[0].context;
}

test('a ~20,000-character report reaches the coach whole: Community and Career included, marked complete', () => {
    const text = report();
    assert.ok(text.length > 15000 && text.indexOf('Community: 17') > 9000, 'the shape of the QA report');
    const ctx = snapshot(text);
    assert.equal(ctx.text.length, text.length);
    assert.match(ctx.text, /Community: 17\. Your results suggest substantial dissatisfaction with your community\./);
    assert.match(ctx.text, /Career: 33/);
    assert.equal(ctx.truncated, false);
    assert.equal(ctx.totalChars, text.length);
});

test('a page longer than 40,000 characters is cut there and says so', () => {
    const text = 'x '.repeat(30000);
    const ctx = snapshot(text);
    assert.equal(ctx.text.length, 40000);
    assert.equal(ctx.truncated, true);
    assert.equal(ctx.totalChars, text.replace(/\s+/g, ' ').trim().length);
});

test('the coach: the tool result says whether the page is complete; when it is not, Erica must say so rather than guess or compare', () => {
    const tool = src.slice(src.indexOf("} else if (functionName === 'get_page_context') {"), src.indexOf("} else if (functionName === 'render_chart') {"));
    assert.match(tool, /const complete = !snapshot\.truncated && totalChars <= pageText\.length;/);
    assert.match(tool, /complete,\s*totalChars,\s*text: pageText/);
    assert.match(tool, /Read the whole text before comparing areas/);
    assert.match(tool, /say so plainly instead of guessing, and never compare areas you cannot see/);
});

test('the coach: the page block in the prompt says when it is only the start of the page and sends Erica to the whole page first', () => {
    const block = src.slice(src.indexOf('    async _syncPageContextIntoPrompt() {'), src.indexOf("'=== END CURRENT PAGE CONTEXT ==='"));
    assert.match(block, /const pageChars = Math\.max\(Number\(snap\.totalChars\) \|\| 0, \(snap\.text \|\| ''\)\.length\);/);
    assert.match(block, /only the first \$\{bodyText\.length\} of \$\{pageChars\} characters of this page: before comparing areas or answering about anything not shown here, call get_page_context for the whole page; never guess the rest/);
    assert.match(block, /visibleLabel,\s*bodyText,/);
});
