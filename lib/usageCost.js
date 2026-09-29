/*
 * Usage → cost. What each Erica session costs us at OpenAI, computed from the
 * usage the APIs report, never estimated from wall-clock alone.
 *
 * Two very different billing shapes feed this:
 *
 *   Realtime (gpt-realtime*): every response.done carries response.usage with
 *   tokens split by modality (text/audio/image) and by cached/uncached. Each
 *   response re-reads the conversation, so a session's cost is the SUM over
 *   its responses. Input transcription (whisper-1) is a separate meter that
 *   arrives on conversation.item.input_audio_transcription.completed — it is
 *   billed per minute of audio and is NOT inside response.usage.
 *
 *   GPT-Live (gpt-live-1): the voice layer is billed per second of session
 *   ($/min, prorated). session.usage.updated / session.closed report the
 *   CUMULATIVE seconds — latest wins, never sum. The delegated backend
 *   (Responses API, e.g. gpt-5.6-terra) bills its own tokens; they arrive
 *   nested in response.event → response.completed → response.usage, one per
 *   backend response, so those ARE summed.
 *
 * Prices are a dated table. A model that is not in the table is FLAGGED
 * (`unpriced`) and contributes $0 — visibly, in the Studio, never silently.
 * When OpenAI changes prices, bump PRICE_TABLE_DATE and the numbers together;
 * snapshots already on disk keep the cost they were priced at (sessionLog
 * stores `priced` on each usage line), so history does not rewrite itself.
 *
 * Pure module: no I/O, no env, so it is unit-testable and safe to require
 * from sessionLog (write side) and metrics/admin (read side).
 */

// Source: https://developers.openai.com/api/docs/pricing — read 2026-09-28.
// Realtime and GPT-Live rows quoted from the "Realtime and audio generation
// models" / "GPT-Live sessions" sections; backend models from "Standard".
const PRICE_TABLE_DATE = '2026-09-28';
const PRICE_SOURCE = 'https://developers.openai.com/api/docs/pricing';

// USD per 1M tokens. `*_cached` is the cached-input rate.
const REALTIME_FULL = {
    text_in: 4.00, text_cached: 0.40, text_out: 16.00,
    audio_in: 32.00, audio_cached: 0.40, audio_out: 64.00,
    image_in: 5.00, image_cached: 0.50,
};
const REALTIME_MINI = {
    text_in: 0.60, text_cached: 0.06, text_out: 2.40,
    audio_in: 10.00, audio_cached: 0.30, audio_out: 20.00,
    image_in: 0.80, image_cached: 0.08,
};

const TOKEN_PRICES = {
    'gpt-realtime': REALTIME_FULL,
    'gpt-realtime-1.5': REALTIME_FULL,
    // 2.1 keeps the audio price and charges a text-output premium.
    'gpt-realtime-2.1': { ...REALTIME_FULL, text_out: 24.00 },
    'gpt-realtime-mini': REALTIME_MINI,
    'gpt-realtime-2.1-mini': REALTIME_MINI,

    // Responses-API models GPT-Live can delegate to. Text tokens only;
    // reasoning tokens are billed as output tokens. `long` is the tier for
    // requests over `threshold` input tokens — the pricing page lists the
    // two tiers without stating the cutoff; 272K is from the model page
    // (developers.openai.com/api/docs/models/gpt-5.6-terra). Coaching turns
    // are nowhere near it; it is here so a runaway context is priced right,
    // not so it ever triggers.
    'gpt-5.6-terra': {
        text_in: 2.00, text_cached: 0.20, text_out: 12.00,
        long: { threshold: 272000, text_in: 4.00, text_cached: 0.40, text_out: 18.00 },
    },
    'gpt-5.5': {
        text_in: 5.00, text_cached: 0.50, text_out: 30.00,
        long: { threshold: 272000, text_in: 10.00, text_cached: 1.00, text_out: 45.00 },
    },
    'gpt-5.4': {
        text_in: 2.50, text_cached: 0.25, text_out: 15.00,
        long: { threshold: 272000, text_in: 5.00, text_cached: 0.50, text_out: 22.50 },
    },
    'gpt-5.1': { text_in: 1.25, text_cached: 0.125, text_out: 10.00 },
    'gpt-5': { text_in: 1.25, text_cached: 0.125, text_out: 10.00 },
    'gpt-4.1': { text_in: 2.00, text_cached: 0.50, text_out: 8.00 },
    'gpt-4.1-mini': { text_in: 0.40, text_cached: 0.10, text_out: 1.60 },
};

