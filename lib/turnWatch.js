/* The open user turn: what the coach's reply slot shows while it waits, and
 * what a dead model session means for it (Varsha, 2026-10-14).
 *
 * A turn opens when the person sends (or a send is queued while no session is
 * open) and collects every message sent until all of them are answered. A
 * reply answers only the messages the model already had when that reply
 * began: a message sent while an older reply streams, or held behind a tool
 * until after it, keeps waiting for its own answer. While any message waits,
 * the slot shows typing dots, '{Coach} is thinking...' at 4 s, 'Still working
 * on it...' at 15 s, or what a running tool is doing. Timers only change that
 * label: a slow but healthy turn is never torn down. The one exception is the
 * cap: 60 s after the latest send with nothing visible, the turn fails and
 * the caller closes the connection, so no indicator can spin forever.
 *
 * Only hard transport signals (session.closed, data channel closed, peer
 * connection disconnected/failed, a connect that never came up) touch the
 * session. With a message waiting they give one fresh session that re-sends
 * every unanswered message once; a second one is failed with 'Try again'.
 * Without one, a chat goes to standby (nothing reconnects until the next
 * send) and a call reconnects as before. A live cut (#40) fails the turn and
 * never recovers. A reply that had started is cut off, never re-sent on its
 * own.
 *
 * Also here, pure so the tests can read them: the GPT-Live history plan
 * (what session.input carries and what the backend gets as items) and the
 * static safety card.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.turnWatch = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const LIMITS = {
        thinkingMs: 4000,     // '{Coach} is thinking...'
        stillMs: 15000,       // 'Still working on it...'
        capMs: 60000,         // nothing visible this long after the latest send: failed
        toolMs: 20000,        // a client tool's fetch
        deepThinkMs: 30000,
        connectMs: 12000,     // /api/proxy/live, and the server's create
        resendDelayMs: 500,   // after session.started, as the queued-message flush
        maxRecoveries: 1,     // automatic fresh sessions per turn: at most 2 connects
        // A call reconnects on its own after a drop, at most this many times
        // in this window; one more drop ends it to standby (each Live session
        // bills >= 15 s, and a close that repeats at creation looped forever).
        callReconnects: 3,
        callReconnectWindowMs: 120000,
        // The wait before each of those attempts: a few seconds offline (a
        // Wi-Fi to cellular handoff fails every create at once) must not use
        // up the cap before the network is back.
        callReconnectDelaysMs: [1500, 5000, 15000],
    };

    const TOOL_LABELS = {
        get_page_context: 'Reading this page...',
        search_knowledge: 'Looking through our resources...',
        search_web: 'Searching the web...',
        deep_think: 'Thinking it through...',
        get_helpful_resources: 'Finding resources for you...',
        render_chart: 'Building a chart...',
        render_table: 'Building a table...',
        refresh_context: 'Catching up on your latest results...',
    };
    const RECONNECTING = 'Connection dropped. Reconnecting...';
    const STILL = 'Still working on it...';

    function createTurnWatch({
        now = () => Date.now(),
        setTimer = (fn, ms) => setTimeout(fn, ms),
        clearTimer = (id) => clearTimeout(id),
        coachName = () => 'Erica',
        onChange = () => {},
        onFail = () => {},
        onEvent = () => {},
        limits = {},
    } = {}) {
        const L = { ...LIMITS, ...limits };
        // { since, phase: 'open' | 'recovering' | 'failed', recoveries,
        //   tools: Map(key -> name), retried, recoveredAt, reported, cause,
        //   partial, lastOutputAt,
        //   entries: [{ id, message, session, queued, wireAt, reply, answered }] }
        // An entry is waiting (no reply has started on it), streaming (reply:
        // the key of a reply that began after it reached the model) or
        // answered. wireAt is when it reached the model: null while queued
        // (no session) or held behind a tool.
        let turn = null;
        let last = 'idle';
        let timer = null;
        // When each reply began (its key: the bot message id), across turns:
        // a reply that began before a message never answers it.
        const replies = new Map();
        let anon = 0;

        const turnId = () => (turn && turn.entries.length ? turn.entries[0].id : (turn ? 'queued-' + turn.since : null));
        const unanswered = () => turn.entries.filter((e) => !e.answered);
        const waiting = () => !!turn && turn.phase !== 'failed'
            && (turn.phase === 'recovering' || !turn.entries.length || turn.entries.some((e) => !e.answered && !e.reply));
        const streaming = () => !!turn && turn.phase === 'open' && !waiting() && turn.entries.some((e) => !e.answered && e.reply);

        function stage() {
            if (!turn) return last;
            if (turn.phase !== 'open') return turn.phase;
            return waiting() ? 'waiting' : 'streaming';
        }

        function view() {
            if (!turn) return { state: last, dots: false, label: null, failed: null };
            if (turn.phase === 'failed') return { state: 'failed', dots: false, label: null, failed: { partial: turn.partial, cause: turn.cause } };
            const state = stage();
            if (!waiting() || now() - turn.since >= L.capMs) return { state, dots: false, label: null, failed: null };
            let label = null;
            const elapsed = now() - turn.since;
            if (turn.phase === 'recovering') label = RECONNECTING;
            else if (turn.tools.size) label = TOOL_LABELS[[...turn.tools.values()].pop()] || STILL;
            else if (elapsed >= L.stillMs) label = STILL;
            else if (elapsed >= L.thinkingMs) label = `${coachName() || 'Your coach'} is thinking...`;
            return { state, dots: true, label, failed: null };
        }

        function changed() {
            schedule();
            try { onChange(view()); } catch (_) { /* the UI must not break the tracker */ }
        }

        // One timer to the next moment the label (or the cap) changes.
        function schedule() {
            if (timer !== null) { clearTimer(timer); timer = null; }
            if (!turn) return;
            let deadline = null;
            if (waiting()) {
                const t = now();
                deadline = [turn.since + L.thinkingMs, turn.since + L.stillMs, turn.since + L.capMs].find((d) => d > t);
                if (deadline === undefined) deadline = t;
            } else if (streaming()) {
                // A reply that stops streaming without finishing settles quietly.
                deadline = turn.lastOutputAt + L.capMs;
            }
            if (deadline === null) return;
            timer = setTimer(tick, Math.max(0, deadline - now()));
        }

        function tick() {
            timer = null;
            if (!turn) return;
            if (waiting() && now() - turn.since >= L.capMs) { fail('cap'); return; }
            if (streaming() && now() - turn.lastOutputAt >= L.capMs) { finish(); return; }
            changed();
        }

        function open() {
            if (!turn || turn.phase === 'failed') {
                turn = { since: now(), entries: [], phase: 'open', recoveries: 0, tools: new Map(), retried: false, recoveredAt: null, reported: false, cause: null, partial: false, lastOutputAt: null };
            } else if (!waiting()) {
                // Everything before was answered or is streaming: this message
                // gets its own recovery.
                turn.recoveries = 0;
                turn.retried = false;
                turn.recoveredAt = null;
            }
            turn.since = now();
        }

        function entry(id) {
            let e = id ? turn.entries.find((x) => x.id === id) : null;
            if (!e) {
                e = { id };
                turn.entries.push(e);
            }
            return e;
        }

        // A send that waits for a session (its bubble shows already): not
        // history (openIds) and not re-sent by sessionStarted, since the
        // queue sends it.
        function queue({ id = null } = {}) {
            open();
            if (id) Object.assign(entry(id), { message: null, session: null, queued: true, wireAt: null, reply: null, answered: false });
            changed();
        }

        // A message went to the model (or is held behind a tool: held, it
        // reaches the model with delivered()).
        function send({ id, message, session, held = false }) {
            open();
            Object.assign(entry(id), { message, session, queued: false, wireAt: held ? null : now(), reply: null, answered: false });
            changed();
        }

        // Held messages reached the model: their 60 s start now.
        function delivered(messages = []) {
            if (!turn || turn.phase === 'failed') return 0;
            const list = Array.isArray(messages) ? messages : [];
            let n = 0;
            turn.entries.forEach((e) => {
                if (!e.answered && !e.queued && e.wireAt === null && list.includes(e.message)) { e.wireAt = now(); n++; }
            });
            if (n) { turn.since = now(); changed(); }
            return n;
        }

        function toolStart(key, name) {
            if (!turn || turn.phase === 'failed') return false;
            turn.tools.set(key, name);
            changed();
            return true;
        }

        function toolEnd(key) {
            if (!turn || !turn.tools.delete(key)) return;
            changed();
        }

        function finish() {
            last = 'done';
            turn = null;
            changed();
        }

        // Coach output. key: the reply (bot message id); startedAt: when the
        // backend began it (its response.created), else when it first showed.
        // It answers the messages that had reached the model by then; a reply
        // that began before them leaves them waiting.
        function output({ key = null, startedAt = null, final = false } = {}) {
            const k = key || 'anon-' + (++anon);
            if (!replies.has(k)) {
                replies.set(k, Math.min(now(), Number.isFinite(startedAt) ? startedAt : now()));
                if (replies.size > 200) replies.delete(replies.keys().next().value);
            }
            if (!turn || turn.phase === 'failed') return;
            const began = replies.get(k);
            const covered = turn.entries.filter((e) => !e.answered && e.wireAt !== null && e.wireAt <= began);
            if (!covered.length) return;
            covered.forEach((e) => { if (!e.reply) e.reply = k; });
            if (turn.recoveredAt !== null && !turn.reported) {
                turn.reported = true;
                onEvent('turn_recovered', { turnId: turnId(), step: turn.retried ? 'user_retry' : 'fresh_session', msToReply: now() - turn.recoveredAt });
            }
            turn.lastOutputAt = now();
            if (final) covered.forEach((e) => { e.answered = true; });
            if (!unanswered().length) finish();
            else changed();
        }

        function fail(cause) {
            if (!turn || turn.phase === 'failed') return null;
            const partial = streaming();
            turn.phase = 'failed';
            turn.cause = cause;
            turn.partial = partial;
            turn.tools.clear();
            const record = { turnId: turnId(), cause, partial, attempts: turn.recoveries };
            onEvent('turn_failed', { turnId: record.turnId, cause, attempts: record.attempts, partial });
            changed();
            try { onFail(record); } catch (_) { /* rendering is the caller's */ }
            return record;
        }

        // A session ended. What happens to the open turn, if any.
        function hardSignal({ cause, inCall = false, cut = false }) {
            if (!turn || turn.phase === 'failed') return { action: inCall ? 'resume-call' : 'standby', turnId: null };
            const id = turnId();
            onEvent('turn_stalled', { turnId: id, cause, stage: stage(), msSinceSend: now() - turn.since, attempt: turn.recoveries + 1 });
            if (cut) { fail('cut'); return { action: 'fail', turnId: id }; }
            if (!waiting() || turn.recoveries >= L.maxRecoveries) { fail(cause); return { action: 'fail', turnId: id }; }
            // A reply that had started is cut off: history now, never re-sent.
            turn.entries.forEach((e) => { if (!e.answered && e.reply) e.answered = true; });
            turn.recoveries++;
            turn.phase = 'recovering';
            turn.tools.clear();
            changed();
            return { action: 'recover', turnId: id };
        }

        // A model session is up: the unanswered messages it has not seen go
        // out again, once, in order (a queued one goes with the queue).
        function sessionStarted(session) {
            if (!turn || turn.phase === 'failed') return [];
            const resend = turn.entries.filter((e) => !e.answered && !e.queued && e.message && e.session !== session);
            resend.forEach((e) => { e.session = session; e.wireAt = now(); e.reply = null; });
            if (turn.phase === 'recovering') {
                turn.phase = 'open';
                turn.recoveredAt = now();
                turn.reported = false;
                changed();
            }
            return resend.map((e) => ({ id: e.id, message: e.message }));
        }

        function connectFailed(cause = 'connect_failed') { return fail(cause); }

        // 'Try again': one more run, as the person's action (a fresh 60 s; if
        // its session dies too, failed again, with no automatic session).
        function retry() {
            if (!turn || turn.phase !== 'failed') return false;
            turn.phase = 'recovering';
            turn.since = now();
            turn.recoveries = L.maxRecoveries;
            turn.retried = true;
            turn.cause = null;
            turn.partial = false;
            // Whichever session comes next (or the one still open, in a call)
            // gets them again.
            turn.entries.forEach((e) => { if (!e.answered) { e.session = null; e.reply = null; } });
            changed();
            return true;
        }

        function reset() {
            turn = null;
            last = 'idle';
            changed();
        }

        return {
            queue, send, delivered, toolStart, toolEnd, output, fail, hardSignal, sessionStarted, connectFailed, retry, reset, view,
            isOpen: () => waiting(),
            // Not history yet: sent and unanswered, or queued (re-sent or
            // flushed after the history).
            openIds: () => (turn && turn.phase !== 'failed' ? unanswered().map((e) => e.id) : []),
            turnId,
        };
    }

    // A message's identity across reloads and id schemes (server history has
    // none, or random ones): a short hash of role and text. No text in it.
    function messageKey(m) {
        const role = m && (m.role === 'user' ? 'user' : 'assistant');
        const text = String((m && (m.text ?? m.content)) || '').trim();
        let h = 0x811c9dc5;
        const s = role + '\n' + text;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return 'k' + h.toString(16).padStart(8, '0');
    }

    // GPT-Live closes a session at creation ('content') when user-role crisis
    // text is in its session.input; the same text reaches the backend as
    // items without that (staging probe, 2026-10-28). So a chat session's
    // voice layer gets the coach's messages only, and anything a content
    // close blocked stays out of every later session.input, a call's too.
    // Whenever session.input lacks part of the window, the backend gets the
    // whole window, in order, as items right after session.started.
    function liveHistoryPlan(turns, { callMode = false, blocked = [] } = {}) {
        const list = Array.isArray(turns) ? turns : [];
        const block = new Set(blocked);
        const input = list.filter((t) => !block.has(messageKey(t)) && (callMode || t.role === 'assistant'));
        return { input, backend: input.length < list.length ? list.slice() : [] };
    }

    // The site's own crisis guidance (Wix preparation, 'Mental Health and
    // Emergency Guidance'): a licensed professional, local emergency services
    // and the TT article; no phone numbers. Shown by the client with no model
    // and no network. Copy to be refined by Eric.
    const SAFETY_CARD = {
        title: 'Support is available',
        paragraphs: [
            "If you're going through something difficult right now, you're not alone, and your well-being matters. Please consider speaking with a licensed mental health professional. If you're thinking about harming yourself or you're in immediate danger, contact your local emergency services now.",
            "Here's a resource with steps and helplines that might help:",
        ],
        linkLabel: 'Finding Mental Health Support',
        linkUrl: 'https://www.talenttransformation.com/post/finding-mental-health-support',
        // The My Talents app: its preamble says no URLs, and a link tap in its
        // webview is undefined (dead, or it replaces the coach).
        appPointer: 'Search for "Finding Mental Health Support" on talenttransformation.com.',
    };

    function safetyCardContent({ inApp = false } = {}) {
        return {
            title: SAFETY_CARD.title,
            paragraphs: SAFETY_CARD.paragraphs.slice(),
            link: inApp ? null : { label: SAFETY_CARD.linkLabel, url: SAFETY_CARD.linkUrl },
            pointer: inApp ? SAFETY_CARD.appPointer : null,
        };
    }

    // The app's webview loads with no caller (treated as 'app'); the web
    // embed passes caller=web, the Studio simulator admin-simulator.
    function isNativeApp({ caller = 'app', hasBridge = false } = {}) {
        return caller === 'app' || !!hasBridge;
    }

    return { LIMITS, TOOL_LABELS, createTurnWatch, messageKey, liveHistoryPlan, safetyCardContent, isNativeApp, SAFETY_CARD };
});
