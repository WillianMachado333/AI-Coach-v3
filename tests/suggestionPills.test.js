// Suggestion pills are off (Varsha's review of 14 Oct 2026: "a distraction
// and a visual hurdle"). Off means no bar above the composer, no
// /api/suggest-followups call and no labels for the icon's hover hints.
// ?pills=1 on the coach page brings them back for staff testing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers/appHarness');

function withPillBar(h) {
    // The harness stubs both methods; the real ones are on the prototype.
    delete h.app.renderQuickActions;
    delete h.app.hideQuickActions;
    const bar = h.doc.createElement('div');
    bar.id = 'quickActions';
    for (let i = 0; i < 2; i++) {
        const btn = h.doc.createElement('button');
        btn.classList.add('quickActionBtn');
        bar.appendChild(btn);
    }
    h.doc.body.appendChild(bar);
    return bar;
}

// renderQuickActions paints on the next frame.
const raf = (app, ctx) => { ctx.requestAnimationFrame = (fn) => ctx.setTimeout(fn, 16); };

const suggestCalls = (h) => h.fetches.filter((f) => /suggest-followups/.test(f.url)).length;

test('pills are off by default: the bar stays hidden in an empty chat and after replies, nothing is fetched, the icon hover gets no labels', async () => {
    const h = createHarness({ setup: raf });
    const bar = withPillBar(h);
    h.app.renderQuickActions('starter');
    await h.advance(5000);
    assert.equal(bar.classList.contains('hidden'), true, 'no starter pills');
    h.app.sendTextMessage('hello');
    await h.advance(3000);
    h.live.reply('Hi there');
    await h.advance(500);
    h.app.renderQuickActions('continuation');
    await h.advance(5000);
    assert.equal(bar.classList.contains('hidden'), true, 'no follow-up pills');
    assert.equal(suggestCalls(h), 0, 'no suggestion request');
    assert.equal(h.app._pillLabels().length, 0, 'the hover hints have nothing to show');
});

test('?pills=1 turns them back on for staff testing', async () => {
    const h = createHarness({ search: '?pills=1', setup: raf });
    const bar = withPillBar(h);
    assert.equal(h.app._suggestionPillsEnabled(), true);
    h.app.renderQuickActions('starter');
    await h.advance(5000);
    assert.equal(bar.classList.contains('hidden'), false, 'the starter pills show');
    assert.ok(h.app._pillLabels().length > 0, 'the hover hints get the labels');
});
