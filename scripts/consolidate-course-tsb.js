#!/usr/bin/env node
/*
 * One-shot: consolidate the 24 per-unit markdown files under
 * knowledge-base/courses/tsb/section-N/ into THREE consolidated files:
 *
 *   knowledge-base/courses/tsb/course-content.md      (lessons + section quizzes)
 *   knowledge-base/courses/tsb/competency-framework.md (framework + skills + performance indicators)
 *   knowledge-base/courses/tsb/quizzes-list.md        (list of quizzes with a short description)
 *   knowledge-base/courses/tsb/_meta.json             (title, description, structure)
 *
 * Rationale: 24 fragmented files are hard for Eric to maintain from the
 * admin UI. Two logical documents + a quiz index give him something
 * presentable, while the vector store still gets the same underlying text
 * (just as bigger chunks).
 *
 * Idempotent: rerun without side effects if the sources still exist.
 * After running, the section-N/*.md files can be deleted (git will keep
 * their history).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'knowledge-base', 'courses', 'tsb');
const SECTION_TITLES = {
    1: 'Understanding Traits, Skills, and Behaviors',
    2: 'Recognizing Personal Tendencies',
    3: 'Developing Skills for Behavioral Change',
    4: 'Understanding Behavior in Context',
    5: 'Managing Traits Through Professional Behavior',
    6: 'Communicating About Traits, Skills, and Behaviors',
    7: 'Applying Trait, Skill, and Behavior Awareness in Workplace Relationships',
    8: 'Using Trait, Skill, and Behavior Awareness for Growth'
};

function readUnit(unit) {
    const [s] = unit.split('.');
    const sectionDir = path.join(ROOT, 'section-' + s);
    if (!fs.existsSync(sectionDir)) return null;
    for (const f of fs.readdirSync(sectionDir)) {
        if (f.startsWith(unit + '-') && f.endsWith('.md')) {
            return fs.readFileSync(path.join(sectionDir, f), 'utf8');
        }
    }
    return null;
}

// Given the full merged markdown of one unit, extract the sections we care about.
function parseUnit(raw) {
    const out = { lesson: '', overview: '', frameworkBody: '', quiz: '' };
    if (!raw) return out;
    // Strip YAML frontmatter for parsing but remember the metadata.
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    let body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    // Split on markdown H2s to get labelled sections.
    // Preserve the header lines by keeping them in the returned chunks.
    const sectionMap = {};
    const parts = body.split(/^## /m);
    // parts[0] is anything before the first ##, ignore it
    for (let i = 1; i < parts.length; i++) {
        const chunk = parts[i];
        const nl = chunk.indexOf('\n');
        const heading = chunk.slice(0, nl).trim();
        const content = chunk.slice(nl + 1).trim();
        sectionMap[heading] = content;
    }
    out.lesson = sectionMap['Lesson (course text)'] || '';
    out.overview = sectionMap['Framework overview'] || '';
    // Everything framework-y goes together in an ordered list.
    const FRAMEWORK_HEADS = [
        'Competency Definition',
        'Competency Statement',
        'Knowledge',
        'Skills',
        'Observable Behaviors',
        'I Demonstrate This When',
        'Performance Indicators',
        'Examples',
        'Non-Examples',
        'Common Misconceptions',
        'Conversation Starters'
    ];
    const fwParts = [];
    for (const h of FRAMEWORK_HEADS) {
        if (sectionMap[h]) fwParts.push('### ' + h + '\n\n' + sectionMap[h]);
    }
    out.frameworkBody = fwParts.join('\n\n');
    // The quiz block, if present, is under "Knowledge Check (Section X)".
    for (const [k, v] of Object.entries(sectionMap)) {
        if (k.startsWith('Knowledge Check')) { out.quiz = v; break; }
    }
    return out;
}

// Read a section's quiz block. Only the .1 unit of each section carries it.
function readQuizForSection(section) {
    const p = parseUnit(readUnit(section + '.1'));
    return p.quiz;
}

function unitTitleFromFilename(unit) {
    const [s] = unit.split('.');
    const sectionDir = path.join(ROOT, 'section-' + s);
    if (!fs.existsSync(sectionDir)) return unit;
    for (const f of fs.readdirSync(sectionDir)) {
        if (f.startsWith(unit + '-') && f.endsWith('.md')) {
            return f.replace(new RegExp('^' + unit + '-'), '').replace(/\.md$/, '').replace(/-/g, ' ');
        }
    }
    return unit;
}

function main() {
    const COURSE_TITLE = 'Understanding Traits, Skills, and Behaviors';
    const COURSE_DESCRIPTION =
        'A foundational course that teaches learners to distinguish personal ' +
        'traits (stable tendencies) from skills (learned capabilities) and behaviors ' +
        '(situational actions) — and to use that distinction to develop themselves ' +
        'and communicate effectively at work. 8 sections × 3 units, each with a ' +
        'section-level knowledge check.';

    // ---------- course-content.md ----------
    const contentParts = [];
    contentParts.push('---');
    contentParts.push('course_id: tsb');
    contentParts.push('title: "' + COURSE_TITLE + '"');
    contentParts.push('artifact: course-content');
    contentParts.push('---');
    contentParts.push('');
    contentParts.push('# ' + COURSE_TITLE + ' — Course content');
    contentParts.push('');
    contentParts.push('> ' + COURSE_DESCRIPTION);
    contentParts.push('');

    for (let s = 1; s <= 8; s++) {
        contentParts.push('## Section ' + s + ' · ' + SECTION_TITLES[s]);
        contentParts.push('');
        for (let u = 1; u <= 3; u++) {
            const unit = s + '.' + u;
            const p = parseUnit(readUnit(unit));
            if (!p.lesson) continue;
            const title = unitTitleFromFilename(unit);
            contentParts.push('### ' + unit + ' · ' + title);
            contentParts.push('');
            contentParts.push(p.lesson);
            contentParts.push('');
        }
        const quiz = readQuizForSection(s);
        if (quiz) {
            contentParts.push('#### Section ' + s + ' — Knowledge check');
            contentParts.push('');
            contentParts.push(quiz);
            contentParts.push('');
        }
    }
    fs.writeFileSync(path.join(ROOT, 'course-content.md'), contentParts.join('\n'), 'utf8');

    // ---------- competency-framework.md ----------
    const fwParts = [];
    fwParts.push('---');
    fwParts.push('course_id: tsb');
    fwParts.push('title: "' + COURSE_TITLE + ' — Competency framework"');
    fwParts.push('artifact: competency-framework');
    fwParts.push('---');
    fwParts.push('');
    fwParts.push('# ' + COURSE_TITLE + ' — Competency framework');
    fwParts.push('');
    fwParts.push('> Administrative view: what the course actually teaches, mapped as competencies. Used by coaches and by Erica to ground reflections. Each unit corresponds one-to-one to a lesson in course-content.md.');
    fwParts.push('');

    for (let s = 1; s <= 8; s++) {
        fwParts.push('## Competency ' + s + ' · ' + SECTION_TITLES[s]);
        fwParts.push('');
        for (let u = 1; u <= 3; u++) {
            const unit = s + '.' + u;
            const p = parseUnit(readUnit(unit));
            if (!p.frameworkBody) continue;
            const title = unitTitleFromFilename(unit);
            fwParts.push('### FfTT-TSB ' + unit + ' · ' + title);
            fwParts.push('');
            if (p.overview) { fwParts.push(p.overview); fwParts.push(''); }
            fwParts.push(p.frameworkBody);
            fwParts.push('');
        }
    }
    fs.writeFileSync(path.join(ROOT, 'competency-framework.md'), fwParts.join('\n'), 'utf8');

    // ---------- quizzes-list.md ----------
    const quizParts = [];
    quizParts.push('---');
    quizParts.push('course_id: tsb');
    quizParts.push('title: "' + COURSE_TITLE + ' — Quizzes"');
    quizParts.push('artifact: quizzes-list');
    quizParts.push('---');
    quizParts.push('');
    quizParts.push('# ' + COURSE_TITLE + ' — Quiz index');
    quizParts.push('');
    quizParts.push('> Each section has one knowledge-check quiz covering all three of its units. Full questions live in course-content.md — this file is a fast index for admins and for Erica to remind learners what each quiz measures.');
    quizParts.push('');
    for (let s = 1; s <= 8; s++) {
        const quiz = readQuizForSection(s);
        if (!quiz) continue;
        // Count questions by looking for numbered lines starting with "**Q"
        const qCount = (quiz.match(/\*\*Q\d+\./g) || []).length;
        quizParts.push('## Section ' + s + ' quiz · ' + SECTION_TITLES[s]);
        quizParts.push('');
        quizParts.push('- **Covers:** units ' + s + '.1, ' + s + '.2, ' + s + '.3');
        quizParts.push('- **Questions:** ' + qCount);
        quizParts.push('- **Purpose:** verify the learner can distinguish concepts and apply them; feedback for each option reinforces the intended framing.');
        quizParts.push('');
    }
    fs.writeFileSync(path.join(ROOT, 'quizzes-list.md'), quizParts.join('\n'), 'utf8');

    // ---------- _meta.json ----------
    const meta = {
        course_id: 'tsb',
        title: COURSE_TITLE,
        description: COURSE_DESCRIPTION,
        artifacts: [
            { key: 'course-content', label: 'Course content', path: 'course-content.md', chars: fs.statSync(path.join(ROOT, 'course-content.md')).size },
            { key: 'competency-framework', label: 'Competency framework', path: 'competency-framework.md', chars: fs.statSync(path.join(ROOT, 'competency-framework.md')).size },
            { key: 'quizzes-list', label: 'Quizzes', path: 'quizzes-list.md', chars: fs.statSync(path.join(ROOT, 'quizzes-list.md')).size }
        ],
        section_count: 8,
        unit_count: 24,
        quiz_count: 8
    };
    fs.writeFileSync(path.join(ROOT, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    console.log('Wrote:');
    console.log('  ' + path.relative(process.cwd(), path.join(ROOT, 'course-content.md')));
    console.log('  ' + path.relative(process.cwd(), path.join(ROOT, 'competency-framework.md')));
    console.log('  ' + path.relative(process.cwd(), path.join(ROOT, 'quizzes-list.md')));
    console.log('  ' + path.relative(process.cwd(), path.join(ROOT, '_meta.json')));
    console.log('');
    console.log('Next: delete the section-* subdirectories once you verify the consolidated files look right.');
}

main();
