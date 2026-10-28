// The real app.js (+ uiLayout.js and the browser lib modules) in a vm
// context with a fake clock, a fake DOM, and a fake GPT-Live behind a fake
// RTCPeerConnection and fetch. Nothing leaves the process.
//
//   const h = createHarness();
//   h.app.sendTextMessage('hello');  await h.advance(2000);
//   h.live.creates   — every POST /api/proxy/live: { kind, input, headers }
//   h.live.sent(i)   — what the client sent on connection i's data channel
//   h.live.closeSession('expired') / h.live.failPc() / h.live.reply('text')
//   h.live.event(inner, delegation) / h.live.functionCall(name, args) / h.live.say('words')
//   h.events(name)   — /api/session-log events posted
//   h.navigations    — every location.href assignment (the page would leave)
//
// The constructor is not run (it wires the whole page); the fields the
// recovery paths read are set here, and what is not under test is stubbed.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { createDocument } = require('./fakeDom');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SOURCES = ['lib/coachUiRules.js', 'lib/liveReasoning.js', 'lib/turnWatch.js', 'uiLayout.js', 'app.js'];
const sources = Object.fromEntries(SOURCES.map((f) => [f, read(f)]));
let historySeq = 0;

function createClock(start = Date.UTC(2026, 9, 28, 12, 0, 0)) {
    let now = start;
    let seq = 0;
    const timers = new Map();
    const errors = [];
    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
    return {
        errors,
        now: () => now,
        setTimeout: (fn, ms = 0, ...args) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every: 0 }); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        setInterval: (fn, ms = 0, ...args) => { const id = ++seq; const every = Math.max(1, Number(ms) || 1); timers.set(id, { at: now + every, fn, args, every }); return id; },
        clearInterval: (id) => { timers.delete(id); },
        flush,
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                await flush();
                let next = null;
                for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
                if (!next) break;
                const [id, t] = next;
                now = t.at;
                if (t.every) t.at += t.every; else timers.delete(id);
                try { t.fn(...t.args); } catch (e) { errors.push(e); }
            }
            now = end;
            await flush();
        },
    };
}

