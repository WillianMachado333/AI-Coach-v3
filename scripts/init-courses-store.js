#!/usr/bin/env node
/**
 * scripts/init-courses-store.js
 * ---------------------------------------------------------------
 * Bootstrap the shared "courses-shared" vector store from every
 * markdown under knowledge-base/courses/. Walks recursively so
 * section subfolders come along. Prints COURSES_STORE_ID to set
 * on Railway.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/init-courses-store.js
 *
 * Idempotency: if the named store already exists, its files are
 * detached + deleted, then the current markdowns are uploaded and
 * attached fresh.
 * ---------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');

const STORE_NAME = 'courses-shared';
const COURSES_DIR = path.join(__dirname, '..', 'knowledge-base', 'courses');

function walkMd(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) out.push(...walkMd(full));
        else if (name.endsWith('.md')) out.push(full);
    }
    return out.sort();
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('OPENAI_API_KEY env var required.');
        process.exit(1);
    }
    const client = new OpenAI({ apiKey });

    if (!fs.existsSync(COURSES_DIR)) {
        console.error('Courses dir not found: ' + COURSES_DIR);
        process.exit(1);
    }
    const files = walkMd(COURSES_DIR);
    if (files.length === 0) {
        console.error('No .md files under ' + COURSES_DIR);
        process.exit(1);
    }
    console.log('Found ' + files.length + ' course files.');

    const page = await client.vectorStores.list({ limit: 100 });
    let store = (page.data || []).find((s) => s.name === STORE_NAME);
    if (store) console.log('Existing store: ' + store.id);
    else { store = await client.vectorStores.create({ name: STORE_NAME }); console.log('Created store: ' + store.id); }

    // Clean existing
    let existing = await client.vectorStores.files.list(store.id, { limit: 100 });
    for (const f of existing.data || []) {
        try {
            await client.vectorStores.files.delete(f.id, { vector_store_id: store.id });
            try { await client.files.delete(f.id); } catch (_) { }
        } catch (e) { console.warn('detach fail: ' + e.message); }
    }

    for (const full of files) {
        // Use relative-from-courses/ as the visible filename so
        // section-1/1.1-trait-awareness.md keeps its identity in retrieval hits.
        const relative = path.relative(COURSES_DIR, full).replace(/\\/g, '/');
        const content = fs.readFileSync(full, 'utf8');
        const file = await client.files.create({
            file: await toFile(Buffer.from(content, 'utf8'), relative, { type: 'text/markdown' }),
            purpose: 'assistants'
        });
        await client.vectorStores.files.create(store.id, { file_id: file.id });
        console.log('  uploaded ' + relative + ' -> ' + file.id);
    }

    const start = Date.now();
    while (Date.now() - start < 60000) {
        const s = await client.vectorStores.retrieve(store.id);
        const c = s.file_counts || {};
        if (c.in_progress === 0) {
            console.log('Indexed: completed=' + c.completed + ' failed=' + c.failed);
            break;
        }
        await new Promise((r) => setTimeout(r, 1500));
    }

    console.log('');
    console.log('COURSES_STORE_ID=' + store.id);
    console.log('Set this env var on Railway and redeploy.');
}

main().catch((e) => { console.error('init failed:', e); process.exit(1); });
