#!/usr/bin/env node
/*
 * Scrape the marketing content of each TT quiz landing page and write it
 * into knowledge-base/quizzes/{quiz_id}/content.md as a starting semantic
 * body Eric can then polish.
 *
 * Rationale (see MEMORY note ai-coach-hard-vs-soft-data): the landing pages
 * are already the "focused on the user" semantic view of each quiz. Erica
 * echoing that content when asked about a quiz is not just fine — it is
 * the right voice. We are NOT scraping question wording, scoring, or URLs
 * (those are hard data and stay on the Wix side, injected via preparation).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..', 'knowledge-base', 'quizzes');

// quiz_id → real Wix URL slug on /post/*
const QUIZ_URL = {
    'life-satisfaction': 'life-satisfaction-quiz',
    'personality': 'personality-quiz',
    'personal-values': 'personal-values-quiz',
    'emotional-intelligence': 'emotional-intelligence-quiz',
    'entrepreneurial-competencies': 'entrepreneurial-competencies-quiz',
    'career-interests': 'career-quiz',
    'communication-styles': 'communication-styles-quiz',
    'learning-mindset': 'learning-mindset-quiz',
    'digital-literacy': 'digital-literacy-quiz',
    'action-oriented-biases': 'action-oriented-biases-quiz-cognitive-bias',
    'interest-biases': 'interest-biases-quiz-cognitive-bias',
    'pattern-recognition-biases': 'pattern-recognition-biases-quiz-cognitive-bias',
    'stability-biases': 'stability-biases-quiz-cognitive-bias',
    'social-biases': 'social-biases-quiz-cognitive-bias',
    'self-related-biases': 'self-related-biases-quiz',
    'talents-identifier': 'talents-identifier-quiz',
    'interactive-styles': 'interactive-styles-quiz',
    'conflict-handling-styles': 'conflict-handling-styles-quiz',
    'identity': 'identity-quiz',
    'career-readiness': 'career-readiness-quiz'
};

function fetch(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        function go(u) {
            https.get(u, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
                }
            }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    if (redirects <= 0) return reject(new Error('too many redirects'));
                    redirects--;
                    return go(new URL(res.headers.location, u).toString());
                }
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + u));
                let buf = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { buf += c; });
                res.on('end', () => resolve({ url: u, body: buf }));
            }).on('error', reject);
        }
        go(url);
    });
}

// Extract the visible post description text, preserving paragraph breaks.
function extractPostDescription(html) {
    // Wix blog: content lives after data-hook="post-description" and ends at
    // the next hook boundary (actions/footer/etc).
    const m = html.match(/data-hook="post-description"[^>]*>([\s\S]*?)data-hook="(post-actions|post-footer|post-main-actions|comments|post-stats|post-metadata|post-tags)/);
    if (!m) return null;
    let raw = m[1];
    // Strip scripts / styles fully.
    raw = raw.replace(/<script[\s\S]*?<\/script>/g, '');
    raw = raw.replace(/<style[\s\S]*?<\/style>/g, '');
    // Preserve breaks on paragraph-like end tags and <br>.
    raw = raw.replace(/<\/(p|div|h[1-6]|li)>/gi, '\n');
    raw = raw.replace(/<(br|hr)\s*\/?>/gi, '\n');
    // Drop remaining tags.
    raw = raw.replace(/<[^>]+>/g, ' ');
    // Decode common HTML entities.
    raw = raw
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&hellip;/g, '…')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&[a-z]+;/gi, ' ');
    // Normalise whitespace, preserve paragraphs.
    raw = raw.split('\n').map((l) => l.replace(/[\t ]+/g, ' ').trim()).filter(Boolean).join('\n');
    // Collapse runs of blank lines to a single blank line.
    raw = raw.replace(/\n{3,}/g, '\n\n');
    return raw.trim();
}

// Cut boilerplate — testimonials, star ratings, CTA button labels, review
// author names. These are marketing padding and just noise for the coach.
function trimBoilerplate(text) {
    if (!text) return text;
    let t = text;
    // Filter paragraph by paragraph so we can drop testimonial-block chunks
    // that appear in the MIDDLE of real content (some pages interleave them).
    const lines = t.split(/\n+/);
    const kept = [];
    let inTestimonial = false;
    for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        // Testimonial section start — kill this line and everything until we
        // see a non-star, non-name, sentence-shaped paragraph again.
        if (/^(What People Are Saying|Reviews|Testimonials)\b/i.test(l)) {
            inTestimonial = true;
            continue;
        }
        // Lines that are just a star run.
        if (/^[⭐★☆]+$/.test(l) || /^[⭐★].{0,3}$/.test(l)) continue;
        // Standalone CTA button labels.
        if (/^(TAKE (THE )?QUIZ|START QUIZ|BUY NOW|LEARN MORE|GET STARTED)$/i.test(l)) continue;
        // Lines that look like a review author name — a short line with just
        // a capitalised name/first-name, no ending punctuation, no verb.
        if (l.length <= 24 && /^[A-Z][a-zA-Z .'-]{1,22}$/.test(l) && !/\b(is|are|was|were|has|have|the|a|an|for|to|with|and|or|by|from|of|in|at)\b/i.test(l)) continue;
        // Testimonial body paragraphs usually contain "I recently", "I highly", "I was", first-person quotes,
        // or a star rating in-line — skip while we're inside a testimonial block.
        if (inTestimonial) {
            const looksLikeReviewBody = /^\s*(I |My |This )/i.test(l) || /\b(recommend|amazing|eye-opener|worth it|thank you)\b/i.test(l);
            const isRealSentence = l.length > 80 && /[.!?]$/.test(l) && !looksLikeReviewBody;
            if (isRealSentence) { inTestimonial = false; kept.push(l); }
            // else: drop this line as testimonial
            continue;
        }
        kept.push(l);
    }
    t = kept.join('\n\n');
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    return t;
}

function buildContent(title, description, scraped) {
    const parts = [];
    parts.push('# ' + title + ' — semantic guide');
    parts.push('');
    parts.push('> ' + description);
    parts.push('');
    parts.push('_Below is the marketing/landing content of this quiz on the Talent Transformation site — the same semantic framing users see. Coach may echo it when explaining or introducing the quiz. Edit / polish as needed. Never add URLs, exact question wording, or scoring here — those are hard data and reach Erica via preparation._');
    parts.push('');
    parts.push('## What the site says about this quiz');
    parts.push('');
    parts.push(scraped);
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('## What this quiz measures');
    parts.push('');
    parts.push('_Optional refinement: distill the above into a one-sentence competency the quiz surfaces._');
    parts.push('');
    parts.push('## What it does NOT try to do');
    parts.push('');
    parts.push('- _Fill in common misreadings — e.g. "this is not a diagnostic tool", "this does not measure X"._');
    parts.push('');
    parts.push('## When Erica should reference this quiz');
    parts.push('');
    parts.push('- _Fill in: what the learner might be asking or feeling when this quiz is the right suggestion._');
    parts.push('');
    return parts.join('\n');
}

async function main() {
    let ok = 0, fail = 0;
    for (const [id, slug] of Object.entries(QUIZ_URL)) {
        const dir = path.join(ROOT, id);
        const metaPath = path.join(dir, '_meta.json');
        if (!fs.existsSync(metaPath)) { console.log('SKIP ' + id + ' (no meta)'); fail++; continue; }
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const url = 'https://www.talenttransformation.com/post/' + slug;
        try {
            const { body } = await fetch(url);
            const raw = extractPostDescription(body);
            if (!raw || raw.length < 60) throw new Error('post-description too short (' + (raw ? raw.length : 0) + ')');
            const clean = trimBoilerplate(raw);
            fs.writeFileSync(path.join(dir, 'content.md'), buildContent(meta.title, meta.description, clean), 'utf8');
            console.log('OK   ' + id + '  (' + clean.length + ' chars from ' + slug + ')');
            ok++;
        } catch (e) {
            console.warn('FAIL ' + id + '  ' + (e && e.message || e));
            fail++;
        }
    }
    console.log('---');
    console.log(ok + ' ok, ' + fail + ' failed.');
}

main();