// USD per minute, prorated per second ("GPT-Live voice sessions are billed
// per second, without rounding up to a whole minute" — pricing page footnote).
const MINUTE_PRICES = {
    'gpt-live-1': 0.05,
    'whisper-1': 0.006,
};

const PER_MILLION = 1_000_000;

/**
 * Map what the API reports to a table key. Exact match first; then a dated
 * snapshot suffix (gpt-5.6-terra-2026-07-30) is stripped. Nothing looser:
 * "gpt-realtime-3" is a model we have never priced, not a variant of
 * gpt-realtime, and guessing would be a silent mis-price — the one thing
 * this module exists to avoid. Returns null when nothing fits; callers flag.
 */
function normalizeModel(name) {
    if (!name || typeof name !== 'string') return null;
    const n = name.trim().toLowerCase();
    if (TOKEN_PRICES[n] || MINUTE_PRICES[n] !== undefined) return n;
    const undated = n.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (TOKEN_PRICES[undated] || MINUTE_PRICES[undated] !== undefined) return undated;
    return null;
}

const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

function unpriced(reason, extra = {}) {
    return { usd: 0, parts: {}, unpriced: reason, table: PRICE_TABLE_DATE, ...extra };
}

/**
 * Realtime response.usage. Field names exactly as the API sends them:
 *   input_tokens, output_tokens,
 *   input_token_details { text_tokens, audio_tokens, image_tokens,
 *                         cached_tokens, cached_tokens_details { text_tokens, audio_tokens, image_tokens } }
 *   output_token_details { text_tokens, audio_tokens }
 */
function priceRealtimeUsage(model, usage) {
    const key = normalizeModel(model);
    const p = key && TOKEN_PRICES[key];
    if (!p || p.audio_in === undefined) return unpriced(`model not in price table: ${model || '(unknown)'}`);
    if (!usage || typeof usage !== 'object') return unpriced('response.done carried no usage object');

    const inD = usage.input_token_details || {};
    const cached = inD.cached_tokens_details || {};
    const outD = usage.output_token_details || {};
    let approx = false;

    let textIn = num(inD.text_tokens);
    let audioIn = num(inD.audio_tokens);
    let imageIn = num(inD.image_tokens);
    if (!usage.input_token_details) {
        // Older shape / defensive: no modality split. Price everything as
        // text and say so; still far better than a silent zero.
        textIn = num(usage.input_tokens);
        approx = true;
    }
    const cText = Math.min(textIn, num(cached.text_tokens));
    const cAudio = Math.min(audioIn, num(cached.audio_tokens));
    const cImage = Math.min(imageIn, num(cached.image_tokens));

    let textOut = num(outD.text_tokens);
    let audioOut = num(outD.audio_tokens);
    if (!usage.output_token_details) {
        textOut = num(usage.output_tokens);
        approx = true;
    }

    const parts = {
        text_in: (textIn - cText) * p.text_in / PER_MILLION,
        text_cached: cText * p.text_cached / PER_MILLION,
        audio_in: (audioIn - cAudio) * p.audio_in / PER_MILLION,
        audio_cached: cAudio * p.audio_cached / PER_MILLION,
        image_in: (imageIn - cImage) * p.image_in / PER_MILLION,
        image_cached: cImage * p.image_cached / PER_MILLION,
        text_out: textOut * p.text_out / PER_MILLION,
        audio_out: audioOut * p.audio_out / PER_MILLION,
    };
    const usd = Object.values(parts).reduce((a, b) => a + b, 0);
    return {
        usd: round6(usd),
        parts: mapRound(parts),
        unpriced: null,
        approx: approx || undefined,
        model: key,
        table: PRICE_TABLE_DATE,
        tokens: {
            input: num(usage.input_tokens) || textIn + audioIn + imageIn,
            output: num(usage.output_tokens) || textOut + audioOut,
            text_in: textIn, audio_in: audioIn, image_in: imageIn,
            cached_in: cText + cAudio + cImage,
            text_out: textOut, audio_out: audioOut,
        },
    };
}

