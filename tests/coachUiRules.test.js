const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../lib/coachUiRules');

test('send action is available only for non-empty text', () => {
    assert.equal(rules.hasSendableText(''), false);
    assert.equal(rules.hasSendableText('   '), false);
    assert.equal(rules.hasSendableText('  hello  '), true);
});

test('message alignment follows author role', () => {
    assert.equal(rules.messageAlignment('user'), 'justify-end');
    assert.equal(rules.messageAlignment('bot'), 'justify-start');
    assert.equal(rules.messageAlignment('assistant'), 'justify-start');
});

test('scroll follow respects the user-controlled reading position', () => {
    assert.equal(rules.isNearBottom(1000, 900, 100), true);
    assert.equal(rules.isNearBottom(1000, 600, 100), false);
});

test('coach animation requires sound, an open output gate, and real level', () => {
    assert.equal(rules.shouldAnimateCoach(0.2, true, false), true);
    assert.equal(rules.shouldAnimateCoach(0.01, true, false), false);
    assert.equal(rules.shouldAnimateCoach(0.2, false, false), false);
    assert.equal(rules.shouldAnimateCoach(0.2, true, true), false);
});

test('streaming highlight follows the newest phrase and preserves the preceding text', () => {
    assert.deepEqual(
        rules.streamingHighlightParts('One two three four five six', 3),
        { before: 'One two three ', highlight: 'four five six' }
    );
    assert.deepEqual(
        rules.streamingHighlightParts('A short reply'),
        { before: '', highlight: 'A short reply' }
    );
});

test('streaming highlight handles empty and whitespace-only text safely', () => {
    assert.deepEqual(rules.streamingHighlightParts(''), { before: '', highlight: '' });
    assert.deepEqual(rules.streamingHighlightParts('   '), { before: '', highlight: '   ' });
});

test('starter suggestions use a safe context signal and preserve fallback', () => {
    const fallback = ['one', 'two', 'three'];
    assert.deepEqual(
        rules.contextualStarterSuggestions('User completed a lesson about decision making', fallback),
        ['Help me compare my options', 'What matters most in this decision?', 'What am I not considering yet?']
    );
    assert.deepEqual(rules.contextualStarterSuggestions('', fallback), fallback);
});

test('suggestion filtering rejects URLs, emails, and identifiers', () => {
    assert.equal(rules.isSafeSuggestion('Help me decide?'), true);
    assert.equal(rules.isSafeSuggestion('Contact me@example.com'), false);
    assert.equal(rules.isSafeSuggestion('Open https://example.com'), false);
    assert.deepEqual(
        rules.filterSuggestions(['safe one', 'safe two', 'user 123456789'], ['a', 'b', 'c']),
        ['a', 'b', 'c']
    );
});
