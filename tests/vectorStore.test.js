// Vector-store lookup (SEC-03, production QA 10 Nov 2026). The lookup read
// one page of 100 stores and CREATED a store on a miss, and read paths
// reached it: a random id on knowledge-search made a new OpenAI vector store,
// and past 100 stores a member whose store was off page 1 silently got an
// empty duplicate after a restart. Now: every page is listed, reads never
// create, a miss is remembered briefly, and only the write path creates.
const test = require('node:test');
const assert = require('node:assert/strict');
const vs = require('../lib/vectorStore');

// The OpenAI SDK surface lib/vectorStore.js uses, over an in-memory account.
function fakeClient(stores) {
    const calls = { list: [], create: [], vsFilesCreate: [], responses: [] };
    let files = 0;
    const client = {
        vectorStores: {
            list: async (q = {}) => {
                calls.list.push({ ...q });
                const list = q.order === 'desc' ? [...stores].reverse() : stores;
                const start = q.after ? list.findIndex((s) => s.id === q.after) + 1 : 0;
                const limit = q.limit || 20;
                await new Promise((r) => setImmediate(r)); // a real round trip yields
                return { data: list.slice(start, start + limit), has_more: start + limit < list.length };
            },
            create: async ({ name }) => {
                calls.create.push(name);
                await new Promise((r) => setImmediate(r));
                const s = { id: 'vs_new_' + calls.create.length, name };
                stores.push(s);
                return s;
            },
            files: {
                list: async () => ({ data: [] }),
                create: async (storeId, { file_id }) => { calls.vsFilesCreate.push([storeId, file_id]); return {}; },
                del: async () => ({}),
            },
        },
        files: {
            create: async () => ({ id: 'file_' + (++files) }),
            retrieve: async () => ({ filename: '' }),
            del: async () => ({}),
        },
        responses: {
            create: async (body) => {
                calls.responses.push(body);
                return { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] };
            },
        },
    };
    return { client, calls };
}

function account(n, extra = {}) {
    const stores = [];
    for (let i = 0; i < n; i++) stores.push({ id: `vs_${i}`, name: `user-member-${i}` });
    for (const [i, s] of Object.entries(extra)) stores.splice(Number(i), 0, s);
    return stores;
}

function setup(stores) {
    const f = fakeClient(stores);
    vs._resetCaches();
    vs.setClient(f.client);
    let t = 1_000_000;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    vs._setNow(now);
    return { ...f, now };
}

test.after(() => { vs.setClient(null); vs._setNow(null); vs._resetCaches(); });

test('lookup lists every page (oldest first, after cursor): a store on page 3 is found, nothing is created', async () => {
    const stores = account(250, { 230: { id: 'vs_target', name: 'user-member-P3' } });
    const { calls } = setup(stores);
    assert.equal(await vs.getUserVectorStoreId('member-P3'), 'vs_target');
    assert.equal(calls.list.length, 3, 'three pages of 100');
    assert.deepEqual(calls.list.map((q) => [q.limit, q.order, q.after || null]), [[100, 'asc', null], [100, 'asc', 'vs_99'], [100, 'asc', 'vs_199']]);
    assert.deepEqual(calls.create, []);
    // Found, and every name seen on the way, is cached for the life of the process.
    assert.equal(await vs.getUserVectorStoreId('member-P3'), 'vs_target');
    assert.equal(await vs.getUserVectorStoreId('member-150'), 'vs_150');
    assert.equal(calls.list.length, 3, 'no listing for a cached name');
});

test('two stores with one name (an old duplicate): the oldest, the original, wins', async () => {
    const { calls } = setup([{ id: 'vs_original', name: 'user-dup' }, { id: 'vs_x', name: 'user-other' }, { id: 'vs_duplicate', name: 'user-dup' }]);
    assert.equal(await vs.getUserVectorStoreId('dup'), 'vs_original');
    assert.equal(await vs.findStoreByName('user-dup'), 'vs_original');
    assert.equal(calls.list.length, 1);
});