// GPT-Live, as seen from the browser: POST /api/proxy/live answers an SDP,
// the peer connection connects and opens its data channel, then the server
// sends session.started. Tests drive the rest.
function createFakeLive(clock) {
    const live = {
        creates: [], pcs: [],
        // (create) => undefined (201) | { status, body } | 'hang'
        policy: () => undefined,
        // (create, pc) => called right after session.started is delivered
        onStarted: null,
        autoStart: true,
    };
    class FakeDataChannel {
        constructor(pc) { this.pc = pc; this.readyState = 'connecting'; this.sent = []; }
        send(s) {
            if (this.readyState !== 'open') throw new Error('InvalidStateError: not open');
            this.sent.push(JSON.parse(s));
        }
        close() {
            if (this.readyState === 'closed') return;
            this.readyState = 'closed';
            clock.setTimeout(() => { if (typeof this.onclose === 'function') this.onclose({}); }, 0);
        }
    }
    class FakePC {
        constructor() {
            this.index = live.pcs.length;
            live.pcs.push(this);
            this.connectionState = 'new';
            this.iceGatheringState = 'complete';
            this.localDescription = null;
            this.closed = false;
        }
        addTransceiver() { return { sender: { replaceTrack() {} } }; }
        createDataChannel() { this.dc = new FakeDataChannel(this); return this.dc; }
        async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
        async setLocalDescription(d) { this.localDescription = d; }
        async setRemoteDescription(d) {
            this.remoteDescription = d;
            this.create = live.creates[live.creates.length - 1];
            clock.setTimeout(() => {
                if (this.closed) return;
                this.connectionState = 'connected';
                if (this.onconnectionstatechange) this.onconnectionstatechange();
                this.dc.readyState = 'open';
                if (this.dc.onopen) this.dc.onopen();
            }, 50);
            clock.setTimeout(() => {
                if (this.closed || !live.autoStart) return;
                live.deliver({ type: 'session.started', session: { id: this.create && this.create.id, model: 'gpt-live-1' } }, this.index);
                if (live.onStarted) live.onStarted(this.create, this);
            }, 100);
        }
        addEventListener() {}
        removeEventListener() {}
        async getStats() { return new Map(); }
        close() {
            if (this.closed) return;
            this.closed = true;
            this.connectionState = 'closed';
            if (this.dc) this.dc.close();
        }
    }
    live.PC = FakePC;
    live.current = () => live.pcs[live.pcs.length - 1];
    live.deliver = (msg, index = live.pcs.length - 1) => {
        const pc = live.pcs[index];
        if (!pc || pc.closed || pc.dc.readyState !== 'open') return false;
        pc.dc.onmessage({ data: JSON.stringify(msg) });
        return true;
    };
    live.sent = (index = live.pcs.length - 1) => (live.pcs[index] ? live.pcs[index].dc.sent : []);
    live.closeSession = (reason, { usage = { seconds: 15 } } = {}) => live.deliver({ type: 'session.closed', reason, ...(usage ? { usage } : {}) });
    live.contentFilterError = () => live.deliver({ type: 'error', error: { type: 'content_filter', code: 'content_filter', message: 'The generation was stopped due to moderation.' } });
    live.failPc = (state = 'failed', index = live.pcs.length - 1) => {
        const pc = live.pcs[index];
        pc.connectionState = state;
        if (pc.onconnectionstatechange) pc.onconnectionstatechange();
    };
    // The delegated backend: one nested Responses event in its envelope.
    live.event = (inner, delegation = 'del_1') => live.deliver({ type: 'response.event', delegation_id: delegation, event: inner });
    live.reply = (text, { delegation = 'del_1', response = 'resp_' + Math.random().toString(36).slice(2), created = true, completed = false } = {}) => {
        if (created) live.event({ type: 'response.created', response: { id: response } }, delegation);
        live.event({ type: 'response.output_text.delta', delta: text }, delegation);
        live.event({ type: 'response.output_text.done', text }, delegation);
        if (completed) live.event({ type: 'response.completed', response: { id: response } }, delegation);
    };
    // The backend asks the client to run a tool (GPT-Live delegation).
    live.functionCall = (name, args, { delegation = 'del_1', call = 'call_' + name, response = 'resp_fc_' + name } = {}) => {
        live.event({ type: 'response.created', response: { id: response } }, delegation);
        live.event({ type: 'response.output_item.done', item: { type: 'function_call', name, call_id: call, arguments: JSON.stringify(args) } }, delegation);
        live.event({ type: 'response.completed', response: { id: response } }, delegation);
    };
    // The voice layer speaking (a call): its own transcript stream.
    live.say = (text) => live.deliver({ type: 'session.output_transcript.delta', delta: text });
    return live;
}

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body, text: async () => JSON.stringify(body) };
}

