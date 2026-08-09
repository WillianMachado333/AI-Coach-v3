#!/usr/bin/env node
/*
 * Build knowledge-base/courses/tsb/*.md from the extracted
 * course.md + framework.md scratch files.
 *
 * Produces 24 unit files (8 sections x 3 units), one per lesson/framework
 * pair, with YAML frontmatter and merged sections in a fixed order so
 * vector-store retrieval always brings the whole unit context back at once.
 *
 * Usage:
 *   COURSE_MD=/path/to/course.md FRAMEWORK_MD=/path/to/framework.md \
 *   node scripts/build-course-tsb.js
 */

const fs = require('fs');
const path = require('path');

const COURSE_MD = process.env.COURSE_MD;
const FRAMEWORK_MD = process.env.FRAMEWORK_MD;
if (!COURSE_MD || !FRAMEWORK_MD) {
    console.error('Set COURSE_MD and FRAMEWORK_MD to the scratchpad paths first.');
    process.exit(1);
}

const OUT_ROOT = path.resolve(__dirname, '..', 'knowledge-base', 'courses', 'tsb');
const COURSE_ID = 'tsb';
const COURSE_TITLE = 'Understanding Traits, Skills, and Behaviors';

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

const courseSrc = fs.readFileSync(COURSE_MD, 'utf8');
const frameworkSrc = fs.readFileSync(FRAMEWORK_MD, 'utf8');

// --- Parse course.md ---
// Skip TOC (everything before the first real "Lesson X.Y Title" that is NOT
// followed by PAGEREF). Simplest: only accept "Lesson N.N Title" where the
// following line is content prose, not another Lesson line.
function parseCourse(md) {
    const lines = md.split('\n');
    const lessons = {}; // key '1.1' -> { title, paragraphs: [] }
    const quizzes = {}; // key '1' -> [ { question, options: [{text, correct}], correctFeedback, incorrectFeedback } ]

    let mode = 'toc'; // toc | lesson | quiz
    let currentLesson = null;
    let currentQuiz = null;
    let currentQuizSection = null;
    let currentQ = null;

    // Find the first real lesson header (no PAGEREF). Everything before is TOC.
    let realStart = -1;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^Lesson (\d)\.(\d) (.+?)$/);
        if (m && !lines[i].includes('PAGEREF')) { realStart = i; break; }
    }
    if (realStart < 0) throw new Error('Could not find first real Lesson header');

    for (let i = realStart; i < lines.length; i++) {
        const line = lines[i];
        const mLesson = line.match(/^Lesson (\d)\.(\d) (.+?)$/);
        const mQuizHeader = line.match(/^Section (\d): Knowledge Check$/);
        const mSectionHeader = line.match(/^Section (\d): (.+)$/); // narrative section separator
        if (mLesson && !line.includes('PAGEREF')) {
            const key = mLesson[1] + '.' + mLesson[2];
            currentLesson = { title: mLesson[3].trim(), paragraphs: [] };
            lessons[key] = currentLesson;
            mode = 'lesson';
            continue;
        }
        if (mQuizHeader) {
            const s = mQuizHeader[1];
            currentQuizSection = s;
            currentQuiz = [];
            quizzes[s] = currentQuiz;
            currentQ = null;
            mode = 'quiz';
            continue;
        }
        if (mSectionHeader && !mQuizHeader) {
            // Narrative section header — skip
            currentLesson = null;
            mode = 'between';
            continue;
        }

        if (mode === 'lesson' && currentLesson) {
            const t = line.trim();
            if (t) currentLesson.paragraphs.push(t);
        }
        if (mode === 'quiz' && currentQuiz) {
            const t = line.trim();
            if (!t) continue;
            if (t.startsWith('Correct feedback:')) {
                if (currentQ) currentQ.correctFeedback = t.replace(/^Correct feedback:\s*/, '');
                continue;
            }
            if (t.startsWith('Incorrect feedback:')) {
                if (currentQ) currentQ.incorrectFeedback = t.replace(/^Incorrect feedback:\s*/, '');
                continue;
            }
            const optMatch = t.match(/^·\s*(.+?)\s*(✓|✗)$/);
            if (optMatch) {
                if (currentQ) currentQ.options.push({ text: optMatch[1], correct: optMatch[2] === '✓' });
                continue;
            }
            // Question line
            currentQ = { question: t, options: [], correctFeedback: '', incorrectFeedback: '' };
            currentQuiz.push(currentQ);
        }
    }

    return { lessons, quizzes };
}

// --- Parse framework.md ---
function parseFramework(md) {
    const lines = md.split('\n');
    const units = {}; // key '1.1' -> { title, sections: {name: [lines]} }

    // Find first real unit header
    let realStart = -1;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^FfTT-TSB (\d)\.(\d): (.+?)$/);
        if (m && !lines[i].includes('PAGEREF')) { realStart = i; break; }
    }
    if (realStart < 0) throw new Error('Could not find first real FfTT-TSB header');

    const SECTION_NAMES = new Set([
        'Competency Definition',
        'Competency Statement',
        'Knowledge',
        'Skills',
        'Observable Behaviors',
        'I Demonstrate This When…',
        'I Demonstrate This When',
        'Performance Indicators',
        'Examples',
        'Non-Examples',
        'Common Misconceptions',
        'Conversation Starters'
    ]);

    let currentUnit = null;
    let currentSection = null;

    for (let i = realStart; i < lines.length; i++) {
        const line = lines[i];
        const mUnit = line.match(/^FfTT-TSB (\d)\.(\d): (.+?)$/);
        if (mUnit && !line.includes('PAGEREF')) {
            const key = mUnit[1] + '.' + mUnit[2];
            currentUnit = { title: mUnit[3].trim(), intro: [], sections: {} };
            units[key] = currentUnit;
            currentSection = 'intro';
            continue;
        }
        if (!currentUnit) continue;
        const t = line.trim();
        // Stop when we hit end-of-unit meta headers that come after 8.3
        if (t === 'Framework-Level Misconceptions' || t === 'Related Competencies' || t === 'References') {
            currentUnit = null;
            continue;
        }
        if (SECTION_NAMES.has(t)) {
            currentSection = t.replace('…', '');
            currentUnit.sections[currentSection] = [];
            continue;
        }
        if (!t) continue;
        if (currentSection === 'intro') currentUnit.intro.push(t);
        else if (currentUnit.sections[currentSection]) currentUnit.sections[currentSection].push(t);
    }
    return units;
}