/**
 * Responses API usage (GPT-Live's delegated backend), as nested in
 * response.event → response.completed → response.usage:
 *   input_tokens, input_tokens_details { cached_tokens },
 *   output_tokens, output_tokens_details { reasoning_tokens }
 * Reasoning tokens are part of output_tokens and billed at the output rate.
 */
function priceResponsesUsage(model, usage) {
    const key = normalizeModel(model);
    const base = key && TOKEN_PRICES[key];
    if (!base) return unpriced(`model not in price table: ${model || '(unknown)'}`);
    if (!usage || typeof usage !== 'object') return unpriced('response.completed carried no usage object');

    const inputTokens = num(usage.input_tokens);
    const cachedIn = Math.min(inputTokens, num(usage.input_tokens_details && usage.input_tokens_details.cached_tokens));
    const outputTokens = num(usage.output_tokens);
    const reasoning = num(usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens);
    const tier = base.long && inputTokens > base.long.threshold ? base.long : base;

    const parts = {
        text_in: (inputTokens - cachedIn) * tier.text_in / PER_MILLION,
        text_cached: cachedIn * tier.text_cached / PER_MILLION,
        text_out: outputTokens * tier.text_out / PER_MILLION,
    };
    const usd = parts.text_in + parts.text_cached + parts.text_out;
    return {
        usd: round6(usd),
        parts: mapRound(parts),
        unpriced: null,
        model: key,
        longContext: tier !== base || undefined,
        table: PRICE_TABLE_DATE,
        tokens: { input: inputTokens, cached_in: cachedIn, output: outputTokens, reasoning },
    };
}

/** Per-second prorated minute billing: GPT-Live voice layer, whisper-1. */
function priceSeconds(model, seconds) {
    const key = normalizeModel(model);
    const rate = key ? MINUTE_PRICES[key] : undefined;
    if (rate === undefined) return unpriced(`model not in price table: ${model || '(unknown)'}`);
    const s = num(seconds);
    return { usd: round6(s / 60 * rate), parts: { minutes: round6(s / 60 * rate) }, unpriced: null, model: key, table: PRICE_TABLE_DATE, seconds: s };
}

/**
 * Realtime input transcription usage (conversation.item.input_audio_transcription.completed).
 * The API sends one of two shapes:
 *   { type: 'duration', seconds }                       — whisper-1 & friends
 *   { type: 'tokens', input_tokens, output_tokens, ... } — token-billed transcribers
 */
function priceTranscriptionUsage(model, usage) {
    if (!usage || typeof usage !== 'object') return unpriced('transcription.completed carried no usage object');
    if (usage.type === 'duration' || (usage.seconds !== undefined && usage.input_tokens === undefined)) {
        return priceSeconds(model, usage.seconds);
    }
    return priceResponsesUsage(model, usage);
}

/**
 * Price one client snapshot as posted to /api/session-log (kind: 'usage').
 * `source` says which API event produced it and therefore which shape
 * `usage` has. Returns the `priced` object sessionLog stores on the line.
 */
function priceSnapshot(snapshot) {
    const s = snapshot || {};
    switch (s.source) {
        case 'response.done':
            return priceRealtimeUsage(s.model, s.usage);
        case 'input_audio_transcription.completed':
            return priceTranscriptionUsage(s.model || 'whisper-1', s.usage);
        case 'session.usage.updated':
        case 'session.closed':
        case 'disconnect': {
            const seconds = s.usage && typeof s.usage.seconds === 'number' ? s.usage.seconds : null;
            if (seconds === null) {
                // Connection-end marker (Realtime, or Live with nothing left
                // to flush): carries the connection's minutes, costs nothing,
                // and must not read as "unpriced".
                return { usd: 0, parts: {}, unpriced: null, marker: true, table: PRICE_TABLE_DATE };
            }
            // Cumulative voice seconds: the aggregate keeps the latest per
            // connection instead of summing these. Only gpt-live-1 bills this
            // way; anything else here is a client bug worth flagging.
            const key = normalizeModel(s.model);
            const model = key && MINUTE_PRICES[key] !== undefined ? key : (s.model || 'gpt-live-1');
            return { ...priceSeconds(model, seconds), cumulative: true };
        }
        case 'response.completed':
            return priceResponsesUsage(s.model || s.backendModel, s.usage);
        default:
            return unpriced(`unknown usage source: ${s.source || '(none)'}`);
    }
}

