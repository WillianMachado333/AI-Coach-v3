// The person-specific part of a Wix preparation (lib/userReport.js). Wix
// answers an unknown or random id with its generic guest text ("This user has
// not taken…", "You dont know the user Name yet"); a "report" found there was
// synced into a new vector store for any id (SEC-03, production QA 10 Nov 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractUserSpecificReport } = require('../lib/userReport');

const BOILERPLATE = 'You are a supportive career and life coach for Talent Transformation. Keep answers short and warm. '.repeat(40);

// The shape of the generic guest preparation, long enough that the old
// positional fallback (skip the first 2500 chars) would have kicked in.
const GUEST_TEXT = [
    BOILERPLATE,
    'This is a list of quizzes this user has not taken yet; when appropriate, recommend the user to take them:',
    '- This user has not taken the Career Readiness Quiz',
    '- This user has not taken the Emotional Intelligence Quiz',
    '- This user has not taken the Leadership Styles Quiz',
    BOILERPLATE,
    'You dont know the user Name yet ',
    '',
].join('\n');

test('the generic guest text an unknown id gets has no user-specific body', () => {
    assert.ok(GUEST_TEXT.length > 3000, 'long enough for the old positional fallback');
    assert.equal(extractUserSpecificReport(GUEST_TEXT), '');
});

test('the shipped fallback preparation (the live guest prompt) has no user-specific body either', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'ericaPreparationFallBack.txt'), 'utf8');
    const message = JSON.parse(raw).message;
    assert.match(message, /This user has not taken/);
    assert.match(message, /You dont know the user Name yet/);
    assert.equal(extractUserSpecificReport(message), '');
});

test('a member preparation still yields its report, from the first marker on', () => {
    const member = [
        BOILERPLATE,
        'This user has taken the following quizzes:',
        'Emotional Intelligence Quiz Report: https://example.org/report/abc',
        'This is a list of quizzes this user has not taken yet; when appropriate, recommend the user to take them:',
        '- This user has not taken the Career Readiness Quiz',
        'The user Name is Sam',
        'The user selected the following goals: grow as a leader',
    ].join('\n');
    const body = extractUserSpecificReport(member);
    assert.match(body, /^# User-Specific Report/);
    assert.ok(body.includes('This user has taken the following quizzes:'));
    assert.ok(body.includes('The user Name is Sam'));
    assert.ok(!body.includes('supportive career and life coach'), 'boilerplate before the first marker is cut');
    // One sign of a person is enough: a name alone, or goals alone.
    assert.notEqual(extractUserSpecificReport(GUEST_TEXT + '\nThe user Name is Ana\n'), '');
    assert.notEqual(extractUserSpecificReport(BOILERPLATE + '\nThe user selected the following goals: rest\n'), '');
});

test('no markers at all, or no text: nothing', () => {
    assert.equal(extractUserSpecificReport(BOILERPLATE), '', 'no positional fallback');
    for (const v of ['', null, undefined, 42, {}]) assert.equal(extractUserSpecificReport(v), '');
});
