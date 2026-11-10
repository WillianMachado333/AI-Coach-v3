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

test('negative cache: an unknown name does not re-list within ACCOUNT_LIST_TTL_MS; after it, it lists again', async () => {
    const { calls, now } = setup(account(250));
    // Concurrent misses on a cold cache share one listing.
    await Promise.all([vs.getUserVectorStoreId('ghost'), vs.getUserVectorStoreId('ghost'), vs.getUserVectorStoreId('ghost')]);
    assert.equal(calls.list.length, 3, 'three concurrent reads, one full listing (3 pages) to say "not found"');
    for (let i = 0; i < 5; i++) assert.equal(await vs.getUserVectorStoreId('ghost'), null);
    assert.equal(calls.list.length, 3, 'remembered: no listing per request');
    now.advance(vs.ACCOUNT_LIST_TTL_MS + 1);
    assert.equal(await vs.getUserVectorStoreId('ghost'), null);
    assert.equal(calls.list.length, 6, 'expired: listed again');
    assert.deepEqual(calls.create, []);
});

// QA review of #78: when the window expires, simultaneous misses for
// DIFFERENT names each listed the whole account (3.6 to 4.1 s apiece).
test('one read listing at a time: simultaneous misses for different names share it (cold, and when the window expires)', async () => {
    const { calls, now } = setup(account(250));
    const cold = await Promise.all(['ghost-a', 'ghost-b', 'ghost-c', 'member-240'].map((id) => vs.getUserVectorStoreId(id)));
    assert.deepEqual(cold, [null, null, null, 'vs_240']);
    assert.equal(calls.list.length, 3, 'one listing (3 pages) answered four names');
    now.advance(vs.ACCOUNT_LIST_TTL_MS + 1);
    await Promise.all(['ghost-d', 'ghost-e'].map((id) => vs.getUserVectorStoreId(id)));
    assert.equal(calls.list.length, 6, 'expired: one more listing for two names, not two');
});

test('a read listing that stopped early (its own name found) lets a waiting miss list on its own', async () => {
    const { calls } = setup(account(250));
    const [found, missing] = await Promise.all([vs.getUserVectorStoreId('member-5'), vs.getUserVectorStoreId('ghost-z')]);
    assert.equal(found, 'vs_5');
    assert.equal(missing, null);
    assert.equal(calls.list.length, 1 + 3, 'page 1 for member-5, then a complete listing for ghost-z');
});

// NEW-2 (QA retest, 10 Nov 2026): the miss was remembered per name, so every
// guest or member without a store paid a whole listing (3.6 to 4.1 s on the
// real account) on their first user_data/all search.
test('NEW-2: after one complete listing, a DIFFERENT unknown name costs no listing either', async () => {
    const { calls, now } = setup(account(950));
    assert.equal(await vs.getUserVectorStoreId('guest-ct-first'), null);
    assert.equal(calls.list.length, 10, 'the first miss lists the whole account once');
    for (const id of ['guest-ct-2', 'guest-ct-3', 'member-no-store', 'random-id']) {
        assert.equal(await vs.getUserVectorStoreId(id), null, id);
    }
    assert.equal(calls.list.length, 10, 'four other people without a store: zero more pages');
    // Searches for them do not list the account either.
    await vs.searchKnowledge({ query: 'my notes', scope: 'user_data', userId: 'guest-ct-5' });
    await vs.searchKnowledge({ query: 'my notes', scope: 'all', objectId: 'member-without-store' });
    assert.equal(calls.list.length, 10, 'searchKnowledge (user_data, all) answers from memory');
    // People who have a store are still found (cached on the way).
    assert.equal(await vs.getUserVectorStoreId('member-900'), 'vs_900');
    assert.equal(calls.list.length, 10);
    now.advance(vs.ACCOUNT_LIST_TTL_MS - 1000);
    assert.equal(await vs.getUserVectorStoreId('guest-ct-6'), null);
    assert.equal(calls.list.length, 10, 'still inside the window');
    assert.deepEqual(calls.create, []);
});

test('NEW-2: a listing that stopped early (the name was found) does not vouch for other names', async () => {
    const { calls } = setup(account(250));
    assert.equal(await vs.getUserVectorStoreId('member-5'), 'vs_5');
    assert.equal(calls.list.length, 1, 'found on page 1, stopped there');
    assert.equal(await vs.getUserVectorStoreId('member-240'), 'vs_240', 'a store on page 3 is still found');
    assert.equal(calls.list.length, 4);
    assert.equal(await vs.getUserVectorStoreId('ghost'), null);
    assert.equal(calls.list.length, 7, 'a miss still needs one complete listing');
});

test('NEW-2: inside the window a store made elsewhere is invisible to reads, but a write finds it (no duplicate)', async () => {
    const stores = account(150);
    const { calls } = setup(stores);
    assert.equal(await vs.getUserVectorStoreId('ghost'), null);
    // Another process (or the V2 server) creates a store for this person.
    stores.push({ id: 'vs_elsewhere', name: 'user-member-late' });
    assert.equal(await vs.getUserVectorStoreId('member-late'), null, 'reads trust the window (at most ACCOUNT_LIST_TTL_MS stale)');
    const listed = calls.list.length;
    const r = await vs.syncUserReport('member-late', '# Report');
    assert.equal(r.storeId, 'vs_elsewhere', 'the write path lists again and reuses it');
    assert.equal(calls.list.length, listed + 2, 'one fresh listing (2 pages)');
    assert.deepEqual(calls.create, []);
    assert.equal(await vs.getUserVectorStoreId('member-late'), 'vs_elsewhere', 'and reads find it from then on');
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