function mapRound(parts) {
    const out = {};
    for (const [k, v] of Object.entries(parts)) if (v) out[k] = round6(v);
    return out;
}

/**
 * Roll a session's usage lines (type === 'usage') into one cost summary.
 *
 *   - Realtime responses and Live backend responses: deduped by responseId
 *     (a replayed snapshot must not double-bill), then summed.
 *   - Transcription: deduped by itemId, summed.
 *   - Live voice seconds: cumulative per connection — latest wins within a
 *     connectionId, summed across reconnects (a new Live session restarts
 *     its counter at 0).
 *   - Minutes: the client's wall-clock `sessionMinutes` per connection
 *     (latest wins), summed across connections; falls back to the span of
 *     usage timestamps when a client never sent it.
 *
 * Lines without `priced` (never expected — sessionLog prices on write) are
 * re-priced here so an old or hand-edited file still gets a number.
 */
function summarizeSession(entries) {
    const usageLines = (entries || []).filter((e) => e && e.type === 'usage');
    const empty = {
        usd: 0, minutes: 0, usdPerMinute: null, snapshots: 0,
        voiceMode: null, models: [], unpriced: [], liveSeconds: 0,
        parts: { realtime: 0, transcription: 0, voice: 0, backend: 0 },
        tokens: { input: 0, output: 0, cached_in: 0, audio_in: 0, audio_out: 0, text_in: 0, text_out: 0, reasoning: 0 },
        firstAt: null, lastAt: null, priceTable: PRICE_TABLE_DATE,
    };
    if (!usageLines.length) return empty;

    const realtime = new Map();     // responseId -> line
    const transcription = new Map(); // itemId -> line
    const backend = new Map();       // responseId -> line
    const liveSeconds = new Map();   // connectionId -> seconds (latest wins)
    const minutes = new Map();       // connectionId -> minutes (latest wins)
    const models = new Set();
    const modes = new Set();
    const unpricedSet = new Set();
    let firstAt = null; let lastAt = null;
    // Dated snapshots (gpt-5.6-terra-2026-07-30) read as the model they are;
    // a name we cannot place stays verbatim so the flag names it exactly.
    const modelLabel = (name) => normalizeModel(name) || name;

    for (const line of usageLines) {
        const priced = line.priced && typeof line.priced === 'object' ? line.priced : priceSnapshot(line);
        const conn = line.connectionId || 'conn-0';
        if (line.t) {
            if (!firstAt || line.t < firstAt) firstAt = line.t;
            if (!lastAt || line.t > lastAt) lastAt = line.t;
        }
        if (line.voiceMode) modes.add(line.voiceMode);
        if (line.model) models.add(modelLabel(line.model));
        if (line.backendModel) models.add(modelLabel(line.backendModel));
        if (priced.unpriced) unpricedSet.add(priced.unpriced);
        if (typeof line.sessionMinutes === 'number' && isFinite(line.sessionMinutes)) {
            minutes.set(conn, Math.max(minutes.get(conn) || 0, line.sessionMinutes));
        }
        const withPrice = { ...line, priced };
        switch (line.source) {
            case 'response.done':
                realtime.set(line.responseId || `anon-${realtime.size}`, withPrice);
                break;
            case 'input_audio_transcription.completed':
                transcription.set(line.itemId || `anon-${transcription.size}`, withPrice);
                break;
            case 'response.completed':
                backend.set(line.responseId || `anon-${backend.size}`, withPrice);
                break;
            case 'session.usage.updated':
            case 'session.closed':
            case 'disconnect': {
                const secs = num(line.usage && line.usage.seconds);
                liveSeconds.set(conn, Math.max(liveSeconds.get(conn) || 0, secs));
                break;
            }
            default:
                break;
        }
    }

    const sumUsd = (map) => [...map.values()].reduce((a, l) => a + (l.priced.usd || 0), 0);
    const tokens = { ...empty.tokens };
    for (const l of realtime.values()) {
        const t = l.priced.tokens || {};
        tokens.input += t.input || 0; tokens.output += t.output || 0; tokens.cached_in += t.cached_in || 0;
        tokens.audio_in += t.audio_in || 0; tokens.audio_out += t.audio_out || 0;
        tokens.text_in += t.text_in || 0; tokens.text_out += t.text_out || 0;
    }
    for (const l of backend.values()) {
        const t = l.priced.tokens || {};
        tokens.input += t.input || 0; tokens.output += t.output || 0; tokens.cached_in += t.cached_in || 0;
        tokens.text_in += (t.input || 0) - (t.cached_in || 0); tokens.text_out += t.output || 0;
        tokens.reasoning += t.reasoning || 0;
    }

    // Voice seconds are cumulative — re-price the final per-connection value
    // rather than trusting whichever snapshot happened to be last on disk.
    let voiceUsd = 0; let totalLiveSeconds = 0;
    for (const secs of liveSeconds.values()) {
        totalLiveSeconds += secs;
        const p = priceSeconds('gpt-live-1', secs);
        voiceUsd += p.usd;
    }

    const parts = {
        realtime: round6(sumUsd(realtime)),
        transcription: round6(sumUsd(transcription)),
        voice: round6(voiceUsd),
        backend: round6(sumUsd(backend)),
    };
    const usd = round6(parts.realtime + parts.transcription + parts.voice + parts.backend);

    let totalMinutes = [...minutes.values()].reduce((a, b) => a + b, 0);
    if (!totalMinutes && firstAt && lastAt) {
        totalMinutes = Math.max(0, (new Date(lastAt).getTime() - new Date(firstAt).getTime()) / 60000);
    }
    // A Live session that only reported seconds still has a duration.
    if (!totalMinutes && totalLiveSeconds) totalMinutes = totalLiveSeconds / 60;
    totalMinutes = Math.round(totalMinutes * 100) / 100;

    return {
        usd,
        minutes: totalMinutes,
        usdPerMinute: totalMinutes > 0 ? round6(usd / totalMinutes) : null,
        snapshots: usageLines.length,
        // A session that reconnected across modes reads "realtime+live".
        voiceMode: modes.size ? [...modes].join('+') : null,
        models: [...models],
        unpriced: [...unpricedSet],
        liveSeconds: totalLiveSeconds,
        parts,
        tokens,
        firstAt,
        lastAt,
        priceTable: PRICE_TABLE_DATE,
    };
}

