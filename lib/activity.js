/**
 * Activity history module (Fase C.2)
 *
 * Fetches user activity events from CleverTap and keeps a per-user JSON cache
 * on the Railway persistent volume so subsequent sessions only fetch the delta
 * since the last known event. Handles both signed-in users (identity=userId)
 * and guest users (objectId = anonymous CleverTap ID from browser SDK, bridged
 * from the parent page).
 *
 * The cache doubles as the source of truth for what gets indexed into the
 * user's vector store as `activity-timeline.md` — retrieval then surfaces
 * relevant events through the existing search_knowledge tool.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.ACTIVITY_DATA_DIR || '/data/activity';
const CT_ACCOUNT_ID = process.env.CLEVERTAP_ACCOUNT_ID || '';
const CT_PASSCODE = process.env.CLEVERTAP_PASSCODE || '';
const CT_REGION = process.env.CLEVERTAP_REGION || 'us1';
const LOOKBACK_DAYS = Number(process.env.ACTIVITY_LOOKBACK_DAYS) || 30;
const EVENT_NAMES = (process.env.ACTIVITY_EVENT_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const MAX_EVENTS_PER_USER = Number(process.env.ACTIVITY_MAX_EVENTS) || 500;

// Serialise concurrent fetches for the same key so a first-visit stampede
// doesn't hammer CleverTap or duplicate writes to the volume.
const inFlight = new Map(); // key -> Promise

function ensureDataDir() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    } catch (e) {
        console.warn('[activity] could not ensure data dir:', DATA_DIR, e?.message || e);
    }
}

function sanitize(key) {
    return String(key || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}

function fileFor(identifierType, identifier) {
    const prefix = identifierType === 'userId' ? 'user' : 'ctid';
    return path.join(DATA_DIR, `${prefix}-${sanitize(identifier)}.json`);
}

function readCache(identifierType, identifier) {
    const p = fileFor(identifierType, identifier);
    try {
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) return null;
        return parsed;
    } catch (e) {
        console.warn('[activity] cache read failed:', p, e?.message || e);
        return null;
    }
}

function writeCache(identifierType, identifier, data) {
    ensureDataDir();
    const p = fileFor(identifierType, identifier);
    try {
        // Atomic-ish write: temp file then rename to avoid half-written JSON
        // on crash mid-write.
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, p);
        return true;
    } catch (e) {
        console.warn('[activity] cache write failed:', p, e?.message || e);
        return false;
    }
}

/**
 * Merge new events into an existing timeline, de-dupe by (name, ts, session)
 * and cap length so a chatty user doesn't blow the cache file open forever.
 */
function mergeAndTrim(existingEvents, newEvents) {
    const seen = new Set();
    const keyOf = (e) => `${e?.name || ''}|${e?.ts || 0}|${e?.session || ''}`;
    const combined = [];
    for (const e of [...(existingEvents || []), ...(newEvents || [])]) {
        if (!e || typeof e !== 'object') continue;
        const k = keyOf(e);
        if (seen.has(k)) continue;
        seen.add(k);
        combined.push(e);
    }
    combined.sort((a, b) => (b.ts || 0) - (a.ts || 0)); // newest first
    return combined.slice(0, MAX_EVENTS_PER_USER);
}

/**
 * Query CleverTap's profile endpoint — returns the user's full profile
 * including an `events` object with per-event {count, first_seen, last_seen}
 * aggregates. This is the shape we actually want for coaching context:
 * "how many times has the user done X, how recently, how long ago did they
 * start" — not raw event instances (which cost N calls).
 *
 * NOTE: originally used /1/events.json with per-event-name loops, which
 * returned 0 records because the filter shape was wrong. profile.json is
 * the right endpoint for "what has THIS user done."
 *
 * @param {{identifier: string, identifierType: 'userId' | 'objectId'}} opts
 * @returns {Promise<Array<{name, ts, count, firstSeenTs, props, source}>>}
 */
async function fetchCleverTapDelta({ identifier, identifierType }) {
    if (!CT_ACCOUNT_ID || !CT_PASSCODE) {
        console.warn('[activity] CleverTap credentials missing, returning empty delta');
        return [];
    }

    let profile;
    try {
        profile = await cleverTapProfileQuery({ identifier, identifierType });
    } catch (e) {
        console.warn('[activity] profile fetch failed:', e?.message || e);
        return [];
    }
    if (!profile || !profile.events) return [];

    // Build our internal event shape. `ts` is the last_seen (most recent
    // occurrence). Include count + first_seen so the coach can reason about
    // frequency and recency.
    const eventNameFilter = new Set(EVENT_NAMES); // empty set means "all"
    const passes = eventNameFilter.size === 0
        ? () => true
        : (name) => eventNameFilter.has(name);

    const out = [];
    for (const [name, agg] of Object.entries(profile.events)) {
        if (!passes(name)) continue;
        if (!agg || typeof agg !== 'object') continue;
        out.push({
            name,
            ts: (Number(agg.last_seen) || 0) * 1000,
            firstSeenTs: (Number(agg.first_seen) || 0) * 1000,
            count: Number(agg.count) || 0,
            props: {},
            source: 'cleverTap'
        });
    }
    return out.filter((e) => e.ts > 0);
}