// --- Format ---
function slugify(s) {
    return s.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim();
}

function fmtSectionAsBullets(lines) {
    return lines.map(l => '- ' + l).join('\n');
}

function fmtPerformanceIndicators(lines) {
    // Expected order: labels (Limited, Developing, Effective, Consistent)
    // followed by their 4 descriptions.
    const LABELS = ['Limited', 'Developing', 'Effective', 'Consistent'];
    const labels = [];
    const descs = [];
    for (const l of lines) {
        if (LABELS.includes(l)) labels.push(l); else descs.push(l);
    }
    if (labels.length === descs.length && labels.length > 0) {
        return labels.map((lb, i) => `- **${lb}**: ${descs[i]}`).join('\n');
    }
    return fmtSectionAsBullets(lines);
}

function fmtConversationStarters(lines) {
    // Each entry starts with a category prefix like "Understanding:", "Reflection or Application:", "Practice or Improvement:"
    return lines.map(l => '- ' + l).join('\n');
}

function buildUnit({ courseUnit, frameworkUnit, quizForSection, sectionN, sectionTitle, unitKey, unitCode }) {
    const [s, u] = unitKey.split('.');
    const frontmatter = [
        '---',
        `course_id: ${COURSE_ID}`,
        `course_title: "${COURSE_TITLE}"`,
        `section: ${s}`,
        `section_title: "${sectionTitle}"`,
        `unit: ${unitKey}`,
        `unit_title: "${courseUnit.title}"`,
        `competency_code: "FfTT-TSB ${unitKey}"`,
        '---',
        ''
    ].join('\n');

    const parts = [];
    parts.push(`# ${COURSE_TITLE} — ${unitKey} ${courseUnit.title}`);
    parts.push('');
    parts.push(`_Section ${s}: ${sectionTitle}_`);
    parts.push('');

    // Lesson prose
    parts.push('## Lesson (course text)');
    parts.push('');
    parts.push(courseUnit.paragraphs.join('\n\n'));
    parts.push('');

    // Framework
    if (frameworkUnit) {
        if (frameworkUnit.intro.length) {
            parts.push('## Framework overview');
            parts.push('');
            parts.push(frameworkUnit.intro.join(' '));
            parts.push('');
        }
        const SEC_ORDER = [
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
        for (const s of SEC_ORDER) {
            const lines = frameworkUnit.sections[s];
            if (!lines || !lines.length) continue;
            parts.push('## ' + s);
            parts.push('');
            if (s === 'Competency Definition' || s === 'Competency Statement') {
                parts.push(lines.join(' '));
            } else if (s === 'Performance Indicators') {
                parts.push(fmtPerformanceIndicators(lines));
            } else if (s === 'Conversation Starters') {
                parts.push(fmtConversationStarters(lines));
            } else {
                parts.push(fmtSectionAsBullets(lines));
            }
            parts.push('');
        }
    }

    // Quiz — only append to the "1.1" of each section (else it duplicates).
    if (unitKey.endsWith('.1') && quizForSection && quizForSection.length) {
        parts.push(`## Knowledge Check (Section ${s})`);
        parts.push('');
        parts.push('_These questions cover all three units in this section (X.1, X.2, X.3)._');
        parts.push('');
        quizForSection.forEach((q, qi) => {
            parts.push(`**Q${qi + 1}.** ${q.question}`);
            q.options.forEach(o => {
                parts.push(`- ${o.correct ? '✅' : '❌'} ${o.text}`);
            });
            if (q.correctFeedback) parts.push(`_Feedback (correct):_ ${q.correctFeedback}`);
            if (q.incorrectFeedback) parts.push(`_Feedback (incorrect):_ ${q.incorrectFeedback}`);
            parts.push('');
        });
    }

    return frontmatter + parts.join('\n');
}

// --- Main ---
const { lessons, quizzes } = parseCourse(courseSrc);
const frameworkUnits = parseFramework(frameworkSrc);

const lessonKeys = Object.keys(lessons).sort();
console.log('Course lessons parsed:', lessonKeys.length);
console.log('Framework units parsed:', Object.keys(frameworkUnits).length);
console.log('Quiz sections parsed:', Object.keys(quizzes).length);

let written = 0;
for (const key of lessonKeys) {
    const [s] = key.split('.');
    const outDir = path.join(OUT_ROOT, 'section-' + s);
    fs.mkdirSync(outDir, { recursive: true });
    const md = buildUnit({
        courseUnit: lessons[key],
        frameworkUnit: frameworkUnits[key],
        quizForSection: quizzes[s],
        sectionN: s,
        sectionTitle: SECTION_TITLES[s] || 'Section ' + s,
        unitKey: key,
        unitCode: 'FfTT-TSB ' + key
    });
    const slug = slugify(lessons[key].title);
    const outPath = path.join(outDir, `${key}-${slug}.md`);
    fs.writeFileSync(outPath, md);
    written++;
}
console.log('wrote', written, 'unit files to', OUT_ROOT);
