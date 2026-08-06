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
 * Query CleverTap Cloud API events endpoint. CleverTap's docs describe the
 * endpoint as taking a body with event_name + from/to (YYYYMMDD) + filters.
 * We do one call per event name and stitch the results because that's the
 * most reliable API shape.
 *
 * @param {{identifier: string, identifierType: 'userId' | 'objectId', fromTs: number, toTs: number}} opts
 * @returns {Promise<Array<{name, ts, props, source}>>}
 */
async function fetchCleverTapDelta({ identifier, identifierType, fromTs, toTs }) {
    if (!CT_ACCOUNT_ID || !CT_PASSCODE) {
        console.warn('[activity] CleverTap credentials missing, returning empty delta');
        return [];
    }
    if (!EVENT_NAMES.length) return [];

    // Convert ts (ms) to YYYYMMDD used by CleverTap event query API
    const dayStamp = (ms) => {
        const d = new Date(ms);
        return Number(
            `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
        );
    };
    const from = dayStamp(fromTs);
    const to = dayStamp(toTs);

    const collected = [];
    for (const eventName of EVENT_NAMES) {
        try {
            const events = await cleverTapEventQuery({
                identifier,
                identifierType,
                eventName,
                from,
                to
            });
            for (const e of events) collected.push(e);
        } catch (e) {
            console.warn('[activity] fetch failed for', eventName, ':', e?.message || e);
        }
    }
    return collected;
}

function cleverTapEventQuery({ identifier, identifierType, eventName, from, to }) {
    return new Promise((resolve, reject) => {
        const filter = { event_name: eventName, from, to };
        if (identifierType === 'objectId') {
            filter.objectId = identifier;
        } else {
            filter.common_profile_prop = { profile_fields_of_interest: [] };
            filter.identity = identifier;
        }

        const body = JSON.stringify(filter);
        const options = {
            hostname: `${CT_REGION}.api.clevertap.com`,
            port: 443,
            path: '/1/events.json?batch_size=500',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body, 'utf8'),
                'X-CleverTap-Account-Id': CT_ACCOUNT_ID,
                'X-CleverTap-Passcode': CT_PASSCODE
            }
        };

        const req = https.request(options, (res) => {
            let chunks = '';
            res.on('data', (c) => { chunks += c; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`CleverTap HTTP ${res.statusCode}: ${chunks.slice(0, 300)}`));
                }
                try {
                    const parsed = JSON.parse(chunks);
                    // Normalise: CleverTap returns { records: [...] } typically
                    const records = Array.isArray(parsed?.records) ? parsed.records : [];
                    const out = records.map((r) => ({
                        name: eventName,
                        ts: (r?.ts && Number(r.ts) * 1000) || (r?.epoch && Number(r.epoch) * 1000) || 0,
                        props: r?.event_props || r?.profile || r || {},
                        source: 'cleverTap'
                    })).filter((e) => e.ts > 0);
                    resolve(out);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(body, 'utf8');
        req.end();
    });
}

/**
 * Format a compact markdown timeline the vector store can index. Grouped
 * by day (newest first) for readable retrieval snippets.
 */
function formatTimelineMarkdown(events, meta) {
    const header = [
        '# User Activity Timeline',
        '',
        `Identifier: ${meta.identifierType}:${meta.identifier}`,
        `Events: ${events.length}`,
        `Last fetch: ${new Date(meta.lastFetchTs || Date.now()).toISOString()}`,
        `Window: last ${LOOKBACK_DAYS} days (rolling)`,
        '',
        '---',
        ''
    ];

    // Group by ISO date (UTC)
    const byDay = new Map();
    for (const e of events) {
        const d = new Date(e.ts);
        const key = d.toISOString().slice(0, 10);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(e);
    }

    const lines = [...header];
    const days = Array.from(byDay.keys()).sort().reverse();
    for (const day of days) {
        lines.push(`## ${day}`);
        lines.push('');
        for (const e of byDay.get(day).sort((a, b) => b.ts - a.ts)) {
            const time = new Date(e.ts).toISOString().slice(11, 16);
            let extras = '';
            try {
                const propsSnip = Object.entries(e.props || {})
                    .filter(([k]) => !k.startsWith('_'))
                    .slice(0, 4)
                    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`)
                    .join(', ');
                if (propsSnip) extras = ` — ${propsSnip}`;
            } catch (_) { /* ignore */ }
            lines.push(`- ${time} UTC · **${e.name}**${extras}`);
        }
        lines.push('');
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

        // Cursor: last known event, or lookback window if first time
        const fromTs = cache?.lastEventTs
            ? new Date(cache.lastEventTs).getTime()
            : now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

        const delta = await fetchCleverTapDelta({
            identifier,
            identifierType,
            fromTs,
            toTs: now
        });

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