function cleverTapProfileQuery({ identifier, identifierType }) {
    return new Promise((resolve, reject) => {
        const qs = identifierType === 'objectId'
            ? `objectId=${encodeURIComponent(identifier)}`
            : `identity=${encodeURIComponent(identifier)}`;
        const options = {
            hostname: `${CT_REGION}.api.clevertap.com`,
            port: 443,
            path: `/1/profile.json?${qs}`,
            method: 'GET',
            headers: {
                'X-CleverTap-Account-Id': CT_ACCOUNT_ID,
                'X-CleverTap-Passcode': CT_PASSCODE
            }
        };
        const req = https.request(options, (res) => {
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    // 404 = no profile for this identity/objectId (fine for guests)
                    if (res.statusCode === 404) return resolve(null);
                    return reject(new Error(`CleverTap HTTP ${res.statusCode}: ${chunks.slice(0, 300)}`));
                }
                try {
                    const parsed = JSON.parse(chunks);
                    resolve(parsed?.record || null);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Format a compact markdown timeline the vector store can index. Uses the
 * aggregate shape from CleverTap profile.json (count + first_seen +
 * last_seen per event name). Sorted by recency of last occurrence.
 */
function formatTimelineMarkdown(events, meta) {
    const header = [
        '# User Activity Summary',
        '',
        `Identifier: ${meta.identifierType}:${meta.identifier}`,
        `Distinct events: ${events.length}`,
        `Last fetch: ${new Date(meta.lastFetchTs || Date.now()).toISOString()}`,
        '',
        'For each event, `count` is how many times the user did it, `first` is when they first did it, `last` is the most recent occurrence. Use this to reason about the user\'s engagement pattern with the platform.',
        '',
        '---',
        ''
    ];

    // Sort by most recent activity first.
    const sorted = [...events].sort((a, b) => (b.ts || 0) - (a.ts || 0));

    const lines = [...header];
    const now = Date.now();
    for (const e of sorted) {
        const lastIso = new Date(e.ts).toISOString().slice(0, 10);
        const firstIso = e.firstSeenTs ? new Date(e.firstSeenTs).toISOString().slice(0, 10) : lastIso;
        const daysAgo = Math.max(0, Math.floor((now - (e.ts || now)) / (24 * 60 * 60 * 1000)));
        const recencyLabel = daysAgo === 0 ? 'today'
            : daysAgo === 1 ? '1 day ago'
            : daysAgo < 30 ? `${daysAgo} days ago`
            : `${Math.floor(daysAgo / 30)} months ago`;
        lines.push(`- **${e.name}** — count: ${e.count}, first: ${firstIso}, last: ${lastIso} (${recencyLabel})`);
    }
    return lines.join('\n');
}

/**
 * Main entry. Returns { events, cached, delta, meta, markdown }.
 * Serialises concurrent requests for the same identifier via inFlight map.
 */
async function getActivityHistory({ identifier, identifierType }) {
    if (!identifier) return { events: [], cached: 0, delta: 0, meta: null, markdown: '' };
    if (!identifierType) identifierType = 'userId';

    const key = `${identifierType}:${identifier}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
        const now = Date.now();
        const cache = readCache(identifierType, identifier);
        const existingEvents = cache?.events || [];

        // profile.json returns aggregate per-event stats (count + last_seen)
        // rather than raw event instances, so incremental cursor becomes an
        // optimisation for skipping a refresh when the profile is stale. For
        // now we always fetch on session start — one HTTP call, cheap.
        const delta = await fetchCleverTapDelta({ identifier, identifierType });

        const merged = mergeAndTrim(existingEvents, delta);
        const lastEventTs = merged[0]?.ts
            ? new Date(merged[0].ts).toISOString()
            : (cache?.lastEventTs || null);

        const data = {
            identifier,
            identifierType,
            lastFetchTs: new Date(now).toISOString(),
            lastEventTs,
            eventsCount: merged.length,
            events: merged
        };
        writeCache(identifierType, identifier, data);

        return {
            events: merged,
            cached: existingEvents.length,
            delta: delta.length,
            meta: {
                identifier,
                identifierType,
                lastFetchTs: data.lastFetchTs,
                lastEventTs: data.lastEventTs
            },
            markdown: formatTimelineMarkdown(merged, data)
        };
    })();

    inFlight.set(key, promise);
    try {
        return await promise;
    } finally {
        inFlight.delete(key);
    }
}

module.exports = {
    getActivityHistory,
    // exported for tests / diagnostics
    _internal: {
        readCache,
        writeCache,
        mergeAndTrim,
        formatTimelineMarkdown,
        fetchCleverTapDelta
    }
};
