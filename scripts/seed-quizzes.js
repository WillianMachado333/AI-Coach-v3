#!/usr/bin/env node
/*
 * Seed the 20 Talent Transformation quizzes into knowledge-base/quizzes/.
 * See MEMORY note ai-coach-hard-vs-soft-data: URLs stay on the Wix side,
 * we only capture semantic context here.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'knowledge-base', 'quizzes');
if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });

const QUIZZES = [
    { id: 'life-satisfaction', title: 'Life Satisfaction', description: 'Your happiness reset starts with this 2-minute quiz. Find out what is holding you back from feeling truly fulfilled.' },
    { id: 'personality', title: 'Personality', description: 'Discover your personality superpowers in 2 minutes and learn how to thrive by understanding what makes you, YOU.' },
    { id: 'personal-values', title: 'Personal Values', description: 'Find what matters to you in 2 minutes and learn how to live with more purpose, joy, and confidence.' },
    { id: 'emotional-intelligence', title: 'Emotional Intelligence', description: 'Enhance your emotional intelligence in 3 minutes and feel more in control, connected, and aware.' },
    { id: 'entrepreneurial-competencies', title: 'Entrepreneurial Competencies', description: 'Find out if you are ready to turn your business idea into reality with this 3-minute quiz.' },
    { id: 'career-interests', title: 'Career Interests', description: 'Find the career that gets you out of bed in 4 minutes.' },
    { id: 'communication-styles', title: 'Communication Styles', description: 'Find your communication style and learn how to win trust, make moves, and level up your connections in 3 minutes.' },
    { id: 'learning-mindset', title: 'Learning Mindset', description: 'Uncover your learning roadblocks in 3 minutes and discover how to stay motivated and focused.' },
    { id: 'digital-literacy', title: 'Digital Literacy', description: 'Find out how tech-savvy you are and learn to thrive, create, and stay safe in the digital world in 2 minutes.' },
    { id: 'action-oriented-biases', title: 'Action-oriented Biases', description: 'Uncover the hidden biases that push you to act without thinking in 2 minutes and learn to stay clear-headed under pressure.' },
    { id: 'interest-biases', title: 'Interest Biases', description: 'In 2 minutes, discover how hidden influences like emotions and money might be steering your decisions.' },
    { id: 'pattern-recognition-biases', title: 'Pattern Recognition Biases', description: 'Discover how your brain connects the dots in 2 minutes and learn to avoid the traps of jumping to conclusions.' },
    { id: 'stability-biases', title: 'Stability Biases', description: 'Find out if your comfort zone is holding you back and learn to embrace change with confidence in 2 minutes.' },
    { id: 'social-biases', title: 'Social Biases', description: 'In 3 minutes, discover if your desire for harmony keeps you from speaking up and learn to stand firm in challenging moments.' },
    { id: 'self-related-biases', title: 'Self-related Biases', description: 'Do you judge yourself differently from others? Take 3 minutes to explore how being in the spotlight can shift your perspective.' },
    { id: 'talents-identifier', title: 'Talents Identifier', description: 'Discover your unique strengths and open doors to future success in just 24 minutes.' },
    { id: 'interactive-styles', title: 'Interactive Styles', description: 'Build better relationships in 2 minutes. Learn how to communicate clearly, confidently, and with genuine care.' },
    { id: 'conflict-handling-styles', title: 'Conflict Handling Styles', description: 'Handle conflict with confidence in 4 minutes and learn how to turn tough moments into opportunities for growth.' },
    { id: 'identity', title: 'Identity', description: 'Understand yourself on a deeper level in 4 minutes and discover how your identity can help you live and lead with purpose.' },
    { id: 'career-readiness', title: 'Career Readiness', description: 'Step into your career with confidence. In 5 minutes, discover the six essential skills that will help you succeed and grow in any workplace.' }
];

function contentTemplate({ title, description }) {
    return [
        '# ' + title + ' — semantic guide',
        '',
        '> ' + description,
        '',
        '## What this quiz measures',
        '',
        '_Fill in: the core competency, trait, or perspective this quiz is trying to surface._',
        '',
        '## What it looks at',
        '',
        '- _Fill in: a few concrete themes the questions probe (without repeating the questions themselves)._',
        '',
        '## What it does NOT try to do',
        '',
        '- _Fill in: common misreadings — e.g. "this is not a diagnostic tool", "this is not an IQ test", "this does not measure X"._',
        '',
        '## Common misconceptions to watch for',
        '',
        '- _Fill in: what people typically over- or under-interpret from the result._',
        '',
        '## When Erica should reference this quiz',
        '',
        '- _Fill in: what the learner might be asking or feeling when this quiz becomes relevant to bring up._',
        ''
    ].join('\n');
}

let created = 0, updatedMeta = 0;
for (const q of QUIZZES) {
    const dir = path.join(ROOT, q.id);
    const metaPath = path.join(dir, '_meta.json');
    const contentPath = path.join(dir, 'content.md');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const isNew = !fs.existsSync(metaPath);
    const meta = { quiz_id: q.id, title: q.title, description: q.description, purpose: '' };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    if (isNew) {
        if (!fs.existsSync(contentPath)) {
            fs.writeFileSync(contentPath, contentTemplate(q), 'utf8');
        }
        created++;
    } else {
        updatedMeta++;
    }
}
console.log('Seed done: ' + created + ' created, ' + updatedMeta + ' meta refreshed. Total ' + QUIZZES.length + ' quizzes.');
console.log('Path: ' + ROOT);
