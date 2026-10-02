/*
 * The speech gate (#40 step 2): GPT-Live bills every second of audio it
 * receives, speech or not — a call left open in a room with a fan costs
 * $3/h. The mic reaches OpenAI only while someone is speaking or Erica is
 * busy; otherwise the sender carries no track (replaceTrack(null)), which
 * Live does not bill.
 *
 * On-device: an AudioWorklet runs Silero VAD on the mic and feeds this
 * module one speech probability per 32 ms frame. Audio never leaves the
 * device until speech is detected. The audio Live hears is the mic through
 * a ~300 ms delay line, so the frames that made the gate open (and a little
 * before them) still reach it: the first syllable is not lost.
 *
 * Measured on staging (2026-10-02), and why "Erica busy" holds the gate:
 *   - with no inbound audio, Live stops sending its own audio within ~4 s
 *     and holds back the answer until audio flows again — so the gate stays
 *     open from the user's turn until Erica has finished speaking;
 *   - Live sends no speech_started/stopped events: its end-of-turn signal is
 *     session.delegation.created; the backend may think 15 s (tool calls).
 *
 * Pure decisions, no audio: the app feeds frames and coach events and acts
 * on what comes back. Shared by the browser and the Node tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.speechGate = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const DEFAULTS = {
        openThreshold: 0.5,    // Silero speech probability that counts as speech
        closeThreshold: 0.35,  // under this a frame is not speech (hysteresis)
        openAfterMs: 120,      // this much speech opens the gate
        hangoverMs: 1200,      // this long without speech (and Erica idle) closes it
        coachQuietMs: 1000,    // Erica inaudible this long counts as idle
        backendIdleMs: 8000,   // a delegation whose backend went quiet with no audio is over
        delegationMaxMs: 90000,
        oneShotMaxMs: 20000,
        // Live drops a session ~267 s after its last inbound audio (#17, and a
        // 294 s silent run on 2026-10-02 that survived on one blip); each 1 s
        // blip bills ~3.6 s. Every 150 s: margin for ~$0.07/h.
        blipEveryMs: 150000,
        blipMs: 1000,
        preRollMs: 300,        // the delay line in front of the sender
    };

    // Is Erica busy — thinking about a turn or speaking? Fed by Live events
    // (delegation created, backend events) and the remote audio level.
    function createCoachActivity(options = {}) {
        const c = { ...DEFAULTS, ...options };
        let delegationAt = null;
        let backendAt = null;
        let audibleAt = null;
        let oneShotAt = null;
        return {
            delegation(at) { delegationAt = at; backendAt = at; },
            backend(at) { if (delegationAt !== null) backendAt = at; },
            audible(at) { audibleAt = at; },
            // Erica is about to speak first (the opening line): Live speaks only
            // while audio flows in, so the gate carries her until she has.
            expectSpeech(at) { oneShotAt = at; },
            busy(at) {
                if (audibleAt !== null && at - audibleAt < c.coachQuietMs) return true;
                if (oneShotAt !== null) {
                    const spoke = audibleAt !== null && audibleAt >= oneShotAt;
                    if ((spoke && at - audibleAt >= c.coachQuietMs) || at - oneShotAt >= c.oneShotMaxMs) oneShotAt = null;
                    else return true;
                }
                if (delegationAt === null) return false;
                const spoke = audibleAt !== null && audibleAt >= delegationAt;
                const settled = (spoke && at - audibleAt >= c.coachQuietMs && at - backendAt >= c.coachQuietMs)
                    || (!spoke && at - backendAt >= c.backendIdleMs)
                    || at - delegationAt >= c.delegationMaxMs;
                if (settled) { delegationAt = null; return false; }
                return true;
            },
            get state() { return { delegationAt, backendAt, audibleAt, oneShotAt }; },
        };
    }

    function createSpeechGate(options = {}) {
        const c = { ...DEFAULTS, ...options };
        let state = 'closed';
        let since = null;          // when the current state began
        let speechRunMs = 0;       // consecutive speech before opening
        let lastSpeechAt = null;
        let maxProb = 0;
        let lastBlipAt = null;
        const totals = { openMs: 0, closedMs: 0, opens: 0, blips: 0, opensBySpeech: 0, opensByCoach: 0 };

        const open = (at, reason, prob) => {
            const closedMs = since === null ? 0 : at - since;
            totals.closedMs += closedMs;
            totals.opens++;
            if (reason === 'speech') totals.opensBySpeech++; else totals.opensByCoach++;
            state = 'open'; since = at; lastSpeechAt = reason === 'speech' ? at : null; maxProb = prob || 0;
            speechRunMs = 0;
            return { action: 'open', reason, prob: Math.round((prob || 0) * 100) / 100, closedMs };
        };
        const close = (at) => {
            const openMs = at - since;
            totals.openMs += openMs;
            const ev = { action: 'close', openMs, maxProb: Math.round(maxProb * 100) / 100 };
            state = 'closed'; since = at; lastBlipAt = null; speechRunMs = 0;
            return ev;
        };

        return {
            config: c,
            get state() { return state; },

            // One VAD frame: { prob, at, frameMs, coachBusy }. Returns an open /
            // close event or null.
            frame({ prob, at, frameMs = 32, coachBusy = false }) {
                if (since === null) since = at;
                const p = typeof prob === 'number' ? prob : 0;
                if (state === 'closed') {
                    if (p >= c.openThreshold) speechRunMs += frameMs;
                    else if (p < c.closeThreshold) speechRunMs = 0;
                    if (speechRunMs >= c.openAfterMs) return open(at, 'speech', p);
                    if (coachBusy) return open(at, 'coach', p);
                    return null;
                }
                if (p > maxProb) maxProb = p;
                if (p >= c.closeThreshold) lastSpeechAt = at;
                const speechQuiet = lastSpeechAt === null || at - lastSpeechAt >= c.hangoverMs;
                // "Busy" already ends 1 s after Erica's last audio (createCoachActivity).
                if (!coachBusy && speechQuiet && at - since >= c.hangoverMs) return close(at);
                return null;
            },

            // Keep-alive for a closed gate: Live drops a session ~267 s after
            // its last inbound audio.
            blipDue(at) {
                if (state !== 'closed' || since === null) return false;
                return at - (lastBlipAt !== null ? lastBlipAt : since) >= c.blipEveryMs;
            },
            noteBlip(at) { lastBlipAt = at; totals.blips++; },

            // Streaming vs gated time so far (the current stretch included).
            totals(at) {
                const t = { ...totals };
                if (since !== null) {
                    if (state === 'open') t.openMs += at - since; else t.closedMs += at - since;
                }
                return t;
            },
        };
    }

    return { createSpeechGate, createCoachActivity, DEFAULTS };
});
