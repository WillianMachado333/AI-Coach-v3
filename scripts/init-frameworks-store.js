#!/usr/bin/env node
/**
 * scripts/init-frameworks-store.js
 * ---------------------------------------------------------------
 * One-shot bootstrap for the shared "frameworks-shared" vector store.
 * Reads every markdown in knowledge-base/frameworks/, uploads them,
 * attaches to a vector store named "frameworks-shared", then prints
 * the store id you should set as FRAMEWORKS_STORE_ID on Railway.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/init-frameworks-store.js
 *
 * Idempotency:
 *   - If the store already exists (by name), we REPLACE its contents:
 *     detach existing files, upload the current markdowns, attach.
 *   - Safe to re-run after editing framework markdowns.
 * ---------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');

const STORE_NAME = 'frameworks-shared';
const FRAMEWORKS_DIR = path.join(__dirname, '..', 'knowledge-base', 'frameworks');

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error('❌ OPENAI_API_KEY env var required.');
        process.exit(1);
    }

    const client = new OpenAI({ apiKey });

    // 1. Locate framework files
    if (!fs.existsSync(FRAMEWORKS_DIR)) {
        console.error(`❌ Frameworks dir not found: ${FRAMEWORKS_DIR}`);
        process.exit(1);
    }
    const files = fs.readdirSync(FRAMEWORKS_DIR)
        .filter((f) => f.endsWith('.md'))
        .sort();
    if (files.length === 0) {
        console.error(`❌ No .md files in ${FRAMEWORKS_DIR}`);
        process.exit(1);
    }
    console.log(`📚 Found ${files.length} framework files.`);

    // 2. Find-or-create store
    console.log(`🔍 Looking up vector store "${STORE_NAME}"...`);
    const page = await client.vectorStores.list({ limit: 100 });
    let store = (page.data || []).find((s) => s.name === STORE_NAME);
    if (store) {
        console.log(`   Found existing store: ${store.id}`);
    } else {
        console.log(`   Creating new store...`);
        store = await client.vectorStores.create({ name: STORE_NAME });
        console.log(`   Created: ${store.id}`);
    }

    // 3. Detach existing files (so re-runs replace content cleanly)
    console.log(`🧹 Removing any existing files from the store...`);
    let existing = await client.vectorStores.files.list(store.id, { limit: 100 });
    for (const f of existing.data || []) {
        try {
            await client.vectorStores.files.delete(f.id, { vector_store_id: store.id });
            // Also drop the underlying file so we don't leak orphans
            try { await client.files.delete(f.id); } catch (_) { /* ignore */ }
            console.log(`   detached + deleted ${f.id}`);
        } catch (e) {
            console.warn(`   couldn't detach ${f.id}: ${e.message}`);
        }
    }

    // 4. Upload + attach each framework
    console.log(`⬆️  Uploading ${files.length} framework files...`);
    const uploaded = [];
    for (const filename of files) {
        const full = path.join(FRAMEWORKS_DIR, filename);
        const content = fs.readFileSync(full, 'utf8');

        const file = await client.files.create({
            file: await toFile(Buffer.from(content, 'utf8'), filename, { type: 'text/markdown' }),
            purpose: 'assistants'
        });
        await client.vectorStores.files.create(store.id, { file_id: file.id });
        console.log(`   ✅ ${filename} -> ${file.id}`);
        uploaded.push({ filename, fileId: file.id, bytes: content.length });
    }

    // 5. Wait briefly for indexing to complete, then report
    console.log(`⏳ Waiting for indexing...`);
    const start = Date.now();
    while (Date.now() - start < 30000) {
        const s = await client.vectorStores.retrieve(store.id);
        const counts = s.file_counts || {};
        if (counts.in_progress === 0) {
            console.log(`   Indexed: completed=${counts.completed} failed=${counts.failed}`);
            break;
        }
        await new Promise((r) => setTimeout(r, 1500));
    }

    console.log('');
    console.log('════════════════════════════════════════════════');
    console.log('✅ Frameworks store ready.');
    console.log('');
    console.log(`   FRAMEWORKS_STORE_ID=${store.id}`);
    console.log('');
    console.log('Set this env var on Railway (production environment) and redeploy.');
    console.log('════════════════════════════════════════════════');
}

main().catch((err) => {
    console.error('❌ Init failed:', err);
    process.exit(1);
});
