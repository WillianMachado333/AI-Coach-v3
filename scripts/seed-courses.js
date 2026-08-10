#!/usr/bin/env node
/*
 * Seed the ~37 Talent Transformation courses into knowledge-base/courses/.
 *
 * Per Willian: create the shell only — title + empty description + empty
 * course-content.md + empty competency-framework.md. Eric will fill each
 * in. URLs are NOT stored here (hard data — belongs on the Wix side and
 * reaches Erica via preparation).
 *
 * Idempotent: if a course dir already exists (e.g. TSB with its real
 * content), it is left untouched.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'knowledge-base', 'courses');
if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });

// Course titles pasted by Willian. `id` is derived to be a safe slug.
// The already-populated TSB course is intentionally NOT listed here so
// its rich content stays intact (script would skip it anyway).
const COURSES = [
    { id: 'thriving-in-an-ai-driven-world', title: 'Thriving in an AI-Driven World' },
    { id: 'nace-critical-thinking', title: 'NACE-Aligned Critical Thinking for Career Readiness' },
    { id: 'thinking-judgment-innovation', title: 'Thinking, Judgment, and Innovation' },
    { id: 'problem-solving-workplace', title: 'Problem Solving in the Workplace' },
    { id: 'customer-service-hospitality', title: 'Customer Service Excellence in Hospitality' },
    { id: 'rest-for-resilience', title: 'Rest for Resilience' },
    // tsb already exists — Understanding Traits, Skills, and Behaviors
    { id: 'nace-intro-career-readiness', title: 'NACE-Aligned Introduction to the Career Readiness' },
    { id: 'thriving-personally-professionally', title: 'Thriving Personally and Professionally' },
    { id: 'nace-career-self-development', title: 'NACE-Aligned Career and Self-Development for Career Readiness' },
    { id: 'nace-equity-inclusion', title: 'NACE-Aligned Equity and Inclusion for Career Readiness' },
    { id: 'nace-teamwork', title: 'NACE-Aligned Teamwork for Career Readiness' },
    { id: 'nace-technology', title: 'NACE-Aligned Technology Career Readiness' },
    { id: 'healthy-relationships', title: 'Healthy Relationships' },
    { id: 'time-management-healthcare', title: 'Time Management for Healthcare Workers' },
    { id: 'taking-initiative', title: 'Taking Initiative' },
    { id: 'social-engagement', title: 'Social Engagement' },
    { id: 'healthcare-interview-readiness', title: 'Healthcare Interview Readiness' },
    { id: 'personal-goal-development', title: 'Personal Goal Development' },
    { id: 'hipaa-patient-privacy', title: 'HIPAA & Patient Privacy Basics' },
    { id: 'financial-stability', title: 'Financial Stability' },
    { id: 'career-and-pursuits', title: 'Career and Pursuits' },
    { id: 'teamwork-hospitality', title: 'Teamwork in Hospitality Settings' },
    { id: 'de-escalation-patients', title: 'De-Escalation Techniques with Patients' },
    { id: 'professional-presence', title: 'Professional Presence for Workplace Success' },
    { id: 'professional-communication-hospitality', title: 'Professional Communication in Hospitality' },
    { id: 'handling-difficult-guests', title: 'Handling Difficult Guests in Hospitality' },
    { id: 'florida-ready-interview-facilitator', title: 'Florida Ready Interview Practice Facilitator' },
    { id: 'dummy-final-knowledge-check', title: 'Dummy Final Knowledge Check' },
    { id: 'dummy-course', title: 'Dummy Course' },
    { id: 'critical-thinking-for-success', title: 'Critical Thinking for Success' },
    { id: 'healthcare-career-readiness', title: 'Healthcare Career Readiness & Employability Skills' },
    { id: 'compassionate-care-patient-engagement', title: 'Compassionate Care & Patient Engagement' },
    { id: 'foundations-workplace-success-healthcare', title: 'Foundations of Workplace Success in Healthcare' },
    { id: 'healthcare-customer-service', title: 'Healthcare Customer Service & Patient Experience Excellence' },
    { id: 'interviewing-skills', title: 'Interviewing Skills for Success' },
    { id: 'communication-skills-life-work', title: 'Build Strong Communication Skills for Life and Work' }
];

function contentTemplate(title) {
    return [
        '---',
        'course_id: ' + arguments[1],
        'title: "' + title + '"',
        'artifact: course-content',
        '---',
        '',
        '# ' + title + ' — Course content',
        '',
        '_Empty. Fill in the pedagogical text: lessons in reading order, section quiz Q&A where relevant. Keep it semantic — no URLs, no hard IDs (those live on the Wix side and reach Erica via preparation)._',
        ''
    ].join('\n');
}
function frameworkTemplate(title, id) {
    return [
        '---',
        'course_id: ' + id,
        'title: "' + title + ' — Competency framework"',
        'artifact: competency-framework',
        '---',
        '',
        '# ' + title + ' — Competency framework',
        '',
        '_Empty. Fill in the competency definitions, skills, observable behaviors, and performance indicators for each section._',
        ''
    ].join('\n');
}
function contentTemplateFor(id, title) {
    return [
        '---',
        'course_id: ' + id,
        'title: "' + title + '"',
        'artifact: course-content',
        '---',
        '',
        '# ' + title + ' — Course content',
        '',
        '_Empty. Fill in the pedagogical text: lessons in reading order, section quiz Q&A where relevant. Keep it semantic — no URLs, no hard IDs (those live on the Wix side and reach Erica via preparation)._',
        ''
    ].join('\n');
}

let created = 0, skipped = 0;
for (const c of COURSES) {
    const dir = path.join(ROOT, c.id);
    if (fs.existsSync(dir)) { skipped++; continue; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_meta.json'), JSON.stringify({
        course_id: c.id, title: c.title, description: ''
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'course-content.md'), contentTemplateFor(c.id, c.title), 'utf8');
    fs.writeFileSync(path.join(dir, 'competency-framework.md'), frameworkTemplate(c.title, c.id), 'utf8');
    created++;
}
console.log('Seed done: ' + created + ' created, ' + skipped + ' skipped (already existed). Total ' + COURSES.length + ' courses defined.');
console.log('Path: ' + ROOT);