/** Money for humans: "$0.0421" under a dollar, "$1.27" above. */
function fmtUsd(v) {
    const n = Number(v) || 0;
    if (n === 0) return '$0.00';
    if (n < 0.01) return '$' + n.toFixed(4);
    if (n < 1) return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
}

const CSV_HEADER = [
    'sessionId', 'startedAt', 'lastAt', 'actor', 'tester', 'voiceMode', 'models',
    'minutes', 'usd', 'usdPerMinute', 'usd_realtime', 'usd_transcription', 'usd_live_voice', 'usd_backend',
    'liveSeconds', 'tokens_input', 'tokens_cached_input', 'tokens_output', 'tokens_audio_in', 'tokens_audio_out',
    'tokens_reasoning', 'snapshots', 'unpriced', 'priceTable',
];

function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** One CSV line per session row ({ sessionId, startedAt, lastAt, actor, cost }). */
function toCsv(rows) {
    const lines = [CSV_HEADER.join(',')];
    for (const r of rows || []) {
        const c = r.cost || summarizeSession([]);
        const actor = (r.actor && (r.actor.email || r.actor.userId || r.actor.objectId)) || 'guest';
        lines.push([
            r.sessionId, r.startedAt || '', r.lastAt || '', actor, r.actor && r.actor.tester ? 'yes' : 'no',
            c.voiceMode || '', (c.models || []).join(' '),
            c.minutes, c.usd, c.usdPerMinute === null ? '' : c.usdPerMinute,
            c.parts.realtime, c.parts.transcription, c.parts.voice, c.parts.backend,
            c.liveSeconds, c.tokens.input, c.tokens.cached_in, c.tokens.output, c.tokens.audio_in, c.tokens.audio_out,
            c.tokens.reasoning, c.snapshots, (c.unpriced || []).join(' | '), c.priceTable,
        ].map(csvEscape).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

module.exports = {
    PRICE_TABLE_DATE,
    PRICE_SOURCE,
    TOKEN_PRICES,
    MINUTE_PRICES,
    normalizeModel,
    priceRealtimeUsage,
    priceResponsesUsage,
    priceSeconds,
    priceTranscriptionUsage,
    priceSnapshot,
    summarizeSession,
    fmtUsd,
    toCsv,
    CSV_HEADER,
};
