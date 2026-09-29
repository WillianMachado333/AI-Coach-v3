/* GPT-Live backend reasoning, collected per delegation for the session log (#24).
 *
 * With session.delegation.responses.reasoning = { summary: 'auto' }, the
 * delegated Responses model streams a reasoning summary inside response.event
 * envelopes. This gathers it per delegation_id, with the tools that delegation
 * called and the text it answered, and hands one record to `post` when the
 * delegation is done. The record is for the Studio only: never rendered to the
 * user, never printed to the console.
 *
 * A delegation that calls a tool spans two responses (the tool call, then the
 * continuation with the answer), so a response that ended in a tool call holds
 * the record until the continuation completes, or `holdMs` passes (posted with
 * status 'incomplete'), or flushAll() (disconnect).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.liveReasoning = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const ANSWER_CAP = 1500;
    const HOLD_MS = 90000;
    const MAX_OPEN = 20;
    // Inner types that carry nothing but reasoning: consumed here, so the
    // caller's catch-all never prints them (their text is the summary).
    const REASONING_TYPES = new Set([
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_part.done',
        'response.reasoning_summary_text.delta',
        'response.reasoning_summary_text.done'
    ]);
    const FINAL_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled']);

    function isReasoningEvent(inner) {
        if (!inner || typeof inner.type !== 'string') return false;
        if (REASONING_TYPES.has(inner.type)) return true;
        return (inner.type === 'response.output_item.added' || inner.type === 'response.output_item.done')
            && !!inner.item && inner.item.type === 'reasoning';
    }

    function capAnswer(text, cap = ANSWER_CAP) {
        const s = String(text || '').trim();
        return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
    }

    function createLiveReasoningLog({
        post,
        holdMs = HOLD_MS,
        answerCap = ANSWER_CAP,
        setTimer = (fn, ms) => setTimeout(fn, ms),
        clearTimer = (id) => clearTimeout(id)
    } = {}) {
        const open = new Map();

        function entryFor(key) {
            let e = open.get(key);
            if (!e) {
                if (open.size >= MAX_OPEN) flush(open.keys().next().value, 'evicted');
                e = { parts: new Map(), reasoningItems: 0, tools: [], answer: '', responseIds: [], model: null, reasoningTokens: 0, toolInResponse: false, timer: null };
                open.set(key, e);
            }
            return e;
        }

        function partKey(inner) {
            return `${inner.item_id || ''}:${inner.summary_index ?? 0}`;
        }

        function flush(key, status) {
            const e = open.get(key);
            if (!e) return null;
            open.delete(key);
            if (e.timer !== null) clearTimer(e.timer);
            const summary = [...e.parts.values()].map((t) => t.trim()).filter(Boolean).join('\n\n');
            // The summarizer skips short reasoning (most turns at effort
            // 'medium'): still logged, marked summarized:false, so the Studio
            // says she reasoned rather than showing nothing. No reasoning
            // item at all, no record.
            if (!summary && !e.reasoningItems) return null;
            const meta = {
                source: 'live_backend',
                summarized: !!summary,
                summary,
                answer: capAnswer(e.answer, answerCap),
                model: e.model,
                delegationId: key.startsWith('delegation:') ? key.slice('delegation:'.length) : null,
                responseId: e.responseIds[e.responseIds.length - 1] || null,
                responseIds: e.responseIds,
                toolCalls: e.tools,
                reasoningTokens: e.reasoningTokens,
                chars: summary.length,
                status
            };
            if (typeof post === 'function') post(meta);
            return meta;
        }

        // Every inner event of a response.event envelope goes through here.
        // Returns { reasoning, posted }: `reasoning` is true when the event
        // carried only reasoning (the caller must not print it); `posted` is
        // the record handed to `post`, when this event finished one.
        function observe(inner, delegationId) {
            const out = { reasoning: isReasoningEvent(inner), posted: null };
            if (!inner || typeof inner.type !== 'string') return out;
            // Live always wraps backend events with their delegation_id.
            const key = delegationId ? `delegation:${delegationId}` : 'no-delegation';
            const t = inner.type;
            if (t === 'response.output_item.added' && inner.item && inner.item.type === 'reasoning') {
                entryFor(key).reasoningItems++;
            } else if (t === 'response.reasoning_summary_text.delta' && typeof inner.delta === 'string') {
                const e = entryFor(key);
                const k = partKey(inner);
                e.parts.set(k, (e.parts.get(k) || '') + inner.delta);
            } else if (t === 'response.reasoning_summary_text.done' && typeof inner.text === 'string') {
                entryFor(key).parts.set(partKey(inner), inner.text);
            } else if (t === 'response.reasoning_summary_part.done' && inner.part && inner.part.text) {
                entryFor(key).parts.set(partKey(inner), inner.part.text);
            } else if (t === 'response.output_item.done' && inner.item && inner.item.type === 'reasoning' && Array.isArray(inner.item.summary)) {
                const e = entryFor(key);
                inner.item.summary.forEach((s, i) => { if (s && s.text) e.parts.set(`${inner.item.id || ''}:${i}`, s.text); });
            } else if (t === 'response.output_item.done' && inner.item && inner.item.type === 'function_call' && inner.item.name) {
                const e = entryFor(key);
                e.tools.push(inner.item.name);
                e.toolInResponse = true;
            } else if (t === 'response.output_text.delta' && typeof inner.delta === 'string') {
                // Reasoning can follow the text; a record without a summary
                // is dropped at completion.
                entryFor(key).answer += inner.delta;
            } else if (FINAL_TYPES.has(t)) {
                const e = open.get(key);
                if (!e) return out;
                const r = inner.response || {};
                if (r.id && !e.responseIds.includes(r.id)) e.responseIds.push(r.id);
                if (r.model) e.model = r.model;
                const rt = r.usage && r.usage.output_tokens_details && r.usage.output_tokens_details.reasoning_tokens;
                if (typeof rt === 'number') e.reasoningTokens += rt;
                if (t === 'response.completed' && e.toolInResponse) {
                    // The answer comes in the continuation response.
                    e.toolInResponse = false;
                    if (e.timer !== null) clearTimer(e.timer);
                    e.timer = setTimer(() => { e.timer = null; flush(key, 'incomplete'); }, holdMs);
                } else {
                    out.posted = flush(key, t.replace('response.', ''));
                }
            }
            return out;
        }

        function flushAll(status = 'disconnect') {
            return [...open.keys()].map((k) => flush(k, status)).filter(Boolean);
        }

        return { observe, flushAll, get openCount() { return open.size; } };
    }

    return { createLiveReasoningLog, isReasoningEvent, capAnswer, ANSWER_CAP, HOLD_MS };
});
