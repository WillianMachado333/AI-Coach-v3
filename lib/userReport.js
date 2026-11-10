/**
 * lib/userReport.js — the person-specific part of a Wix ericaPreparation
 * `message`, the text server.js syncs into that person's vector store.
 *
 * The message is mostly generic prompt (persona, rules, resources) with the
 * person's quiz reports, name and goals in it. Only that part is uploaded:
 * the boilerplate would crowd out real user data in retrieval.
 *
 * Wix answers an unknown or random id with its GENERIC guest preparation
 * ("This user has not taken…", "You dont know the user Name yet"). That text
 * must yield nothing (SEC-03, production QA 10 Nov 2026): a body found there
 * was uploaded as a "report" and created a vector store for any id. So:
 *   - a body needs evidence that the text is about one person (a report URL,
 *     a quiz taken, a name, goals). The list of quizzes "this user has not
 *     taken" is in the guest text too, so on its own it proves nothing;
 *   - no evidence, no body. The old positional fallback (skip the first
 *     2500 chars) is gone: on the guest text it returned boilerplate.
 */

// Where the person-specific part starts (the earliest match wins).
const START_MARKERS = [
    /Report:\s*https?:\/\//i,                             // "Quiz X Report: https://..."
    /This user has taken/i,                               // Positive assessment marker
    /This is a list of quizzes this user has not taken/i, // Metadata footer (also in the guest text)
    /\n[A-Z][^\n]*Quiz\s*\n/,                             // "Something Quiz" section header
    /^Thge user Name is|^The user Name is/im,             // Name marker (typos in source preserved)
    /The user selected the following goals/i,             // Goals marker
];

// Evidence that the text is about one person. Never in the generic guest text.
const PERSON_MARKERS = [
    /Report:\s*https?:\/\//i,
    /This user has taken/i,
    /^Thge user Name is|^The user Name is/im,
    /The user selected the following goals/i,
];

const HEADER = '# User-Specific Report\n\nThe following content is drawn from this user\'s assessment reports and profile metadata. Use it to inform coaching responses.\n\n---\n\n';

/** The person-specific report in `message`, or '' when there is none. */
function extractUserSpecificReport(message) {
    if (!message || typeof message !== 'string') return '';
    if (!PERSON_MARKERS.some((re) => re.test(message))) return '';

    let earliestIndex = -1;
    for (const re of START_MARKERS) {
        const m = message.match(re);
        if (m && (earliestIndex === -1 || m.index < earliestIndex)) earliestIndex = m.index;
    }
    if (earliestIndex < 0) return '';
    // A small header so retrieval snippets have anchoring context.
    return HEADER + message.slice(earliestIndex).trim();
}

module.exports = { extractUserSpecificReport, START_MARKERS, PERSON_MARKERS };