function createHarness({ search = '', savedState = null, voiceApiMode = 'live', setup } = {}) {
    const clock = createClock();
    const live = createFakeLive(clock);
    const doc = createDocument();
    const container = doc.createElement('main'); container.id = 'chatContainer';
    const messages = doc.createElement('div'); messages.id = 'chatMessages';
    container.appendChild(messages);
    doc.body.appendChild(container);
    const notice = doc.createElement('button'); notice.id = 'callEndedNotice'; notice.className = 'call-ended hidden';
    doc.body.appendChild(notice);
    const control = (tag) => { const el = doc.createElement(tag); el.value = ''; el.disabled = false; doc.body.appendChild(el); return el; };

    const posts = [];
    const fetches = [];
    const hangs = new Set(); // url fragments that never answer (until aborted)
    let liveCount = 0;
    const fetchImpl = (url, init = {}) => {
        const u = String(url);
        fetches.push({ url: u, init });
        if (u.includes('/api/session-log')) {
            try { posts.push(JSON.parse(init.body)); } catch (_) { /* not JSON */ }
            return Promise.resolve(jsonResponse(200, { ok: true }));
        }
        const hanging = [...hangs].some((h) => u.includes(h));
        if (u.includes('/api/proxy/live')) {
            const headers = init.headers || {};
            let input = [];
            let sdp = init.body;
            if (String(headers['Content-Type']).includes('json')) { const b = JSON.parse(init.body); input = b.input || []; sdp = b.sdp; }
            const create = { id: 'ls_' + (++liveCount), kind: headers['X-Erica-Reconnect'] || null, input, sdp, headers, at: clock.now() };
            live.creates.push(create);
            const verdict = live.policy(create);
            if (verdict === 'hang' || hanging) return abortable(init.signal);
            if (verdict && verdict.status) return Promise.resolve(jsonResponse(verdict.status, verdict.body || {}));
            return Promise.resolve(jsonResponse(201, { session: { id: create.id, model: 'gpt-live-1' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } }));
        }
        if (hanging) return abortable(init.signal);
        if (u.includes('/api/voice-mode')) return Promise.resolve(jsonResponse(200, { mode: 'live' }));
        return Promise.resolve(jsonResponse(404, { error: 'not in the harness' }));
    };
    function abortable(signal) {
        return new Promise((resolve, reject) => {
            if (signal) signal.addEventListener('abort', () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e); });
        });
    }

    const storage = new Map();
    const logs = { log: [], warn: [], error: [] };
    const quiet = { log: (...a) => logs.log.push(a), info: (...a) => logs.log.push(a), debug: () => {}, warn: (...a) => logs.warn.push(a), error: (...a) => logs.error.push(a) };
    class FakeDate extends Date {
        constructor(...a) { if (a.length) super(...a); else super(clock.now()); }
        static now() { return clock.now(); }
    }
    // A page that assigns location.href navigates away (maintenance.html):
    // every assignment is recorded, since the vm page itself stays.
    const navigations = [];
    let href = 'http://localhost/' + search;
    const location = {
        search, origin: 'http://localhost', pathname: '/',
        get href() { return href; },
        set href(v) { navigations.push(String(v)); href = String(v); },
    };
    const ctx = {
        console: quiet,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        setInterval: clock.setInterval, clearInterval: clock.clearInterval,
        Date: FakeDate,
        document: doc,
        navigator: { userAgent: 'node-harness' },
        location,
        URLSearchParams, URL, AbortController, TextEncoder, TextDecoder,
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        RTCPeerConnection: live.PC,
        RTCSessionDescription: class { constructor(d) { Object.assign(this, d); } },
        MediaStream: class {},
        fetch: fetchImpl,
        localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
        queueMicrotask,
        addEventListener() {}, removeEventListener() {},
        postMessage() {},
    };
    ctx.window = ctx; ctx.self = ctx; ctx.parent = ctx; ctx.top = ctx; ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of SOURCES) {
        const code = f === 'app.js' ? sources[f] + '\n;globalThis.__VoiceChatBot = VoiceChatBot;' : sources[f];
        vm.runInContext(code, ctx, { filename: f });
    }
    // The UI layer, minus what needs the real page.
    const ui = ctx.uiLayout;
    ui.updateMicToggleVisibility = () => {};
    ui.updateTextButtonVisibility = () => {};
    ui.setMicToggleUI = () => {};
    ui.setCallModePanelOpen = () => {};
    ui.updateSpeakerLevel = () => {};
    ui.updateMessageElement = (app, m) => {
        let el = app.messageElements.get(m.id);
        if (!el) {
            el = doc.createElement('div');
            el.setAttribute('data-message-id', m.id);
            el.setAttribute('data-timestamp', m.timestamp);
            el.setAttribute('data-role', m.role);
            app.messageElements.set(m.id, el);
            const kids = messages.children;
            const before = kids.find((c) => Number(c.getAttribute('data-timestamp') || 0) > m.timestamp);
            messages.insertBefore(el, before || null);
        }
        el.textContent = m.text;
    };

    const stateStore = { state: savedState ? JSON.parse(JSON.stringify(savedState)) : null };
    const Bot = ctx.__VoiceChatBot;
    const CMap = vm.runInContext('Map', ctx);
    const app = Object.create(Bot.prototype);
    Object.assign(app, {
        apiKey: '', pc: null, dataChannel: null, isConnected: false, isConnecting: false, isRecording: false,
        isCallAudioEnabled: false, isSelfMuted: false, localStream: null, remoteAudio: null, sessionId: 's-harness',
        messages: [], messageElements: new CMap(), seqCounter: 0,
        pendingResponses: new CMap(), activeAudioResponses: new CMap(), pendingFunctionCalls: new CMap(),
        _pendingTextMessages: [], pendingAttachments: [], analyticsSession: { textQuestionCount: 0, responseCount: 0 },
        voiceApiMode, selectedVoice: 'marin', basePath: '',
        currentVoiceProfile: { character: 'Erica', label: 'coach', companionId: 'Supportive' },
        chatMessages: messages, chatLoader: null, textInput: control('textarea'), callButton: control('button'), connectButton: null, apiKeyInput: control('input'), sendTextButton: control('button'),
        callEndedNotice: notice,
        audioOutputGate: false, openingLineSent: true, isSoundEnabled: true,
        _liveLimits: { maxMin: 30, idleMin: 10 }, SESSION_INACTIVITY_TIMEOUT_MS: 30 * 60 * 1000,
        stateManager: {
            saveSessionState: (s) => { stateStore.state = JSON.parse(JSON.stringify(s)); return true; },
            loadSessionState: () => (stateStore.state ? JSON.parse(JSON.stringify(stateStore.state)) : null),
        },
    });
    const noop = () => {};
    const anoop = async () => {};
    Object.assign(app, {
        stopActivePreview: anoop, checkVoiceLimit: () => true, fetchEricaPreparation: anoop,
        _loadVoiceCards: anoop, _applyStoredCoachSettings: anoop, requestReportContextFromParent: async () => null,
        fetchConversationHistory: async () => null, _maybeSendOpeningLine: anoop, setCallAudioEnabled: noop,
        _resolveVoiceApiMode: async () => app.voiceApiMode, apiUrl: (p) => p, trackCoachEvent: noop,
        hideQuickActions: noop, renderQuickActions: noop, _liveFullInstructions: () => 'INSTRUCTIONS',
        _liveDelegationUpdate: () => ({ type: 'session.update', session: { delegation: { type: 'responses' } } }),
        _injectClipboardIntoSession: noop, showLoader: noop, hideLoader: noop, setMicButtonState: noop,
        updateTextButtonVisibility: noop, getUserIdFromURL: () => null, getEmailFromURL: () => null,
        _logTurnFor: noop, queueBotMessageQC: noop, scrollMessageTopIntoView: noop, isChatNearBottom: () => true,
        resetVoiceInactivityTimer: noop, clearVoiceInactivityTimer: noop, _silentCallSawLife: noop, _silentCallDisarm: noop,
        incrementVoiceUsage: noop, emitAskedEricaEvent: noop, _clipboardNoteActivity: noop, stopAllVideos: noop,
        updateCurrentVoiceVideo: noop, _scheduleClipboardDistill: noop, _speechGateStop: noop, _speechGateReattach: noop,
        cancelActiveResponses: anoop, _languageRule: () => '', _nameHintAllowed: () => false, _coachSwitchLine: () => '',
        getEffectiveVoiceProfile: () => app.currentVoiceProfile, getUrlQuestion: () => null,
        startRecording: async () => { app.isRecording = true; app.localStream = { getAudioTracks: () => [{ readyState: 'live', enabled: true }], getTracks: () => [{ stop() {} }] }; },
    });
    if (setup) setup(app, ctx);
    if (savedState) app.loadSavedState();

    return {
        app, ctx, live, clock, doc, logs, posts, fetches, hangs, navigations,
        state: () => stateStore.state,
        advance: (ms) => clock.advance(ms),
        flush: () => clock.flush(),
        events: (name) => posts.filter((p) => p.kind === 'event' && (!name || p.name === name)),
        // The coach's reply slot and the transcript extras.
        indicator: () => doc.getElementById('turnIndicator'),
        failedNote: () => messages.querySelector('[data-turn-failed]'),
        safetyCards: () => messages.querySelectorAll('[data-safety-card]'),
        history: (pairs) => {
            let t = clock.now() - 600000;
            app.isRestoringHistory = true;
            try {
                pairs.forEach(([role, text], i) => app.upsertMessage(`hist-${++historySeq}`, role === 'user' ? 'user' : 'bot', text, true, (t += 1000)));
            } finally {
                app.isRestoringHistory = false;
            }
        },
    };
}

// What a connection's data channel carried, as short tags:
//   update | item:user:<text> | item:assistant:<text> | item:fn | create | other:<type>
function wire(sent) {
    return sent.map((m) => {
        if (m.type === 'session.update') return 'update';
        if (m.type === 'response.create') return 'create';
        if (m.type === 'response.item.create' || m.type === 'conversation.item.create') {
            const it = m.item || {};
            if (it.type === 'function_call_output') return 'item:fn';
            return `item:${it.role}:${(it.content && it.content[0] && it.content[0].text) || ''}`;
        }
        return 'other:' + m.type;
    });
}

module.exports = { createHarness, createClock, wire };
