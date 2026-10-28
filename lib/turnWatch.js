/* The open user turn: what the coach's reply slot shows while it waits, and
 * what a dead model session means for it (Varsha, 2026-10-14).
 *
 * A turn opens when the person sends (or a send is queued while no session is
 * open) and joins later sends until the coach's answer finishes. While it
 * waits, the slot shows typing dots, '{Coach} is thinking...' at 4 s, 'Still
 * working on it...' at 15 s, or what a running tool is doing. Timers only
 * change that label: a slow but healthy turn is never torn down. The one
 * exception is the cap: 60 s after the latest send with nothing visible, the
 * turn fails and the caller closes the connection, so no indicator can spin
 * forever.
 *
 * Only hard transport signals (session.closed, data channel closed, peer
 * connection disconnected/failed, a connect that never came up) touch the
 * session. With an open turn they give one fresh session that re-sends every
 * unanswered message once; a second one is failed with 'Try again'. Without
 * one, a chat goes to standby (nothing reconnects until the next send) and a
 * call reconnects as before. A live cut (#40) fails the turn and never
 * recovers. A reply that had started is cut off, never re-sent on its own.
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

    // Causes that are not the transport failing: no safety card for them.
    const SOFT_CAUSES = new Set(['cap', 'cut']);

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
        // { since, entries: [{ id, message, session }], state, recoveries,
        //   tools: Map(key -> name), retried, recoveredAt, cause, partial }
        let turn = null;
        let last = 'idle';
        let timer = null;

        const turnId = () => (turn && turn.entries.length ? turn.entries[0].id : (turn ? 'queued-' + turn.since : null));
        const waiting = () => !!turn && (turn.state === 'waiting' || turn.state === 'recovering');

        function view() {
            if (!turn) return { state: last, dots: false, label: null, failed: null };
            if (turn.state === 'failed') return { state: 'failed', dots: false, label: null, failed: { partial: turn.partial, cause: turn.cause } };
            if (!waiting() || now() - turn.since >= L.capMs) return { state: turn.state, dots: false, label: null, failed: null };
            let label = null;
            const elapsed = now() - turn.since;
            if (turn.state === 'recovering') label = RECONNECTING;
            else if (turn.tools.size) label = TOOL_LABELS[[...turn.tools.values()].pop()] || STILL;
            else if (elapsed >= L.stillMs) label = STILL;
            else if (elapsed >= L.thinkingMs) label = `${coachName() || 'Your coach'} is thinking...`;
            return { state: turn.state, dots: true, label, failed: null };
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
            } else if (turn.state === 'streaming') {
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
            if (turn.state === 'streaming' && now() - turn.lastOutputAt >= L.capMs) { finish(); return; }
            changed();
        }

        function open() {
            if (!turn || turn.state === 'failed' || turn.state === 'streaming') {
                turn = { since: now(), entries: [], state: 'waiting', recoveries: 0, tools: new Map(), retried: false, recoveredAt: null, cause: null, partial: false, lastOutputAt: null };
            }
            turn.since = now();
            if (turn.state !== 'recovering') turn.state = 'waiting';
        }

        function queue() { open(); changed(); }

        function send({ id, message, session }) {
            open();
            turn.entries.push({ id, message, session });
            changed();
        }

        function toolStart(key, name) {
            if (!turn || turn.state === 'failed') return false;
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

        function output({ final = false } = {}) {
            if (!turn || turn.state === 'failed') return;
            if (waiting()) {
                if (turn.recoveredAt !== null) {
                    onEvent('turn_recovered', { turnId: turnId(), step: turn.retried ? 'user_retry' : 'fresh_session', msToReply: now() - turn.recoveredAt });
                }
                turn.state = 'streaming';
            }
            turn.lastOutputAt = now();
            if (final) finish();
            else changed();
        }

        function fail(cause) {
            if (!turn || turn.state === 'failed') return null;
            const partial = turn.state === 'streaming';
            turn.state = 'failed';
            turn.cause = cause;
            turn.partial = partial;
            turn.tools.clear();
            const record = { turnId: turnId(), cause, partial, hard: !SOFT_CAUSES.has(cause), attempts: turn.recoveries };
            onEvent('turn_failed', { turnId: record.turnId, cause, attempts: record.attempts, partial });
            changed();
            try { onFail(record); } catch (_) { /* rendering is the caller's */ }
            return record;
        }

        // A session ended. What happens to the open turn, if any.
        function hardSignal({ cause, inCall = false, cut = false }) {
            if (!turn || turn.state === 'failed') return { action: inCall ? 'resume-call' : 'standby', turnId: null };
            const id = turnId();
            onEvent('turn_stalled', { turnId: id, cause, stage: turn.state, msSinceSend: now() - turn.since, attempt: turn.recoveries + 1 });
            if (cut) { fail('cut'); return { action: 'fail', turnId: id }; }
            if (turn.state === 'streaming' || turn.recoveries >= L.maxRecoveries) { fail(cause); return { action: 'fail', turnId: id }; }
            turn.recoveries++;
            turn.state = 'recovering';
            turn.tools.clear();
            changed();
            return { action: 'recover', turnId: id };
        }

        // A model session is up: the unanswered messages it has not seen go
        // out again, once, in order.
        function sessionStarted(session) {
            if (!turn || turn.state === 'failed') return [];
            const resend = turn.entries.filter((e) => e.session !== session);
            resend.forEach((e) => { e.session = session; });
            if (turn.state === 'recovering') {
                turn.state = 'waiting';
                turn.recoveredAt = now();
                changed();
            }
            return resend.map((e) => ({ id: e.id, message: e.message }));
        }

        function connectFailed(cause = 'connect_failed') { return fail(cause); }

        // 'Try again': one more run, as the person's action (a fresh 60 s; if
        // its session dies too, failed again, with no automatic session).
        function retry() {
            if (!turn || turn.state !== 'failed') return false;
            turn.state = 'recovering';
            turn.since = now();
            turn.recoveries = L.maxRecoveries;
            turn.retried = true;
            turn.cause = null;
            turn.partial = false;
            // Whichever session comes next (or the one still open, in a call)
            // gets them again.
            turn.entries.forEach((e) => { e.session = null; });
            changed();
            return true;
        }

        function reset() {
            turn = null;
            last = 'idle';
            changed();
        }

        return {
            queue, send, toolStart, toolEnd, output, fail, hardSignal, sessionStarted, connectFailed, retry, reset, view,
            isOpen: () => waiting(),
            openIds: () => (waiting() ? turn.entries.map((e) => e.id) : []),
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
