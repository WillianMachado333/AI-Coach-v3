#!/usr/bin/env node
/*
 * Synthetic session generator.
 *
 * Fills /data/sessions/ on the Railway volume with ~30 realistic-looking
 * Coach Studio sessions so the observatory has real material to inspect
 * before real users start showing up.
 *
 * Uses the OpenAI Responses API (NOT the Realtime API — Realtime is browser
 * WebRTC and can't be driven from a script) to generate coach turns that
 * respect a chosen persona + user profile. Every session posts events
 * through /api/session-log so we exercise the same ingestion path real
 * clients use.
 *
 * Usage (locally):
 *   BASE=https://web-production-2c7ff.up.railway.app \
 *   ADMIN_PASSWORD=<your admin password used only for /api/session-log> \
 *   OPENAI_API_KEY=<key> \
 *   node scripts/gen-synthetic-sessions.js [--count 30] [--dry-run]
 *
 * Or on the server:
 *   npm run gen:sessions
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const BASE = process.env.BASE || 'https://web-production-2c7ff.up.railway.app';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.SYNTHETIC_MODEL || 'gpt-4.1-mini';
const COUNT = argInt('--count', 30);
const DRY = process.argv.includes('--dry-run');

if (!OPENAI_KEY && !DRY) {
    console.error('OPENAI_API_KEY missing. Set it or run with --dry-run to check plan without calling OpenAI.');
    process.exit(1);
}

function argInt(name, def) {
    const i = process.argv.indexOf(name);
    if (i < 0) return def;
    const v = parseInt(process.argv[i + 1] || '', 10);
    return Number.isFinite(v) ? v : def;
}

// 10 personas × 3 topics = 30. Vary slightly on each run so re-running
// produces different flavours rather than clones.
const PERSONAS = [
    { id: 'Supportive', character: 'Erica', style: 'Calm, reassuring. Emotional safety before action.' },
    { id: 'Directive', character: 'Steve', style: 'Sharp, decisive. Cuts through noise, names the next step.' },
    { id: 'Discovery', character: 'Emma', style: 'Curious. Asks the question the user has been avoiding.' },
    { id: 'Empowering', character: 'Jasmine', style: 'Reflects the user\'s own strengths back to them. Ownership-first.' },
    { id: 'Exploratory', character: 'Evan', style: 'Looks for patterns and unspoken connections.' },
    { id: 'Guidance', character: 'Michael', style: 'Practical, teacher-mode. Shows examples and options.' },
    { id: 'Nurturing', character: 'Sarah', style: 'Slow, tender. Names feelings before problem-solving.' },
    { id: 'Strengths', character: 'Sean', style: 'Anchors every reflection on what is working.' },
    { id: 'Supportive', character: 'Erica', style: 'Same persona, different user profile.' },
    { id: 'Directive', character: 'Steve', style: 'Same persona, different user profile.' }
];
const TOPICS = [
    { topic: 'career-decision', opening: 'I am torn between staying in my job and taking a risky offer at a startup.' },
    { topic: 'burnout', opening: 'I have been feeling drained for weeks. Even weekends do not restore me.' },
    { topic: 'quiz-results', opening: 'I just did the Emotional Intelligence quiz. My self-regulation score was way lower than I expected. What does that mean for me?' }
];

// Some sessions are "testers" so the observatory's tester-filter has
// something to filter out.
const TESTER_MARKERS = ['+demo', '+test'];

async function main() {
    console.log('== Synthetic session generator ==');
    console.log('  BASE =', BASE);
    console.log('  count =', COUNT);
    console.log('  dry-run =', DRY);
    if (DRY) return;

    let ok = 0, fail = 0;
    for (let i = 0; i < COUNT; i++) {
        const persona = PERSONAS[i % PERSONAS.length];
        const topic = TOPICS[i % TOPICS.length];
        // 3 sessions out of 30 are marked as tester via email pattern.
        const isTester = (i % 10) === 0;
        const email = isTester
            ? 'qa' + TESTER_MARKERS[i % TESTER_MARKERS.length] + '@talenttransformation.com'
            : synthEmail(i);
        // Historical spread: sessions from up to 7 days ago.
        const backDays = Math.floor(i / 5);
        const started = new Date(Date.now() - backDays * 24 * 60 * 60 * 1000 - Math.random() * 60 * 60 * 1000);
        try {
            const sessionId = await startSession({ email, caller: 'synthetic', when: started });
            await runConversation({ sessionId, persona, topic, started });
            console.log('  [' + (i + 1) + '/' + COUNT + ']', persona.id, '/', topic.topic, '-> ', sessionId, isTester ? '(tester)' : '');
            ok++;
        } catch (e) {
            fail++;
            console.error('  [' + (i + 1) + '/' + COUNT + '] failed:', e?.message || e);
        }
    }
    console.log('done:', ok, 'ok,', fail, 'failed');
}

async function startSession({ email, caller, when }) {
    // We call the real preparation endpoint to allocate a session id server-side
    // — that also runs syncActivityForSession, which we harmlessly ignore.
    const body = { caller, email };
    const resp = await postJson(BASE + '/api/erica-preparation', body);
    const sid = resp.headers['x-session-id'];
    if (!sid) throw new Error('no X-Session-Id header in preparation response');
    return sid;
}

async function runConversation({ sessionId, persona, topic, started }) {
    const systemPrompt = 'You are ' + persona.character + ', a ' + persona.id + ' coach at Talent Transformation. Style: ' + persona.style + '\nRespond in 3–5 sentences of first-person coach voice. If the user\'s message would benefit from context you do not have, briefly acknowledge that instead of inventing detail.';
    // 3-5 turns per conversation.
    const turnCount = 3 + Math.floor(Math.random() * 3);
    let userText = topic.opening;
    const conv = [];
    for (let t = 0; t < turnCount; t++) {
        // Log user turn.
        await sessionLog(sessionId, {
            kind: 'user_turn',
            text: userText,
            meta: { synthetic: true }
        });
        conv.push({ role: 'user', content: userText });

        // Generate coach reply.
        const coachText = await openaiChat({ system: systemPrompt, messages: conv });
        conv.push({ role: 'assistant', content: coachText });

        // Occasionally sprinkle a tool call before the bot turn (search_knowledge / render_chart / etc).
        const rand = Math.random();
        if (rand < 0.35) {
            await sessionLog(sessionId, {
                kind: 'tool_call',
                name: 'search_knowledge',
                args: { query: topic.topic + ' framework guidance', scope: 'frameworks' },
                result: { chunks: 4 },
                ms: 800 + Math.floor(Math.random() * 900)
            });
        } else if (rand < 0.45) {
            await sessionLog(sessionId, {
                kind: 'tool_call',
                name: 'render_chart',
                args: { type: 'bar', title: 'Sample' },
                result: { success: true },
                ms: 40
            });
        }

        // Occasionally simulate a tool failure so metrics has something to flag.
        if (Math.random() < 0.08) {
            await sessionLog(sessionId, {
                kind: 'tool_call',
                name: 'deep_think',
                args: { query: 'complex reasoning' },
                result: null,
                error: 'timeout after 8s',
                ms: 8000
            });
        }

        await sessionLog(sessionId, {
            kind: 'bot_turn',
            text: coachText,
            promptSnapshot: systemPrompt,
            meta: { synthetic: true }
        });

        // 20% chance user just stops here (mid-conversation drop-off).
        if (Math.random() < 0.2 && t >= 1) break;

        // Generate a follow-up user message.
        userText = await openaiChat({
            system: 'You are a user in a coaching conversation. Reply naturally to the coach in 1-2 sentences, either going deeper on the topic or shifting slightly. Do NOT ask "what next" — you drive.',
            messages: conv
        });
    }
}

// ---- Small HTTP helpers ---------------------------------------------------

async function sessionLog(sessionId, evt) {
    const body = { sessionId, ...evt };
    await postJson(BASE + '/api/session-log', body);
}

async function openaiChat({ system, messages }) {
    const body = {
        model: MODEL,
        input: [{ role: 'system', content: system }, ...messages]
    };
    const resp = await postJson('https://api.openai.com/v1/responses', body, {
        Authorization: 'Bearer ' + OPENAI_KEY
    });
    const parsed = resp.body;
    let out = '';
    for (const item of parsed.output || []) {
        if (item.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) if (c.type === 'output_text' || c.type === 'text') out += (c.text || '');
        }
    }
    return out.trim() || '(no response)';
}

function postJson(urlStr, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const mod = u.protocol === 'https:' ? https : http;
        const data = JSON.stringify(body);
        const req = mod.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + (u.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                ...extraHeaders
            }
        }, (res) => {
            let raw = '';
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ' ' + raw.slice(0, 300)));
                let parsed = raw;
                try { parsed = JSON.parse(raw); } catch (_) { /* keep raw */ }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function synthEmail(i) {
    const names = ['ana', 'bruno', 'carla', 'diego', 'elena', 'felipe', 'gabi', 'hugo', 'iris', 'joao'];
    const surnames = ['silva', 'costa', 'martins', 'ribeiro', 'gomes', 'lima', 'rocha', 'melo'];
    const n = names[i % names.length];
    const s = surnames[Math.floor(i / names.length) % surnames.length];
    return n + '.' + s + '+syn' + i + '@example.com';
}

main().catch((e) => {
    console.error('fatal:', e?.message || e);
    process.exit(1);
});