test('a read miss creates nothing: searchKnowledge for a random userId or objectId searches no user store', async () => {
    const { calls } = setup(account(120));
    for (const who of [{ userId: 'random-' + Math.random().toString(36).slice(2) }, { objectId: 'ct-random-' + Math.random().toString(36).slice(2) }]) {
        const r = await vs.searchKnowledge({ query: 'what did my report say?', scope: 'user_data', ...who });
        assert.deepEqual([r.chunks, r.vectorStoreIds, r.reason], [[], [], 'no stores available for scope'], JSON.stringify(who));
    }
    assert.equal(await vs.getUserVectorStoreId('nobody'), null);
    assert.deepEqual(calls.create, [], 'no store created on a read');
    assert.equal(calls.responses.length, 0, 'nothing to search, no model call');
    // A known member's store is searched (the guest store is "user-guest-<objectId>").
    const stores = [{ id: 'vs_g', name: 'user-guest-ct-1' }];
    const g = setup(stores);
    const r = await vs.searchKnowledge({ query: 'q', scope: 'user_data', objectId: 'ct-1' });
    assert.deepEqual(r.vectorStoreIds, ['vs_g']);
    assert.deepEqual(g.calls.responses[0].tools[0].vector_store_ids, ['vs_g']);
});

test('negative cache: an unknown name does not re-list within NEGATIVE_TTL_MS; after it, it lists again', async () => {
    const { calls, now } = setup(account(250));
    assert.equal(await vs.getUserVectorStoreId('ghost'), null);
    assert.equal(calls.list.length, 3, 'one full listing to say "not found"');
    for (let i = 0; i < 5; i++) assert.equal(await vs.getUserVectorStoreId('ghost'), null);
    assert.equal(calls.list.length, 3, 'remembered: no listing per request');
    // Concurrent misses share one listing.
    const before = calls.list.length;
    await Promise.all([vs.getUserVectorStoreId('ghost-2'), vs.getUserVectorStoreId('ghost-2'), vs.getUserVectorStoreId('ghost-2')]);
    assert.equal(calls.list.length, before + 3, 'three concurrent reads, one listing (3 pages)');
    now.advance(vs.NEGATIVE_TTL_MS + 1);
    assert.equal(await vs.getUserVectorStoreId('ghost'), null);
    assert.equal(calls.list.length, before + 6, 'expired: listed again');
    assert.deepEqual(calls.create, []);
});

test('the write path still creates: syncUserReport makes the store on the first write, once, and a read then finds it', async () => {
    const { calls } = setup(account(150));
    // A read first: remembered as missing...
    assert.equal(await vs.getUserVectorStoreId('member-W'), null);
    // ...which must not stop the write from looking again and creating.
    const r = await vs.syncUserReport('member-W', '# Report\nThe user Name is W.');
    assert.equal(r.changed, true);
    assert.deepEqual(calls.create, ['user-member-W']);
    assert.equal(r.storeId, 'vs_new_1');
    assert.deepEqual(calls.vsFilesCreate[0], ['vs_new_1', r.fileId]);
    const listed = calls.list.length;
    assert.equal(await vs.getUserVectorStoreId('member-W'), 'vs_new_1', 'the read finds what the write made');
    assert.equal(calls.list.length, listed, 'from the cache');
    assert.equal((await vs.syncUserReport('member-W', '# Report\nThe user Name is W.')).reason, 'hash unchanged');
    assert.equal(calls.create.length, 1);
});

test('the write path reuses a store past page 1 (no empty duplicate after a restart), and concurrent writers create once', async () => {
    const { calls } = setup(account(180));
    const r = await vs.syncUserReport('member-170', '# Report');
    assert.equal(r.storeId, 'vs_170');
    assert.deepEqual(calls.create, [], 'found on page 2, not duplicated');
    // A preparation fires the report and the activity sync at once for a new person.
    await Promise.all([
        vs.syncUserReport('member-new', '# Report for new'),
        vs.syncUserActivity({ identifier: 'member-new', identifierType: 'userId', markdown: '# Activity' }),
        vs.saveSessionMemory('member-new', 'summary'),
    ]);
    assert.deepEqual(calls.create, ['user-member-new'], 'one store for three concurrent writes');
    const ids = new Set(calls.vsFilesCreate.map(([id]) => id));
    assert.deepEqual([...ids].filter((id) => id !== 'vs_170'), ['vs_new_1']);
});
