class VoiceChatBot {
    constructor() {
        this.apiKey = '';
        this.pc = null; // RTCPeerConnection
        this.dataChannel = null;
        this.isConnected = false;
        this.isRecording = false;
        this.isCallAudioEnabled = false; // default: audio off until call mode
        this.isSelfMuted = false; // call-mode mic mute (without ending the call)
        this.localStream = null;
        this.remoteAudio = null;
        this.sessionId = null;
        this.audioContext = null;
        this.analyser = null;
        this.audioLevelInterval = null;
        this.remoteAnalyser = null;
        this.remoteLevelInterval = null;
        this.remoteAudioSource = null;
        this.remoteAudioGain = null;
        this.lastRemoteLevelAt = 0;
        this._previewClearTimer = null;
        this.audioCheckInterval = null;
        this.audioPacketsSent = 0;
        this.currentUserMessageElement = null; // Track current partial user message
        this.currentUserTranscript = ''; // Accumulate transcript text
        this.currentUserItemId = null; // Track current user message item ID
        this.lastFinalizedUserMessage = null; // Track the last finalized user message DOM element
        this.currentBotMessageElement = null; // Track current partial bot message
        this.currentBotTranscript = ''; // Accumulate bot transcript text
        this.currentBotItemId = null; // Track current bot message item ID
        this.selectedVoice = 'marin'; // Default voice (Erica)
        this.selectedCompanionId = null; // Distinguish coaches even if they share the same openaiVoice
        this._userExplicitlySelectedCoach = false; // True only when user clicks a coach or valid ?aic= is used
        this.currentVoiceThumbUrl = null; // Keep the resolved thumb even if DOM avatar is removed
        this._activeResponseId = null; // track server-side active response id (Realtime allows 1 at a time)
        this._suppressedResponseIds = new Set(); // response ids that should not appear in chat/history
        this._oneShot = null; // one-shot speak request (preview/opening line)
        this.currentPreviewCompanionId = null; // active preview companion id (if any)
        this.previewSession = null; // isolated preview connection (no main-session side effects)
        this.previewTtsAudio = null;
        this.previewTtsAbort = null;
        this.previewTtsObjectUrl = null;
        this.previewTtsPlaying = false;
        this.previewTtsCurrentKey = null;
        this.previewTtsRequestId = 0;
        this.previewTtsCache = new Map(); // key -> { url, ts }
        this.previewTtsCacheTtlMs = 24 * 60 * 60 * 1000; // 24h
        this.pendingResponses = new Set(); // Track response IDs that were created while recording
        this.pendingBotMessages = []; // Queue bot messages until a user message exists
        this.messages = []; // Canonical ordered message store
        this.messageElements = new Map(); // Map message ID to DOM element
        this.seqCounter = 0; // Sequence to keep stable ordering when timestamps tie
        this.inputStartTimestamp = null; // Track when user started speaking
        this.botStartTimestamp = null; // Track when bot started responding
        this.pendingFunctionCalls = new Set(); // Track function calls waiting for response completion
        this.customInstructions = null; // Store custom instructions from API
        this.activeAudioResponses = new Set(); // Track responses that have active audio
        this.conversationHistoryToSend = null; // Store history to send after session is configured
        this.isRestoringHistory = false; // Flag to avoid saving while restoring history
        this.iframeMessaging = null; // postMessage helper for host <-> iframe
        this.iframeMessageLog = []; // keep recent postMessage exchanges for diagnostics
        this.reportContextCache = null;
        this.reportContextLastAt = 0;
        this._reportContextWaiters = [];
        this._reportContextListenerAttached = false;
        this.reportContextTimeoutMs = 1500;

        // Voice Inactivity Timeout State
        this.voiceInactivityTimeout = null; // Timer for 30-second inactivity timeout
        this.lastAudioActivityTimestamp = null; // Track last detected audio activity
        this.lastAudioResetTimestamp = 0; // Track last time we reset timer due to audio
        this.isVoiceMutedByInactivity = false; // Flag to track if muted due to inactivity
        this.inactivityMuteTimestamp = null; // Track when inactivity mute occurred
        this.VOICE_INACTIVITY_TIMEOUT_MS = 30000; // 30 seconds
        this.VOICE_ACTIVITY_THRESHOLD = 0.02; // Minimum RMS level to consider as activity

        // Session Inactivity Timeout State (30 minutes → on hold)
        this.sessionInactivityTimeout = null;
        this.SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
        this.isOnHold = false;
        this._serverVoiceUsageCount = 0;

        // Analytics State
        this.analyticsSession = {
            voiceQuestionCount: 0,
            textQuestionCount: 0,
            responseCount: 0
        };

        // Audio Output Gating (prevent hearing tail of old messages on reconnect)
        this.audioOutputGate = false;
        // Removed minNewMessageTimestamp - using absolute timestamps (Date.now()) instead

        // URL question: sent once after first successful connection, never again
        this._urlQuestionSent = false;
        // Queue for messages sent before connection is ready
        this._pendingTextMessages = [];

        // Debug logging toggle:
        // - URL param: ?ericaDebug=1
        // - localStorage: ERICA_DEBUG=1
        this.debugEnabled = this.getDebugEnabled();

        // Conversation history fetch controls:
        // - Single-flight: dedupe concurrent history fetches
        // - Cache: avoid refetching during reconnect/voice changes/iframe reload storms
        this._historyFetchInFlight = null; // Promise|null
        this._historyCache = new Map(); // userId -> { ts, history }

        // Erica preparation fetch controls (to avoid Wix 429 storms):
        // - Single-flight: dedupe concurrent prep fetches
        // - Cache: avoid refetching during reconnects/autoConnect/iframe reloads
        this._prepFetchInFlight = null; // Promise|null
        this._prepCache = new Map(); // key -> { ts, data }

        // Connect single-flight (prevents multiple overlapping connect() attempts)
        this.isConnecting = false;

        // Conversation history save throttling (reduces Wix load -> fewer 429s)
        this._saveHistoryTimer = null;
        this._lastHistorySaveAt = 0;
        this._historySaveInFlight = false;
        this._historySaveDirty = false;
        this._historySavePreferSoon = false;
        this._historySaveDebounceMs = 800;
        this._historySaveMinIntervalMs = 15000;

        // Message QC (bot responses)
        this.qcCheckedMessageIds = new Set();
        this.qcInFlight = new Set();
        this.qcRetryCount = new Map(); // messageId -> number
        this.MAX_QC_RETRIES = 2;

        // Opening line behavior:
        // - We trigger the opening line explicitly after connect/reconnect.
        // - It is not auto-sent from configureSession.

        // Temporarily disable separate history fetch while investigating Wix 429s.
        // Re-enable later when history is bundled into preparation or when Wix limits are resolved.
        // Toggle via:
        // - URL param: ?disableHistoryFetch=1
        // - localStorage: DISABLE_HISTORY_FETCH=1
        this.disableHistoryFetch = this.getDisableHistoryFetch();

        // --- Behavior tuning mode (test harness only) ---
        // Enabled only when the iframe URL contains ?tune=1.
        // Allows the test harness (apps.talenttransformation.com / talenttransformation.com / localhost) to
        // request current tunable fields and apply overrides live via session.update.
        this.tuningEnabled = this.getTuningEnabled();
        this.tuningToken = this.getTuningToken(); // optional shared token for demos
        this.behaviorOverrides = null; // coach-specific override patch
        this.preparationOverrides = null; // global/preparation override patch

        // Detect base path for subfolder deployment
        this.basePath = this.detectBasePath();

        // Initialize state manager for session persistence
        this.stateManager = typeof window.StateManager !== 'undefined' ? new window.StateManager() : null;
        if (this.stateManager) {
            this.stateManager.setupNativeBridge();
        }

        if (typeof window.initLayout === 'function') {
            window.initLayout(this);
        } else {
            console.warn('[Erica] initLayout helper not found; UI may not initialize correctly.');
        }
        this.setupIframeMessaging();
        this.setupReportContextMessaging();
        this.setupTuningMessaging();

        // Companions cache (fast first paint for coach list)
        this._companionsCacheKey = 'ERICA_COMPANIONS_CACHE_V1';
        this._companionsCacheTtlMs = 24 * 60 * 60 * 1000; // 24h
        this.renderCachedCompanions();

        // IMPORTANT: The coach list should come from the preparation API (companions array).
        // `voiceProfiles.json` is only a fallback when preparation is unavailable.
        this.restoreModeIfNeeded();
        this.autoConnect();
    }

    restoreModeIfNeeded() {
        // console.log('[Erica] ----------------------------------------');
        // console.log('[Erica] Checking if mode restoration is needed...');
        const savedState = this.loadSavedState();
        // console.log('[Erica] Loaded saved state:', savedState);

        if (savedState && savedState.mode === 'call') {
            // Prototype phase: voice mode is open to guests. Nobody uses the
            // product yet, so a login wall in front of the demo would kill
            // the exact evaluation loop we need. Reintroduce a gate later
            // once we have usage worth protecting (e.g. per-guest voice-
            // minute cap tracked via CleverTap objectId).

            // 1. Open Call Panel
            if (window.uiLayout && typeof window.uiLayout.setCallModePanelOpen === 'function') {
                // console.log('[Erica] Opening call panel UI...');
                window.uiLayout.setCallModePanelOpen(this, true, true); // true, true = open, skipSave (prevent overwrite)
            }

            // 2. Connect
            // console.log('[Erica] Triggering connect()...');
            this.connect().catch(e => console.error('[Erica] Connection failed during restore:', e));

            // 3. Start recording
            // console.log('[Erica] Triggering startRecording()...');
            this.startRecording().then(() => {
                // console.log('[Erica] startRecording() promise resolved.');
            }).catch(error => {
                console.error('[Erica] ❌ Failed to restore call mode recording:', error);
                console.warn('[Erica] Browser blocked auto-start. Waiting for user interaction.');
            });
        } else if (this.getUrlVoiceMode()) {
            // URL param ?voiceMode=true — auto-open call panel and start
            // recording. Prototype phase: no login gate for guests.
            if (window.uiLayout && typeof window.uiLayout.setCallModePanelOpen === 'function') {
                window.uiLayout.setCallModePanelOpen(this, true, true);
            }
            this.connect().catch(e => console.error('[Erica] Connection failed during voiceMode init:', e));
            this.startRecording().catch(err => {
                console.warn('[Erica] Auto-start voice blocked by browser, waiting for user interaction.', err);
            });
        } else {
            // console.log('[Erica] Mode is not "call" (found:', savedState?.mode, '), skipping restoration.');
        }
    }

    isPreviewActive() {
        return !!(this.previewTtsPlaying || this.previewTtsAbort);
    }

    async stopActivePreview({ clearPreview = true } = {}) {
        let stopped = false;
        this.previewTtsRequestId += 1;
        if (this.previewTtsAbort) {
            try {
                this.previewTtsAbort.abort();
            } catch (_) { }
            this.previewTtsAbort = null;
            stopped = true;
        }
        if (this.previewTtsAudio) {
            try {
                this.previewTtsAudio.pause();
                this.previewTtsAudio.currentTime = 0;
                this.previewTtsAudio.removeAttribute('src');
                this.previewTtsAudio.load();
            } catch (_) { }
            stopped = true;
        }
        const cacheKey = this.previewTtsCurrentKey || this._findPreviewCacheKeyByUrl(this.previewTtsObjectUrl);
        const hasCache = !!(cacheKey && this.previewTtsCache && this.previewTtsCache.has(cacheKey));
        if (this.previewTtsObjectUrl && !hasCache) {
            try {
                URL.revokeObjectURL(this.previewTtsObjectUrl);
            } catch (_) { }
            this.previewTtsObjectUrl = null;
        }
        this.previewTtsPlaying = false;
        this.previewTtsCurrentKey = hasCache ? cacheKey : null;
        if (clearPreview) {
            this.currentPreviewCompanionId = null;
        }
        return stopped;
    }

    async playCoachPreview({ companionId, openaiVoice, coachName, text }) {
        try {
            const previewText = (text || '').trim();
            if (!previewText) return false;

            const nextCompanionId = companionId ? String(companionId) : null;
            const isSamePreview =
                this.isPreviewActive() &&
                nextCompanionId &&
                String(this.currentPreviewCompanionId || '').toLowerCase() === nextCompanionId.toLowerCase();

            if (isSamePreview) {
                await this.stopActivePreview({ clearPreview: true });
                return false;
            }

            if (this.isPreviewActive()) {
                await this.stopActivePreview({ clearPreview: false });
            }

            if (nextCompanionId) {
                this.currentPreviewCompanionId = nextCompanionId;
            }

            const persona = this.resolvePreviewPersona({ companionId, openaiVoice });
            const styleInstructions = persona ? this.buildVoiceStyleInstructions(persona) : '';
            const personaVoice =
                (persona && persona.openaiVoice) ||
                (persona && persona.voice) ||
                null;
            const prompt =
                `Say exactly this phrase: ${previewText}`;
            console.log('[Erica Preview] prompt', prompt);

            const voiceToUse = personaVoice || openaiVoice || this.selectedVoice || 'marin';
            console.log('[Erica Preview] resolved voice', {
                companionId: companionId || null,
                personaId: persona?.id || persona?.companionId || persona?.character || null,
                personaVoice: personaVoice || null,
                passedVoice: openaiVoice || null,
                selectedVoice: this.selectedVoice || null,
                finalVoice: voiceToUse
            });

            if (!this.previewTtsAudio) {
                this.previewTtsAudio = document.createElement('audio');
                this.previewTtsAudio.autoplay = true;
                this.previewTtsAudio.volume = 1.0;
                this.previewTtsAudio.style.display = 'none';
                document.body.appendChild(this.previewTtsAudio);
            }

            await this.stopActivePreview({ clearPreview: false });
            const requestId = ++this.previewTtsRequestId;

            const cacheKey = this._buildPreviewCacheKey({
                text: previewText,
                voice: voiceToUse,
                instructions: styleInstructions
            });
            const cached = this._getPreviewCacheEntry(cacheKey);
            if (cached && cached.url) {
                this.previewTtsObjectUrl = cached.url;
                this.previewTtsCurrentKey = cacheKey;
                this.previewTtsAudio.src = cached.url;
                this.previewTtsPlaying = true;
                this.previewTtsAudio.onended = () => {
                    this.previewTtsPlaying = false;
                };
                await this.previewTtsAudio.play().catch(() => { });
                return true;
            }

            const controller = new AbortController();
            this.previewTtsAbort = controller;
            this.previewTtsPlaying = true;

            const ttsResponse = await fetch(this.apiUrl('/api/preview-tts'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: previewText,
                    voice: voiceToUse,
                    instructions: styleInstructions || ''
                }),
                signal: controller.signal
            });
            this.previewTtsAbort = null;

            if (requestId !== this.previewTtsRequestId) {
                this.previewTtsPlaying = false;
                return false;
            }

            if (!ttsResponse.ok) {
                const errText = await ttsResponse.text();
                console.warn('[Erica Preview] TTS failed', errText);
                this.previewTtsPlaying = false;
                return false;
            }

            const audioBlob = await ttsResponse.blob();
            if (requestId !== this.previewTtsRequestId) {
                this.previewTtsPlaying = false;
                return false;
            }
            if (this.previewTtsObjectUrl && !this._isPreviewCacheKeyActive(this.previewTtsCurrentKey)) {
                try {
                    URL.revokeObjectURL(this.previewTtsObjectUrl);
                } catch (_) { }
            }
            this.previewTtsObjectUrl = URL.createObjectURL(audioBlob);
            this.previewTtsCurrentKey = cacheKey;
            this.previewTtsCache.set(cacheKey, { url: this.previewTtsObjectUrl, ts: Date.now() });
            this.previewTtsAudio.src = this.previewTtsObjectUrl;
            this.previewTtsAudio.onended = () => {
                this.previewTtsPlaying = false;
            };
            await this.previewTtsAudio.play().catch(() => {
                this.previewTtsPlaying = false;
            });
            return true;
        } catch (e) {
            console.warn('[Erica] playCoachPreview failed:', e);
            await this.stopActivePreview({ clearPreview: false });
            return false;
        }
    }

    async speakOneShot({ promptText, suppressFromUI = false, ensureSpeaker = false, leaveSpeakerOn = false, restoreDelayMs = 0 }) {
        const text = (promptText || '').trim();
        if (!text) return false;

        if (this._oneShot && this._oneShot.active) {
            await this.cancelIfActiveResponse();
            this._endOneShot({ force: true });
        }

        const restoreAudio = (ensureSpeaker && !leaveSpeakerOn) ? {
            isCallAudioEnabled: !!this.isCallAudioEnabled,
            isSoundEnabled: !!this.isSoundEnabled
        } : null;

        if (ensureSpeaker) {
            this.isSoundEnabled = true;
            this.setCallAudioEnabled(true);
        }

        if (!this.isConnected) {
            await this.connect({ skipOpeningLine: true });
        }
        await this._waitForDataChannelOpen(12_000);

        await this.cancelIfActiveResponse();

        let resolveStarted = null;
        const startedPromise = new Promise((resolve) => { resolveStarted = resolve; });

        this._oneShot = {
            active: true,
            suppressFromUI,
            responseId: null,
            restoreAudio,
            _resolveStarted: resolveStarted,
            _startedResolved: false,
            startedAt: Date.now(),
            restoreDelayMs: Number.isFinite(restoreDelayMs) ? Math.max(0, restoreDelayMs) : 0
        };

        this.sendMessage({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }]
            }
        });
        this.sendMessage({ type: 'response.create' });

        // Resolve when response.created arrives (used for UI loader)
        const started = await Promise.race([
            startedPromise,
            this.sleep(15_000).then(() => false)
        ]);

        // Safety timeout: clean up if response.done never arrives
        setTimeout(() => {
            if (this._oneShot && this._oneShot.active && Date.now() - this._oneShot.startedAt > 20_000) {
                this._endOneShot({ force: true });
            }
        }, 21_000);

        return !!started;
    }

    resolvePreviewPersona({ companionId, openaiVoice }) {
        const idKey = companionId ? String(companionId).toLowerCase() : null;
        if (idKey) {
            const cached = this.resolveCompanionConfigFromCache(idKey);
            if (cached) return cached;
            if (this.voiceProfilesById && this.voiceProfilesById[idKey]) {
                return this.voiceProfilesById[idKey];
            }
        }
        const voiceKey = openaiVoice ? String(openaiVoice).toLowerCase() : null;
        if (voiceKey && this.voiceProfilesByVoice && Array.isArray(this.voiceProfilesByVoice[voiceKey])) {
            return this.voiceProfilesByVoice[voiceKey][0] || null;
        }
        return this.getEffectiveVoiceProfile() || this.currentVoiceProfile || null;
    }

    resolveCompanionConfigFromCache(idKey) {
        const getCfg = (entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const cfg = entry.configuration && typeof entry.configuration === 'object' ? entry.configuration : null;
            return cfg || null;
        };

        const matchEntry = (entry) => {
            if (!entry) return false;
            const cfg = entry.configuration || {};
            const keys = [
                entry.companionId,
                cfg.companionId,
                cfg.id,
                cfg.character
            ].filter(Boolean).map((v) => String(v).toLowerCase());
            return keys.includes(idKey);
        };

        const last = Array.isArray(this.lastCompanions) ? this.lastCompanions : null;
        if (last) {
            const found = last.find(matchEntry);
            const cfg = getCfg(found);
            if (cfg) return cfg;
        }

        const cached = this.loadCompanionsCache();
        const cachedList = cached && Array.isArray(cached.companions) ? cached.companions : null;
        if (cachedList) {
            const found = cachedList.find(matchEntry);
            const cfg = getCfg(found);
            if (cfg) return cfg;
        }

        return null;
    }

    _buildPreviewCacheKey({ text, voice, instructions }) {
        const normText = String(text || '').trim();
        const normVoice = String(voice || '').trim().toLowerCase();
        const normInstr = String(instructions || '').trim();
        return `${normVoice}::${this._hashPreview(normText)}::${this._hashPreview(normInstr)}`;
    }

    _hashPreview(value) {
        const str = String(value || '');
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & 0xffffffff;
        }
        return Math.abs(hash).toString(36);
    }

    _getPreviewCacheEntry(key) {
        if (!key || !this.previewTtsCache) return null;
        const entry = this.previewTtsCache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.ts > this.previewTtsCacheTtlMs) {
            try {
                URL.revokeObjectURL(entry.url);
            } catch (_) { }
            this.previewTtsCache.delete(key);
            return null;
        }
        return entry;
    }

    _isPreviewCacheKeyActive(key) {
        if (!key || !this.previewTtsCache) return false;
        return this.previewTtsCache.has(key);
    }

    _findPreviewCacheKeyByUrl(url) {
        if (!url || !this.previewTtsCache) return null;
        for (const [key, entry] of this.previewTtsCache.entries()) {
            if (entry && entry.url === url) return key;
        }
        return null;
    }

    estimateSpeechDurationMs(text) {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
        if (!words) return 2000;
        const wordsPerSecond = 2.2; // ~132 wpm
        const baseMs = 900; // small buffer for TTS start/finish
        const ms = Math.round((words / wordsPerSecond) * 1000 + baseMs);
        const withSafety = ms + 5000; // extra 5s safety to avoid cutting the tail
        return Math.min(Math.max(withSafety, 2000), 30000);
    }

    async cancelIfActiveResponse() {
        if (!this._activeResponseId && (!this.pendingResponses || this.pendingResponses.size === 0)) return;
        await this.cancelActiveResponses().catch(() => { });
        await this.waitForAudioToFinish().catch(() => { });
        await this.sleep(150);
    }

    _endOneShot({ responseId = null, force = false } = {}) {
        if (!this._oneShot) return;
        if (!force && responseId && this._oneShot.responseId && responseId !== this._oneShot.responseId) return;
        const restore = this._oneShot.restoreAudio;
        const wasPreview = !!this._oneShot.suppressFromUI;
        const startedAt = this._oneShot.startedAt || Date.now();
        const restoreDelayMs = this._oneShot.restoreDelayMs || 0;
        try {
            if (this._oneShot._resolveStarted && !this._oneShot._startedResolved) {
                this._oneShot._startedResolved = true;
                this._oneShot._resolveStarted(false);
            }
        } catch (_) { }
        this._oneShot = null;
        if (wasPreview) {
            // Don't clear immediately; let the animation follow actual audio levels.
            this.schedulePreviewClear();
        }
        if (restore) {
            const applyRestore = () => {
                this.isSoundEnabled = !!restore.isSoundEnabled;
                this.setCallAudioEnabled(!!restore.isCallAudioEnabled);
            };

            // If preview temporarily enabled audio outside call mode, wait for local audio queue to drain.
            if (!restore.isCallAudioEnabled) {
                const waitUntilIdle = () => {
                    const queueEmpty = !this.audioQueue || this.audioQueue.length === 0;
                    if (!this.isPlaying && queueEmpty) {
                        const remaining = Math.max(0, restoreDelayMs - (Date.now() - startedAt));
                        setTimeout(applyRestore, Math.max(200, remaining));
                    } else {
                        setTimeout(waitUntilIdle, 120);
                    }
                };
                waitUntilIdle();
            } else {
                applyRestore();
            }
        }
    }

    schedulePreviewClear() {
        if (this._previewClearTimer) {
            clearTimeout(this._previewClearTimer);
        }
        const check = () => {
            const now = Date.now();
            const last = this.lastRemoteLevelAt || 0;
            const quietFor = now - last;
            // Only clear after a quiet period so the animation matches audio tail.
            if (quietFor > 1200) {
                this.currentPreviewCompanionId = null;
                if (window.uiLayout && typeof window.uiLayout.updateSpeakerLevel === 'function') {
                    window.uiLayout.updateSpeakerLevel(this, 0);
                }
                this._previewClearTimer = null;
                return;
            }
            this._previewClearTimer = setTimeout(check, 300);
        };
        this._previewClearTimer = setTimeout(check, 300);
    }

    async _maybeSendOpeningLine({ skipIfSent = true } = {}) {
        if (!this.openingLinePrompt) return false;
        if (skipIfSent && this.openingLineSent) return false;
        const ok = await this.speakOneShot({
            promptText: this.openingLinePrompt,
            suppressFromUI: false,
            ensureSpeaker: false
        });
        if (ok) this.openingLineSent = true;
        return ok;
    }

    _waitForDataChannelOpen(timeoutMs = 10_000) {
        const start = Date.now();
        return new Promise((resolve, reject) => {
            const tick = () => {
                if (this.dataChannel && this.dataChannel.readyState === 'open') return resolve();
                if (!this.isConnected && !this.isConnecting) return reject(new Error('Not connected'));
                if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for data channel'));
                setTimeout(tick, 100);
            };
            tick();
        });
    }

    // ---- Companions cache + normalization (API schema can vary) ----
    loadCompanionsCache() {
        try {
            const raw = window.localStorage?.getItem(this._companionsCacheKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.companions)) return null;
            if (typeof parsed.ts !== 'number') return null;
            if (Date.now() - parsed.ts > this._companionsCacheTtlMs) return null;
            return parsed;
        } catch (_) {
            return null;
        }
    }

    saveCompanionsCache(companions) {
        try {
            window.localStorage?.setItem(
                this._companionsCacheKey,
                JSON.stringify({ ts: Date.now(), companions })
            );
        } catch (_) { }
    }

    renderCachedCompanions() {
        const cached = this.loadCompanionsCache();
        if (!cached || !Array.isArray(cached.companions) || cached.companions.length === 0) return;
        if (typeof this.renderCoachList === 'function') {
            this.renderCoachList(cached.companions);
        }
    }

    normalizeCompanions(rawList) {
        if (!Array.isArray(rawList)) return [];
        const out = [];
        for (const entry of rawList) {
            if (!entry || typeof entry !== 'object') continue;

            // API sometimes nests the config as entry.configuration.configuration
            let cfg = entry.configuration;
            if (cfg && typeof cfg === 'object' && cfg.configuration && typeof cfg.configuration === 'object') {
                cfg = cfg.configuration;
            }
            cfg = (cfg && typeof cfg === 'object') ? cfg : {};

            const companionId =
                entry.companionId ||
                cfg.companionId ||
                cfg.id ||
                cfg.character ||
                entry._id ||
                'Coach';

            const normalizedCfg = {
                ...cfg,
                companionId: cfg.companionId || entry.companionId || cfg.id || cfg.character || companionId,
                id: cfg.id || cfg.companionId || entry.companionId || cfg.character || companionId,
                character: cfg.character || cfg.id || cfg.companionId || companionId,
                label: cfg.label || cfg.role || '',
                openaiVoice: cfg.openaiVoice || '',
                thumb: cfg.thumb || null,
                // Normalize voice speed buckets (API may send Slow/Medium/Fast)
                voiceSpeed: this.normalizeSpeedValue(cfg.voiceSpeed || 'normal')
            };

            // Keep only companions that can actually be selected
            if (!normalizedCfg.openaiVoice) continue;

            out.push({
                ...entry,
                companionId,
                configuration: normalizedCfg
            });
        }
        // Keep API order, but ensure the "primary" coach (Erica / Supportive) is first.
        // Do a stable sort using the original index.
        const withIdx = out.map((c, idx) => ({ c, idx }));
        const isPrimary = (comp) => {
            const cfg = comp?.configuration || {};
            const cid = String(comp?.companionId || '').toLowerCase();
            const id = String(cfg.id || cfg.companionId || '').toLowerCase();
            const character = String(cfg.character || '').toLowerCase();
            // common representations for the default coach
            return cid === 'supportive' || id === 'supportive' || character === 'erica';
        };
        withIdx.sort((a, b) => {
            const ap = isPrimary(a.c) ? 0 : 1;
            const bp = isPrimary(b.c) ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return a.idx - b.idx;
        });
        return withIdx.map(x => x.c);
    }

    promptCoachNameChange() {
        try {
            const current =
                (this.currentVoiceProfile && this.currentVoiceProfile.character) ||
                (this.statusText && this.statusText.textContent) ||
                '';
            if (typeof this.openCoachNameModal === 'function') {
                this.openCoachNameModal(current || '');
                return;
            }
            const next = window.prompt('Coach name:', current || '');
            if (next === null) return; // cancelled
            const trimmed = String(next).trim();
            if (!trimmed) return;
            this.setCoachDisplayName(trimmed);
        } catch (e) {
            console.warn('[Erica] promptCoachNameChange failed:', e);
        }
    }

    getCoachNameStorageKey() {
        const id =
            (this.selectedCompanionId) ||
            (this.currentVoiceProfile && (this.currentVoiceProfile.id || this.currentVoiceProfile.character)) ||
            this.selectedVoice ||
            'coach';
        return `ERICA_COACH_NAME_${String(id).toLowerCase()}`;
    }

    getVoiceSpeedStorageKey() {
        const id =
            (this.selectedCompanionId) ||
            (this.currentVoiceProfile && (this.currentVoiceProfile.id || this.currentVoiceProfile.character)) ||
            this.selectedVoice ||
            'coach';
        return `ERICA_VOICE_SPEED_${String(id).toLowerCase()}`;
    }

    setVoiceSpeed(speedValue) {
        // Expected values: 'slow' | 'normal' | 'fast'
        if (!speedValue) return;
        const normalized = this.normalizeSpeedValue(String(speedValue));
        if (this.currentVoiceProfile) {
            this.currentVoiceProfile.voiceSpeed = normalized;
        }
        // Save to localStorage for persistence across sessions
        try {
            const key = this.getVoiceSpeedStorageKey();
            window.localStorage?.setItem(key, normalized);
        } catch (_) { }
        // Push updated instructions to OpenAI
        this.configureSession();
    }

    getDebugEnabled() {
        try {
            const raw = window.location && window.location.search ? window.location.search : '';
            const params = new URLSearchParams(raw);
            if (params.get('ericaDebug') === '1') return true;
        } catch (_) { }
        try {
            return String(window.localStorage?.getItem('ERICA_DEBUG') || '') === '1';
        } catch (_) { }
        return false;
    }

    getDisableHistoryFetch() {
        try {
            const raw = window.location && window.location.search ? window.location.search : '';
            const params = new URLSearchParams(raw);
            if (params.get('disableHistoryFetch') === '1') return true;
        } catch (_) { }
        try {
            return String(window.localStorage?.getItem('DISABLE_HISTORY_FETCH') || '') === '1';
        } catch (_) { }
        return true; // default: disabled for now
    }

    getTuningEnabled() {
        try {
            const raw = window.location && window.location.search ? window.location.search : '';
            const params = new URLSearchParams(raw);
            return params.get('tune') === '1';
        } catch (_) { }
        return false;
    }

    getTuningToken() {
        try {
            const raw = window.location && window.location.search ? window.location.search : '';
            const params = new URLSearchParams(raw);
            const t = params.get('tuneToken');
            return t ? String(t) : null;
        } catch (_) { }
        return null;
    }

    getUrlVoiceMode() {
        try {
            const raw = window.location && window.location.search ? window.location.search : '';
            const params = new URLSearchParams(raw);
            const vm = params.get('voiceMode') || params.get('talk_mode') || params.get('voice');
            return vm === 'true' || vm === '1' || vm === 'yes' || vm === 'y';
        } catch (_) { }
        return false;
    }

    getUrlCoach() {
        try {
            const raw = window.location && window.location.search ? window.location.search : '';
            const params = new URLSearchParams(raw);
            const val = params.get('coach') || params.get('aic');
            return val ? String(val).toLowerCase() : null;
        } catch (_) { }
        return null;
    }

    getUrlAutoSubmit() {
        try {
            const raw = window.location && window.location.search ? window.location.search : '';
            const params = new URLSearchParams(raw);
            const val = params.get('autosubmit');
            // Default is true (auto-send). Only false when explicitly set to 'n' or 'false' or '0'
            if (val === 'n' || val === 'no' || val === 'false' || val === '0') return false;
            return true;
        } catch (_) { }
        return true;
    }

    getUrlQuestion() {
        try {
            const raw = window.location && window.location.search ? window.location.search : '';
            const params = new URLSearchParams(raw);
            const val = params.get('question') || params.get('q');
            if (!val) return null;
            const trimmed = String(val).trim();
            return trimmed.length > 500 ? trimmed.substring(0, 500) : trimmed;
        } catch (_) { }
        return null;
    }

    applyUrlCoachSelection() {
        const urlCoach = this.getUrlCoach();
        if (!urlCoach) return false;

        const profile = this.voiceProfilesById && (
            this.voiceProfilesById[urlCoach] ||
            // also try original casing by scanning keys
            Object.values(this.voiceProfilesById).find(p =>
                (p.companionId || '').toLowerCase() === urlCoach ||
                (p.id || '').toLowerCase() === urlCoach
            )
        );

        if (!profile) {
            console.warn(`[Erica] URL coach "${urlCoach}" not found in profiles — will show coach selection.`);
            // Mark as invalid so shouldShowCoachSelection() doesn't skip the screen
            this._urlCoachInvalid = true;
            return false;
        }

        const thumb = profile.thumb
            ? (typeof this.apiUrl === 'function' ? this.apiUrl('/' + profile.thumb.replace(/^\//, '')) : profile.thumb)
            : null;

        this._userExplicitlySelectedCoach = true; // Valid URL coach counts as explicit choice
        this.setSelectedVoice(
            profile.openaiVoice || 'marin',
            thumb,
            profile.character || profile.id || 'Coach',
            profile.companionId || null
        );
        console.log(`[Erica] URL coach applied: "${profile.character || profile.companionId}"`);
        return true;
    }

    isAllowedTuningOrigin(origin) {
        if (!origin || typeof origin !== 'string') return false;
        // Allow local dev + production TT origins for boss demos
        if (origin.startsWith('http://localhost')) return true;
        if (origin.startsWith('http://127.0.0.1')) return true;
        if (origin === 'https://apps.talenttransformation.com') return true;
        if (origin === 'https://talenttransformation.com') return true;
        if (origin.endsWith('.up.railway.app')) return true;
        if (origin.endsWith('.awav.com') || origin === 'https://awav.com') return true;
        return false;
    }

    setupTuningMessaging() {
        if (!this.tuningEnabled) return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

        window.addEventListener('message', (event) => {
            try {
                if (!this.isAllowedTuningOrigin(event.origin)) return;
                const data = event.data;
                if (!data || typeof data !== 'object') return;

                // Optional shared token check (if iframe URL includes tuneToken)
                if (this.tuningToken && data.token !== this.tuningToken) {
                    return;
                }

                if (data.type === 'erica-request-tuning-state') {
                    const persona = this.getEffectiveVoiceProfile() || this.currentVoiceProfile || null;
                    const payload = {
                        companionId: persona ? (persona.companionId || persona.id || null) : null,
                        openaiVoice: persona ? (persona.openaiVoice || null) : (this.selectedVoice || null),
                        character: persona ? (persona.character || '') : '',
                        label: persona ? (persona.label || '') : '',
                        userFacingContext: persona ? (persona.userFacingContext || '') : '',
                        coachingStyle: persona && typeof persona.coachingStyle === 'object' && persona.coachingStyle ? persona.coachingStyle : {},
                        voiceProfile: persona && typeof persona.voiceProfile === 'object' && persona.voiceProfile ? persona.voiceProfile : {},
                        agentGuidance: persona ? (persona.agentGuidance || '') : '',
                        behavioralGuardrails: persona && Array.isArray(persona.behavioralGuardrails) ? persona.behavioralGuardrails : [],
                        conversationStyle: persona && Array.isArray(persona.conversationStyle) ? persona.conversationStyle : [],
                        customInstructions: (this.preparationOverrides && typeof this.preparationOverrides.customInstructions === 'string')
                            ? this.preparationOverrides.customInstructions
                            : (this.customInstructions || ''),
                        openingLinePrompt: (this.preparationOverrides && typeof this.preparationOverrides.openingLinePrompt === 'string')
                            ? this.preparationOverrides.openingLinePrompt
                            : (this.openingLinePrompt || '')
                    };
                    event.source?.postMessage({ type: 'erica-tuning-state', payload }, event.origin);
                    return;
                }

                if (data.type === 'erica-apply-overrides') {
                    console.log('[Erica][TUNE] Received erica-apply-overrides', {
                        origin: event.origin,
                        hasToken: !!data.token,
                        hasPayload: !!data.payload
                    });
                    const payload = data.payload || {};
                    const companionPatch = payload.companionPatch || {};
                    const prepPatch = payload.preparationPatch || {};

                    // Validate minimal shapes
                    const nextBehaviorOverrides = {};
                    if (typeof companionPatch.agentGuidance === 'string') nextBehaviorOverrides.agentGuidance = companionPatch.agentGuidance;
                    if (typeof companionPatch.character === 'string') nextBehaviorOverrides.character = companionPatch.character;
                    if (typeof companionPatch.label === 'string') nextBehaviorOverrides.label = companionPatch.label;
                    if (typeof companionPatch.userFacingContext === 'string') nextBehaviorOverrides.userFacingContext = companionPatch.userFacingContext;
                    if (companionPatch.coachingStyle && typeof companionPatch.coachingStyle === 'object' && !Array.isArray(companionPatch.coachingStyle)) {
                        nextBehaviorOverrides.coachingStyle = companionPatch.coachingStyle;
                    }
                    if (companionPatch.voiceProfile && typeof companionPatch.voiceProfile === 'object' && !Array.isArray(companionPatch.voiceProfile)) {
                        nextBehaviorOverrides.voiceProfile = companionPatch.voiceProfile;
                    }
                    if (Array.isArray(companionPatch.behavioralGuardrails)) nextBehaviorOverrides.behavioralGuardrails = companionPatch.behavioralGuardrails;
                    if (Array.isArray(companionPatch.conversationStyle)) nextBehaviorOverrides.conversationStyle = companionPatch.conversationStyle;
                    this.behaviorOverrides = nextBehaviorOverrides;

                    const nextPrepOverrides = {};
                    if (typeof prepPatch.customInstructions === 'string') nextPrepOverrides.customInstructions = prepPatch.customInstructions;
                    if (typeof prepPatch.openingLinePrompt === 'string') nextPrepOverrides.openingLinePrompt = prepPatch.openingLinePrompt;
                    this.preparationOverrides = nextPrepOverrides;

                    // Apply immediately to current in-memory fields too (so UI + next rebuild uses them)
                    if (typeof nextPrepOverrides.customInstructions === 'string') {
                        this.customInstructions = nextPrepOverrides.customInstructions;
                    }
                    if (typeof nextPrepOverrides.openingLinePrompt === 'string') {
                        this.openingLinePrompt = nextPrepOverrides.openingLinePrompt;
                        // Allow the tuned opening line to fire again if desired (only if no history)
                        this.openingLineSent = false;
                    }

                    // Push a new session.update right away (if connected)
                    this.configureSession();

                    const sentOk = !!this.lastSessionConfig?.sentOk;
                    const readyState = this.dataChannel?.readyState;
                    const err =
                        sentOk ? null :
                            (!this.dataChannel ? 'DataChannel not created yet' :
                                (readyState !== 'open' ? `DataChannel not open (state=${readyState})` : 'Unknown send failure'));

                    console.log('[Erica][TUNE] Overrides applied', {
                        sentOk,
                        readyState,
                        agentGuidanceLen: typeof nextBehaviorOverrides.agentGuidance === 'string' ? nextBehaviorOverrides.agentGuidance.length : 0,
                        guardrailsCount: Array.isArray(nextBehaviorOverrides.behavioralGuardrails) ? nextBehaviorOverrides.behavioralGuardrails.length : 0,
                        conversationStyleCount: Array.isArray(nextBehaviorOverrides.conversationStyle) ? nextBehaviorOverrides.conversationStyle.length : 0,
                        customInstructionsLen: typeof this.customInstructions === 'string' ? this.customInstructions.length : 0,
                        openingLinePromptLen: typeof this.openingLinePrompt === 'string' ? this.openingLinePrompt.length : 0
                    });

                    event.source?.postMessage(
                        { type: 'erica-overrides-applied', ok: sentOk, error: err },
                        event.origin
                    );
                    return;
                }
            } catch (err) {
                try {
                    event.source?.postMessage({ type: 'erica-overrides-applied', ok: false, error: err?.message || String(err) }, event.origin);
                } catch (_) { }
            }
        });
    }

    getEffectiveVoiceProfile() {
        if (!this.currentVoiceProfile) return null;
        if (!this.behaviorOverrides) return this.currentVoiceProfile;
        return {
            ...this.currentVoiceProfile,
            ...this.behaviorOverrides
        };
    }

    dlog(...args) {
        if (this.debugEnabled) {
            console.log(...args);
        }
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Fetch helper that retries on HTTP 429 using exponential backoff + jitter.
     * This is important for Wix Functions which may throttle bursty traffic.
     */
    async fetchWithBackoff(url, options, { label = 'request', retries = 4 } = {}) {
        let attempt = 0;
        while (true) {
            attempt++;
            const res = await fetch(url, options);

            if (res.status !== 429 || attempt > retries) {
                return res;
            }

            const ra = res.headers?.get ? res.headers.get('retry-after') : null;
            const retryAfterMs =
                ra && !Number.isNaN(Number(ra)) ? Math.max(500, Number(ra) * 1000) : 0;

            const backoffMs =
                retryAfterMs ||
                Math.min(12000, 800 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400);

            console.warn(`[Erica] ${label} got 429, retrying`, { attempt, backoffMs });
            await this.sleep(backoffMs);
        }
    }

    detectBasePath() {
        // Get the pathname (e.g., "/erica/" or "/" or "/erica/index.html")
        const pathname = window.location.pathname;

        // Remove filename if present (e.g., "index.html")
        let basePath = pathname.replace(/\/[^/]*\.(html|htm)$/, '');

        // If pathname ends with just "/", keep it
        // Otherwise, ensure it ends with "/"
        if (!basePath.endsWith('/')) {
            basePath = basePath + '/';
        }

        // If we're at root, basePath should be "/"
        if (basePath === '//') {
            basePath = '/';
        }

        return basePath;
    }

    apiUrl(path) {
        // Prevent double-prefixing if path already contains basePath
        if (path.startsWith(this.basePath)) {
            return path;
        }
        // Also check if basePath is just "/" to avoid issues, though logic below handles it.
        // If basePath is "/agentErica/" and path is "/agentErica/companions/...", return path.

        // Remove leading slash from path if present, then combine with basePath
        const cleanPath = path.startsWith('/') ? path.substring(1) : path;
        const fullUrl = `${this.basePath}${cleanPath}`;

        // Log for debugging route issues
        if (path.includes('search')) {
            console.log('[Erica] 🔍 apiUrl constructed:', {
                inputPath: path,
                cleanPath: cleanPath,
                basePath: this.basePath,
                fullUrl: fullUrl,
                absoluteUrl: window.location.origin + fullUrl
            });
        }
        return fullUrl;
    }

    async loadVoiceProfiles() {
        try {
            const response = await fetch(this.apiUrl('voiceProfiles.json'));
            if (response.ok) {
                const data = await response.json();
                console.log('[Erica] Voice profiles loaded successfully');

                // Normalize array structure (new schema)
                const profilesArray = Array.isArray(data) ? data : [];
                this.voiceProfilesArray = profilesArray;
                this.voiceProfilesByVoice = {}; // voice -> [profiles]
                this.voiceProfilesById = {};    // id/companionId/character -> profile

                profilesArray.forEach((entry) => {
                    if (!entry || !entry.configuration) return;
                    const cfg = entry.configuration;
                    const companionId = (entry.companionId || cfg.id || cfg.character || '').toLowerCase();
                    const openaiVoice = (cfg.openaiVoice || '').toLowerCase();

                    // store original configuration augmented with companionId
                    const normalized = { ...cfg, companionId: entry.companionId || cfg.id || cfg.character };
                    if (openaiVoice) {
                        if (!this.voiceProfilesByVoice[openaiVoice]) this.voiceProfilesByVoice[openaiVoice] = [];
                        this.voiceProfilesByVoice[openaiVoice].push(normalized);
                    }
                    if (companionId) this.voiceProfilesById[companionId] = normalized;
                    const idKey = (cfg.id || '').toLowerCase();
                    if (idKey) this.voiceProfilesById[idKey] = normalized;
                    const charKey = (cfg.character || '').toLowerCase();
                    if (charKey) this.voiceProfilesById[charKey] = normalized;
                });

                // Set default profile (Erica - marin voice)
                this.currentVoiceProfile = (this.voiceProfilesByVoice['marin'] && this.voiceProfilesByVoice['marin'][0]) || null;
                // Backward compatibility reference
                this.voiceProfiles = this.voiceProfilesByVoice;
                this.updateVoiceProfile('marin');
                // Ensure UI (status, panel) reflect default profile once data is loaded
                if (!this.applyUrlCoachSelection() && !this._urlCoachInvalid) {
                    // No URL coach — use default (marin)
                    if (this.voiceMenuItems && this.voiceMenuItems.length > 0) {
                        const defaultItem = this.voiceMenuItems.find(item => item.getAttribute('data-voice') === 'marin');
                        this.setSelectedVoice(
                            'marin',
                            defaultItem ? defaultItem.getAttribute('data-thumb') : null,
                            defaultItem ? defaultItem.getAttribute('data-character') : null
                        );
                    } else {
                        this.populateAgentDetailsPanel();
                    }
                }
                // Play idle video for selected voice
                if (this.currentVoiceProfile) {
                    this.updateCurrentVoiceVideo('idle');
                }
            } else {
                console.warn('[Erica] Failed to load voice profiles:', response.status);
            }
        } catch (error) {
            console.error('[Erica] Error loading voice profiles:', error);
        }
    }

    updateVoiceProfile(openaiVoice) {
        // Normalize maps if needed
        if (!this.voiceProfilesByVoice && this.voiceProfilesArray) {
            this.voiceProfilesByVoice = {}; // voice -> [profiles]
            this.voiceProfilesById = {};    // id/companionId/character -> profile
            this.voiceProfilesArray.forEach((entry) => {
                const cfg = entry?.configuration;
                if (!cfg) return;
                const voiceKey = (cfg.openaiVoice || '').toLowerCase();
                const companionId = (entry.companionId || cfg.id || cfg.character || '').toLowerCase();
                const normalized = { ...cfg, companionId: entry.companionId || cfg.id || cfg.character };
                if (voiceKey) {
                    if (!this.voiceProfilesByVoice[voiceKey]) this.voiceProfilesByVoice[voiceKey] = [];
                    this.voiceProfilesByVoice[voiceKey].push(normalized);
                }
                if (companionId) this.voiceProfilesById[companionId] = normalized;
                const idKey = (cfg.id || '').toLowerCase();
                if (idKey) this.voiceProfilesById[idKey] = normalized;
                const charKey = (cfg.character || '').toLowerCase();
                if (charKey) this.voiceProfilesById[charKey] = normalized;
            });
        }

        const key = openaiVoice ? openaiVoice.toLowerCase() : null;
        // Prefer explicit companion selection (prevents merging coaches that share the same voice)
        const selectedIdKey = this.selectedCompanionId ? String(this.selectedCompanionId).toLowerCase() : null;
        const bySelectedId =
            selectedIdKey && this.voiceProfilesById && this.voiceProfilesById[selectedIdKey]
                ? this.voiceProfilesById[selectedIdKey]
                : null;

        const byId =
            (key && this.voiceProfilesById && this.voiceProfilesById[key]) || null;

        const byVoiceArr =
            (key && this.voiceProfilesByVoice && Array.isArray(this.voiceProfilesByVoice[key]))
                ? this.voiceProfilesByVoice[key]
                : null;

        const profile = bySelectedId || byId || (byVoiceArr ? byVoiceArr[0] : null);

        if (!profile) {
            console.warn('[Erica] Voice profile not found for voice:', openaiVoice);
            return;
        }

        this.currentVoiceProfile = profile;
        // console.log('[Erica] Updated voice profile:', profile.character || profile.companionId || 'unknown');

        // Restore custom name from localStorage if previously renamed
        try {
            const nameKey = this.getCoachNameStorageKey();
            const savedName = window.localStorage?.getItem(nameKey);
            if (savedName) {
                this.currentVoiceProfile.character = savedName;
            }
        } catch (_) { }

        // Load saved voice speed from localStorage if available
        /* try {
            const key = this.getVoiceSpeedStorageKey();
            const savedSpeed = window.localStorage?.getItem(key);
            if (savedSpeed) {
                this.currentVoiceProfile.voiceSpeed = this.normalizeSpeedValue(savedSpeed);
            }
        } catch (_) { } */

        // Ensure we keep a thumb URL even if the header avatar DOM is removed in the new UI
        const resolvedThumb = this.resolveCompanionThumb(profile);
        if (resolvedThumb) {
            this.currentVoiceThumbUrl = resolvedThumb;
            if (this.currentVoiceThumb) {
                this.currentVoiceThumb.src = resolvedThumb;
                this.currentVoiceThumb.alt =
                    profile.character || profile.label || profile.id || openaiVoice || 'Coach';
            }
        }

        // Update voice style instructions
        this.voiceStyleInstructions = this.buildVoiceStyleInstructions();

        // Update persona context
        this.personaContext = this.currentVoiceProfile.userFacingContext || '';

        // Update session configuration
        this.configureSession();

        // Update UI elements (including coach type text)
        this.populateAgentDetailsPanel();
    }

    buildVoiceStyleInstructions(personaOverride = null) {
        const persona = personaOverride || this.getEffectiveVoiceProfile() || this.currentVoiceProfile;
        if (!persona) {
            return '';
        }

        let instructions = '';

        // Persona label / role
        if (persona.label) {
            instructions += `\n\nPersona Label: ${persona.label}`;
        }

        // Add coaching style information
        if (persona.coachingStyle) {
            const cs = persona.coachingStyle;
            const primary = cs.primaryObjective || cs.type || '';
            const desc = cs.description || '';
            const strengths = cs.strengths || '';
            const limits = cs.limits || '';
            instructions += `\n\nCoaching Style: ${primary}${desc ? `\n${desc}` : ''}${strengths ? `\nStrengths: ${strengths}` : ''}${limits ? `\nLimits: ${limits}` : ''}`;
        }

        // Add agent guidance (most important for behavior)
        if (persona.agentGuidance) {
            instructions += `\n\n${persona.agentGuidance}`;
        }

        // Add behavioral guardrails
        if (Array.isArray(persona.behavioralGuardrails) && persona.behavioralGuardrails.length > 0) {
            instructions += `\n\nBehavioral Guardrails (follow strictly):`;
            persona.behavioralGuardrails.forEach((g) => {
                const parts = [];
                if (g.priority) parts.push(`priority: ${g.priority}`);
                if (g.type) parts.push(`type: ${g.type}`);
                if (g.condition) parts.push(`condition: ${g.condition}`);
                if (g.trigger) parts.push(`trigger: ${g.trigger}`);
                const meta = parts.length ? ` [${parts.join(', ')}]` : '';
                instructions += `\n- ${g.directive || g.id || ''}${meta}`;
            });
        }

        // Add conversation style examples
        if (persona.conversationStyle && Array.isArray(persona.conversationStyle) && persona.conversationStyle.length > 0) {
            instructions += `\n\nExample conversation approaches:`;
            persona.conversationStyle.forEach((style) => {
                instructions += `\n- ${style}`;
            });
        }

        // Determine pacing instruction from UI selection
        let pacingOverride = null;
        let pausesOverride = null;
        if (persona.voiceSpeed) {
            const s = String(persona.voiceSpeed).toLowerCase().trim();
            if (s === 'slow') {
                pacingOverride = "Very Slow. Speak deliberately and slowly, like a thoughtful teacher.";
                pausesOverride = "Long, distinct pauses between every sentence.";
            } else if (s === 'fast') {
                pacingOverride = "Very Fast. Speak rapidly and energetically.";
                pausesOverride = "Minimal to no pauses. Keep the flow continuous.";
            } else {
                pacingOverride = "Normal conversational pace.";
            }
        }

        // Add voice profile (affect, tone, pacing, etc.)
        if (persona.voiceProfile) {
            const vp = persona.voiceProfile;
            // Use explicit speed setting if available, otherwise fallback to profile default
            const effectivePacing = pacingOverride || vp.pacing;
            const effectivePauses = pausesOverride || vp.pauses;

            // Fix 4: Strip any XML/SSML-like tags that may leak into voice profile values
            // (e.g., Emma's config had raw <voice tone="..."> tags that appeared in user-visible output)
            const sanitize = (s) => typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : (s || '');

            instructions += `\n\nVoice Style Guidelines:
- Voice Affect: ${sanitize(vp.affect)}
- Tone: ${sanitize(vp.tone)}
- Pacing: ${sanitize(effectivePacing)}
- Emotion: ${sanitize(vp.emotion)}
- Pronunciation: ${sanitize(vp.pronunciation)}
- Pauses: ${sanitize(effectivePauses)}`;
        } else if (pacingOverride) {
            instructions += `\n\nPacing Guidelines: ${pacingOverride}\nPauses: ${pausesOverride || 'Natural'}`;
        }

        instructions += `\n\nEmbody this coaching style and voice in all your responses.`;

        return instructions;
    }

    /**
     * Load saved session state from localStorage
     */
    loadSavedState() {
        if (!this.stateManager) {
            return null;
        }

        const state = this.stateManager.loadSessionState();
        if (!state) {
            return null;
        }

        // console.log('[Erica] Restoring saved session state');

        // Restore selected coach and update UI
        if (state.selectedCoach) {
            // Restore the explicit choice flag from saved state
            // Legacy states (before flag was added) have companionId but no userChoseCoach —
            // if they have a companionId, they DID choose (it was just saved in the old format)
            this._userExplicitlySelectedCoach = !!state.userChoseCoach || !!state.selectedCoach.companionId;
            // Call setSelectedVoice to properly update all UI elements
            this.setSelectedVoice(
                state.selectedCoach.voice || 'marin',
                state.selectedCoach.thumb || null,
                state.selectedCoach.name || 'Coach',
                state.selectedCoach.companionId || null,
                true // skipSave: prevent overwriting mode during restoration
            );
        }

        // Restore conversation history if available
        if (state.conversationHistory && Array.isArray(state.conversationHistory)) {
            this.restoreConversationHistory(state.conversationHistory);
        }

        return state;
    }

    /**
     * Save current session state to localStorage
     */
    saveCurrentState(mode = 'chat') {
        if (!this.stateManager) {
            return;
        }

        const state = {
            mode: mode,
            userChoseCoach: this._userExplicitlySelectedCoach || false,
            selectedCoach: {
                companionId: this.selectedCompanionId,
                voice: this.selectedVoice,
                name: this.currentVoiceProfile?.character || this.currentVoiceProfile?.id || 'Coach',
                thumb: this.currentVoiceThumbUrl
            },
            conversationHistory: this.getConversationHistory(),
            userId: this.getUserIdFromURL()
        };

        if (this.currentVoiceThumbUrl && !this.currentVoiceThumbUrl.startsWith('http')) {
            // Ensure absolute URL for live server persistence
            // This handles relative paths like /companions/foo.png or companions/foo.png
            try {
                if (typeof this.apiUrl === 'function') {
                    // apiUrl returns path-absolute (e.g. /agenterica/companions/...), so we prepend origin
                    const path = this.apiUrl(this.currentVoiceThumbUrl);
                    state.selectedCoach.thumb = new URL(path, window.location.origin).href;
                } else {
                    state.selectedCoach.thumb = new URL(this.currentVoiceThumbUrl, window.location.origin).href;
                }
            } catch (_) {
                // validation fallback
                state.selectedCoach.thumb = this.currentVoiceThumbUrl;
            }
        }

        this.stateManager.saveSessionState(state);
    }

    /**
     * Determine if coach selection should be shown
     */
    shouldShowCoachSelection() {
        // v3 UX default: open directly on chat with Erica ("Supportive" / marin)
        // as the default coach. The coach picker is NOT shown at boot anymore;
        // users open it via the "Switch Coaching Style" menu item or the
        // back-to-list button whenever they want to change coach.
        //
        // Two escape hatches keep the old flow reachable:
        //  1. Invalid URL coach — fall back to picker so user can choose manually
        //  2. Explicit URL flag ?picker=1 (or ?showPicker=1) — opt back in

        if (this._urlCoachInvalid) return true;

        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('picker') === '1' || params.get('showPicker') === '1') return true;
        } catch (_) { /* URL parsing failure is non-fatal */ }

        return false;
    }

    /**
     * Determine if the AI Navigator quiz should be shown.
     * v3 UX default: skip the multi-question quiz. Chat with Erica opens
     * directly. The quiz is still available via ?nav=1 URL flag for anyone
     * who wants the guided coach discovery.
     */
    shouldShowNavigator() {
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('nav') === '1' || params.get('navigator') === '1') return true;
        } catch (_) { /* URL parsing failure is non-fatal */ }
        return false;
    }

    /**
     * Show the AI Navigator quiz, then render coach list with results.
     */
    _showNavigator(companionsList) {
        const voiceMenuScroll = document.getElementById('voiceMenuScroll');
        if (!voiceMenuScroll) {
            // Fallback: no scroll container, just render coach list
            this.renderCoachList(companionsList);
            return;
        }

        // Hide the default header, coach list, and input bar while navigator is showing
        const header = document.getElementById('coachListHeader');
        if (header) header.style.display = 'none';
        const coachList = document.getElementById('coachList');
        if (coachList) coachList.style.display = 'none';
        const inputWrapper = document.getElementById('inputWrapper');
        if (inputWrapper) inputWrapper.style.display = 'none';

        const nav = new EricaNavigator(voiceMenuScroll, {
            onComplete: (result) => {
                this.navigatorTags = result.tags || null;
                console.log('[Erica] Navigator completed:', result);
                if (coachList) coachList.style.display = '';
                if (inputWrapper) inputWrapper.style.display = '';
                this.renderCoachList(companionsList, result);
            },
            onSkip: () => {
                console.log('[Erica] Navigator skipped');
                if (header) header.style.display = '';
                if (coachList) coachList.style.display = '';
                if (inputWrapper) inputWrapper.style.display = '';
                this.renderCoachList(companionsList);
            },
            trackEvent: (name, props) => {
                if (typeof this.trackCoachEvent === 'function') {
                    this.trackCoachEvent(name, props);
                }
            }
        });

        nav.load().then(() => {
            nav.show();
        }).catch(err => {
            console.warn('[Erica] Navigator failed to load, showing coach list:', err);
            if (header) header.style.display = '';
            this.renderCoachList(companionsList);
        });
    }

    async autoConnect() {
        // SECURITY: Never fetch or store long-lived OpenAI API keys in the browser.
        // The server-side proxy holds the OpenAI key and negotiates Realtime.
        try {
            setTimeout(() => {
                // Avoid storms if multiple instances exist or connect is already running.
                if (this.isConnected || this.isConnecting) return;
                // When a URL coach is specified, fire the opening line; otherwise preload silently.
                const skipOpeningLine = !this.getUrlCoach();
                this.connect({ skipOpeningLine }).catch(() => { });
            }, 500);
        } catch (_) {
            // Silently fail
        }
    }

    flushPendingBotMessages(insertAfterMessage) {
        if (!insertAfterMessage || this.pendingBotMessages.length === 0) {
            return;
        }

        // Temporarily set the last finalized user message for insertion ordering
        this.lastFinalizedUserMessage = insertAfterMessage;

        // Drain the queue in order
        const pending = [...this.pendingBotMessages];
        this.pendingBotMessages = [];

        pending.forEach(msg => {
            this.updateBotMessage(msg.id, msg.text, msg.isFinal, msg.timestamp);
        });
    }

    getConversationHistory() {
        // Get all messages sorted by timestamp and sequence
        const sorted = [...this.messages].sort((a, b) => {
            if (a.timestamp !== b.timestamp) {
                return a.timestamp - b.timestamp;
            }
            return a.seq - b.seq;
        });

        // Format for database storage
        return sorted.map(msg => ({
            id: msg.id,
            role: msg.role === 'bot' ? 'assistant' : (msg.role === 'system' ? 'system' : 'user'),
            content: msg.text || '',
            timestamp: msg.timestamp,
            isFinal: msg.final || false,
            companionId: msg.companionId || null,
            companionThumb: msg.companionThumb || null,
            inputType: msg.inputType || null   // 'voice' | 'text' | null
        }));
    }

    logConversationHistory() {
        const history = this.getConversationHistory();
        this.dlog('[Conversation History]', JSON.stringify(history, null, 2));
        // Check for summarization if enabled
        this._checkHistorySummarization();
    }

    async _checkHistorySummarization() {
        // Thresholds
        const TRIGGER_COUNT = 200;
        const KEEP_RECENT = 150;

        if (this.isSummarizing) return;

        // Use this.messages as source of truth
        if (!this.messages || this.messages.length < TRIGGER_COUNT) return;

        console.log('[Erica] 🧹 History summarization triggered. Count:', this.messages.length);
        this.isSummarizing = true;

        try {
            // Sort to ensure we slice correctly
            const sortedMessages = [...this.messages].sort((a, b) => {
                if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
                return a.seq - b.seq;
            });

            // Identify chunks
            const splitIndex = sortedMessages.length - KEEP_RECENT;
            if (splitIndex <= 0) {
                this.isSummarizing = false;
                return;
            }

            const messagesToSummarize = sortedMessages.slice(0, splitIndex); // Oldest
            const recentMessages = sortedMessages.slice(splitIndex); // Newest

            console.log(`[Erica] Summarizing first ${messagesToSummarize.length} messages, keeping last ${recentMessages.length}.`);

            // Format for API
            const apiMessages = messagesToSummarize.map(m => ({
                role: m.role === 'bot' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'),
                content: m.text || ''
            }));

            const summary = await this._fetchSummary(apiMessages);

            if (summary) {
                // Create summary message object
                const summaryMessage = {
                    id: `summary_${Date.now()}`,
                    role: 'system',
                    text: `[Previous Conversation Summary]: ${summary}`,
                    final: true,
                    timestamp: messagesToSummarize[0].timestamp || Date.now() - 100000,
                    seq: messagesToSummarize[0].seq || 0,
                    type: 'summary'
                };

                // Replace 'messagesToSummarize' with 'summaryMessage' in the main array
                // We do this by filtering out the old ones and adding the summary, then re-sorting implicitly or just setting.
                // Since this.messages is not sorted by default (upsert pushes), we'll rebuild it properly.

                // To be safe, we keep recentMessages and prepend summary.
                this.messages = [summaryMessage, ...recentMessages];

                console.log('[Erica] ✅ History compacted. New size:', this.messages.length);

                // Persist new state
                this.saveConversationHistory();

                // Update UI if needed (though UI handles individual messages, a reload might be cleaner or we just leave it)
                // Ideally we should remove old DOM elements, but for now we rely on the state update.
                if (window.uiLayout && typeof window.uiLayout.clearMessages === 'function') {
                    // window.uiLayout.clearMessages(); // Optional: clear and re-render
                    // window.uiLayout.renderMessages(this.messages);
                }
            }

        } catch (error) {
            console.error('[Erica] Summarization failed:', error);
        } finally {
            this.isSummarizing = false;
        }
    }

    async _fetchSummary(messages) {
        try {
            const response = await this.fetchWithBackoff(
                this.apiUrl('/api/summarize'),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages })
                },
                { label: 'summarize', retries: 2 }
            );

            if (!response.ok) throw new Error(`Status ${response.status}`);
            const data = await response.json();
            return data.summary;
        } catch (e) {
            console.error('[Erica] Error fetching summary:', e);
            return null;
        }
    }

    async fetchConversationHistory() {
        const userId = this.getUserIdFromURL();
        if (!userId) {
            this.dlog('[Erica] History fetch skipped (no userId in URL)');
            return null;
        }

        // Cache (60s TTL): avoid refetching on reconnect storms / agent changes.
        const cached = this._historyCache.get(userId);
        const now = Date.now();
        if (cached && now - cached.ts < 60_000) {
            this.dlog('[Erica] Using cached conversation history', { userId, messages: Array.isArray(cached.history) ? cached.history.length : null });
            return cached.history;
        }

        // Single-flight: if a fetch is already running, reuse it.
        if (this._historyFetchInFlight) {
            return this._historyFetchInFlight;
        }

        const startMs = Date.now();
        const reqId = `histfetch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        console.info('[Erica] History fetch -> /api/conversation-history-fetch', { reqId, userId });

        this._historyFetchInFlight = (async () => {
            try {
                const response = await this.fetchWithBackoff(
                    this.apiUrl('/api/conversation-history-fetch'),
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ userId })
                    },
                    { label: 'history fetch', retries: 4 }
                );

                if (!response.ok) {
                    const durationMs = Date.now() - startMs;
                    const retryAfter = response.headers?.get ? response.headers.get('retry-after') : null;
                    let bodyPreview = '';
                    try {
                        const txt = await response.text();
                        bodyPreview = (txt || '').replace(/\s+/g, ' ').trim().slice(0, 260);
                    } catch (_) { }
                    console.error('[Erica] History fetch failed', {
                        reqId,
                        status: response.status,
                        statusText: response.statusText,
                        durationMs,
                        retryAfter,
                        bodyPreview
                    });
                    return null;
                }

                const data = await response.json();
                if (data.ok && data.text) {
                    const history = JSON.parse(data.text);
                    const durationMs = Date.now() - startMs;
                    console.info('[Erica] History fetch ok', {
                        reqId,
                        durationMs,
                        messages: Array.isArray(history) ? history.length : null
                    });
                    this._historyCache.set(userId, { ts: Date.now(), history });

                    // Count today's voice messages from server history to enforce limit across login/logout
                    const today = this._getTodayString();
                    const serverVoiceCount = Array.isArray(history)
                        ? history.filter(m =>
                            m.role === 'user' &&
                            m.inputType === 'voice' &&
                            m.timestamp &&
                            new Date(m.timestamp).toISOString().split('T')[0] === today
                        ).length
                        : 0;
                    this._serverVoiceUsageCount = serverVoiceCount;
                    console.log(`[Erica] Server voice usage today: ${serverVoiceCount}`);
                    return history;
                }

                const durationMs = Date.now() - startMs;
                console.info('[Erica] History fetch returned no usable history', { reqId, durationMs, ok: !!data?.ok });
                return null;
            } catch (error) {
                console.error('[Erica] History fetch error:', error);
                return null;
            } finally {
                this._historyFetchInFlight = null;
            }
        })();

        return this._historyFetchInFlight;
    }

    mergeConversationHistory(history, { source = 'server' } = {}) {
        if (!history || !Array.isArray(history) || history.length === 0) {
            return 0;
        }

        const existingById = new Set();
        const existingFallback = new Set();
        this.messages.forEach((msg) => {
            if (msg.id) existingById.add(msg.id);
            const key = `${msg.role}|${msg.timestamp}|${(msg.text || '').trim()}`;
            existingFallback.add(key);
        });

        const toAdd = [];
        const existingTimestamps = this.messages
            .map(m => m.timestamp)
            .filter(ts => typeof ts === 'number' && ts > 0);
        const minExistingTs = existingTimestamps.length > 0 ? Math.min(...existingTimestamps) : null;
        const fallbackBase = (minExistingTs && Number.isFinite(minExistingTs))
            ? Math.max(0, minExistingTs - 1000)
            : Date.now() - (history.length * 1000);

        history.forEach((msg, idx) => {
            if (!msg) return;
            const id = msg.id || null;
            if (id && existingById.has(id)) return;
            const role = msg.role === 'assistant' ? 'bot' : 'user';
            const text = msg.content || msg.text || '';
            let timestamp = msg.timestamp;
            if (!timestamp || typeof timestamp !== 'number' || timestamp < 1000000000000) {
                timestamp = fallbackBase + idx;
            }
            const key = `${role}|${timestamp}|${(text || '').trim()}`;
            if (existingFallback.has(key)) return;
            toAdd.push({ ...msg, role: msg.role === 'assistant' ? 'bot' : 'user', content: text, timestamp });
        });

        if (toAdd.length === 0) return 0;

        this.isRestoringHistory = true;
        try {
            const tsUsage = new Map();
            toAdd.forEach((msg) => {
                const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : Date.now();
                const count = tsUsage.get(ts) || 0;
                tsUsage.set(ts, count + 1);
                if (count > 0) {
                    msg.timestamp = ts + count; // ensure stable order for same-timestamp history
                }
            });

            toAdd
                .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
                .forEach((msg) => {
                    const role = msg.role === 'assistant' ? 'bot' : msg.role;
                    this.upsertMessage(msg.id || `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, msg.content || '', true, msg.timestamp, {
                        companionId: msg.companionId || null,
                        companionThumb: msg.companionThumb || null,
                        // inputType was missing here — caused inputType to be null after history merge
                        inputType: msg.inputType || null
                    });
                });
        } finally {
            this.isRestoringHistory = false;
        }

        return toAdd.length;
    }

    async queueBotMessageQC(messageId, text) {
        if (!messageId || !text || !String(text).trim()) return;
        if (this.isRestoringHistory) return;
        if (this.qcCheckedMessageIds.has(messageId)) return;
        if (this.qcInFlight.has(messageId)) return;

        this.qcInFlight.add(messageId);
        try {
            let result = null;
            try {
                result = await this.runMessageQC(text);
                console.log('[Erica] QC result', {
                    messageId,
                    ok: result?.ok,
                    issues: result?.issues || null
                });
            } catch (err) {
                console.warn('[Erica] QC server call failed, running local fallback:', err?.message || err);
            }

            this.qcCheckedMessageIds.add(messageId);
            const cleaned = this.extractCleanedBotText(text, result);

            if (cleaned === null) {
                // Garbage detected - check if we should retry
                const retries = this.qcRetryCount.get(messageId) || 0;
                if (retries < this.MAX_QC_RETRIES) {
                    this.qcRetryCount.set(messageId, retries + 1);
                    console.warn('[Erica] QC detected garbage, triggering auto-retry', { messageId, retry: retries + 1 });
                    this.regenerateResponse(messageId);
                    return; // Don't finalize/hide yet, we're retrying
                }

                // extractCleanedBotText returned null → message is pure metadata/garbage, hide it
                console.log('[Erica] QC hiding garbage message (max retries hit or no retry possible)', {
                    messageId,
                    originalPreview: String(text).slice(0, 120)
                });
                this.updateBotMessage(messageId, '', true, null, { qcChecked: true });
            } else if (cleaned && cleaned !== text) {
                console.log('[Erica] QC applied replacement', {
                    messageId,
                    originalPreview: String(text).slice(0, 120),
                    cleanedPreview: String(cleaned).slice(0, 120)
                });
                this.updateBotMessage(messageId, cleaned, true, null, { qcChecked: true });
            } else {
                console.log('[Erica] QC kept original', { messageId });
            }
        } catch (err) {
            console.warn('[Erica] Message QC failed entirely:', err);
        } finally {
            this.qcInFlight.delete(messageId);
        }
    }

    /**
     * Triggers a new response from the OpenAI Realtime API when garbage is detected.
     */
    regenerateResponse(originalMessageId) {
        if (!this.isActive()) return;
        console.log('[Erica] Requesting regenerated response for:', originalMessageId);

        // Trigger a new response creation via the data channel
        this.sendMessage({
            type: 'response.create'
        });
    }

    /**
     * Extracts clean bot text from a QC result or applies local heuristics.
     * Returns:
     *   string  – the cleaned text (may equal original if nothing to fix)
     *   null    – the message is pure metadata/garbage and should be hidden
     */
    extractCleanedBotText(originalText, qcResult) {
        const original = String(originalText || '');

        // 1. If server QC returned a cleaned version, use it
        if (qcResult && qcResult.ok === false && qcResult.cleanedText) {
            const cleaned = String(qcResult.cleanedText || '').trim();
            if (cleaned) return cleaned;
        }

        // 2. Local fallback heuristics (runs even when server QC fails)
        const trimmed = original.trim();

        // 2a. Detect JSON-wrapped messages
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object') {
                    // Extract real content from known wrapper keys
                    const voiceResponse = parsed.voice_response || parsed.response || parsed.message || parsed.text || null;
                    if (typeof voiceResponse === 'string' && voiceResponse.trim()) {
                        return voiceResponse.trim();
                    }
                    // Pure metadata with no usable content (e.g. {"name":"Erica"}, {"coach":"erica"})
                    // → signal to caller this message should be hidden
                    console.log('[Erica] QC local: detected pure JSON metadata', { preview: trimmed.slice(0, 120) });
                    return null;
                }
            } catch (_) { }
        }

        // 2b. Detect markdown code fences wrapping the entire message
        if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
            const inner = trimmed.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
            if (inner) return inner;
        }

        // 2c. Detect template/placeholder artifacts like {coach: erica} (not valid JSON but looks like garbage)
        if (/^\{[a-zA-Z_]+\s*:\s*[^}]+\}$/.test(trimmed) && trimmed.length < 80) {
            console.log('[Erica] QC local: detected placeholder artifact', { preview: trimmed });
            return null;
        }

        return original;
    }

    async runMessageQC(text) {
        const payloadText = String(text || '');
        if (!payloadText.trim()) {
            return { ok: true, cleanedText: payloadText, issues: ['qc_empty'] };
        }
        const payload = {
            text: payloadText
        };
        console.log('[Erica] QC request payload', { length: payloadText.length, preview: payloadText.slice(0, 120) });
        const response = await this.fetchWithBackoff(
            this.apiUrl('/api/message-qc'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            },
            { label: 'message qc', retries: 2 }
        );
        if (!response.ok) {
            let errBody = '';
            try {
                errBody = await response.text();
            } catch (_) { }
            console.warn('[Erica] QC request failed', {
                status: response.status,
                statusText: response.statusText,
                body: errBody
            });
            throw new Error(`QC request failed: ${response.status}`);
        }
        return await response.json();
    }

    restoreConversationHistory(history) {
        if (!history || !Array.isArray(history) || history.length === 0) {
            return;
        }

        // Clear existing messages
        this.messages = [];
        this.messageElements.clear();
        if (this.chatMessages) {
            // The pill container (#quickActions) may have been re-parented
            // into #chatMessages by renderQuickActions on a prior turn. A raw
            // innerHTML wipe would delete it — after which
            // document.getElementById('quickActions') silently returns null
            // and renderQuickActions becomes a no-op for the rest of the
            // session. Detach the pill container before clearing, re-attach
            // afterwards (hidden — the caller re-shows it when appropriate).
            const pills = document.getElementById('quickActions');
            if (pills && this.chatMessages.contains(pills)) {
                pills.classList.add('hidden');
                this.chatMessages.parentElement?.appendChild(pills);
            }
            this.chatMessages.innerHTML = '';
        }

        // console.info('[Erica] Restoring conversation history:', history.length, 'messages');

        // Restore messages from history using their original timestamps (absolute Unix timestamps)
        // No normalization needed - timestamps are already in universal time (milliseconds since epoch)
        this.isRestoringHistory = true;
        try {
            history.forEach((msg) => {
                const role = msg.role === 'assistant' ? 'bot' : 'user';

                // Use the timestamp as-is if it exists, otherwise generate a new one
                // If timestamp is from performance.now() (small number), convert to Date.now() format
                let timestamp = msg.timestamp;
                if (!timestamp || timestamp < 1000000000000) {
                    // Timestamp is too small to be a Unix timestamp (before 2001)
                    // This means it's likely from performance.now() - generate a new absolute timestamp
                    // Use current time minus a small offset to ensure it appears before new messages
                    timestamp = Date.now() - (history.length * 1000);
                }

                this.upsertMessage(
                    msg.id,
                    role,
                    msg.content,
                    msg.isFinal,
                    timestamp,
                    {
                        companionId: msg.companionId,
                        companionThumb: msg.companionThumb
                    }
                );
            });
        } finally {
            this.isRestoringHistory = false;
        }

        // Log restoration complete (without full history dump to reduce console spam)
        // console.info('[Erica] History restoration complete:', this.messages.length, 'messages restored');
        // Uncomment the line below if you need to see the full history after restoration
        // this.logConversationHistory();
    }

    async sendHistoryToOpenAI(history) {
        if (!history || !Array.isArray(history) || history.length === 0) {
            return;
        }

        // Wait for data channel to be ready
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            // Wait a bit and try again
            setTimeout(() => this.sendHistoryToOpenAI(history), 500);
            return;
        }

        // console.log('[Erica] Sending conversation history to OpenAI:', history.length, 'messages');

        // Send each message to OpenAI in the correct format
        for (const msg of history) {
            try {
                if (msg.role === 'user') {
                    // User messages use input_text
                    this.sendMessage({
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'user',
                            content: [
                                {
                                    type: 'input_text',
                                    text: msg.content
                                }
                            ]
                        }
                    });
                } else if (msg.role === 'assistant') {
                    // Assistant messages use 'text' type (not input_text or output_text)
                    // This is the format OpenAI Realtime API expects for assistant message history
                    this.sendMessage({
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'assistant',
                            content: [
                                {
                                    type: 'output_text',
                                    text: msg.content
                                }
                            ]
                        }
                    });
                } else if (msg.role === 'system') {
                    // System messages (e.g., summaries)
                    this.sendMessage({
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'system',
                            content: [
                                {
                                    type: 'input_text',
                                    text: msg.content
                                }
                            ]
                        }
                    });
                }

                // Small delay between messages to avoid overwhelming the API
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error('[Erica] Error sending history message:', error, msg);
                // Continue with next message even if one fails
            }
        }

        // console.log('[Erica] Finished sending conversation history');
    }

    /**
     * Queue a save of the current conversation history.
     * We mark the history "dirty" on any final message (user or bot), but we only
     * POST at a controlled cadence to avoid Wix rate limits.
     *
     * - preferSoon: when true (typically bot final), uses a shorter debounce so we
     *   are more likely to persist the assistant reply as the last stored message.
     */
    saveConversationHistory({ preferSoon = false } = {}) {
        const userId = this.getUserIdFromURL();
        if (!userId) {
            // Silently fail if no userId - don't spam console
            return;
        }

        // Optional kill switch for testing
        try {
            if (String(window.localStorage?.getItem('DISABLE_HISTORY_SAVE') || '') === '1') {
                return;
            }
        } catch (_) { }

        this._historySaveDirty = true;
        if (preferSoon) this._historySavePreferSoon = true;

        // If a save is currently in-flight, let it finish; the dirty flag will trigger a follow-up save.
        if (this._historySaveInFlight) {
            return;
        }

        // Debounce: collapse bursts into one save.
        if (this._saveHistoryTimer) {
            clearTimeout(this._saveHistoryTimer);
        }

        const debounceMs = this._historySavePreferSoon ? Math.min(300, this._historySaveDebounceMs) : this._historySaveDebounceMs;
        this._saveHistoryTimer = setTimeout(() => {
            this._flushConversationHistorySave().catch((err) => {
                console.error('[Erica] Error flushing conversation history save:', err);
            });
        }, debounceMs);
    }

    async _flushConversationHistorySave() {
        const userId = this.getUserIdFromURL();
        if (!userId) return;
        if (this._historySaveInFlight) return;
        if (!this._historySaveDirty) return;

        // Enforce minimum interval between saves
        const now = Date.now();
        const sinceLast = now - (this._lastHistorySaveAt || 0);
        const waitMs = Math.max(0, (this._historySaveMinIntervalMs || 0) - sinceLast);
        if (waitMs > 0) {
            // Re-schedule flush for later; keep dirty flag set.
            if (this._saveHistoryTimer) clearTimeout(this._saveHistoryTimer);
            this._saveHistoryTimer = setTimeout(() => {
                this._flushConversationHistorySave().catch((err) => {
                    console.error('[Erica] Error flushing conversation history save:', err);
                });
            }, waitMs);
            return;
        }

        this._historySaveInFlight = true;
        try {
            const history = this.getConversationHistory();
            // Store compact JSON to reduce payload size
            const historyText = JSON.stringify(history);

            const response = await this.fetchWithBackoff(
                this.apiUrl('/api/conversation-history-save'),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, text: historyText })
                },
                // Keep retries low to avoid amplifying throttling storms
                { label: 'history save', retries: 2 }
            );

            this._lastHistorySaveAt = Date.now();

            if (!response.ok) {
                console.error('[Erica] Failed to save conversation history:', response.status, response.statusText);
                // Keep dirty so we retry on the next trigger / next window.
                this._historySaveDirty = true;
            } else {
                this._historySaveDirty = false;
                this._historySavePreferSoon = false;
            }
        } catch (error) {
            console.error('[Erica] Error saving conversation history:', error);
            this._historySaveDirty = true;
        } finally {
            this._historySaveInFlight = false;

            // If more changes came in while saving, schedule another flush.
            if (this._historySaveDirty) {
                if (this._saveHistoryTimer) clearTimeout(this._saveHistoryTimer);
                this._saveHistoryTimer = setTimeout(() => {
                    this._flushConversationHistorySave().catch((err) => {
                        console.error('[Erica] Error flushing conversation history save:', err);
                    });
                }, this._historySaveDebounceMs || 800);
            }
        }
    }

    upsertMessage(id, role, text, isFinal, timestamp, meta = {}) {
        if (!id) {
            console.warn('[Erica] upsertMessage called with no ID');
            return;
        }

        // Suggestion pills lifecycle:
        //   - User message arriving -> hide (they've committed, don't distract)
        //   - Bot FINAL message arriving -> re-render as "continuation" set
        //     (short follow-ups that keep the conversation moving)
        //   - Bot streaming (not final) -> leave state as-is
        //
        // Live bot messages arrive via updateBotMessage() -> upsertMessage(id, 'bot', ...).
        // History restore also uses role='bot'. Guard with !isRestoringHistory so
        // replaying old messages doesn't stack pills mid-restore. Wrapped in
        // try/catch because this is UX-only and must never break core message
        // rendering if the DOM isn't ready yet.
        try {
            if (role === 'user') {
                if (typeof this.hideQuickActions === 'function') this.hideQuickActions();
            } else if ((role === 'assistant' || role === 'bot') && isFinal && !this.isRestoringHistory) {
                if (typeof this.renderQuickActions === 'function') {
                    // Small delay lets the message bubble render first so
                    // the pills don't briefly overlap the finalisation.
                    setTimeout(() => this.renderQuickActions('continuation'), 150);
                }
            }
        } catch (_) { /* non-fatal */ }

        // Ensure text is a string (not null/undefined)
        const messageText = (text || '').trim();

        // Reduce console noise: log only final messages or when restoring history debugging
        if (!this.isRestoringHistory && isFinal) {
            /* console.log('[Erica] upsertMessage (final):', {
                id,
                role,
                textLength: messageText.length,
                textPreview: messageText.substring(0, 120),
                isFinal,
                timestamp,
                messagesCount: this.messages.length
            }); */
        }

        const existing = this.messages.find(m => m.id === id);
        const wasFinal = existing ? existing.final : false;
        let message = existing;

        // Reset inactivity timer when messages are received (active conversation)
        // User messages = user speaking, Bot messages = bot responding
        // Note: Audio track events fire once at connection, not per-message
        if ((role === 'user' || role === 'bot') && messageText.length > 0) {
            this.resetVoiceInactivityTimer();
        }

        if (existing) {
            // Update existing message
            // When qcChecked, respect empty text (QC wants to hide garbage).
            // Otherwise fall back to existing text to avoid blanking partial streams.
            existing.text = (meta.qcChecked && messageText === '') ? '' : (messageText || existing.text || '');
            if (isFinal) existing.final = true;
            if (timestamp) existing.timestamp = existing.timestamp || timestamp;
            if (meta.companionId) existing.companionId = meta.companionId;
            if (meta.companionThumb) existing.companionThumb = meta.companionThumb;
            if (meta.qcChecked) existing.qcChecked = true;
            // if (meta.inputType) existing.inputType = meta.inputType; // old: inputType not preserved on update
            if (meta.inputType) existing.inputType = meta.inputType;
            message = existing;
            // Removed verbose log - was crowding console
        } else {
            // Use absolute timestamp (Date.now()) - universal time, not relative to page load
            let finalTimestamp = timestamp || Date.now();

            if (role === 'bot') {
                // Find the most recent user message
                const userMessages = this.messages.filter(m => m.role === 'user');
                if (userMessages.length > 0) {
                    const lastUserMessage = userMessages.sort((a, b) => b.timestamp - a.timestamp)[0];
                    // Bot message must come after the user message it's responding to
                    // Add small offset (100ms) to ensure proper ordering
                    // If the bot message timestamp is earlier or same as the last user message, adjust it.
                    if (finalTimestamp <= lastUserMessage.timestamp) {
                        finalTimestamp = lastUserMessage.timestamp + 100;
                    }
                }
            }

            // Create new message
            message = {
                id,
                role,
                text: messageText,
                final: !!isFinal,
                timestamp: finalTimestamp,
                seq: this.seqCounter++,
                companionId: meta.companionId,
                companionThumb: meta.companionThumb,
                qcChecked: !!meta.qcChecked,
                inputType: meta.inputType || null   // 'voice' | 'text' | null (for bot/system)
            };
            this.messages.push(message);
            // Removed verbose log - was crowding console
        }

        // Update or create DOM element for this specific message
        if (window.uiLayout && typeof window.uiLayout.updateMessageElement === 'function') {
            window.uiLayout.updateMessageElement(this, message);
        }

        // Don't log conversation history on every message update - too verbose
        // Only log when explicitly needed (e.g., after restoration)

        // Sync conversation to parent (Wix) for satisfaction survey and host-side features
        // Fires for all users (including guests) on every final message
        if (isFinal && !this.isRestoringHistory) {
            if (this.iframeMessaging && typeof this.iframeMessaging.sendToHost === 'function') {
                try {
                    const historyText = JSON.stringify(this.getConversationHistory());
                    this.iframeMessaging.sendToHost({ action: 'syncHistoryText', historyText });
                } catch (_) {}
            }
        }

        // Save conversation history to API only when message is finalized
        // and we're NOT in the middle of restoring from history.
        if (isFinal && !this.isRestoringHistory) {
            // Prefer saving shortly after bot final so the stored transcript typically ends with the assistant reply.
            this.saveConversationHistory({ preferSoon: role === 'bot' });

            // Trigger summarization check
            if (this.messages.length >= 70) { // Slight optimization: check early
                this._checkHistorySummarization();
            }

            // VOICE USAGE COUNTING
            // Increment ONLY if this is a BOT response AND we are in active Call Mode (Voice).
            // This ensures text-only chats don't count towards the voice limit.
            // also ensures we don't count same message multiple times (check !wasFinal)
            if (role === 'bot' && this.isRecording && !wasFinal) {
                this.incrementVoiceUsage();
            }

            // Also save state to localStorage for session persistence
            // Use current mode (call vs chat) to avoid overwriting call state when new messages arrive
            this.saveCurrentState(this.isRecording ? 'call' : 'chat');
        }
    }

    setupIframeMessaging() {
        if (typeof window.createIframeMessaging !== 'function') {
            console.warn('[Erica] iframeMessaging helper not available; skipping postMessage wiring.');
            return;
        }
        this.iframeMessaging = window.createIframeMessaging({
            windowObj: window,
            // For iframe diagnostics: return ONLY the actual OpenAI Realtime session.update payload.
            // This avoids duplicate/derived debug fields (instructions/customInstructions/currentVoiceProfile, etc.)
            // and shows exactly what we send over the dataChannel.
            getPayload: () => this.lastSessionConfig?.sessionConfig || { message: 'No session config yet' },
            logger: console,
            onLog: (entry) => this.logIframeMessage(entry)
        });
        this.iframeMessaging.start();
    }

    setupReportContextMessaging() {
        if (this._reportContextListenerAttached) return;
        this._reportContextListenerAttached = true;
        window.addEventListener('message', (event) => {
            const data = event?.data || {};
            if (data.type === 'REPORT_VISIBLE_TEXT_CACHE' && data.cache) {
                console.log('[Erica] 📥 Report cache received from parent', {
                    url: data.cache?.url || null,
                    title: data.cache?.title || null,
                    chars: data.cache?.text ? String(data.cache.text).length : 0
                });
                this.reportContextCache = data.cache;
                this.reportContextLastAt = Date.now();
                const waiters = Array.isArray(this._reportContextWaiters) ? this._reportContextWaiters.splice(0) : [];
                waiters.forEach((resolveFn) => {
                    try {
                        resolveFn(this.reportContextCache);
                    } catch (_) { }
                });
            }
        });
    }

    async requestReportContextFromParent({ timeoutMs, force = false } = {}) {
        if (this.reportContextCache && !force) {
            console.log('[Erica] 📤 Report cache already available (skip request)', {
                url: this.reportContextCache?.url || null,
                chars: this.reportContextCache?.text ? String(this.reportContextCache.text).length : 0
            });
            return this.reportContextCache;
        }
        if (!window.parent || window.parent === window) {
            console.log('[Erica] 📤 Report cache request skipped (no parent)');
            return null;
        }

        const waitMs = Number.isFinite(timeoutMs) ? timeoutMs : this.reportContextTimeoutMs;
        return new Promise((resolve) => {
            let done = false;
            const finish = (val) => {
                if (done) return;
                done = true;
                resolve(val || null);
            };

            const timer = setTimeout(() => {
                console.warn('[Erica] ⏱️ Report cache request timed out', { waitMs });
                finish(this.reportContextCache || null);
            }, waitMs);

            this._reportContextWaiters.push((cache) => {
                clearTimeout(timer);
                finish(cache);
            });

            try {
                console.log('[Erica] 📤 Requesting report cache from parent');
                window.parent.postMessage({ type: 'REQUEST_REPORT_CACHE' }, '*');
            } catch (err) {
                console.warn('[Erica] 📤 Report cache postMessage failed', err);
                clearTimeout(timer);
                finish(null);
            }
        });
    }

    logIframeMessage(entry) {
        try {
            const normalized = {
                timestamp: Date.now(),
                direction: entry?.direction || 'unknown',
                type: entry?.type || 'unknown',
                origin: entry?.origin || null,
                note: entry?.note || null,
                payloadPreview: entry?.payloadPreview || null
            };
            this.iframeMessageLog.push(normalized);
            if (this.iframeMessageLog.length > 100) {
                this.iframeMessageLog.shift();
            }
        } catch (err) {
            console.warn('[Erica] Failed to log iframe message:', err);
        }
    }

    emitAskedEricaEvent(text) {
        if (!text || this.isRestoringHistory) return;

        // Analytics: Asked AI Coach Voice
        // Use persistent usage count (plus current one) for accurate tracking across sessions
        const usage = this._loadVoiceUsage ? this._loadVoiceUsage() : { count: 0 };
        const currentCount = (usage.count || 0) + 1;

        // Update memory session for legacy reference (optional)
        this.analyticsSession.voiceQuestionCount = currentCount;

        this.trackCoachEvent('Asked AI Coach Voice', {
            Question: text,
            VoiceQuestionCount: currentCount
        });
    }


    toggleSound() {
        this.isSoundEnabled = !this.isSoundEnabled;

        if (this.remoteAudio) {
            // Only unmute during active call; otherwise stay muted
            const shouldMute = !this.isSoundEnabled || !this.isCallAudioEnabled;
            this.remoteAudio.muted = shouldMute;
            if (!shouldMute) {
                this.remoteAudio.volume = 1.0;
            }
        }

        // Analytics: Muted AI Voice Speaker (only when muting?)
        // Requirement says "When user mutes".
        if (!this.isSoundEnabled) {
            this.trackCoachEvent('Muted AI Voice Speaker', {});
        }

        // Update icon visibility via UI helper
        if (window.uiLayout && typeof window.uiLayout.setCallAudioIcon === 'function') {
            window.uiLayout.setCallAudioIcon(this, this.isSoundEnabled);
        }

        // Ensure playback state respects call mode after toggling sound
        this.setCallAudioEnabled(this.isCallAudioEnabled);
    }

    toggleSelfMute() {
        // Toggle local microphone track without ending the call.
        if (!this.localStream) return;
        const tracks = typeof this.localStream.getAudioTracks === 'function' ? this.localStream.getAudioTracks() : [];
        if (!tracks || tracks.length === 0) return;
        const track = tracks[0];

        // Mute = disable the track. Unmute = enable.
        const nextMuted = !!track.enabled; // enabled -> muting; disabled -> unmuting
        track.enabled = !track.enabled;
        this.isSelfMuted = nextMuted;

        // Analytics: Muted AI Voice Mic
        if (this.isSelfMuted) {
            this.trackCoachEvent('Muted AI Voice Mic', {});
        }
    }

    updateTextButtonVisibility() {
        if (window.uiLayout && typeof window.uiLayout.updateTextButtonVisibility === 'function') {
            window.uiLayout.updateTextButtonVisibility(this);
        }
    }

    updateMicToggleVisibility() {
        if (window.uiLayout && typeof window.uiLayout.updateMicToggleVisibility === 'function') {
            window.uiLayout.updateMicToggleVisibility(this);
        }
    }

    toggleMicTrack() {
        // Detect dead connection (same as sendTextMessage)
        const channelDead = !this.dataChannel || this.dataChannel.readyState !== 'open';
        if (channelDead && this.isConnected) {
            console.log('[Erica] DataChannel dead while isConnected=true — forcing reconnect (voice)...');
            this.isConnected = false;
        }

        if (!this.isConnected) {
            // Auto-reconnect then start recording (mirrors sendTextMessage pattern)
            if (!this.isConnecting) {
                console.log('[Erica] Not connected — reconnecting before starting voice...');
                this.isOnHold = false;
                this.connect()
                    .then(() => new Promise(resolve => setTimeout(resolve, 800)))
                    .then(() => {
                        if (this.isConnected) {
                            this.startRecording().catch(err => {
                                console.error('[Erica] startRecording after reconnect failed:', err);
                            });
                        } else {
                            console.warn('[Erica] Reconnect did not complete — voice not started');
                        }
                    })
                    .catch(err => {
                        console.error('[Erica] Manual connect failed:', err);
                    });
            }
            return;
        }

        // If we are recording, treat this as a "Stop" action
        if (this.isRecording) {
            this.stopRecording();
            return;
        }

        // Prototype phase: no login gate for voice — guests may try it.
        // (see equivalent comment in the restoreMode() and voiceMode branches)

        // If we don't have a stream (or not recording), treat this as "Start"
        // Voice Limit Check (redundant but safe)
        if (!this.checkVoiceLimit()) {
            // User clicked mic manually but limit is reached -> Show Upgrade Modal
            if (typeof this.showVoiceLimitUpgradeModal === 'function') {
                this.showVoiceLimitUpgradeModal();
            } else {
                this.showVoiceLimitAlert(); // Fallback
            }
            return;
        }

        this.startRecording().catch(err => console.error('[Erica] startRecording failed:', err));
    }

    setMicToggleUI(isEnabled) {
        if (window.uiLayout && typeof window.uiLayout.setMicToggleUI === 'function') {
            window.uiLayout.setMicToggleUI(this, isEnabled);
        }
    }

    updateCallPanelMicUI() {
        if (window.uiLayout && typeof window.uiLayout.updateCallPanelMicUI === 'function') {
            window.uiLayout.updateCallPanelMicUI(this);
        }
    }

    toggleAgentDetailsPanel(forceState) {
        if (!this.agentDetailsPanel) return;
        const isOpen = this.agentDetailsPanel.classList.contains('open');
        const nextState = typeof forceState === 'boolean' ? forceState : !isOpen;
        if (nextState) {
            this.populateAgentDetailsPanel();
            this.agentDetailsPanel.classList.add('open');
            if (this.statusText) this.statusText.style.display = 'none';
            // Analytics: Clicked Change Persona Name
            // (Requirement says "When user clicks on the option to change the persona name". 
            // Opening the panel gives them that option)
            this.trackCoachEvent('Clicked Change Persona Name', {});
        } else {
            this.agentDetailsPanel.classList.remove('open');
            if (this.statusText) this.statusText.style.display = '';
        }
    }

    populateAgentDetailsPanel() {
        if (!this.currentVoiceProfile) return;
        if (this.agentNameInput) {
            this.agentNameInput.value = this.currentVoiceProfile.character || '';
        }
        const speed = this.normalizeSpeedValue(this.currentVoiceProfile.voiceSpeed);
        this.setSpeedPillSelection(speed);
        if (this.agentContext) {
            this.agentContext.textContent = this.currentVoiceProfile.userFacingContext || '';
        }

        // Update coach type text (e.g., "Supportive", "Directive", etc.)
        if (this.coachTypeText) {
            const coachType = this.currentVoiceProfile.id ||
                this.currentVoiceProfile.companionId ||
                this.currentVoiceProfile.role ||
                'Coach';
            this.coachTypeText.textContent = coachType;
        }
    }

    applyAgentDetailsChanges() {
        if (!this.currentVoiceProfile) return;
        const newName = this.agentNameInput ? this.agentNameInput.value.trim() : '';
        const newSpeed = this.getSelectedSpeedValue();

        const oldName = this.currentVoiceProfile.character;
        const oldSpeed = this.currentVoiceProfile.voiceSpeed;

        if (newName && newName !== oldName) {
            this.currentVoiceProfile.character = newName;
            // Analytics: Changed Persona Name
            this.trackCoachEvent('Changed Persona Name', {
                PersonaBefore: oldName,
                PersonaAfter: newName
            });

            // Update status label
            if (this.statusText) {
                this.statusText.textContent = newName;
            }
            // Update active voice menu item name
            if (this.voiceMenuItems && this.voiceMenuItems.length > 0) {
                this.voiceMenuItems.forEach((item) => {
                    if (item.classList.contains('active')) {
                        const nameEl = item.querySelector('.voice-name');
                        if (nameEl) nameEl.textContent = newName;
                    }
                });
            }
        }

        if (newSpeed && newSpeed !== oldSpeed) {
            this.currentVoiceProfile.voiceSpeed = newSpeed;
            // Analytics: Changed Persona Voice Speed
            this.trackCoachEvent('Changed Persona Voice Speed', {
                VoiceSpeedBefore: oldSpeed,
                VoiceSpeedAfter: newSpeed
            });
        }

        this.toggleAgentDetailsPanel(false);
    }

    setCoachDisplayName(newName) {
        if (!this.currentVoiceProfile) return;

        const oldName = this.currentVoiceProfile.character;
        if (newName && newName !== oldName) {
            this.currentVoiceProfile.character = newName;

            // Analytics: Changed Persona Name
            this.trackCoachEvent('Changed Persona Name', {
                PersonaBefore: oldName,
                PersonaAfter: newName
            });

            // Persist to localStorage so the name survives coach switches and page reloads
            try {
                const storageKey = this.getCoachNameStorageKey();
                if (String(newName).toLowerCase() === 'coach') {
                    window.localStorage?.removeItem(storageKey);
                } else {
                    window.localStorage?.setItem(storageKey, String(newName));
                }
            } catch (_) { }

            // Update lastCompanions in-memory so renderCoachList shows the new name
            if (Array.isArray(this.lastCompanions)) {
                const matchId = (
                    this.selectedCompanionId ||
                    (this.currentVoiceProfile && (this.currentVoiceProfile.id || this.currentVoiceProfile.companionId)) ||
                    ''
                ).toLowerCase();
                if (matchId) {
                    const entry = this.lastCompanions.find(c => {
                        const cfg = c.configuration || {};
                        return String(c.companionId || '').toLowerCase() === matchId ||
                               String(cfg.id || '').toLowerCase() === matchId ||
                               String(cfg.companionId || '').toLowerCase() === matchId;
                    });
                    if (entry && entry.configuration) {
                        entry.configuration.character = String(newName);
                    }
                }
            }

            // Update status labels
            if (this.statusText) {
                this.statusText.textContent = newName;
            }
            if (this.agentNameDisplay) {
                this.agentNameDisplay.textContent = newName;
            }

            // Update active voice menu item name
            if (this.voiceMenuItems && this.voiceMenuItems.length > 0) {
                this.voiceMenuItems.forEach((item) => {
                    const voiceId = item.getAttribute('data-voice');
                    if (voiceId === this.selectedVoice) {
                        const nameEl = item.querySelector('.voice-name');
                        if (nameEl) nameEl.textContent = newName;
                        // Update data attribute for consistency
                        item.setAttribute('data-character', newName);
                    }
                });
            }

            // Refresh coach list to reflect the updated name
            if (typeof this.renderCoachList === 'function' && Array.isArray(this.lastCompanions)) {
                this.renderCoachList(this.lastCompanions);
            }

            // Update session instructions so the AI knows its new name immediately
            if (this.isConnected) {
                console.log('[Erica] Updating session instructions with new name...');
                this.configureSession().catch(err => console.error('[Erica] Failed to update session instructions:', err));
            }
        }
    }

    setVoiceSpeed(newSpeed) {
        if (!this.currentVoiceProfile) return;

        const oldSpeed = this.currentVoiceProfile.voiceSpeed;
        if (newSpeed && newSpeed !== oldSpeed) {
            this.currentVoiceProfile.voiceSpeed = newSpeed;

            // Analytics: Changed Persona Voice Speed
            this.trackCoachEvent('Changed Persona Voice Speed', {
                VoiceSpeedBefore: oldSpeed,
                VoiceSpeedAfter: newSpeed
            });

            // Update session if connected
            if (this.isConnected) {
                console.log('[Erica] Updating session instructions with new speed...');
                this.configureSession().catch(err => console.error('[Erica] Failed to update session instructions:', err));
            }
        }
    }

    selectSpeedPill(pill) {
        if (!pill || !this.agentSpeedPills) return;
        this.agentSpeedPills.forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        this.updateSpeedLabelFromPill(pill.dataset.speed);
    }

    setSpeedPillSelection(speedValue) {
        if (!this.agentSpeedPills) return;
        let matched = false;
        this.agentSpeedPills.forEach((p) => {
            if (p.dataset.speed === speedValue) {
                p.classList.add('active');
                matched = true;
                this.updateSpeedLabelFromPill(speedValue);
            } else {
                p.classList.remove('active');
            }
        });
        if (!matched && this.agentSpeedPills.length > 0) {
            this.agentSpeedPills[0].classList.add('active');
            this.updateSpeedLabelFromPill(this.agentSpeedPills[0].dataset.speed);
        }
    }

    getSelectedSpeedValue() {
        if (!this.agentSpeedPills) return null;
        const active = this.agentSpeedPills.find((p) => p.classList.contains('active'));
        return active ? active.dataset.speed : null;
    }

    updateSpeedLabelFromPill(val) {
        // No extra label needed; pills show current selection
    }

    normalizeSpeedValue(raw) {
        if (!raw) return 'normal';
        const v = String(raw).toLowerCase().trim();
        if (v.includes('slow')) return 'slow';
        if (v.includes('fast')) return 'fast';
        return 'normal';
    }

    playAgentContextVoice() {
        if (!this.agentContext || !this.agentContext.textContent) {
            return;
        }
        const text = this.agentContext.textContent.trim();
        if (!text) return;

        // If already speaking, cancel
        if (window.speechSynthesis && window.speechSynthesis.speaking) {
            window.speechSynthesis.cancel();
            this.setSpeakButtonState(false);
            return;
        }

        if (!window.speechSynthesis) {
            console.warn('SpeechSynthesis not supported in this browser.');
            return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = this.getVoiceRateFromSpeed();
        utterance.onend = () => this.setSpeakButtonState(false);
        utterance.onerror = () => this.setSpeakButtonState(false);

        this.setSpeakButtonState(true);
        window.speechSynthesis.speak(utterance);
    }

    getVoiceRateFromSpeed() {
        // Only used for browser SpeechSynthesis preview (not OpenAI).
        // Map our fuzzy speed buckets to a reasonable rate range.
        const raw = (this.currentVoiceProfile && this.currentVoiceProfile.voiceSpeed) || 'normal';
        const speed = this.normalizeSpeedValue(raw);
        if (speed === 'slow') return 0.9;
        if (speed === 'fast') return 1.15;
        return 1.0;
    }

    setSpeakButtonState(active) {
        if (window.uiLayout && typeof window.uiLayout.setSpeakButtonState === 'function') {
            window.uiLayout.setSpeakButtonState(this, active);
        }
    }

    setCallAudioEnabled(isEnabled) {
        this.isCallAudioEnabled = !!isEnabled;

        if (!this.remoteAudio) {
            return;
        }

        const shouldMute = !this.isSoundEnabled || !this.isCallAudioEnabled || this.audioOutputGate;

        console.log('[Erica Gate] setCallAudioEnabled:', {
            isEnabled,
            isSoundEnabled: this.isSoundEnabled,
            isCallAudioEnabled: this.isCallAudioEnabled,
            audioOutputGate: this.audioOutputGate,
            RESULT_shouldMute: shouldMute
        });

        this.remoteAudio.muted = shouldMute;

        if (!shouldMute) {
            this.remoteAudio.volume = 1.0;
            this.remoteAudio.play().catch(() => { });
        } else {
            try {
                this.remoteAudio.pause();
            } catch (_) {
                // Ignore pause errors
            }
        }
    }

    // --- Analytics Helper ---
    trackCoachEvent(eventName, props = {}) {
        console.log('[Erica Debug] trackCoachEvent called:', eventName, props);

        const currentPersona =
            (this.currentVoiceProfile && this.currentVoiceProfile.character) ||
            (this.currentVoiceProfile && this.currentVoiceProfile.id) ||
            this._selectedCharacterName ||
            this.selectedVoice ||
            'Unknown';

        const resolveAbsoluteUrl = (url) => {
            if (!url) return null;
            if (url.startsWith('http://') || url.startsWith('https://')) return url;
            try {
                return new URL(url, window.location.origin).href;
            } catch (_) { return url; }
        };

        const baseProps = {
            Persona: currentPersona,
            PersonaImage: resolveAbsoluteUrl(this.currentVoiceThumbUrl),
            SourcePage: window.location.href,
            WixUserId: this.getUserIdFromURL ? (this.getUserIdFromURL() || '') : ''
        };

        const finalProps = { ...baseProps, ...props };

        // Console log for verification
        console.log(`[Erica Analytics] ${eventName}`, finalProps);

        // Channel 1: iframe postMessage (Wix / web parent)
        if (this.iframeMessaging && typeof this.iframeMessaging.sendCleverTapEvent === 'function') {
            this.iframeMessaging.sendCleverTapEvent(eventName, finalProps);
        }

        // Channel 2: native bridge (iOS / Android WebView)
        if (typeof messageToApp === 'function') {
            messageToApp({ clevertapEvent: eventName, clevertapProperties: finalProps });
        }
    }

    sendTextMessage(textPayload = null) {
        const text = textPayload || this.textInput?.value.trim();
        if (!text) return;

        // Dismiss the empty-state suggestion pills the moment the user commits
        // to sending anything. They only serve to reduce cold-start friction;
        // once the conversation is underway they'd just clutter the view.
        this.hideQuickActions();

        // Detect dead connection: isConnected may be true but dataChannel degraded
        // (common after on-hold period where WebRTC silently drops)
        const channelDead = !this.dataChannel || this.dataChannel.readyState !== 'open';
        if (!this.isConnected || channelDead) {
            if (channelDead && this.isConnected) {
                console.log('[Erica] DataChannel dead while isConnected=true — forcing reconnect...');
                this.isConnected = false;
            }

            // Queue the message — it will be sent when connection is ready
            console.log('[Erica] Not connected — queuing message:', text);
            this._pendingTextMessages.push(text);
            if (!textPayload && this.textInput) {
                this.textInput.value = '';
                this.updateTextButtonVisibility();
            }
            this.isOnHold = false;

            // Only trigger connect if not already connecting
            if (!this.isConnecting) {
                this.connect({ skipOpeningLine: true })
                    .then(() => {
                        this._sendPendingTextMessage();
                    })
                    .catch(err => console.error('[Erica] Reconnect error:', err));
            }
            // If already connecting, _sendPendingTextMessage will be called from
            // the dataChannel.onopen handler (see below)
            return;
        }

        // Clear on-hold flag if still connected
        if (this.isOnHold) {
            this.isOnHold = false;
        }

        // Track input type for bot reply attribution
        this._lastUserInputType = 'text';

        // Analytics: Asked AI Coach text
        this.analyticsSession.textQuestionCount++;
        this.trackCoachEvent('Asked AI Coach text', {
            Question: text,
            TextQuestionCount: this.analyticsSession.textQuestionCount
        });

        // Reset 30-minute session inactivity timer
        this.startSessionInactivityTimer();

        // Clear the input only if using DOM input (not payload)
        if (!textPayload) {
            this.textInput.value = '';
            this.updateTextButtonVisibility();
        }

        // Add user message to chat with absolute timestamp
        const userTimestamp = Date.now();
        const userMessageId = `user-text-${userTimestamp}`;
        /*this.upsertMessage(userMessageId, 'user', text, true, userTimestamp);*/
        this.upsertMessage(userMessageId, 'user', text, true, userTimestamp, { inputType: 'text' });


        // Fire analytics for asked question (text path)
        // this.emitAskedEricaEvent(text); // REMOVED: This was causing duplicate "Voice" events for text chat

        // Set bot timestamp to come after user message
        if (!this.botStartTimestamp) {
            this.botStartTimestamp = userTimestamp + 100; // 100ms after user message
        }

        // Send text message to Realtime API
        this.sendMessage({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: text
                    }
                ]
            }
        });

        // Create a response to get the model's reply
        setTimeout(() => {
            if (this.isConnected) {
                const responseConfig = {
                    type: 'response.create'
                };

                this.sendMessage(responseConfig);
            }

            // Show loader and disable inputs while waiting for response
            // Show loader and disable inputs while waiting for response
            // Loader removed as per request for questions
            // Mic button logic removed: Keep mic enabled during text response generation
            // if (typeof this.setMicButtonState === 'function') this.setMicButtonState('disabled');

        }, 100);
    }

    // ------------------------------------------------------------------
    // Quick-action suggestion pills (empty-chat cold-start UX)
    // ------------------------------------------------------------------
    // Three static suggestions per coaching persona, tuned to what that
    // coach is actually good at (see knowledge-base/frameworks/*.md).
    // Rendered when the chat is empty and dismissed on first user message.
    // ------------------------------------------------------------------
    _getQuickActionsForPersona(companionId, mode = 'starter') {
        // Starter set — shown on empty chat. Opens the conversation with a
        // recognisable coaching frame that plays to that persona's strengths.
        const starter = {
            Supportive: [
                "I'm feeling overwhelmed and need to slow down",
                "Help me find a small first step I can take",
                "Just help me sort through what I'm feeling"
            ],
            Directive: [
                "What's the next best step I should take?",
                "Help me make a decision today",
                "I need to move fast — cut through the noise"
            ],
            Discovery: [
                "What am I not seeing in my situation?",
                "Help me examine my assumptions",
                "Ask me the question I need to sit with"
            ],
            Empowering: [
                "What are my real options right now?",
                "Help me remember what I'm capable of",
                "I want to make a decision I own"
            ],
            Exploratory: [
                "What patterns do you see in what I've shared?",
                "Help me explore what's underneath this",
                "I want to think creatively about this"
            ],
            Guidance: [
                "What have others in my situation tried?",
                "Give me the lay of the land, then I'll choose",
                "I want to learn by doing — where do I start?"
            ],
            Nurturing: [
                "Just listen for a moment — I need to process",
                "Help me name what I'm actually feeling",
                "I want to talk about connection and boundaries"
            ],
            Strengths: [
                "Remind me what I do well",
                "How can I use my strengths for what's in front of me?",
                "I'm focused on what's broken — help me see what's working"
            ]
        };

        // Continuation set — shown after each assistant reply. Meant to keep
        // the conversation moving forward with beats natural to that persona.
        const continuation = {
            Supportive: [
                "Tell me more",
                "What's a small next step from here?",
                "Can we slow down and stay with this?"
            ],
            Directive: [
                "What do I do next?",
                "Give me the specific action",
                "Am I overthinking this?"
            ],
            Discovery: [
                "Ask me a harder question",
                "What am I still missing?",
                "What's really underneath this?"
            ],
            Empowering: [
                "Show me my options again",
                "Reflect that back to me",
                "Help me commit to a choice"
            ],
            Exploratory: [
                "Go deeper on that",
                "What pattern is this part of?",
                "How does this connect to what I said before?"
            ],
            Guidance: [
                "Show me an example",
                "What would you try first?",
                "I want to test this — how?"
            ],
            Nurturing: [
                "Say more about that",
                "Help me name this feeling",
                "Just sit with me for a moment"
            ],
            Strengths: [
                "What strength can I use here?",
                "Point out what's working",
                "How do I build on this?"
            ]
        };

        const universalStarter = [
            "Help me clarify what I'm working on",
            "I have a decision to make — help me think through it",
            "I want to reflect on something that's been on my mind"
        ];
        const universalContinuation = [
            "Tell me more",
            "Give me a concrete example",
            "What's a good next step?"
        ];

        if (mode === 'continuation') {
            return continuation[companionId] || universalContinuation;
        }
        return starter[companionId] || universalStarter;
    }

    _paintQuickActionButtons(suggestions) {
        const container = document.getElementById('quickActions');
        if (!container) return;
        const buttons = container.querySelectorAll('.quickActionBtn');
        buttons.forEach((btn, i) => {
            const suggestion = suggestions[i] || '';
            btn.textContent = suggestion;
            // Remove any loading-state classes when painting real content.
            btn.classList.remove('animate-pulse', 'text-transparent', 'select-none', 'pointer-events-none', 'bg-gray-100');
            btn.classList.add('bg-white');
            if (!suggestion) {
                btn.classList.add('hidden');
                btn.onclick = null;
                return;
            }
            btn.classList.remove('hidden');
            btn.onclick = () => {
                if (typeof this.sendTextMessage === 'function') {
                    this.sendTextMessage(suggestion);
                }
            };
        });
    }

    /**
     * Paint the pills in a "loading" (skeleton) state — grey pulsing bars,
     * non-clickable. Used while we wait for dynamic suggestions to arrive.
     * Placeholder widths vary so it doesn't look like 3 identical rectangles.
     */
    _paintQuickActionSkeleton() {
        const container = document.getElementById('quickActions');
        if (!container) return;
        const placeholders = ['                      ', // ~22 nbsps
                              '                 ',                                             // ~17
                              '                   '];                              // ~19
        const buttons = container.querySelectorAll('.quickActionBtn');
        buttons.forEach((btn, i) => {
            btn.textContent = placeholders[i] || '         ';
            btn.classList.remove('hidden', 'bg-white');
            btn.classList.add('animate-pulse', 'bg-gray-100', 'text-transparent', 'select-none', 'pointer-events-none');
            btn.onclick = null;
        });
    }

    async _syncUserActivityIntoPrompt() {
        console.log('[Erica.activitySync] 🔵 START');
        // Wait for an identifier we can hand to /api/user-activity. Signed-in
        // users have userId in the URL; guests get an objectId bridged from
        // the parent page via postMessage (window.__ttCleverTapId) — that
        // arrives shortly after boot, so poll for up to ~5s.
        const activityUserId = this.getUserIdFromURL();
        // Allow ?objectId=... in the URL as a testing/debug override so we can
        // exercise the flow without needing the parent-page CleverTap bridge.
        let activityObjectId = null;
        try {
            const urlObj = new URLSearchParams(window.location.search).get('objectId');
            if (urlObj) activityObjectId = String(urlObj);
        } catch (_) { /* non-fatal */ }
        if (!activityObjectId && typeof window !== 'undefined' && window.__ttCleverTapId) {
            activityObjectId = String(window.__ttCleverTapId);
        }
        console.log('[Erica.activitySync] identity check', { activityUserId, activityObjectId });
        if (!activityUserId && !activityObjectId) {
            console.log('[Erica.activitySync] polling for window.__ttCleverTapId (up to 5s)…');
            for (let i = 0; i < 25 && !activityObjectId; i++) {
                await new Promise((r) => setTimeout(r, 200));
                activityObjectId = (typeof window !== 'undefined' && window.__ttCleverTapId) ? String(window.__ttCleverTapId) : null;
            }
            if (!activityObjectId) {
                console.warn('[Erica.activitySync] ❌ no identifier available after 5s polling — bailing');
                return;
            }
            console.log('[Erica.activitySync] ✓ got objectId after polling:', activityObjectId);
        }

        try {
            const body = activityUserId
                ? { userId: activityUserId }
                : { objectId: activityObjectId };
            console.log('[Erica.activitySync] 📡 POST /api/user-activity', body);
            const resp = await fetch(this.apiUrl('/api/user-activity'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            console.log('[Erica.activitySync] response status:', resp.status);
            if (!resp.ok) {
                const txt = await resp.text().catch(() => '');
                console.warn('[Erica.activitySync] ❌ non-OK, body:', txt.slice(0, 300));
                return;
            }
            const data = await resp.json();
            const events = Array.isArray(data.events) ? data.events : [];
            console.log('[Erica.activitySync] events returned:', events.length, events.map(e => e.name));
            if (events.length === 0) {
                console.log('[Erica.activitySync] ⚠️ 0 events, nothing to inject');
                return;
            }

            const now = Date.now();
            const DAY = 24 * 60 * 60 * 1000;
            const daysAgo = (ts) => Math.max(0, Math.floor((now - (ts || now)) / DAY));
            const isoDate = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown');
            const humanRec = (d) => d === 0 ? 'today'
                : d === 1 ? 'yesterday'
                : d < 7 ? `${d} days ago`
                : d < 30 ? `${d} days ago`
                : `${Math.floor(d / 30)} months ago`;

            const sorted = [...events].sort((a, b) => (b.ts || 0) - (a.ts || 0));

            // Split by RECENCY. What matters most for a coach is "what did you
            // just do RIGHT NOW", not lifetime totals. Framing must make that
            // obvious to the model — earlier version used raw counts which
            // read as "you did this 92x today" and confused both the model
            // and the user reading her responses.
            const today = sorted.filter((e) => daysAgo(e.ts) === 0);
            const thisWeek = sorted.filter((e) => { const d = daysAgo(e.ts); return d > 0 && d < 7; });
            const older = sorted.filter((e) => daysAgo(e.ts) >= 7).slice(0, 8);

            const fmtLine = (e) => {
                const total = e.count > 1 ? ` (${e.count}x lifetime on this device, first: ${isoDate(e.firstSeenTs)})` : '';
                return `- ${e.name}${total}`;
            };
            const fmtOlder = (e) => {
                const rec = humanRec(daysAgo(e.ts));
                return `- ${e.name} — last ${rec}${e.count > 1 ? ` (${e.count}x lifetime)` : ''}`;
            };

            const sections = [];
            if (today.length) {
                sections.push('TODAY (this current session — most important):');
                sections.push(today.map(fmtLine).join('\n'));
            }
            if (thisWeek.length) {
                sections.push('');
                sections.push('EARLIER THIS WEEK:');
                sections.push(thisWeek.map(fmtOlder).join('\n'));
            }
            if (older.length) {
                sections.push('');
                sections.push('OVER TIME (historical, use only if the user asks about long-term patterns):');
                sections.push(older.map(fmtOlder).join('\n'));
            }
            if (sections.length === 0) {
                sections.push('(no activity available for this user)');
            }

            const activityBlock = [
                '',
                '=== USER ACTIVITY TIMELINE (live, from platform telemetry) ===',
                'THIS IS CRITICAL CONTEXT. Below is what THIS user has done on our platform.',
                'Counts labelled "lifetime" are TOTAL ever done on this device — not "did today". Do not confuse the two.',
                '',
                'MANDATORY BEHAVIOUR:',
                '- In your VERY FIRST turn with this user, reference at least one specific thing from the TODAY section (naturally, e.g. "I noticed you were exploring X — how are you feeling about it?" — NOT "your telemetry shows...").',
                '- Whenever the user is vague ("I want to talk", "help me think"), anchor on something concrete from TODAY.',
                '- NEVER read counts aloud, never mention "telemetry" or "your history" or "the system". Just talk like a coach who paid attention.',
                '- If TODAY is empty but EARLIER THIS WEEK has entries, use those instead.',
                '- If suggestions or next-steps come up, prefer options that build on TODAY\'s activity.',
                '',
                sections.join('\n'),
                '=== END USER ACTIVITY TIMELINE ==='
            ].join('\n');

            // PREPEND (not append) so the model sees this block up front rather
            // than buried after ~120k characters of grounding + reasoning
            // directives, which was silently ignoring it in practice.
            const beforeLen = (this.customInstructions || '').length;
            this.customInstructions = activityBlock + '\n\n' + (this.customInstructions || '');
            this.userActivityMarkdown = activityBlock;
            console.log('[Erica.activitySync] 📊 injected — customInstructions', beforeLen, '→', this.customInstructions.length, 'chars');
            console.log('[Erica.activitySync] block preview:\n' + activityBlock);
            if (this.isConnected && typeof this.configureSession === 'function') {
                console.log('[Erica.activitySync] 🔁 re-configuring Realtime session with activity in prompt');
                this.configureSession();
            } else {
                console.warn('[Erica.activitySync] ⚠️ NOT connected yet — activity is stored, will be picked up on first configureSession call');
            }
            try {
                if (typeof this.renderQuickActions === 'function') {
                    this.renderQuickActions();
                }
            } catch (_) { /* non-fatal */ }
        } catch (e) {
            console.warn('[Erica] user activity injection failed:', e?.message || e);
        }
    }

    async _fetchDynamicFollowUps() {
        // Grab the tail of the conversation. Use this.messages (the canonical
        // in-memory store) so we get the exact final text after streaming.
        // Cap at 8 recent turns to keep the request small and the model
        // focused on what just happened.
        const src = Array.isArray(this.messages) ? this.messages.slice(-8) : [];
        const messages = src
            .filter((m) => m && typeof m.text === 'string' && m.text.trim())
            .map((m) => ({
                role: (m.role === 'user') ? 'user' : 'coach',
                content: m.text.trim()
            }));

        const activity = (typeof this.userActivityMarkdown === 'string' && this.userActivityMarkdown.trim())
            ? this.userActivityMarkdown
            : null;

        // Need EITHER a conversation to react to OR live activity to ground
        // starter suggestions; without either the server can't produce
        // anything meaningful.
        if (messages.length === 0 && !activity) return null;

        const personaLabel =
            (this.currentVoiceProfile && (this.currentVoiceProfile.label || this.currentVoiceProfile.companionId)) ||
            this.selectedCompanionId || '';

        try {
            const url = this.apiUrl('/api/suggest-followups');
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages, persona: personaLabel, activity })
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            if (Array.isArray(data.suggestions) && data.suggestions.length > 0) {
                return data.suggestions.slice(0, 3);
            }
        } catch (e) {
            console.warn('[Erica] suggest-followups fetch failed:', e?.message || e);
        }
        return null;
    }

    renderQuickActions(mode) {
        const container = document.getElementById('quickActions');
        if (!container) return;

        const chatMsgs = document.getElementById('chatMessages');
        if (!chatMsgs) return;

        // Auto-detect mode: empty chat -> starter, otherwise continuation.
        // Exclude the pill container itself from the "chat is empty" check.
        const messageChildren = Array.from(chatMsgs.children).filter((el) => el.id !== 'quickActions');
        const chatEmpty = messageChildren.length === 0;
        const resolvedMode = mode || (chatEmpty ? 'starter' : 'continuation');

        // NOTE: previously we hid pills entirely during voice-recording. That
        // caused "sometimes no pills after starting a call" — the guard was
        // too aggressive. Pills work fine alongside call mode (user can still
        // tap one to inject a text turn), so we render regardless of isRecording.

        // Re-parent into #chatMessages so it flows with the conversation.
        if (container.parentElement !== chatMsgs) {
            chatMsgs.appendChild(container);
        } else if (chatMsgs.lastElementChild !== container) {
            chatMsgs.appendChild(container);
        }
        container.classList.remove('hidden');

        // Paint decision. Guiding principle: ONE visible pill transition per
        // turn. No skeleton flash, no morph. Pills reveal once with their
        // final content.
        //
        //   - starter mode WITH activity  -> paint persona defaults instantly
        //     (they're a reasonable fallback), then fetch activity-grounded
        //     suggestions in the background and swap them in when they arrive.
        //   - starter mode WITHOUT activity -> persona defaults (instant,
        //     no fetch — server can't ground without messages or activity).
        //   - continuation mode with real conversation -> KEEP HIDDEN. Fire
        //     fetch in the background. Reveal pills ONCE when the fetch
        //     resolves. If it times out (>3s), reveal persona defaults then.
        //     This is what eliminates the "skeleton flash then swap" flicker
        //     that the user called out.
        const hasActivity = !!(typeof this.userActivityMarkdown === 'string' && this.userActivityMarkdown.trim());
        const wantDynamic = (resolvedMode === 'continuation' && messageChildren.length >= 1)
            || (resolvedMode === 'starter' && hasActivity);
        const isContinuation = resolvedMode === 'continuation';

        if (!wantDynamic) {
            // Nothing to fetch — reveal defaults immediately.
            container.classList.remove('hidden');
            const staticSuggestions = this._getQuickActionsForPersona(this.selectedCompanionId, resolvedMode);
            this._paintQuickActionButtons(staticSuggestions);
        } else if (isContinuation) {
            // Keep hidden until fetch resolves; reveal is deferred to the
            // .then/.catch branch below.
            container.classList.add('hidden');
        } else {
            // starter + activity: reveal defaults NOW, upgrade in place on
            // resolve. This is the only mid-turn morph we allow, and it's
            // pre-send (user hasn't done anything yet), so it feels calm.
            container.classList.remove('hidden');
            const staticSuggestions = this._getQuickActionsForPersona(this.selectedCompanionId, resolvedMode);
            this._paintQuickActionButtons(staticSuggestions);
        }

        // Scroll into view so the user sees the pills (only if visible).
        const scrollContainer = document.getElementById('chatContainer');
        if (scrollContainer && !container.classList.contains('hidden')) {
            requestAnimationFrame(() => {
                scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
            });
        }

        if (!wantDynamic) return;

        // Bump a token so stale responses (from earlier turns) can't overwrite
        // a newer set of suggestions.
        this._quickActionsFetchToken = (this._quickActionsFetchToken || 0) + 1;
        const myToken = this._quickActionsFetchToken;

        const revealWithDefaults = () => {
            const staticSuggestions = this._getQuickActionsForPersona(this.selectedCompanionId, resolvedMode);
            this._paintQuickActionButtons(staticSuggestions);
            container.classList.remove('hidden');
            if (scrollContainer) {
                requestAnimationFrame(() => scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' }));
            }
        };

        // Timeout guard: after 3s, reveal persona defaults so the user isn't
        // waiting silently for pills that may never come.
        const timeoutId = setTimeout(() => {
            if (myToken !== this._quickActionsFetchToken) return;
            if (!container.classList.contains('hidden')) return; // already revealed by fetch
            console.warn('[Erica] suggest-followups slow, revealing persona defaults');
            revealWithDefaults();
        }, 3000);

        this._fetchDynamicFollowUps().then((dynamic) => {
            clearTimeout(timeoutId);
            if (myToken !== this._quickActionsFetchToken) return;

            if (dynamic && dynamic.length > 0) {
                console.log('[Erica] 🎯 dynamic follow-ups:', dynamic);
                this._paintQuickActionButtons(dynamic);
                container.classList.remove('hidden');
                if (scrollContainer) {
                    requestAnimationFrame(() => scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' }));
                }
            } else {
                revealWithDefaults();
            }
        }).catch(() => {
            clearTimeout(timeoutId);
            if (myToken !== this._quickActionsFetchToken) return;
            revealWithDefaults();
        });
    }

    hideQuickActions() {
        const container = document.getElementById('quickActions');
        if (container) container.classList.add('hidden');
    }

    setSelectedVoice(voice, thumb, character, companionId = null, skipSave = false) {
        if (!voice) return;
        this.selectedVoice = voice;
        if (companionId) {
            this.selectedCompanionId = String(companionId);
        }
        // Store character name as fallback for analytics when voiceProfiles aren't loaded yet
        if (character && character !== 'Coach') {
            this._selectedCharacterName = String(character);
        }

        // Update voice profile based on OpenAI voice
        this.updateVoiceProfile(voice);

        // Update status label to reflect current voice
        let storedName = null;
        try {
            const key = this.getCoachNameStorageKey();
            storedName = window.localStorage?.getItem(key) || null;
            // Fix: Ignore cached "coach" to prevent generic name override
            if (storedName && storedName.toLowerCase() === 'coach') {
                storedName = null;
            }
        } catch (_) { }
        if (storedName && this.currentVoiceProfile) {
            this.currentVoiceProfile.character = String(storedName);
        }
        if (this.statusText) {
            const label =
                (storedName) ||
                (this.currentVoiceProfile && this.currentVoiceProfile.character) ||
                (this.currentVoiceProfile && this.currentVoiceProfile.label) ||
                character ||
                voice;
            this.statusText.textContent = label || '';
        }

        // Update thumbnail in selector button
        const resolvedThumb = thumb || this.resolveCompanionThumb(this.currentVoiceProfile);
        if (resolvedThumb) {
            this.currentVoiceThumbUrl = resolvedThumb;
        }
        if (resolvedThumb && this.currentVoiceThumb) {
            this.currentVoiceThumb.src = resolvedThumb;
            this.currentVoiceThumb.alt = character || voice;
        }

        // Reset speaking state and show idle video
        this.isBotSpeaking = false;
        this.botAudioReady = false;
        this.currentVideoState = 'idle';
        this.lastAudioTime = 0;
        this.silentIntervals = 0;
        this.progressIntervals = 0;
        this.updateCurrentVoiceVideo('idle');

        // Update UI active state
        // New Logic: dynamic coach list items
        const coachItems = document.querySelectorAll('.coachListItem');
        if (coachItems && coachItems.length > 0) {
            coachItems.forEach((item) => {
                const itemId = item.getAttribute('data-companion-id');
                const itemVoice = item.getAttribute('data-voice');

                // Match by ID preferred, fallback to voice
                let isActive = false;
                if (this.selectedCompanionId && itemId && String(itemId) === String(this.selectedCompanionId)) {
                    isActive = true;
                } else if (!this.selectedCompanionId && itemVoice === voice) {
                    isActive = true;
                }

                // Update Class
                if (isActive) {
                    item.classList.add('active-coach');
                } else {
                    item.classList.remove('active-coach');
                }

                // Update "Active" badge and Button Text
                const badgeContainer = item.querySelector('h3')?.parentElement;
                const existingBadge = badgeContainer?.querySelector('span.text-primary');
                const btn = item.querySelector('.connect-action-btn');

                if (isActive) {
                    // Add badge if missing
                    if (badgeContainer && !existingBadge) {
                        const badge = document.createElement('span');
                        badge.className = 'text-xs text-primary font-medium';
                        badge.textContent = '● Active';
                        badgeContainer.appendChild(badge);
                    }
                    // Update button
                    if (btn) {
                        // btn.textContent wipes out the icon, so we carefuly update text node only
                        // But simpler: just HTML replacement is robust enough here
                        btn.innerHTML = `Resume <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-iconColor group-hover:text-gray-600"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
                    }
                } else {
                    // Remove badge if present
                    if (existingBadge) {
                        existingBadge.remove();
                    }
                    // Update button
                    if (btn) {
                        btn.innerHTML = `Connect <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-iconColor group-hover:text-gray-600"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
                    }
                }
            });
        }

        // Legacy sidebar items support
        if (this.voiceItems && this.voiceItems.length > 0) {
            this.voiceItems.forEach((item) => {
                if (item.getAttribute('data-voice') === voice) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });
        }

        // Update voice menu items
        if (this.voiceMenuItems && this.voiceMenuItems.length > 0) {
            this.voiceMenuItems.forEach((item) => {
                if (item.getAttribute('data-voice') === voice) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });
        }

        // Refresh agent details panel fields
        this.populateAgentDetailsPanel();

        // Save state when coach is selected
        // Save state when coach is selected (unless skipped during restore)
        if (!skipSave) {
            this.saveCurrentState(this.isRecording ? 'call' : 'chat');
        }

        // Analytics: Selected Persona (sends to both iframe + native bridge)
        if (this.analyticsSession) {
            this.trackCoachEvent('Selected Persona', {});
        }

        // Refresh the empty-state quick-action pills with suggestions matching
        // the newly-selected coach. Renders only if the chat is still empty;
        // becomes a no-op once the conversation has started.
        try { this.renderQuickActions(); } catch (_) { /* non-fatal */ }
    }

    resolveCompanionThumb(profile) {
        if (!profile) return null;
        let t = profile.thumb;
        if (t) {
            // Already absolute?
            if (t.startsWith('http://') || t.startsWith('https://')) return t;
            // Otherwise resolve via apiUrl
            return this.apiUrl(t);
        }
        return null;
    }

    // Video playback methods - supports both idle and speaking animations
    updateCurrentVoiceVideo(state) {
        // Broadcast avatar animation state to the parent-page bridge so
        // the persistent corner-icon can animate in sync with the coach's
        // in-iframe avatar. Fires on every state transition (idle/speaking).
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'CT_ICON_ANIMATION', name: state }, '*');
            }
        } catch (_) { /* non-fatal */ }

        if (!this.currentVoiceProfile || !this.currentVoiceVideo || !this.currentVoiceThumb) return;

        // Force idle-only mode for now
        state = 'idle';

        // Prefer high-res idle for the top icon (84p subfolder under /idle/), fallback to base idle
        let videoPath = this.currentVoiceProfile.idleVideo;
        if (videoPath && videoPath.includes('/idle/')) {
            const largeCandidate = videoPath.replace('/idle/', '/idle/84p/');
            videoPath = largeCandidate || videoPath;
        }

        if (!videoPath) {
            // No video available, ensure image is shown
            this.currentVoiceVideo.style.display = 'none';
            this.currentVoiceThumb.style.display = 'block';
            this.currentVideoState = state;
            return;
        }

        // Don't update if we're already showing the correct video
        if (this.currentVideoState === state && this.currentVoiceVideo.classList.contains('playing')) {
            return;
        }

        this.currentVideoState = state;
        const video = this.currentVoiceVideo;
        const sources = video.querySelectorAll('source');

        // Check if we need to change the video source
        const webmPath = videoPath.replace(/\.mp4$/, '.webm');
        const currentWebmSrc = sources[0].getAttribute('src');
        const currentMp4Src = sources[1].getAttribute('src');

        // Only reload if the source has changed
        if (currentWebmSrc !== webmPath || currentMp4Src !== videoPath) {
            sources[0].src = webmPath; // WebM source
            sources[1].src = videoPath; // MP4 fallback

            // Keep thumbnail visible by default until video loads
            this.currentVoiceThumb.style.display = 'block';
            video.style.display = 'none';

            // Handle video load errors (only if ALL sources fail)
            const handleVideoError = () => {
                video.style.display = 'none';
                this.currentVoiceThumb.style.display = 'block';
                video.removeEventListener('error', handleVideoError);
                video.removeEventListener('canplay', handleVideoSuccess);
            };

            // Handle successful video load
            const handleVideoSuccess = () => {
                // Video is ready, show it and hide thumbnail
                video.style.display = 'block';
                this.currentVoiceThumb.style.display = 'none';
                video.removeEventListener('canplay', handleVideoSuccess);
                // Try to play
                video.play().then(() => {
                    video.classList.add('playing');
                }).catch(() => {
                    // If play fails, show thumbnail
                    video.style.display = 'none';
                    this.currentVoiceThumb.style.display = 'block';
                });
            };

            video.addEventListener('error', handleVideoError, { once: true });
            video.addEventListener('canplay', handleVideoSuccess, { once: true });
            video.load();
        } else {
            // Source hasn't changed, check if video is ready
            if (video.readyState >= 2 && !video.paused) {
                video.style.display = 'block';
                this.currentVoiceThumb.style.display = 'none';
            } else if (video.readyState >= 2) {
                // Video is loaded but paused, try to play
                video.play().then(() => {
                    video.classList.add('playing');
                    video.style.display = 'block';
                    this.currentVoiceThumb.style.display = 'none';
                }).catch(() => {
                    video.style.display = 'none';
                    this.currentVoiceThumb.style.display = 'block';
                });
            } else {
                // Video not ready, show thumbnail
                video.style.display = 'none';
                this.currentVoiceThumb.style.display = 'block';
            }
        }
    }

    playVideoForMenuItem(item, state) {
        if (!this.voiceProfiles) return;

        const character = item.getAttribute('data-character');
        const voiceKey = item.getAttribute('data-voice');
        const companionId = item.getAttribute('data-companion-id');

        const profile =
            (voiceKey && this.voiceProfilesByVoice && this.voiceProfilesByVoice[voiceKey]) ||
            (companionId && this.voiceProfilesById && this.voiceProfilesById[companionId]) ||
            (voiceKey && this.voiceProfiles && this.voiceProfiles[voiceKey]) ||
            (character && this.voiceProfiles && this.voiceProfiles[character.toLowerCase()]) ||
            null;

        if (!profile) return;

        // For the menu list, prefer the smaller idle video to avoid blur at 52px
        const videoPath = state === 'speaking'
            ? profile.speakingVideo
            : (profile.idleVideoSmall || profile.idleVideo);

        if (!videoPath) return;

        const video = item.querySelector('video');
        const img = item.querySelector('img');
        if (!video || !img) return;

        const sources = video.querySelectorAll('source');
        const webmPath = videoPath.replace(/\.mp4$/, '.webm');
        sources[0].src = webmPath; // WebM source
        sources[1].src = videoPath; // MP4 fallback

        // Handle video load errors
        const handleVideoError = () => {
            video.style.display = 'none';
            img.style.display = 'block';
            video.removeEventListener('error', handleVideoError);
        };

        video.addEventListener('error', handleVideoError, { once: true });

        video.load();
        video.style.display = 'block';
        img.style.display = 'none';

        video.play().then(() => {
            video.classList.add('playing');
        }).catch(() => {
            video.style.display = 'none';
            img.style.display = 'block';
        });
    }

    stopVideoForMenuItem(item) {
        const video = item.querySelector('video');
        const img = item.querySelector('img');
        if (video && img) {
            video.pause();
            video.currentTime = 0;
            video.classList.remove('playing');
            video.style.display = 'none';
            img.style.display = 'block';
        }
    }

    playWaveAnimation() {
        // Broadcast wave animation to parent bridge so the corner icon also
        // plays the wave GIF. Falls back to idle after ~2.5s (typical wave
        // clip length).
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'CT_ICON_ANIMATION', name: 'waving' }, '*');
                setTimeout(() => {
                    try {
                        window.parent.postMessage({ type: 'CT_ICON_ANIMATION', name: 'idle' }, '*');
                    } catch (_) { /* non-fatal */ }
                }, 2500);
            }
        } catch (_) { /* non-fatal */ }

        // Delegate to UI Layout to play wave in call mode panel
        if (window.uiLayout && typeof window.uiLayout.playCallModeWave === 'function') {
            window.uiLayout.playCallModeWave(this);
        } else {
            console.warn('[Erica] UI Layout wave function not available');
        }
    }

    stopAllVideos() {
        // Stop current voice video
        if (this.currentVoiceVideo) {
            this.currentVoiceVideo.pause();
            this.currentVoiceVideo.currentTime = 0;
            this.currentVoiceVideo.classList.remove('playing');
            this.currentVoiceVideo.style.display = 'none';
            if (this.currentVoiceThumb) {
                this.currentVoiceThumb.style.display = 'block';
            }
        }

        // Stop all menu item videos
        this.voiceMenuItems.forEach((item) => {
            this.stopVideoForMenuItem(item);
        });

        this.isBotSpeaking = false;
        this.currentVideoState = 'idle';
    }

    setVoiceControlsDisabled(disabled) {
        if (this.voiceItems && this.voiceItems.length > 0) {
            this.voiceItems.forEach((item) => {
                item.disabled = disabled;
            });
        }
        if (this.voiceMenuItems && this.voiceMenuItems.length > 0) {
            this.voiceMenuItems.forEach((item) => {
                item.disabled = disabled;
            });
        }
    }

    async disconnect() {
        // Stop recording if active
        if (this.isRecording) {
            this.stopRecording();
        }

        // Close data channel
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }

        // Close peer connection
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
        this.audioSender = null;

        // Stop local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        // Stop all videos
        this.stopAllVideos();

        // Remove remote audio
        if (this.remoteAudio) {
            this.remoteAudio.pause();
            this.remoteAudio.srcObject = null;
            if (this.remoteAudio.parentNode) {
                this.remoteAudio.parentNode.removeChild(this.remoteAudio);
            }
            this.remoteAudio = null;
        }

        // Clear audio context
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        // Clear intervals
        if (this.audioLevelInterval) {
            clearInterval(this.audioLevelInterval);
            this.audioLevelInterval = null;
        }
        if (this.audioCheckInterval) {
            clearInterval(this.audioCheckInterval);
            this.audioCheckInterval = null;
        }
        if (this.remoteLevelInterval) {
            clearInterval(this.remoteLevelInterval);
            this.remoteLevelInterval = null;
        }
        // Clear session inactivity timer
        this.clearSessionInactivityTimer();
        this.remoteAnalyser = null;
        if (this.remoteAudioSource) {
            try { this.remoteAudioSource.disconnect(); } catch (_) { }
            this.remoteAudioSource = null;
        }
        if (this.remoteAudioGain) {
            try { this.remoteAudioGain.disconnect(); } catch (_) { }
            this.remoteAudioGain = null;
        }
        if (window.uiLayout && typeof window.uiLayout.updateSpeakerLevel === 'function') {
            window.uiLayout.updateSpeakerLevel(this, 0);
        }

        // Reset state
        this.isConnected = false;
        this.isRecording = false;
        this.pendingResponses.clear();
        this.activeAudioResponses.clear();
        this.pendingFunctionCalls.clear();

        // Update UI
        this.updateStatus(false);
        this.callButton.disabled = true;
        this.textInput.disabled = true;
        this.sendTextButton.disabled = true;
        this.setCallAudioEnabled(false);

        // Reset UI helpers
        if (typeof this.hideLoader === 'function') this.hideLoader();
        // Mic button is already disabled via callButton alias above, but reinforcing state style
        if (typeof this.setMicButtonState === 'function') this.setMicButtonState('disabled');

        // Reset mute state
        this.isSelfMuted = false;
    }

    async reconnectWithNewVoice(options = {}) {
        // We are switching coaches/voices; on the next session we want the coach to "re-introduce"
        // even if there is existing history in the UI.
        this.openingLineSent = false;

        // Disconnect current connection
        await this.disconnect();

        // Wait a bit before reconnecting
        await new Promise(resolve => setTimeout(resolve, 500));

        // Reconnect with new voice
        try {
            await this.establishConnection();
            if (!options.skipOpeningLine) {
                await this._maybeSendOpeningLine({ skipIfSent: false });
            }
        } catch (error) {
            console.error('[Erica] Reconnection error:', error);
            const errorMessage = error.message || 'Unknown error occurred';
            console.warn('[Erica] Failed to reconnect:', errorMessage);
        }
    }

    // ------------------------------------------------------------------------
    // Voice Usage Limit Logic
    // ------------------------------------------------------------------------

    _getTodayString() {
        return new Date().toISOString().split('T')[0]; // "YYYY-MM-DD"
    }

    _loadVoiceUsage() {
        try {
            const raw = localStorage.getItem('erica_voice_usage_v1');
            if (!raw) return { date: this._getTodayString(), count: 0 };

            const p = JSON.parse(raw);
            const today = this._getTodayString();

            // Reset if new day
            if (p.date !== today) {
                return { date: today, count: 0 };
            }
            return p;
        } catch (e) {
            console.warn('[Erica] Error loading voice usage:', e);
            return { date: this._getTodayString(), count: 0 };
        }
    }

    _saveVoiceUsage(usageData) {
        try {
            localStorage.setItem('erica_voice_usage_v1', JSON.stringify(usageData));
        } catch (e) {
            console.error('[Erica] Error saving voice usage:', e);
        }
    }

    /*checkVoiceLimit() {
        if (!this.questionsLimit) return true; // No limit enforced (or not yet loaded)

        const usage = this._loadVoiceUsage();
        // Check if limit reached
        if (usage.count >= this.questionsLimit) {
            console.warn(`[Erica] Voice limit reached: ${usage.count}/${this.questionsLimit}`);
            return false;
        }
        return true;
    }*/
    checkVoiceLimit() {
        if (!this.questionsLimit) return true; // No limit enforced

        const usage = this._loadVoiceUsage();
        const effectiveCount = Math.max(usage.count, this._serverVoiceUsageCount || 0);

        if (effectiveCount >= this.questionsLimit) {
            console.warn(`[Erica] Voice limit reached: ${effectiveCount}/${this.questionsLimit}`);
            return false;
        }
        return true;
    }

    async incrementVoiceUsage() {
        const usage = this._loadVoiceUsage();
        usage.count += 1;
        this._saveVoiceUsage(usage);
        // console.log(`[Erica] Voice usage incremented: ${usage.count}/${this.questionsLimit || '?'}`);

        if (this.questionsLimit && usage.count >= this.questionsLimit) {
            console.log('[Erica] Voice limit reached during active session. Stopping.');
            
            // Analytics: voice limit reached
            this.trackCoachEvent('Voice Limit Reached', {
                VoiceQuestionCount: usage.count,
                DailyLimit: this.questionsLimit
            });
            
            if (this.isRecording) {
                // Stop the session first
                if (typeof this.stopRecording === 'function') {
                    this.stopRecording(true); // Force stop to ensure cleanup
                } else {
                    // Fallback if stopRecording is missing (safeguard)
                    this.isRecording = false;
                    if (this.localStream) {
                        this.localStream.getTracks().forEach(t => t.stop());
                        this.localStream = null;
                    }
                    if (window.uiLayout && typeof window.uiLayout.setMicToggleUI === 'function') {
                        window.uiLayout.setMicToggleUI(false);
                    }
                    this.saveCurrentState('chat');
                }
            }
            this.showVoiceLimitAlert();
        }
    }

    stopRecording(force = false) {
        console.log('[Erica Debug] stopRecording ENTRY. isRecording:', this.isRecording, 'timestamp:', this.recordingStartTimestamp, 'Force:', force);
        if (!this.isRecording && !force) {
            console.warn('[Erica Debug] stopRecording checking failed: isRecording is false');
            return;
        }
        console.log('[Erica] Stopping recording...');
        this.isRecording = false;

        if (this.localStream) {
            const tracks = this.localStream.getTracks();
            console.log(`[Erica Debug] Stopping ${tracks.length} local tracks.`);
            tracks.forEach(track => {
                try {
                    track.stop();
                    track.enabled = false;
                    console.log(`[Erica Debug] Stopped track: ${track.id} (${track.kind})`);
                } catch (e) {
                    console.error('[Erica Debug] Error stopping track:', e);
                }
            });
            this.localStream = null;
        } else {
            console.warn('[Erica Debug] stopRecording called but this.localStream is NULL. Mic might stay open!');
        }

        // Bridge valid references (if any legacy ones needed)

        // Update UI
        if (window.uiLayout) {
            if (typeof window.uiLayout.setMicToggleUI === 'function') {
                window.uiLayout.setMicToggleUI(this, false);
            }
            if (typeof window.uiLayout.setCallModePanelOpen === 'function') {
                window.uiLayout.setCallModePanelOpen(this, false);
            }
        }

        // IMPORTANT: Disable call-audio gating immediately
        this.audioOutputGate = true; // Gate immediately
        this.setCallAudioEnabled(false);

        // Cancel any pending generation on the server
        if (this.isConnected) {
            this.cancelActiveResponses();
        }

        if (this.audioLevelInterval) {
            clearInterval(this.audioLevelInterval);
            this.audioLevelInterval = null;
        }

        // Clear voice inactivity timer
        this.clearVoiceInactivityTimer();
        this.isVoiceMutedByInactivity = false;

        // Re-enable voice controls
        if (this.isConnected) {
            // this.setVoiceControlsDisabled(false); // Check if exists, or just rely on state
        }

        // Save state
        this.saveCurrentState('chat');

        // Track event
        const durationSeconds = this.recordingStartTimestamp ? Math.round((Date.now() - this.recordingStartTimestamp) / 1000) : 0;
        console.log('[Erica Debug] Tracking event: Stopped AI Voice Mode. Duration:', durationSeconds);
        this.trackCoachEvent('Stopped AI Voice Mode', {
            SessionDuration: durationSeconds
        });
    }

    // Voice Inactivity Timeout Management
    startVoiceInactivityTimer() {
        this.clearVoiceInactivityTimer();
        this.lastAudioActivityTimestamp = Date.now();
        this.voiceInactivityTimeout = setTimeout(() => {
            this.handleVoiceInactivityTimeout();
        }, this.VOICE_INACTIVITY_TIMEOUT_MS);
        console.log('⏱️  [Erica Inactivity] Timer STARTED - will trigger in 30 seconds');
    }

    resetVoiceInactivityTimer() {
        if (this.isVoiceMutedByInactivity) return; // Don't reset if already muted
        if (!this.isRecording) return; // Only reset if recording

        const timeSinceLastActivity = Date.now() - this.lastAudioActivityTimestamp;
        console.log('[Erica Inactivity] Timer reset - audio detected (was silent for', Math.round(timeSinceLastActivity / 1000), 'seconds)');

        this.lastAudioActivityTimestamp = Date.now();
        this.clearVoiceInactivityTimer();
        this.voiceInactivityTimeout = setTimeout(() => {
            this.handleVoiceInactivityTimeout();
        }, this.VOICE_INACTIVITY_TIMEOUT_MS);

        // Reset 30-minute session inactivity timer on voice activity
        this.startSessionInactivityTimer();
    }

    clearVoiceInactivityTimer() {
        if (this.voiceInactivityTimeout) {
            clearTimeout(this.voiceInactivityTimeout);
            this.voiceInactivityTimeout = null;
        }
    }

    startSessionInactivityTimer() {
        this.clearSessionInactivityTimer();
        this.sessionInactivityTimeout = setTimeout(() => {
            this.handleSessionInactivityTimeout();
        }, this.SESSION_INACTIVITY_TIMEOUT_MS);
        console.log('[Session Inactivity] Timer started/reset - will disconnect after 30 minutes of inactivity');
    }

    clearSessionInactivityTimer() {
        if (this.sessionInactivityTimeout) {
            clearTimeout(this.sessionInactivityTimeout);
            this.sessionInactivityTimeout = null;
        }
    }

    handleSessionInactivityTimeout() {
        if (!this.isConnected) return;
        console.log('[Session Inactivity] 30 minutes elapsed - setting on hold');
        this.isOnHold = true;
        if (window.uiLayout && typeof window.uiLayout.updateStatusDot === 'function') {
            window.uiLayout.updateStatusDot(this, 'onhold');
        }
        if (typeof this.trackCoachEvent === 'function') {
            this.trackCoachEvent('Session On Hold - Inactivity Timeout', {});
        }
    }

    handleVoiceInactivityTimeout() {
        console.log('⏰ [Erica Inactivity] TIMER REACHED ZERO - 30 seconds elapsed!');

        if (!this.isRecording || this.isVoiceMutedByInactivity) return;

        // We rely on continuous resets based on audio levels (lastRemoteLevelAt)
        // to keep the timer alive while coach is speaking.
        // If we reached here, it means true silence (no user speech, no coach audio levels).

        console.log('[Erica] Voice inactivity timeout triggered - muting microphone');

        // Mute the microphone track
        const audioTrack = this.localStream?.getAudioTracks()[0];
        if (audioTrack) {
            // Check if already muted by user
            this.wasMutedBeforeInactivity = !audioTrack.enabled;
            console.log('[Erica] User mute state preserved:', this.wasMutedBeforeInactivity ? 'MUTED' : 'UNMUTED');

            audioTrack.enabled = false;
        }

        this.isVoiceMutedByInactivity = true;
        this.inactivityMuteTimestamp = Date.now();

        // Show modal
        console.log('[Erica] Showing inactivity modal...');
        console.log('[Erica] Modal element exists?', !!this.voiceInactivityModal);
        console.log('[Erica] showVoiceInactivityModal function exists?', typeof this.showVoiceInactivityModal === 'function');

        if (typeof this.showVoiceInactivityModal === 'function') {
            this.showVoiceInactivityModal();
            console.log('[Erica] ✅ Modal show function called');
        } else {
            console.error('[Erica] ❌ showVoiceInactivityModal function not found!');
        }

        // Track analytics
        if (typeof this.trackCoachEvent === 'function') {
            this.trackCoachEvent('Voice Muted - Inactivity Timeout', {
                sessionDuration: Date.now() - this.recordingStartTimestamp,
                lastActivity: this.lastAudioActivityTimestamp
            });
        }
    }

    setupAudioAnalysis(stream) {
        if (!stream) return;

        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;

            this.audioContext = new AudioContext();
            const source = this.audioContext.createMediaStreamSource(stream);
            const analyser = this.audioContext.createAnalyser();

            analyser.fftSize = 256;
            source.connect(analyser);

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            // Stop any existing interval
            if (this.audioLevelInterval) clearInterval(this.audioLevelInterval);

            // Check audio levels every 200ms
            this.audioLevelInterval = setInterval(() => {
                if (!this.isRecording || this.isVoiceMutedByInactivity) return;

                analyser.getByteFrequencyData(dataArray);

                // Calculate average volume
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i];
                }
                const average = sum / bufferLength;

                // Normalize to 0-1 range (approx)
                const volume = average / 255;

                // If volume exceeds threshold, reset interactivity timer
                if (volume > this.VOICE_ACTIVITY_THRESHOLD) {
                    // console.log('[Erica] Voice activity detected:', volume.toFixed(3));
                    this.resetVoiceInactivityTimer();
                }
            }, 200);

            console.log('[Erica] Audio analysis started for inactivity monitoring');
        } catch (e) {
            console.error('[Erica] Error setting up audio analysis:', e);
        }
    }

    resumeFromInactivity() {
        if (!this.isVoiceMutedByInactivity) return;

        console.log('[Erica] Resuming from inactivity - checking mute state');

        // Unmute the microphone track ONLY if it wasn't muted before
        const audioTrack = this.localStream?.getAudioTracks()[0];
        if (audioTrack) {
            if (this.wasMutedBeforeInactivity) {
                console.log('[Erica] Microphone remains MUTED (user was muted before inactivity)');
                audioTrack.enabled = false;
            } else {
                console.log('[Erica] Unmuting microphone');
                audioTrack.enabled = true;
            }
        }

        this.isVoiceMutedByInactivity = false;
        this.wasMutedBeforeInactivity = false; // Reset state

        // Hide modal
        if (typeof this.hideVoiceInactivityModal === 'function') {
            this.hideVoiceInactivityModal();
        }

        // Restart timer
        this.startVoiceInactivityTimer();

        // Track analytics
        if (typeof this.trackCoachEvent === 'function') {
            this.trackCoachEvent('Voice Resumed - After Inactivity', {
                muteDuration: Date.now() - this.inactivityMuteTimestamp
            });
        }
    }

    showVoiceLimitAlert() {
        if (typeof this.showLimitReachedPrompt === 'function') {
            this.showLimitReachedPrompt();
        } else {
            alert("You’ve reached your voice limit for today. You can keep chatting by text. Voice will be back tomorrow.");
        }
    }

    clearConversation() {
        console.log('[Erica] Clearing conversation...');

        // Clear in-memory message data
        this.messages = [];
        this.messageElements.clear();
        this.pendingBotMessages = [];

        // Clear current message tracking
        this.currentUserMessageElement = null;
        this.currentUserTranscript = '';
        this.currentUserItemId = null;
        this.lastFinalizedUserMessage = null;
        this.currentBotMessageElement = null;
        this.currentBotTranscript = '';
        this.currentBotItemId = null;

        // Clear DOM elements
        if (this.chatMessages) {
            this.chatMessages.innerHTML = '';
        }

        // Clear conversation history cache
        if (this._historyCache) {
            this._historyCache.clear();
        }

        // Save the cleared state (empty conversation history)
        this.saveCurrentState(this.isRecording ? 'call' : 'chat');

        // Persist empty history to server so reopen doesn't restore old messages
        this.saveConversationHistory({ preferSoon: true });

        // Track analytics event
        if (typeof this.trackCoachEvent === 'function') {
            this.trackCoachEvent('Cleared Conversation', {});
        }

        console.log('[Erica] Conversation cleared successfully');
    }

    async connect(options = {}) {
        await this.stopActivePreview({ clearPreview: false });
        // Voice Limit Check
        if (!this.checkVoiceLimit()) {
            this.showVoiceLimitAlert();
            return;
        }

        // Prevent overlapping connect attempts (they hammer preparation/history endpoints).
        if (this.isConnected || this.isConnecting) {
            this.dlog('[Erica] connect() ignored (already connected/connecting)', {
                isConnected: this.isConnected,
                isConnecting: this.isConnecting
            });
            return;
        }
        this.isConnecting = true;
        this.updateStatus('connecting');

        // SECURITY: Do not accept or store OpenAI API keys in the browser.
        // Realtime negotiation is done via /api/proxy/realtime using a server-held key.
        this.apiKey = '';

        if (this.apiKeyInput) {
            this.apiKeyInput.disabled = true;
        }
        if (this.connectButton) {
            this.connectButton.disabled = true;
        }
        // Keep voice controls enabled - they'll work once connected
        if (this.connectButton) {
            this.connectButton.textContent = 'Connecting...';
        }

        // Fetch preparation even in guest mode (no userId/email)
        const userId = this.getUserIdFromURL();
        const email = this.getEmailFromURL();
        const prepIdentifier = userId || email || null;
        try {
            if (this.connectButton) this.connectButton.textContent = 'Loading instructions...';
            await this.fetchEricaPreparation(prepIdentifier);
        } catch (error) {
            // If this was an intentional abort (invalid URL coach), stop here —
            // the navigator/coach list is already rendered, don't fall through to defaults
            if (this._urlCoachInvalid) {
                console.log('[Erica] Connection aborted — waiting for user to select a coach.');
                this.isConnecting = false;
                return;
            }

            console.error('Error fetching Erica preparation:', error);
            // Ensure UI doesn't hang on spinner
            const coachList = document.getElementById('coachList');
            if (coachList && coachList.innerHTML.includes('animate-spin')) {
                coachList.innerHTML = '<div class="p-4 text-center text-gray-500 text-sm">Unable to load coach list.<br>(Using default voice)</div>';
            }
            // Fallback: try local `voiceProfiles.json` only if preparation is unavailable.
            try {
                await this.loadVoiceProfiles();
                if (typeof this.renderCoachList === 'function' && Array.isArray(this.voiceProfilesArray) && this.voiceProfilesArray.length > 0) {
                    this.renderCoachList(this.voiceProfilesArray);
                }
            } catch (_) {
                // ignore
            }
            // Continue with default instructions if fetch fails
        }

        // Request report context from parent iframe (for report pages).
        // By the time the user opens Erica, the report is already rendered on the parent page,
        // so the parent can respond immediately to REQUEST_REPORT_CACHE.
        try {
            const reportCtx = await this.requestReportContextFromParent();
            if (reportCtx && reportCtx.text) {
                const reportText = String(reportCtx.text);
                this.customInstructions = (this.customInstructions || '') + '\n\nReport Context (current page):\n' + reportText;
                console.log('[Erica] ✓ Report context appended to instructions at connect(), chars:', reportText.length);
            }
        } catch (_) {
            // Non-fatal: proceed without report context
        }

        // Fetch conversation history before connecting (if enabled).
        // Note: history may also be provided via preparation response.
        let conversationHistory = null;
        if (this.disableHistoryFetch) {
            this.dlog('[Erica] History fetch is currently disabled (investigation mode)');
        } else {
            // Check if preparation already provided history (preferred path)
            const hasPreparationHistory = this._prepResponseData && 
                this._prepResponseData.conversationHistory && 
                Array.isArray(JSON.parse(this._prepResponseData.conversationHistory || '[]')) &&
                JSON.parse(this._prepResponseData.conversationHistory || '[]').length > 0;
            
            if (hasPreparationHistory) {
                this.dlog('[Erica] Skipping redundant history fetch (provided by preparation)');
                conversationHistory = null; // Already merged during preparation
            } else {
                try {
                    if (this.connectButton) this.connectButton.textContent = 'Loading history...';
                    conversationHistory = await this.fetchConversationHistory();
                    if (conversationHistory) {
                        // Merge server history into current conversation
                        this.mergeConversationHistory(conversationHistory, { source: 'server' });
                    }
                } catch (error) {
                    console.error('Error fetching conversation history:', error);
                    // Continue without history if fetch fails
                }
            }
        }

        // Store history to send after session is configured.
        // Do not clobber a history already populated via preparation.
        if (conversationHistory) {
            this.conversationHistoryToSend = conversationHistory;
        }

        // Detect URL question BEFORE connecting. If present, hard-block the opening
        // line at the source so no other code path (preparation tune, requestOpeningLine,
        // reconnect, etc.) can fire it during the connection setup window. Previously
        // the gating relied only on _urlQuestionSent and a 1s setTimeout, which left a
        // race window where the opening line could win and the bot would just greet
        // the user instead of answering the URL question.
        const urlQuestion = !this._urlQuestionSent ? this.getUrlQuestion() : null;
        if (urlQuestion) {
            this._urlQuestionSent = true;
            this.openingLineSent = true; // global hard-block for _maybeSendOpeningLine
            console.log('[Erica] URL question detected — opening line blocked globally');
        }

        try {
            await this.establishConnection();
            // Default to audio off unless actively in call mode.
            this.setCallAudioEnabled(!!this.isRecording);
            // Send URL question OR opening line — not both.
            // If a URL question is present, it replaces the opening line as the
            // conversation starter. Otherwise, fire the normal opening line.
            if (urlQuestion) {
                if (this.getUrlAutoSubmit()) {
                    // Auto-submit: send the question immediately
                    try {
                        await this._waitForDataChannelOpen(5000);
                    } catch (e) {
                        console.warn('[Erica] Data channel wait timed out, sending question anyway:', e);
                    }
                    console.log('[Erica] Sending URL question:', urlQuestion);
                    this.sendTextMessage(urlQuestion);
                } else {
                    // No auto-submit: place in input field for user to review/edit
                    console.log('[Erica] Placing URL question in input (autosubmit=n):', urlQuestion);
                    if (this.textInput) {
                        this.textInput.value = urlQuestion;
                        this.updateTextButtonVisibility();
                    }
                }
            } else if (!options.skipOpeningLine) {
                await this._maybeSendOpeningLine();
            }
        } catch (error) {
            console.error('Connection error:', error);
            const errorMessage = error.message || 'Unknown error occurred';
            console.warn('[Erica] Failed to connect:', errorMessage);
            this.apiKeyInput.disabled = false;

            // Reset UI on failure
            if (typeof this.hideLoader === 'function') this.hideLoader();
            // Re-enable (or disable? likely enable to allow retry, or just leave disabled if fatal?)
            // Usually we want to allow retry.
            if (this.connectButton) {
                this.connectButton.disabled = false;
                this.connectButton.textContent = 'Connect';
            }
            if (typeof this.setMicButtonState === 'function') {
                // Determine state: if we have a voice profile selected, maybe we are 'ready' again?
                // Or just 'enabled' to allow clicking again (which triggers connect).
                this.setMicButtonState('enabled');
            }
        } finally {
            this.isConnecting = false;
        }
    }

    async requestOpeningLine({ force = false } = {}) {
        await this.stopActivePreview({ clearPreview: false });
        // Ensure audio is gated by call mode before speaking the opening line.
        this.setCallAudioEnabled(!!this.isRecording);
        return await this._maybeSendOpeningLine({ skipIfSent: !force });
    }

    getEmailFromURL() {
        // Extract email from URL manually to preserve + characters
        // URLSearchParams converts + to space, so we need to handle it manually
        const rawUrl = window.location.href;
        const emailMatch = rawUrl.match(/[?&]email=([^&]*)/);

        if (emailMatch) {
            // Get the raw email value from URL
            let rawEmail = emailMatch[1];

            // Decode URI component (this will decode %2B to +, and other encoded chars)
            try {
                const decoded = decodeURIComponent(rawEmail);

                // If the decoded email has spaces and looks like an email (has @),
                // those spaces were likely + characters that got converted
                // Replace them back to + (emails don't have spaces)
                if (decoded.includes(' ') && decoded.includes('@')) {
                    return decoded.replace(/\s+/g, '+');
                }

                return decoded;
            } catch (e) {
                // If decode fails, the email might already be decoded
                // Check if it has spaces that should be +
                if (rawEmail.includes(' ') && rawEmail.includes('@')) {
                    return rawEmail.replace(/\s+/g, '+');
                }
                return rawEmail;
            }
        }

        return null;
    }

    getUserIdFromURL() {
        // Extract userId from URL
        const rawUrl = window.location.href;
        const userIdMatch = rawUrl.match(/[?&]userId=([^&]*)/i);

        if (userIdMatch) {
            try {
                return decodeURIComponent(userIdMatch[1]);
            } catch (error) {
                return userIdMatch[1];
            }
        }

        return null;
    }

    async fetchEricaPreparation(prepId, { force = false } = {}) {
        try {
            // console.log('[Erica] Fetching preparation for identifier:', prepId, 'Force:', force);

            const cacheKey = prepId ? String(prepId) : '__guest__';
            const cached = this._prepCache.get(cacheKey);
            const now = Date.now();

            // 60s TTL to avoid Wix 429 during bursty reconnects/reloads
            let data = null;
            if (!force && cached && now - cached.ts < 60_000) {
                this.dlog('[Erica] Using cached preparation', { cacheKey });
                data = cached.data;
            } else {
                // Single-flight: share the same network call across concurrent attempts
                if (!this._prepFetchInFlight) {
                    this._prepFetchInFlight = (async () => {
                        const response = await this.fetchWithBackoff(
                            this.apiUrl('/api/erica-preparation'),
                            {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                // Send userId if not email; otherwise send email for backward compatibility
                                /*body: JSON.stringify(
                                    prepId && typeof prepId === 'string' && prepId.includes('@')
                                        ? { email: prepId }
                                        : prepId
                                            ? { userId: prepId }
                                            : {} // guest mode: send empty payload, server is resilient
                                )*/
                                // Fixed code — add caller from URL + bridged CleverTap objectId (Fase C.2):
                                body: JSON.stringify({
                                    caller: new URLSearchParams(window.location.search).get('caller') || 'app',
                                    // objectId is set by the parent-page bridge (AI coach Monitor in Wix)
                                    // in response to REQUEST_CLEVERTAP_ID. Present for guest users; harmless
                                    // when signed-in (server prefers userId).
                                    ...(typeof window !== 'undefined' && window.__ttCleverTapId
                                        ? { objectId: String(window.__ttCleverTapId) }
                                        : {}),
                                    ...(prepId && typeof prepId === 'string' && prepId.includes('@')
                                        ? { email: prepId }
                                        : prepId
                                            ? { userId: prepId }
                                            : {})
                                })
                            },
                            { label: 'preparation fetch', retries: 8 }
                        );

                        // Read text once so we can debug even on errors
                        const responseText = await response.text();

                        if (!response.ok) {
                            console.error('[Erica] Preparation API error response:', {
                                status: response.status,
                                statusText: response.statusText,
                                bodyPreview: (responseText || '').replace(/\s+/g, ' ').trim().slice(0, 1000)
                            });
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }

                        // Try to parse as JSON, but handle text responses too
                        // console.log('[Erica] Preparation API raw response (first 200 chars):', responseText.substring(0, 200));

                        let parsed;
                        try {
                            parsed = JSON.parse(responseText);
                            // console.log('[Erica] Preparation API response (parsed JSON):', {
                            // hasData: !!parsed,
                            // dataType: typeof parsed,
                            // keys: typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : 'N/A',
                            // preview: typeof parsed === 'string' ? parsed.substring(0, 100) : JSON.stringify(parsed).substring(0, 100)
                            // });
                            // console.log('FULL_PREP_JSON:', JSON.stringify(parsed, null, 2));
                        } catch (e) {
                            // If not JSON, treat as plain text
                            console.log('[Erica] Preparation API response is not JSON, treating as text');
                            parsed = responseText;
                        }

                        this._prepCache.set(cacheKey, { ts: Date.now(), data: parsed });
                        return parsed;
                    })().finally(() => {
                        this._prepFetchInFlight = null;
                    });
                }

                data = await this._prepFetchInFlight;
            }

            // Store preparation data for connection flow optimization
            this._prepResponseData = data;

            // Consume bundled conversation history from preparation (preferred path).
            // Server returns `conversationHistory` as a JSON string (or array).
            try {
                const currentUserId = this.getUserIdFromURL();
                const keyUsed = data && typeof data === 'object' ? (data.conversationHistoryKeyUsed || null) : null;

                if (currentUserId && keyUsed && keyUsed !== currentUserId) {
                    console.warn('[Erica] Ignoring bundled history (key mismatch)', { currentUserId, keyUsed });
                } else {
                    let history = data && typeof data === 'object' ? data.conversationHistory : null;

                    if (typeof history === 'string' && history.trim()) {
                        history = JSON.parse(history);
                    }

                    if (Array.isArray(history) && history.length > 0) {
                        // Normalize companionThumb URLs that may have been stored with a localhost origin
                        // (e.g., "http://localhost:8000/companions/Erica-thumb.png") so production
                        // renders avatars from the current deployment basePath.
                        const normalizeThumb = (thumb) => {
                            if (!thumb || typeof thumb !== 'string') return thumb;
                            const t = thumb.trim();

                            // Extract /companions/... from any path (handles /agentErica/companions/... etc.)
                            const compIdx = t.indexOf('/companions/');
                            if (compIdx !== -1 && !t.startsWith('http')) {
                                return this.apiUrl(t.substring(compIdx));
                            }
                            if (t.startsWith('companions/')) return this.apiUrl('/' + t);

                            // Handle absolute URLs — extract /companions/* from the pathname
                            if (t.startsWith('http://') || t.startsWith('https://')) {
                                try {
                                    const u = new URL(t);
                                    const ci = u.pathname.indexOf('/companions/');
                                    if (ci !== -1) {
                                        return this.apiUrl(u.pathname.substring(ci));
                                    }
                                } catch (_) {
                                    // ignore parse errors, fall through
                                }
                            }

                            return thumb;
                        };

                        history = history.map((msg) => {
                            if (!msg || typeof msg !== 'object') return msg;
                            const next = { ...msg };
                            if (next.companionThumb) {
                                next.companionThumb = normalizeThumb(next.companionThumb);
                            }
                            return next;
                        });

                        /* console.info('[Erica] Using bundled conversation history from preparation', {
                            messages: history.length,
                            keyUsed: keyUsed || null
                        }); */

                        // Merge history without replacing current conversation
                        this.mergeConversationHistory(history, { source: 'preparation' });
                        this.conversationHistoryToSend = history;

                        // Count today's voice messages from preparation history (same as fetchConversationHistory path)
                        const today = this._getTodayString();
                        const prepVoiceCount = Array.isArray(history)
                            ? history.filter(m =>
                                m.role === 'user' &&
                                m.inputType === 'voice' &&
                                m.timestamp &&
                                new Date(m.timestamp).toISOString().split('T')[0] === today
                            ).length
                            : 0;
                        this._serverVoiceUsageCount = Math.max(this._serverVoiceUsageCount || 0, prepVoiceCount);
                        console.log(`[Erica] Server voice usage today (preparation): ${prepVoiceCount}`);

                        // Seed cache to avoid refetch/parsing on reconnect storms
                        if (currentUserId && this._historyCache) {
                            this._historyCache.set(currentUserId, { ts: Date.now(), history });
                        }
                    }
                }
            } catch (e) {
                console.warn('[Erica] Failed to parse bundled conversationHistory from preparation', e);
            }

            // Store the preparation instructions and update companions if provided
            if (data) {
                // Capture opening line prompt if present
                if (typeof data.openingLinePrompt === 'string') {
                    this.openingLinePrompt = data.openingLinePrompt.trim();
                }
                // Build primary instructions, preferring `message`, then fallbacks
                const buildInstructions = (payload) => {
                    if (typeof payload === 'string') {
                        return payload.trim();
                    }
                    if (!payload || typeof payload !== 'object') return '';
                    const fields = [
                        payload.message,
                        payload.ericaPreparation,
                        payload.preparation,
                        payload.instructions
                    ];
                    const primary = fields.find((f) => typeof f === 'string' && f.trim().length > 0);
                    if (primary) return primary.trim();
                    try {
                        return JSON.stringify(payload);
                    } catch (_) {
                        return '';
                    }
                };

                let instructions = buildInstructions(data);

                // If companions array present, normalize and use it as live voice profiles.
                // This supports inconsistent API shapes (flat vs nested) and prevents merging coaches
                // that share the same openaiVoice (we select by companionId).
                if (Array.isArray(data.companions)) {
                    const profilesArray = this.normalizeCompanions(data.companions);
                    this.saveCompanionsCache(profilesArray);
                    this.voiceProfilesArray = profilesArray;
                    this.voiceProfilesByVoice = {}; // voice -> [profiles]
                    this.voiceProfilesById = {};    // id/companionId/character -> profile

                    profilesArray.forEach((entry) => {
                        if (!entry || !entry.configuration) return;
                        const cfg = entry.configuration;
                        const companionId = (entry.companionId || cfg.id || cfg.character || '').toLowerCase();
                        const openaiVoice = (cfg.openaiVoice || '').toLowerCase();
                        const normalized = { ...cfg, companionId: entry.companionId || cfg.id || cfg.character };
                        if (openaiVoice) {
                            if (!this.voiceProfilesByVoice[openaiVoice]) this.voiceProfilesByVoice[openaiVoice] = [];
                            this.voiceProfilesByVoice[openaiVoice].push(normalized);
                        }
                        if (companionId) this.voiceProfilesById[companionId] = normalized;
                        const idKey = (cfg.id || '').toLowerCase();
                        if (idKey) this.voiceProfilesById[idKey] = normalized;
                        const charKey = (cfg.character || '').toLowerCase();
                        if (charKey) this.voiceProfilesById[charKey] = normalized;
                    });

                    // Backward compatibility reference
                    this.voiceProfiles = this.voiceProfilesByVoice;

                    // Append companion summary
                    const primaryComp =
                        this.currentVoiceProfile ||
                        profilesArray.find((c) => (c.configuration?.openaiVoice || '').toLowerCase() === (this.selectedVoice || 'marin').toLowerCase()) ||
                        profilesArray[0];
                    if (primaryComp && primaryComp.configuration) {
                        const cfg = primaryComp.configuration;
                        const summaryParts = [
                            cfg.character || primaryComp.companionId || cfg.id,
                            cfg.label || cfg.role,
                            cfg.userFacingContext,
                            cfg.voiceSpeed ? `Voice Speed: ${cfg.voiceSpeed}` : null
                        ].filter(Boolean);
                        if (summaryParts.length > 0) {
                            instructions = `${instructions}\n\nCompanion Profile:\n${summaryParts.map((p) => `- ${p}`).join('\n')}`.trim();
                        }
                    }

                    // If ?coach= is in the URL, try to select that coach FIRST
                    // (must run before renderCoachList so we know if the coach is valid)
                    if (!this.applyUrlCoachSelection() && !this._urlCoachInvalid) {
                        const currentVoiceKey = this.selectedVoice ? this.selectedVoice.toLowerCase() : 'marin';
                        const currentArr = this.voiceProfilesByVoice[currentVoiceKey];
                        const marinArr = this.voiceProfilesByVoice['marin'];
                        this.currentVoiceProfile =
                            (Array.isArray(currentArr) ? currentArr[0] : null) ||
                            (Array.isArray(marinArr) ? marinArr[0] : null) ||
                            (Object.values(this.voiceProfilesById || {})[0] || null);

                        if (this.currentVoiceProfile) {
                            this.updateVoiceProfile(this.currentVoiceProfile.openaiVoice);
                            this.updateCurrentVoiceVideo('idle');
                        }
                    }

                    // console.log('[Erica] Voice profiles updated from preparation API companions array');

                    // DYNAMIC RENDER: Use renderCoachList, with navigator if applicable
                    // Runs AFTER applyUrlCoachSelection so _urlCoachInvalid is known
                    // Skip re-rendering if user already has an active coach (reconnect scenario)
                    if (typeof this.renderCoachList === 'function' && !this._coachListRendered) {
                        this._coachListRendered = true;
                        const savedNav = typeof EricaNavigator !== 'undefined' ? EricaNavigator.getSavedResult() : null;
                        if (savedNav) {
                            this.navigatorTags = savedNav.tags || null;
                            this.renderCoachList(profilesArray, savedNav);
                        } else if (typeof EricaNavigator !== 'undefined' && this.shouldShowNavigator()) {
                            this._showNavigator(profilesArray);
                        } else {
                            this.renderCoachList(profilesArray);
                        }
                    } else if (typeof this.renderCoachList === 'function') {
                        // Reconnect: just update the companion data without re-rendering UI
                        this.lastCompanions = profilesArray;
                    }

                    // If URL coach was invalid AND user hasn't selected a coach yet, abort.
                    // Once user selects a coach, _urlCoachInvalid is cleared by uiLayout.js
                    // and we skip this check on subsequent connect() calls.
                    if (this._urlCoachInvalid) {
                        console.log('[Erica] Invalid URL coach — aborting connection, showing coach selection.');
                        // Queue the URL question so it sends after user picks a coach and connects
                        const pendingQ = this.getUrlQuestion();
                        if (pendingQ) {
                            this._pendingTextMessages.push(pendingQ);
                            console.log('[Erica] URL question queued for after coach selection:', pendingQ);
                        }
                        this._urlQuestionSent = true; // Mark as handled so connect() doesn't re-process it
                        this.isConnecting = false;
                        // Open the coach selection overlay (it was hidden at initLayout because getUrlCoach() was truthy)
                        if (window.uiLayout && typeof window.uiLayout.setVoiceMenuOpen === 'function') {
                            window.uiLayout.setVoiceMenuOpen(this, true);
                        }
                        throw new Error('Invalid URL coach — user must select a coach');
                    }
                }

                // ============================================================
                // AI-Coach-v3: knowledge-grounding directive
                // ------------------------------------------------------------
                // Overrides the legacy "if not in uploaded documents, say
                // you're unsure" pattern in the base preparation prompt.
                // The base prompt was written before search_knowledge existed
                // and actively teaches Erica to punt on frameworks / user data
                // she doesn't have inline — which defeats the whole retrieval
                // layer. We tell her explicitly to CALL the tool first.
                // ============================================================
                const knowledgeGroundingDirective = [
                    '',
                    '=== KNOWLEDGE GROUNDING & REASONING (v3) ===',
                    'You have TWO tools that dramatically improve the quality of your responses:',
                    '',
                    '1. `search_knowledge` — searches a real knowledge base of coaching',
                    "   frameworks and this user's assessment reports / session history.",
                    '2. `deep_think` — delegates careful step-by-step reasoning to a dedicated',
                    '   reasoning model when the question is complex or involves trade-offs.',
                    '',
                    'MANDATORY BEHAVIOR FOR search_knowledge:',
                    '- When the user asks about coaching styles, frameworks, approaches, or names',
                    '  any coaching persona (Supportive, Directive, Discovery, Empowering,',
                    '  Nurturing, Guidance, Exploratory, Strengths, etc.), CALL search_knowledge',
                    "  with scope='frameworks' BEFORE answering.",
                    "- When the user asks about their OWN results, quizzes, reports, values,",
                    '  strengths, patterns, or anything specific to them, CALL search_knowledge',
                    "  with scope='user_data' BEFORE answering.",
                    "- Only say you don't know AFTER search_knowledge returns no relevant chunks.",
                    '',
                    'MANDATORY BEHAVIOR FOR deep_think:',
                    '- CALL deep_think whenever the user is weighing a decision, considering',
                    '  trade-offs, describing a dilemma, asking "what should I consider" /',
                    '  "help me think through this" / "I feel torn between X and Y", or when',
                    '  answering well requires holding multiple angles at once (values vs.',
                    '  skills, risk vs. stability, career vs. family, etc.).',
                    '- FIRST call search_knowledge if relevant grounding exists, THEN pass the',
                    '  retrieved excerpts as the `context` argument to deep_think.',
                    '- Use the returned reasoning to shape your answer, but never read the',
                    '  reasoning aloud. Deliver the suggested answer in your own coaching voice.',
                    '',
                    'GENERAL:',
                    '- Do not name the tools to the user; use them silently.',
                    '- If chunks come back from search_knowledge, weave the substance into your',
                    '  coaching voice; do not just recite them.',
                    '- This overrides any earlier instruction about "if a quiz or resource isn\'t',
                    '  in the uploaded documents, say you are unsure" — that predates these',
                    '  tools and no longer applies.',
                    '=== END KNOWLEDGE GROUNDING & REASONING ==='
                ].join('\n');

                instructions = `${instructions}\n${knowledgeGroundingDirective}`;

                // Inject the user's live activity timeline directly into the
                // system prompt so Erica knows about it WITHOUT needing to call
                // search_knowledge first. Was previously only in the vector
                // store — Erica had to decide to look, which she often didn't,
                // so the user history was invisible in practice.
                //
                // The bridged CleverTap objectId may not be on window yet at
                // this point (bridge is async postMessage), so poll for it up
                // to ~5s. Fire-and-forget so preparation completion isn't blocked.
                if (!this._activitySyncStarted) {
                    this._activitySyncStarted = true;
                    this._syncUserActivityIntoPrompt();
                }

                this.customInstructions = instructions;
                // Re-push session config now that customInstructions is populated.
                // updateVoiceProfile above may have called configureSession before this was set (race condition).
                if (this.isConnected) {
                    this.configureSession();
                }
                // console.log('[Erica] Stored custom instructions (final), length:', this.customInstructions.length);
            } else {
                console.warn('[Erica] No preparation data found in response');
            }

            if (this.customInstructions) {
                console.log('[Erica] ✓ Custom instructions stored successfully, preview:', this.customInstructions.substring(0, 150));
            } else {
                console.warn('[Erica] ✗ Custom instructions NOT stored - check API response format');
            }

            // Extract Question/Voice Limit
            // Expected key: 'questionsLimit' (e.g., 25 or 250)
            if (data && typeof data === 'object') {
                if (typeof data.questionsLimit === 'number') {
                    this.questionsLimit = data.questionsLimit;
                    // console.log('[Erica] Voice Limit stored:', this.questionsLimit);
                } else if (typeof data.limit === 'number') {
                    this.questionsLimit = data.limit;
                    // console.log('[Erica] Voice Limit stored (from "limit"):', this.questionsLimit);
                }
            }

        } catch (error) {
            console.error('[Erica] Error fetching preparation:', error);
            throw error;
        }
    }

    async establishConnection() {
        try {
            // Show loader and disable mic while connecting
            if (typeof this.showLoader === 'function') this.showLoader();
            if (typeof this.setMicButtonState === 'function') this.setMicButtonState('disabled');

            // Create WebRTC peer connection for audio streaming
            this.pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });


            // Pre-create an audio transceiver so we can attach the mic later via replaceTrack without renegotiation
            const audioTransceiver = this.pc.addTransceiver('audio', { direction: 'sendrecv' });
            this.audioSender = audioTransceiver ? audioTransceiver.sender : null;

            // If we already have a local stream (e.g. from startRecording), attach it now
            if (this.localStream) {
                const track = this.localStream.getAudioTracks()[0];
                if (track && this.audioSender) {
                    // console.log('[Erica] Attaching existing local stream to new connection');
                    this.audioSender.replaceTrack(track);
                }
            }


            // Set up audio element for remote audio
            this.remoteAudio = document.createElement('audio');
            this.remoteAudio.autoplay = true;
            this.remoteAudio.volume = 1.0;
            // Start muted until a call is active
            this.remoteAudio.muted = true;
            this.remoteAudio.style.display = 'none';
            document.body.appendChild(this.remoteAudio);

            // Add event listeners for audio element
            this.remoteAudio.oncanplay = () => {
                // Try to play when ready
                this.remoteAudio.play().catch(() => {
                    // Silent fail - user interaction may be needed
                });
            };
            this.remoteAudio.onerror = (error) => {
                console.error('Audio playback error:', this.remoteAudio.error);
            };

            // Track when bot is speaking for video playback
            // For MediaStreams, onplay/onpause events fire too early (when play() is called, not when audio actually plays)
            // So we rely only on the periodic check which verifies actual audio playback

            // Check audio track state periodically (for MediaStreams)
            // Only check if we're connected and have a valid audio element
            this.audioCheckInterval = setInterval(() => {
                if (!this.isConnected || !this.remoteAudio || !this.remoteAudio.srcObject) {
                    // If not connected or no audio, ensure we're in idle state
                    if (this.isBotSpeaking) {
                        this.isBotSpeaking = false;
                        this.updateCurrentVoiceVideo('idle');
                    }
                    this.lastAudioTime = 0;
                    this.silentIntervals = 0;
                    return;
                }

                const stream = this.remoteAudio.srcObject;
                const audioTracks = stream.getAudioTracks();
                const hasActiveTrack = audioTracks.some(track => track.readyState === 'live' && track.enabled && !track.muted);

                // If no active track, force idle and reset timers
                if (!hasActiveTrack) {
                    if (this.isBotSpeaking) {
                        this.isBotSpeaking = false;
                        this.updateCurrentVoiceVideo('idle');
                    }
                    this.botAudioReady = false;
                    this.lastAudioTime = 0;
                    this.silentIntervals = 0;
                    this.progressIntervals = 0;
                    return;
                }

                // More accurate playback detection: check if audio is actually playing
                // and has progressed (not just initialized)
                const currentTime = this.remoteAudio.currentTime || 0;
                const progressed = (currentTime - this.lastAudioTime) > 0.05; // ~50ms advance
                const isPlaying = !this.remoteAudio.paused &&
                    !this.remoteAudio.ended &&
                    currentTime > 0 &&
                    this.remoteAudio.readyState >= 2; // HAVE_CURRENT_DATA or higher

                // If we haven't seen audio unmute yet, try to infer readiness from progress; otherwise stay idle
                if (!this.botAudioReady) {
                    if (progressed && isPlaying) {
                        this.progressIntervals += 1;
                        if (this.progressIntervals >= 2) {
                            this.botAudioReady = true; // we saw real playback progress, treat as ready
                        }
                    } else {
                        this.progressIntervals = 0;
                        if (this.isBotSpeaking) {
                            this.isBotSpeaking = false;
                            this.updateCurrentVoiceVideo('idle');
                        }
                        this.silentIntervals = 0;
                        this.lastAudioTime = currentTime;
                        return;
                    }
                }

                // Only switch to speaking if we have an active track AND audio actually progresses AND audio gate is open
                if (hasActiveTrack && isPlaying && progressed && !this.audioOutputGate) {
                    // Trigger mic button speaking animation
                    if (typeof this.setMicSpeakingAnimation === 'function') {
                        this.setMicSpeakingAnimation(true);
                    }
                    this.silentIntervals = 0;
                    this.progressIntervals = 0;

                    // Reset inactivity timer while coach is speaking (throttled to every 5 seconds)
                    // Use lastRemoteLevelAt which tracks when actual audio levels were detected (not just stream connection)
                    const now = Date.now();
                    const hasRecentAudio = this.lastRemoteLevelAt && (now - this.lastRemoteLevelAt < 500); // Audio detected in last 500ms

                    if (hasRecentAudio && (now - this.lastAudioResetTimestamp > 5000)) {
                        // console.log('[Erica Inactivity] 🎙️ Coach speaking (audio level detected) - resetting timer');
                        this.resetVoiceInactivityTimer();
                        this.lastAudioResetTimestamp = now;
                    }

                    // Idle-only mode: do not switch to speaking video
                } else {
                    // Stop mic button speaking animation
                    if (typeof this.setMicSpeakingAnimation === 'function') {
                        this.setMicSpeakingAnimation(false);
                    }
                    this.silentIntervals += 1;
                    // Idle-only mode: keep idle; no speaking state to clear
                }

                this.lastAudioTime = currentTime;
            }, 200); // Check every 200ms

            // Handle incoming audio track from OpenAI
            this.pc.ontrack = (event) => {
                if (event.track.kind === 'audio') {
                    console.log('[Erica Inactivity] 📡 Audio track received from OpenAI');
                    // Always isolate bot audio into its own stream to avoid mixing local tracks
                    const stream = new MediaStream([event.track]);

                    // Track mute/unmute to gate speaking detection
                    this.botAudioReady = false; // wait for unmute or playback progress
                    event.track.onunmute = () => {
                        console.log('[Erica Inactivity] 🔊 Audio track UNMUTED - receiving audio from OpenAI');
                        this.botAudioReady = true;
                        // Reset inactivity timer when receiving audio from OpenAI
                        this.resetVoiceInactivityTimer();
                    };
                    event.track.onmute = () => {
                        console.log('[Erica Inactivity] 🔇 Audio track MUTED');
                        this.botAudioReady = false;
                        if (this.isBotSpeaking) {
                            this.isBotSpeaking = false;
                            this.updateCurrentVoiceVideo('idle');
                        }
                        this.lastAudioTime = 0;
                        this.silentIntervals = 0;
                    };
                    event.track.onended = () => {
                        this.botAudioReady = false;
                        if (this.isBotSpeaking) {
                            this.isBotSpeaking = false;
                            this.updateCurrentVoiceVideo('idle');
                        }
                        this.lastAudioTime = 0;
                        this.silentIntervals = 0;
                    };

                    // Set up audio element
                    if (!this.remoteAudio.srcObject || this.remoteAudio.srcObject !== stream) {
                        this.remoteAudio.srcObject = stream;
                    }

                    // Start remote audio level monitoring for speaker animation
                    this.startRemoteAudioLevelMonitoring(stream);

                    // Ensure audio element is ready
                    this.remoteAudio.volume = 1.0;
                    // Gate audio by call mode; mute if call not active
                    const shouldMuteForCall = !this.isCallAudioEnabled || !this.isSoundEnabled;
                    this.remoteAudio.muted = shouldMuteForCall;

                    // Try to play the audio
                    const playAudio = async () => {
                        if (!this.isCallAudioEnabled) {
                            // Do not play audio when not in call mode
                            this.remoteAudio.muted = true;
                            return;
                        }
                        try {
                            this.remoteAudio.muted = !this.isSoundEnabled; // Respect sound toggle state
                            this.remoteAudio.volume = 1.0;
                            const playPromise = this.remoteAudio.play();
                            if (playPromise !== undefined) {
                                await playPromise;
                            }
                        } catch (error) {
                            // If user interaction needed, set up click handler
                            if (error.name === 'NotAllowedError') {
                                const enableAudio = () => {
                                    if (this.remoteAudio) {
                                        this.remoteAudio.play().catch(() => { });
                                    }
                                    document.removeEventListener('click', enableAudio);
                                };
                                document.addEventListener('click', enableAudio, { once: true });
                            } else {
                                console.error('Audio playback error:', error);
                            }
                        }
                    };

                    playAudio();
                    setTimeout(playAudio, 500);
                    setTimeout(playAudio, 1000);
                }
            };

            // Microphone is requested lazily on user click (startRecording)

            // Set up data channel for text messages (OpenAI may create this, so we listen for it)
            this.pc.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.dataChannel.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        this.handleMessage(message);
                    } catch (error) {
                        console.error('Error parsing message:', error);
                    }
                };
                this.dataChannel.onopen = () => {
                    this.configureSession();
                    // Connection ready - hide loader and enable mic
                    if (typeof this.hideLoader === 'function') this.hideLoader();
                    if (typeof this.setMicButtonState === 'function') this.setMicButtonState('enabled');
                    // Safety net for guest users: onconnectionstatechange may fire before
                    // the handler is registered, so ensure connected state and timer start here too
                    if (!this.isConnected) {
                        this.isConnected = true;
                        this.updateStatus(true);
                        if (this.textInput) this.textInput.disabled = false;
                        if (this.sendTextButton) this.sendTextButton.disabled = false;
                    }
                    this.startSessionInactivityTimer();
                    // Send any message queued while connecting
                    this._sendPendingTextMessage();
                };
            };

            // Also create our own data channel as fallback
            this.dataChannel = this.pc.createDataChannel('oai-events');
            this.dataChannel.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error);
                }
            };

            this.dataChannel.onopen = () => {
                this.configureSession();
                // Connection ready - hide loader and enable mic
                if (typeof this.hideLoader === 'function') this.hideLoader();
                if (typeof this.setMicButtonState === 'function') this.setMicButtonState('enabled');
                // Safety net for guest users: ensure connected state and timer start here too
                if (!this.isConnected) {
                    this.isConnected = true;
                    this.updateStatus(true);
                    if (this.textInput) this.textInput.disabled = false;
                    if (this.sendTextButton) this.sendTextButton.disabled = false;
                }
                this.startSessionInactivityTimer();
                // Send any message queued while connecting
                this._sendPendingTextMessage();
            };

            // Create WebRTC offer
            const offer = await this.pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: false
            });
            await this.pc.setLocalDescription(offer);

            // GA API requires ICE gathering to complete before sending SDP,
            // otherwise user audio is never detected (speech_started won't fire).
            if (this.pc.iceGatheringState !== 'complete') {
                await new Promise((resolve) => {
                    const checkState = () => {
                        if (this.pc.iceGatheringState === 'complete') {
                            this.pc.removeEventListener('icegatheringstatechange', checkState);
                            resolve();
                        }
                    };
                    this.pc.addEventListener('icegatheringstatechange', checkState);
                    // Timeout fallback — don't hang forever
                    setTimeout(() => {
                        this.pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }, 5000);
                });
            }

            // Send SDP offer to OpenAI Realtime GA API via server-side proxy
            // Pass selected voice so the server includes it in the initial session config
            const response = await fetch(this.apiUrl('/api/proxy/realtime'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/sdp',
                    'X-Erica-Voice': this.selectedVoice || 'marin'
                },
                body: this.pc.localDescription.sdp
            });

            if (!response.ok) {
                let errorText = '';
                try {
                    errorText = await response.text();
                } catch (e) {
                    errorText = response.statusText;
                }

                console.error('API Error Response:', {
                    status: response.status,
                    statusText: response.statusText,
                    body: errorText
                });

                // Helpful error messages (server-held key)
                if (response.status === 401 || response.status === 403) {
                    throw new Error(
                        `Server proxy authorization failed (${response.status}). Check the server OpenAI key configuration and permissions.`
                    );
                }
                throw new Error(`API Error (${response.status}): ${errorText || response.statusText}`);
            }

            // Response should be SDP answer
            const answerSdp = await response.text();

            if (!response.ok) {
                throw new Error(`API Error (${response.status}): ${answerSdp || response.statusText}`);
            }

            // Set remote description from OpenAI's SDP answer
            await this.pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: answerSdp
            }));

            // Monitor connection state
            this.pc.onconnectionstatechange = () => {
                if (this.pc.connectionState === 'connected') {
                    this.isConnected = true;
                    this._openaiFailCount = 0; // Reset failure counter on successful connection
                    this.updateStatus(true);
                    if (this.callButton) this.callButton.disabled = false;
                    if (this.textInput) this.textInput.disabled = false;
                    if (this.sendTextButton) this.sendTextButton.disabled = false;
                    if (this.connectButton) this.connectButton.textContent = 'Connected';
                    // Voice controls are enabled - user can change voice when not recording
                    // Connection established - no message needed
                    this.startSessionInactivityTimer();

                } else if (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed') {
                    this.isConnected = false;

                    // Auto-reconnect silently instead of showing "Disconnected"
                    // Show "Connecting..." while we attempt to restore the session
                    if (!this.isConnecting && !this._autoReconnecting) {
                        this._autoReconnecting = true;
                        console.log('[Erica] WebRTC dropped — auto-reconnecting silently...');
                        if (window.uiLayout && typeof window.uiLayout.updateStatusDot === 'function') {
                            window.uiLayout.updateStatusDot(this, 'connecting');
                        }

                        // Small delay to let the connection fully close
                        setTimeout(() => {
                            this.connect({ skipOpeningLine: true })
                                .then(() => {
                                    console.log('[Erica] Auto-reconnect successful');
                                    this._autoReconnecting = false;
                                })
                                .catch(err => {
                                    console.warn('[Erica] Auto-reconnect failed:', err?.message || err);
                                    this._autoReconnecting = false;
                                    // Only now show disconnected if reconnect failed
                                    this.updateStatus(false);
                                    if (this.callButton) this.callButton.disabled = true;
                                    if (this.connectButton) {
                                        this.connectButton.disabled = false;
                                        this.connectButton.textContent = 'Reconnect';
                                    }
                                });
                        }, 1500);
                    }
                }
            };

            // Wait a bit for connection to establish
            await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
            console.error('Connection error:', error);

            // Track consecutive OpenAI connection failures
            // (not Wix 429s — those are handled separately with retries)
            this._openaiFailCount = (this._openaiFailCount || 0) + 1;
            console.warn(`[Erica] OpenAI connection failure #${this._openaiFailCount}`);
            if (this._openaiFailCount >= 3) {
                console.error('[Erica] 3 consecutive OpenAI failures — redirecting to maintenance page');
                // Preserve URL params so retry can restore the session
                const params = new URLSearchParams(window.location.search);
                const target = 'maintenance.html' + (params.toString() ? '?' + params.toString() : '');
                window.location.href = target;
                return;
            }

            throw error;
        }
    }

    cancelActiveResponses() {
        return new Promise((resolve) => {
            if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                console.log('[Erica] DataChannel not ready, skipping response cancellation');
                resolve();
                return;
            }

            // Cancel all pending responses
            if (this.pendingResponses.size > 0) {

                this.pendingResponses.forEach(responseId => {
                    this.sendMessage({
                        type: 'response.cancel',
                        response_id: responseId
                    });
                });

                // Clear the sets after canceling
                this.pendingResponses.clear();
                this.activeAudioResponses.clear();

                // Wait longer for cancellations and audio to stop
                setTimeout(() => {
                    console.log('[Erica] Canceled responses, waiting for audio to stop');
                    resolve();
                }, 800);
            } else {
                // Also try to cancel any response that might be active but not tracked
                // Clear input buffer to stop any ongoing processing
                this.sendMessage({
                    type: 'input_audio_buffer.clear'
                });

                // Clear active audio responses
                this.activeAudioResponses.clear();

                setTimeout(() => {
                    resolve();
                }, 500);
            }
        });
    }

    waitForAudioToFinish() {
        return new Promise((resolve) => {
            // Check if there's any active audio
            if (this.activeAudioResponses.size === 0) {
                // Also check if remoteAudio is playing
                if (this.remoteAudio && !this.remoteAudio.paused && this.remoteAudio.currentTime > 0 && !this.remoteAudio.ended) {
                    // Wait for audio to finish
                    const checkAudio = () => {
                        if (this.remoteAudio.paused || this.remoteAudio.ended || this.remoteAudio.currentTime === 0) {
                            console.log('[Erica] Audio finished playing');
                            resolve();
                        } else {
                            setTimeout(checkAudio, 100);
                        }
                    };
                    checkAudio();
                } else {
                    resolve();
                }
            } else {
                // Wait for all active audio responses to finish
                const maxWait = 5000; // Max 5 seconds
                const startTime = Date.now();
                const checkAudio = () => {
                    if (this.activeAudioResponses.size === 0 || (Date.now() - startTime) > maxWait) {
                        console.log('[Erica] Audio responses finished or timeout reached');
                        resolve();
                    } else {
                        setTimeout(checkAudio, 200);
                    }
                };
                checkAudio();
            }
        });
    }

    configureSession() {
        // Build instructions using SANDWICH approach:
        //   [1] Persona identity block (primacy — "who am I")
        //   [2] Global preamble from preparation API (rules, scope, resources)
        //   [3] Language detection
        //   [4] Persona reinforcement reminder (recency — last thing the model reads)
        //
        // This ensures persona-specific coaching style isn't drowned by the ~17k global preamble.

        const fallbackPreamble =
            'You are a helpful AI assistant. Respond naturally and conversationally. When users ask about current events, information, or need to search the web, use the search_web function to get up-to-date information.';

        const prepPreamble =
            typeof this.customInstructions === 'string' && this.customInstructions.trim().length > 0
                ? this.customInstructions.trim()
                : null;

        let globalBlock = prepPreamble || fallbackPreamble;
        if (prepPreamble) {
            console.log('[Erica] Using preparation preamble for session, length:', prepPreamble.length);
        } else {
            console.log('[Erica] Using fallback preamble for session (no preparation preamble available yet)');
        }

        // --- Fix 1: Voice-mode preamble override ---
        // The global preamble contains "Mode of Operation: Text Chat ... well-structured formatting,
        // including bold headings and clear indentation" which causes verbose bulleted responses
        // even in voice mode. Replace with voice-appropriate instructions.
        const isVoiceMode = this.isRecording || this.isCallAudioEnabled;
        if (isVoiceMode) {
            globalBlock = globalBlock.replace(
                /Mode of Operation: Text Chat[^\n]*(?:\n-[^\n]*formatting[^\n]*)?/i,
                'Mode of Operation: Voice Conversation\n' +
                '- You are in a live voice conversation. Respond naturally and conversationally.\n' +
                '- Do NOT use markdown, bullet points, numbered lists, bold text, or structured formatting.\n' +
                '- Keep responses concise (2-4 sentences). Ask follow-up questions rather than giving long advice.'
            );
        }

        // --- Fix 2: Sandwich — persona FIRST (primacy), then global, then persona reminder (recency) ---
        const persona = this.getEffectiveVoiceProfile() || this.currentVoiceProfile;
        let instructions = '';

        if (persona) {
            // [1] PERSONA IDENTITY BLOCK (primacy — sets "who I am" before anything else)
            const roleLabel = persona.label || persona.role || persona.companionId || persona.id || 'coach';
            let personaIntro = `You are ${persona.character}, a ${roleLabel} coach at Talent Transformation.`;
            if (persona.userFacingContext) {
                personaIntro += ` ${persona.userFacingContext}`;
            }

            instructions = personaIntro;
            instructions += this.buildVoiceStyleInstructions(persona);
            instructions += '\n\n--- GENERAL GUIDELINES ---\n\n';
        }

        // [2] GLOBAL PREAMBLE (rules, scope, resources — identical for all coaches)
        instructions += globalBlock;

        // [3] LANGUAGE DETECTION
        instructions += '\n\nAlways respond in the same language the user is currently using. ' +
            'Detect the language of the user\'s latest message and reply in that exact language. ' +
            'Do not default to English. Do not carry over the language from previous messages in the conversation history.';

        // --- Fix 3: Persona reinforcement at the END (recency effect) ---
        if (persona) {
            const style = persona.coachingStyle?.primaryObjective || persona.label || '';
            instructions += `\n\nCRITICAL COACHING STYLE REMINDER: You are ${persona.character}. ` +
                `Your coaching approach is "${style}". ` +
                `Your behavioral guardrails take PRIORITY over the general guidelines above. ` +
                `Stay in character at all times.`;
        }

        // OpenAI Realtime GA has a 16,384 token limit for instructions.
        // Rough estimate: 1 token ≈ 3.5 chars for English text with URLs.
        // If over limit: truncate instructions, send the overflow as a system message
        // so nothing is lost. Only affects users with large preparation data.
        const MAX_INSTRUCTION_CHARS = 50000; // ~14k tokens, safe margin under 16,384 token limit (same for mini and full)
        this._instructionOverflow = null; // Reset overflow from previous configureSession calls

        if (instructions.length > MAX_INSTRUCTION_CHARS) {
            console.warn(`[Erica] Instructions too long (${instructions.length} chars, ~${Math.round(instructions.length / 3.5)} tokens). Splitting.`);

            const separator = '--- GENERAL GUIDELINES ---';
            const sepIdx = instructions.indexOf(separator);
            if (sepIdx !== -1) {
                const personaBlock = instructions.substring(0, sepIdx + separator.length);
                const afterSep = instructions.substring(sepIdx + separator.length);

                const reinforceIdx = afterSep.lastIndexOf('CRITICAL COACHING STYLE REMINDER');
                const reinforceBlock = reinforceIdx !== -1 ? afterSep.substring(reinforceIdx - 2) : '';
                const globalBlock = reinforceIdx !== -1 ? afterSep.substring(0, reinforceIdx - 2) : afterSep;

                const maxGlobal = MAX_INSTRUCTION_CHARS - personaBlock.length - reinforceBlock.length - 100;
                if (globalBlock.length > maxGlobal) {
                    const trimmedGlobal = globalBlock.substring(0, maxGlobal);
                    const overflowContent = globalBlock.substring(maxGlobal);

                    instructions = personaBlock + trimmedGlobal + reinforceBlock;

                    // Store overflow to send as system message after session.update
                    this._instructionOverflow = overflowContent.trim();
                    console.log(`[Erica] Instructions split: ${instructions.length} chars in instructions, ${this._instructionOverflow.length} chars overflow → will send as system message`);
                }
            } else {
                // No separator — hard truncate, save overflow
                this._instructionOverflow = instructions.substring(MAX_INSTRUCTION_CHARS).trim();
                instructions = instructions.substring(0, MAX_INSTRUCTION_CHARS);
                console.warn('[Erica] Hard-split instructions (no separator found)');
            }
        }

        // Log final instructions length for debugging
        console.log('[Erica] Final instructions length:', instructions.length);
        // Explicit visibility so we can confirm what the model ACTUALLY sees at
        // the top of its context (primacy position). If activity is here, it's
        // as high-priority as we can get it. Also expose on window for the
        // in-page debug endpoint to grab.
        try {
            window.__ericaLastInstructions = instructions;
            console.log('[Erica] 📤 session.update instructions HEAD (first 1500 chars):\n' + instructions.slice(0, 1500));
            const activityIdx = instructions.indexOf('USER ACTIVITY TIMELINE');
            if (activityIdx >= 0) {
                console.log('[Erica] ✅ Activity block IS in instructions at offset', activityIdx, '/ length', instructions.length);
            } else {
                console.warn('[Erica] ❌ Activity block NOT present in instructions (either not fetched yet or was truncated)');
            }
        } catch (_) { /* non-fatal */ }

        // Configure the OpenAI Realtime GA session
        // GA uses nested audio.input / audio.output structure (not flat fields)
        const config = {
            type: 'session.update',
            session: {
                type: 'realtime',
                model: 'gpt-realtime',
                instructions: instructions,
                output_modalities: ['audio'],
                audio: {
                    input: {
                        transcription: {
                            model: 'whisper-1'
                        },
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.95,
                            prefix_padding_ms: 600,
                            silence_duration_ms: 2000
                        }
                    },
                    output: {
                        voice: this.selectedVoice
                    }
                },
                tools: [
                    {
                        type: 'function',
                        name: 'get_helpful_resources',
                        description: 'Retrieve helpful resources from the local site list. Optionally filter by query or type and limit the number of results.',
                        parameters: {
                            type: 'object',
                            properties: {
                                query: {
                                    type: 'string',
                                    description: 'Optional search query to match resource name or description'
                                },
                                type: {
                                    type: 'string',
                                    description: 'Optional resource type filter (e.g., Article, Video, Podcast)'
                                },
                                limit: {
                                    type: 'number',
                                    description: 'Optional max number of results to return'
                                }
                            },
                            required: []
                        }
                    },
                    {
                        type: 'function',
                        name: 'change_coach_name',
                        description: 'Change the coach\'s display name when the user requests it. Use this when the user asks to call you by a different name or nickname (e.g., "Can I call you Sarah?", "I\'d like to call you Alex").',
                        parameters: {
                            type: 'object',
                            properties: {
                                new_name: {
                                    type: 'string',
                                    description: 'The new name the user wants to call the coach'
                                }
                            },
                            required: ['new_name']
                        }
                    },
                    {
                        type: 'function',
                        name: 'play_wave_animation',
                        description: 'Play the coach\'s wave animation. Use this when saying goodbye, when the user asks you to wave, or in other friendly moments where waving is appropriate.',
                        parameters: {
                            type: 'object',
                            properties: {},
                            required: []
                        }
                    },
                    {
                        type: 'function',
                        name: 'refresh_context',
                        description: 'Refresh your knowledge about the user, including quiz results, reports, and preparation context. Use this when the user asks about their performance, results, or if you need to update your understanding of the user.',
                        parameters: {
                            type: 'object',
                            properties: {
                                category: {
                                    type: 'string',
                                    enum: ['general', 'quiz', 'report'],
                                    description: 'The specific area of information to refresh. Use "quiz" for assessment results, "report" for analysis documents, or "general" for overall context.'
                                }
                            },
                            required: ['category']
                        }
                    },
                    {
                        type: 'function',
                        name: 'search_knowledge',
                        description: 'Search the coaching knowledge base for relevant information to ground your response. Use this whenever the user asks about their assessments, personal results, coaching frameworks, past sessions, or wants specific insights tied to their data. Choose scope: "user_data" for anything about THIS user (their quiz results, reports, past sessions), "frameworks" for general coaching approaches, "all" when unsure.',
                        parameters: {
                            type: 'object',
                            properties: {
                                query: {
                                    type: 'string',
                                    description: 'A specific, self-contained natural-language question capturing what to search for. Include enough context so it is meaningful on its own.'
                                },
                                scope: {
                                    type: 'string',
                                    enum: ['user_data', 'frameworks', 'all'],
                                    description: 'user_data = this user\'s report/history. frameworks = general coaching frameworks. all = both (default).'
                                }
                            },
                            required: ['query']
                        }
                    },
                    {
                        type: 'function',
                        name: 'deep_think',
                        description: 'Delegate careful step-by-step reasoning to a dedicated reasoning model (o4-mini). Use this ONLY when the question genuinely needs it: complex ethical trade-offs, weighing multiple options against the user\'s values, tracing a chain of consequences, deciding between coaching approaches for a nuanced situation, or when the user explicitly asks you to think this through. Do NOT use for simple factual, empathic, or acknowledgment turns. Include any grounding chunks you already retrieved via search_knowledge in the context field so the reasoner has real material. The tool returns reasoning + a suggested answer; use them to shape your reply but do not read the reasoning aloud.',
                        parameters: {
                            type: 'object',
                            properties: {
                                query: {
                                    type: 'string',
                                    description: 'The user\'s question restated fully, with any relevant conversational context you have gathered.'
                                },
                                context: {
                                    type: 'string',
                                    description: 'Optional. Grounding material to inform reasoning (e.g. concatenated excerpts from a previous search_knowledge call, salient facts about the user).'
                                }
                            },
                            required: ['query']
                        }
                    }
                ],
                tool_choice: 'auto'
            }
        };

        // Cache last session config for iframe debug panel
        this.lastSessionConfig = {
            instructions,
            selectedVoice: this.selectedVoice,
            customInstructions: this.customInstructions,
            currentVoiceProfile: this.currentVoiceProfile,
            openingLinePrompt: this.openingLinePrompt,
            sessionConfig: config,
            iframeMessageLog: this.iframeMessageLog
        };

        // Tuning diagnostics: show what is being applied and whether it was sent successfully.
        if (this.tuningEnabled) {
            const eff = this.getEffectiveVoiceProfile() || this.currentVoiceProfile;
            console.log('[Erica][TUNE] configureSession() building session.update', {
                hasBehaviorOverrides: !!this.behaviorOverrides,
                hasPreparationOverrides: !!this.preparationOverrides,
                selectedVoice: this.selectedVoice,
                effectiveCompanionId: eff ? (eff.companionId || eff.id || null) : null,
                effectiveCharacter: eff ? eff.character : null,
                agentGuidanceLen: eff && typeof eff.agentGuidance === 'string' ? eff.agentGuidance.length : 0,
                guardrailsCount: eff && Array.isArray(eff.behavioralGuardrails) ? eff.behavioralGuardrails.length : 0,
                conversationStyleCount: eff && Array.isArray(eff.conversationStyle) ? eff.conversationStyle.length : 0,
                customInstructionsLen: this.customInstructions ? this.customInstructions.length : 0,
                openingLinePromptLen: this.openingLinePrompt ? this.openingLinePrompt.length : 0
            });
        }

        const sentOk = this.sendMessage(config);
        if (this.tuningEnabled) {
            console.log('[Erica][TUNE] session.update send result', {
                sentOk,
                hasDataChannel: !!this.dataChannel,
                readyState: this.dataChannel?.readyState
            });
        }
        this.lastSessionConfig.sentOk = sentOk;
        this.lastSessionConfig.sentAt = Date.now();

        // Send instruction overflow as system message BEFORE history
        // (only when instructions exceeded the token limit — see truncation above)
        if (this._instructionOverflow && sentOk) {
            this.sendMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'system',
                    content: [{ type: 'input_text', text: '[Additional context]\n' + this._instructionOverflow }]
                }
            });
            console.log('[Erica] Sent instruction overflow as system message:', this._instructionOverflow.length, 'chars');
            this._instructionOverflow = null;
        }

        // Send conversation history after session is configured
        if (this.conversationHistoryToSend) {
            // Wait a bit for session.update to be processed
            setTimeout(() => {
                this.sendHistoryToOpenAI(this.conversationHistoryToSend);
                this.conversationHistoryToSend = null; // Clear after sending
            }, 500);
        }

        // Note: opening line is triggered explicitly after connect/reconnect.
    }

    /**
     * Send any queued text messages that were typed before the connection was ready.
     */
    _sendPendingTextMessage() {
        if (!this._pendingTextMessages || !this._pendingTextMessages.length || !this.isConnected) return;
        const messages = this._pendingTextMessages.splice(0);
        console.log('[Erica] Sending', messages.length, 'queued message(s)');
        // Send each with a small stagger so they arrive in order
        messages.forEach((text, i) => {
            setTimeout(() => {
                this.sendTextMessage(text);
            }, 500 + (i * 300));
        });
    }

    sendMessage(message) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            const messageStr = JSON.stringify(message);
            if (message.type === 'session.update') {
                // console.log('[Erica] Sending session.update via dataChannel, voice:', message.session?.voice);
            }
            this.dataChannel.send(messageStr);
            return true;
        } else {
            console.warn('[Erica] Cannot send message - dataChannel not ready:', {
                hasDataChannel: !!this.dataChannel,
                readyState: this.dataChannel?.readyState
            });
            return false;
        }
    }

    sendOpeningLinePrompt() {
        // Send the opening line prompt as a user instruction so the model responds with the greeting
        if (this.openingLineSent) return;
        if (!this.openingLinePrompt) return;
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            // Try again shortly
            console.log('[Erica] Opening line prompt: dataChannel not ready, retrying...');
            setTimeout(() => this.sendOpeningLinePrompt(), 300);
            return;
        }
        // If there are already messages (e.g., restored history), do not send the opening line.
        if (this.messages && this.messages.length > 0) {
            return;
        }
        console.log('[Erica] Sending opening line prompt as user message:', this.openingLinePrompt);
        this.sendMessage({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: this.openingLinePrompt
                    }
                ]
            }
        });

        // Trigger the model to respond (Realtime requires an explicit response.create after adding a user message).
        setTimeout(() => {
            this.sendMessage({ type: 'response.create' });
        }, 100);

        this.openingLineSent = true;

        // Automatically wave on first greeting for friendly interaction
        setTimeout(() => {
            if (typeof this.playWaveAnimation === 'function') {
                this.playWaveAnimation();
                console.log('[Erica] 👋 Automatic wave triggered on opening line');
            }
        }, 1500); // Wait 1.5s for video to load and greeting to start
    }

    async executeFunction(functionName, functionArgs, callId, responseId) {
        // Dedup: the same function call arrives from BOTH `response.output_item.added`
        // (streaming) and `response.done` (final). Without this guard we run the tool
        // twice, send two `function_call_output` items, and fire two `response.create`
        // — the second of which hits "Conversation already has an active response".
        if (!this._executedCallIds) this._executedCallIds = new Set();
        if (callId && this._executedCallIds.has(callId)) {
            console.log('[Erica] 🔁 Skipping duplicate function call (already executed):', functionName, callId);
            return;
        }
        if (callId) this._executedCallIds.add(callId);

        try {
            console.log('[Erica] 🔍 Function call received:', functionName, functionArgs);
            let result = null;
            const safeArgs = functionArgs && typeof functionArgs === 'object' ? functionArgs : {};

            if (functionName === 'search_web') {
                const query = safeArgs.query || '';

                if (!query) {
                    console.warn('[Erica] ⚠️ Search called but no query provided');
                    result = JSON.stringify({ error: 'Search query is required' });
                } else {
                    console.log('[Erica] 🔍 Web search requested for:', query);

                    // Call secure server-side proxy (API key never exposed to client)
                    try {
                        console.log('[Erica] 🔍 Making secure server-side search request...');

                        const searchUrl = this.apiUrl('/api/search');
                        console.log('[Erica] 🔍 Sending POST request to:', searchUrl, 'with query:', query);
                        const searchResponse = await fetch(searchUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                query: query
                            })
                        });

                        if (!searchResponse.ok) {
                            const errorText = await searchResponse.text();
                            console.error('[Erica] ❌ Search API error:', {
                                status: searchResponse.status,
                                statusText: searchResponse.statusText,
                                error: errorText.substring(0, 500)
                            });
                            throw new Error(`Search API error: ${searchResponse.status} - ${errorText.substring(0, 200)}`);
                        }

                        const searchData = await searchResponse.json();
                        console.log('[Erica] ✅ Search response received');

                        // Extract the answer from the response
                        if (searchData.answer) {
                            result = searchData.answer;
                            console.log('[Erica] ✅ Search completed, answer length:', result.length);
                        } else {
                            console.warn('[Erica] ⚠️ No answer in search response');
                            result = `A web search was performed for "${query}" but no results were returned.`;
                        }

                    } catch (error) {
                        console.error('[Erica] ❌ Error performing web search:', error);
                        throw new Error(`Web search failed: ${error.message}`);
                    }
                }
            } else if (functionName === 'get_helpful_resources') {
                const query = typeof safeArgs.query === 'string' ? safeArgs.query : '';
                const type = typeof safeArgs.type === 'string' ? safeArgs.type : '';
                const limit = Number.isFinite(safeArgs.limit) ? safeArgs.limit : undefined;

                try {
                    const resourcesUrl = this.apiUrl('/api/helpful-resources');
                    const resourcesResponse = await fetch(resourcesUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            query,
                            type,
                            limit
                        })
                    });

                    if (!resourcesResponse.ok) {
                        const errorText = await resourcesResponse.text();
                        console.error('[Erica] ❌ Helpful resources API error:', {
                            status: resourcesResponse.status,
                            statusText: resourcesResponse.statusText,
                            error: errorText.substring(0, 500)
                        });
                        throw new Error(`Helpful resources API error: ${resourcesResponse.status} - ${errorText.substring(0, 200)}`);
                    }

                    const resourcesData = await resourcesResponse.json();
                    const items = Array.isArray(resourcesData?.items) ? resourcesData.items : [];
                    const itemPreview = items.slice(0, 3).map((item) => ({
                        name: item?.Name || item?.name || null,
                        type: item?.type || null,
                        link: item?.link || null
                    }));

                    console.log('[Erica] ✅ Helpful resources response received:', {
                        total: resourcesData?.total,
                        filtered: resourcesData?.filtered,
                        returned: items.length,
                        preview: itemPreview
                    });

                    if (items.length === 0) {
                        result = JSON.stringify({
                            error: 'No helpful resources matched the query.',
                            query,
                            type,
                            total: resourcesData?.total ?? 0
                        });
                    } else {
                        result = JSON.stringify(resourcesData);
                    }
                } catch (error) {
                    console.error('[Erica] ❌ Error fetching helpful resources:', error);
                    throw new Error(`Helpful resources fetch failed: ${error.message}`);
                }
            } else if (functionName === 'change_coach_name') {
                const newName = typeof safeArgs.new_name === 'string' ? safeArgs.new_name.trim() : '';

                if (!newName) {
                    console.warn('[Erica] ⚠️ change_coach_name called but no name provided');
                    result = JSON.stringify({ error: 'New name is required' });
                } else {
                    console.log('[Erica] 🏷️ Coach name change requested:', newName);

                    try {
                        // Call existing method to update coach name
                        this.setCoachDisplayName(newName);
                        result = JSON.stringify({
                            success: true,
                            message: `Coach name changed to ${newName}`
                        });
                        console.log('[Erica] ✅ Coach name changed successfully to:', newName);
                    } catch (error) {
                        console.error('[Erica] ❌ Error changing coach name:', error);
                        result = JSON.stringify({
                            error: `Failed to change coach name: ${error.message}`
                        });
                    }
                }
            } else if (functionName === 'play_wave_animation') {
                console.log('[Erica] 👋 Wave animation requested');

                try {
                    // Trigger wave animation in call mode panel
                    if (typeof this.playWaveAnimation === 'function') {
                        this.playWaveAnimation();
                        result = JSON.stringify({
                            success: true,
                            message: 'Wave animation played'
                        });
                        console.log('[Erica] ✅ Wave animation triggered successfully');
                    } else {
                        console.warn('[Erica] ⚠️ playWaveAnimation method not available');
                        result = JSON.stringify({
                            success: false,
                            message: 'Wave animation not available'
                        });
                    }
                } catch (error) {
                    console.error('[Erica] ❌ Error playing wave animation:', error);
                    result = JSON.stringify({
                        error: `Failed to play wave animation: ${error.message}`
                    });
                }
            } else if (functionName === 'refresh_context') {
                const category = safeArgs.category || 'general';
                console.log(`[Erica] 🔄 Refresh context requested. Category: ${category}`);

                try {
                    if (window.uiLayout && typeof window.uiLayout.setWaitingState === 'function') {
                        window.uiLayout.setWaitingState(this, true);
                    }

                    const userId = this.getUserIdFromURL();
                    const email = this.getEmailFromURL();
                    const prepIdentifier = userId || email || null;

                    const reportCache = await this.requestReportContextFromParent({ force: true });

                    // Force fetch new data (bypass cache)
                    const newData = await this.fetchEricaPreparation(prepIdentifier, { force: true });

                    // Update session with new instructions (background persistence)
                    this.configureSession();

                    // Prepare return value (System Message content)
                    let output = "Context refreshed.";

                    if (typeof newData === 'string') {
                        output = newData;
                    } else if (newData && typeof newData === 'object') {
                        if (category === 'quiz') {
                            // Filter for quiz/assessment related keys
                            const quizKeys = Object.keys(newData).filter(k =>
                                k.toLowerCase().includes('quiz') || k.toLowerCase().includes('assessment') || k.toLowerCase().includes('score')
                            );
                            if (quizKeys.length > 0) {
                                const subsets = {};
                                quizKeys.forEach(k => subsets[k] = newData[k]);
                                output = JSON.stringify(subsets);
                            } else {
                                // If no specific quiz keys, return full data or a relevant instruction field
                                output = newData.ericaPreparation || JSON.stringify(newData);
                            }
                        } else if (category === 'report') {
                            // Filter for report related keys
                            const reportKeys = Object.keys(newData).filter(k =>
                                k.toLowerCase().includes('report') || k.toLowerCase().includes('analysis')
                            );
                            if (reportKeys.length > 0) {
                                const subsets = {};
                                reportKeys.forEach(k => subsets[k] = newData[k]);
                                output = JSON.stringify(subsets);
                            } else {
                                output = newData.ericaPreparation || JSON.stringify(newData);
                            }
                        } else {
                            // General: prefer the main instruction text if available to save tokens, else dump JSON
                            output = newData.ericaPreparation || newData.message || JSON.stringify(newData);
                        }
                    } else {
                        output = "Context refreshed. No new data found.";
                    }

                    if (reportCache && reportCache.text) {
                        const reportText = String(reportCache.text || '');
                        const reportHeader = `\n\nReport Context (host page):\n`;
                        output = `${output}${reportHeader}${reportText}`;
                    }

                    // Safety truncation
                    if (output.length > 8000) {
                        output = output.substring(0, 8000) + "... (truncated)";
                    }

                    result = output;
                    console.log('[Erica] ✅ Context refreshed. Returning data length:', result.length);

                } catch (error) {
                    console.error('[Erica] ❌ refresh_context failed:', error);
                    result = JSON.stringify({ error: `Failed to refresh context: ${error.message}` });
                } finally {
                    if (window.uiLayout && typeof window.uiLayout.setWaitingState === 'function') {
                        window.uiLayout.setWaitingState(this, false);
                    }
                }
            } else if (functionName === 'search_knowledge') {
                // AI-Coach-v3 grounding tool. Calls /api/knowledge-search which
                // runs file_search over the frameworks-shared store and (when
                // scope includes user_data) the caller's user-<id> store.
                const query = typeof safeArgs.query === 'string' ? safeArgs.query.trim() : '';
                const scope = ['user_data', 'frameworks', 'all'].includes(safeArgs.scope) ? safeArgs.scope : 'all';
                const userId = this.getUserIdFromURL();

                // Show the typing indicator + disable mic while retrieval runs (~2-5s).
                // Without this, the user sees a silent pause between filler and answer,
                // which reads as "stuck". Reuses the same setWaitingState pattern that
                // refresh_context already uses.
                if (window.uiLayout && typeof window.uiLayout.setWaitingState === 'function') {
                    window.uiLayout.setWaitingState(this, true);
                }

                if (!query) {
                    result = JSON.stringify({ error: 'Empty query' });
                } else {
                    // Include objectId for guest users so search_knowledge can find the
                    // guest vector store (keyed as "guest-<objectId>" server-side).
                    const objectId = (typeof window !== 'undefined' && window.__ttCleverTapId) ? String(window.__ttCleverTapId) : null;
                    console.log('[Erica] 🔎 search_knowledge:', { scope, hasUserId: !!userId, hasObjectId: !!objectId, queryPreview: query.slice(0, 120) });
                    try {
                        const searchUrl = this.apiUrl('/api/knowledge-search');
                        const kresp = await fetch(searchUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ query, scope, userId, objectId })
                        });

                        if (!kresp.ok) {
                            const errText = await kresp.text();
                            console.error('[Erica] ❌ knowledge-search HTTP error:', kresp.status, errText.slice(0, 400));
                            result = JSON.stringify({ error: `search_knowledge failed: ${kresp.status}` });
                        } else {
                            const kdata = await kresp.json();
                            const chunks = (kdata.chunks || []).map((c) => ({
                                source: c.filename,
                                score: c.score,
                                excerpt: c.text
                            }));

                            // Return raw chunks only — no pre-synthesized answer.
                            // Earlier iteration returned the synthesised answer field too,
                            // which the Realtime model tended to echo verbatim. When that
                            // synthesis was hedgy ("I couldn't find...") the whole
                            // grounding pipeline looked broken even when chunks were
                            // clearly retrieved. Forcing the Realtime model to compose
                            // from raw chunks keeps the coaching voice consistent and
                            // eliminates the "hedgy echo" failure mode.
                            const instructionForModel = chunks.length > 0
                                ? 'Use the excerpts below to answer the user. Weave the content into your coaching voice — do not read them verbatim, do not name the search tool. If the excerpts contradict, prefer the one with the higher score. Do NOT tell the user you could not find information: the excerpts below ARE what you found.'
                                : 'No matching content was found in the knowledge base for this query. Acknowledge briefly and either broaden the search with a different query in the same scope, try the other scope, or ask the user for a clarifying detail.';

                            result = JSON.stringify({
                                instruction: instructionForModel,
                                chunks: chunks,
                                storesQueried: (kdata.vectorStoreIds || []).length,
                                scopeApplied: scope,
                                chunkCount: chunks.length
                            });
                            console.log('[Erica] ✅ search_knowledge chunks:', chunks.length);
                        }
                    } catch (error) {
                        console.error('[Erica] ❌ search_knowledge failed:', error);
                        result = JSON.stringify({ error: `search_knowledge exception: ${error.message}` });
                    }
                }

                // Always hide the typing indicator + re-enable mic when the tool call
                // resolves (success or failure). If we skipped early due to empty query,
                // still clear the state.
                if (window.uiLayout && typeof window.uiLayout.setWaitingState === 'function') {
                    window.uiLayout.setWaitingState(this, false);
                }
            } else if (functionName === 'deep_think') {
                // AI-Coach-v3 reasoning layer. Delegates to o4-mini via
                // /api/deep-think for step-by-step reasoning; returns
                // { reasoning, answer, model } which the Realtime model uses
                // to compose (but does not read verbatim) its response.
                const query = typeof safeArgs.query === 'string' ? safeArgs.query.trim() : '';
                const context = typeof safeArgs.context === 'string' ? safeArgs.context : '';

                // Show typing indicator while o4-mini reasons (often 3-8s — heavier
                // than search_knowledge because it's a full reasoning call).
                if (window.uiLayout && typeof window.uiLayout.setWaitingState === 'function') {
                    window.uiLayout.setWaitingState(this, true);
                }

                if (!query) {
                    result = JSON.stringify({ error: 'Empty query' });
                } else {
                    console.log('[Erica] 🧠 deep_think:', {
                        queryPreview: query.slice(0, 120),
                        contextChars: context.length
                    });
                    try {
                        const dtUrl = this.apiUrl('/api/deep-think');
                        const dtResp = await fetch(dtUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ query, context })
                        });

                        if (!dtResp.ok) {
                            const errText = await dtResp.text();
                            console.error('[Erica] ❌ deep-think HTTP error:', dtResp.status, errText.slice(0, 400));
                            result = JSON.stringify({ error: `deep_think failed: ${dtResp.status}` });
                        } else {
                            const dtData = await dtResp.json();
                            console.log('[Erica] ✅ deep_think returned:', {
                                model: dtData.model,
                                reasoningChars: (dtData.reasoning || '').length,
                                answerChars: (dtData.answer || '').length
                            });
                            result = JSON.stringify({
                                instruction: 'Use the reasoning and answer below to compose your reply. Do NOT read the reasoning aloud — it is internal deliberation. Deliver the answer in your own coaching voice.',
                                reasoning: dtData.reasoning || null,
                                suggestedAnswer: dtData.answer || null,
                                modelUsed: dtData.model || null
                            });
                        }
                    } catch (error) {
                        console.error('[Erica] ❌ deep_think failed:', error);
                        result = JSON.stringify({ error: `deep_think exception: ${error.message}` });
                    }
                }

                // Hide the typing indicator regardless of outcome.
                if (window.uiLayout && typeof window.uiLayout.setWaitingState === 'function') {
                    window.uiLayout.setWaitingState(this, false);
                }
            } else {
                console.warn('[Erica] ⚠️ Unknown function:', functionName);
                result = JSON.stringify({ error: `Unknown function: ${functionName}` });
            }

            // Send the function result back to the model as a conversation item
            console.log('[Erica] 📦 Function output payload:', {
                functionName,
                outputLength: typeof result === 'string' ? result.length : null,
                outputPreview: typeof result === 'string' ? result.substring(0, 300) : result
            });
            this.sendMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: callId,
                    output: result
                }
            });

            // Create a new response so the model can continue with the function result
            // Wait a bit to ensure the function output is processed
            setTimeout(() => {
                if (this.isConnected) {
                    this.sendMessage({
                        type: 'response.create'
                    });
                }
            }, 200);

        } catch (error) {
            console.error('[Erica] Function execution error:', error);

            // Send error back to the model
            const errorOutput = JSON.stringify({ error: error.message || 'Function execution failed' });

            this.sendMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: callId,
                    output: errorOutput
                }
            });
        }
    }

    handleMessage(message) {
        switch (message.type) {
            case 'input_audio_buffer.speech_started':
                // Capture the timestamp when user STARTS speaking
                // This is the correct moment to timestamp the message, not when transcript arrives
                this.userSpeechStartTime = Date.now();
                console.log('[Erica] Speech started, captured timestamp:', this.userSpeechStartTime);

                // PAUSE inactivity timer while user is speaking
                console.log('[Erica Inactivity] User speaking - PAUSING timer');
                this.clearVoiceInactivityTimer();
                break;

            case 'input_audio_buffer.committed':
            case 'input_audio_buffer.speech_stopped':
                // User finished speaking - loader removed as per request
                // Mic button logic removed: Keep mic enabled to allow barge-in/continued speech
                // if (typeof this.setMicButtonState === 'function') this.setMicButtonState('disabled');

                // RESUME inactivity timer (will count down 30s from now)
                console.log('[Erica Inactivity] User stopped speaking - RESUMING timer');
                this.startVoiceInactivityTimer();
                break;

            case 'conversation.item.created':
                // User message created (text or audio) - loader removed as per request
                if (message.item && message.item.role === 'user') {
                    // Mic button logic removed: Keep mic enabled
                    // if (typeof this.setMicButtonState === 'function') this.setMicButtonState('disabled');
                }

                // Track item ID for transcripts
                // Track item ID for transcripts
                if (message.item && message.item.id) {
                    if (message.item.role === 'user') {
                        this.currentUserItemId = message.item.id;

                        // Set timestamp immediately upon creation
                        // Use captured speech start time if available
                        let userTimestamp = this.userSpeechStartTime || Date.now();

                        if (this.botStartTimestamp) {
                            userTimestamp = Math.min(userTimestamp, this.botStartTimestamp - 100);
                        }
                        this.inputStartTimestamp = userTimestamp;

                        // Create emptiness indicator or placeholder if needed
                        // But rely on updateUserMessage to actually show it
                    }
                }
                break;

            case 'conversation.item.input_audio_transcription.delta':
                // Ungate audio when user speaks (start of new interaction)
                if (this.audioOutputGate) {
                    // console.log('[Erica Gate] UNGATE: User Speech Detected (input_audio_transcription.delta)');
                    this.audioOutputGate = false;
                    this.setCallAudioEnabled(true);
                }

                // Handle partial transcript updates in real-time
                /* console.log('[Erica] Received input_audio_transcription.delta:', {
                    hasDelta: !!message.delta,
                    deltaLength: message.delta ? message.delta.length : 0,
                    deltaPreview: message.delta ? message.delta.substring(0, 50) : 'none',
                    hasItemId: !!message.item_id,
                    itemId: message.item_id,
                    currentItemId: this.currentUserItemId
                }); */

                if (message.delta && message.item_id) {
                    // Check if this is a new message (different item_id or no current message)
                    // OR if we somehow missed setting the timestamp (fallback)
                    if (!this.currentUserItemId || message.item_id !== this.currentUserItemId || !this.inputStartTimestamp) {
                        // console.log('[Erica] New user message started, item_id:', message.item_id);
                        // New message - reset tracking and set start timestamp
                        this.currentUserMessageElement = null;
                        this.currentUserTranscript = this.currentUserItemId === message.item_id ? this.currentUserTranscript : '';
                        this.currentUserItemId = message.item_id;

                        // Set timestamp when message starts
                        // Use the timestamp captured when speech started (not when transcript arrives)
                        let userTimestamp = this.userSpeechStartTime || Date.now();

                        if (this.botStartTimestamp) {
                            // Bot already started responding - user message should come before
                            userTimestamp = Math.min(userTimestamp, this.botStartTimestamp - 100);
                        }
                        this.inputStartTimestamp = userTimestamp;
                    }
                    this.currentUserTranscript += message.delta;
                    // Use the start timestamp we set when this message began
                    this.updateUserMessage(message.item_id, this.currentUserTranscript, false, this.inputStartTimestamp);
                } else {
                    console.warn('[Erica] input_audio_transcription.delta missing delta or item_id:', {
                        hasDelta: !!message.delta,
                        hasItemId: !!message.item_id
                    });
                }
                break;

            case 'conversation.item.input_audio_transcription.completed':
                /* console.log('[Erica] Received input_audio_transcription.completed:', {
                    hasItem: !!message.item,
                    hasTranscript: !!message.item?.transcript,
                    transcriptLength: message.item?.transcript ? message.item.transcript.length : 0,
                    transcriptPreview: message.item?.transcript ? message.item.transcript.substring(0, 50) : 'none',
                    itemId: message.item_id,
                    currentItemId: this.currentUserItemId
                }); */

                // Use provided transcript if available; otherwise fall back to accumulated delta text.
                // OpenAI sends top-level `transcript` field (not nested under `item`), but we also
                // check `message.item?.transcript` as a fallback for any API variations.
                const finalTranscript = message.transcript || message.item?.transcript || this.currentUserTranscript || '';

                if (finalTranscript && finalTranscript.length > 0) {
                    // If we don't have a message element yet, create one and set timestamp
                    if (!this.currentUserMessageElement) {
                        this.currentUserItemId = message.item_id || null;

                        // Set timestamp if not already set
                        if (!this.inputStartTimestamp) {
                            let userTimestamp = this.userSpeechStartTime || Date.now();

                            if (this.botStartTimestamp) {
                                // Bot already started responding - user message should come before
                                userTimestamp = Math.min(userTimestamp, this.botStartTimestamp - 100);
                            }
                            this.inputStartTimestamp = userTimestamp;
                        }
                    }
                    // Update the final transcript using the start timestamp
                    const ts = this.inputStartTimestamp || Date.now();
                    const finalId = message.item_id || `user-${Date.now()}`;
                    // console.log('[Erica] Finalizing user message, id:', finalId, 'transcript length:', finalTranscript.length);
                    this.updateUserMessage(finalId, finalTranscript, true, ts);

                    // Reset for next message
                    this.currentUserMessageElement = null;
                    this.currentUserTranscript = '';
                    this.currentUserItemId = null;
                    this.inputStartTimestamp = null;
                    this.userSpeechStartTime = null; // Clear the captured speech start time
                } else {
                    console.warn('[Erica] input_audio_transcription.completed missing transcript:', {
                        hasItem: !!message.item,
                        hasTranscript: !!message.item?.transcript,
                        hasTopLevelTranscript: !!message.transcript
                    });
                }
                break;

            case 'conversation.item.output_audio_transcription.delta':
                // Bot started speaking/typing - hide loader
                if (typeof this.hideLoader === 'function') this.hideLoader();
                if (typeof this.setMicButtonState === 'function') this.setMicButtonState('enabled');
                // Suppress preview one-shot transcripts from chat/history
                if (this._oneShot && this._oneShot.suppressFromUI) break;
                // Process bot responses even when mic is off (text input with audio reply)
                // Process bot responses - they should appear after user messages
                if (message.delta && message.item_id) {
                    // Check if this is a new message (different item_id or no current message)
                    if (!this.currentBotItemId || message.item_id !== this.currentBotItemId) {
                        // New message - reset tracking
                        this.currentBotMessageElement = null;
                        this.currentBotTranscript = '';
                        this.currentBotItemId = message.item_id;

                        // Set bot timestamp if not already set, ensuring it's after user messages
                        if (!this.botStartTimestamp) {
                            let botTimestamp = Date.now();

                            // Check if user is currently speaking (use earliest known user timestamp)
                            // userSpeechStartTime is set when speech starts (before transcript arrives)
                            // inputStartTimestamp is set when transcript delta arrives
                            const userStartTime = this.userSpeechStartTime || this.inputStartTimestamp;

                            if (userStartTime && this.currentUserItemId) {
                                // User message is in progress - bot must come after it
                                botTimestamp = Math.max(botTimestamp, userStartTime + 100);
                            } else if (userStartTime) {
                                // User spoke but no item_id yet - still ensure bot comes after
                                botTimestamp = Math.max(botTimestamp, userStartTime + 100);
                            } else {
                                // Check for the most recent user message in the array
                                const userMessages = this.messages.filter(m => m.role === 'user');
                                if (userMessages.length > 0) {
                                    const lastUserMessage = userMessages.sort((a, b) => b.timestamp - a.timestamp)[0];
                                    botTimestamp = Math.max(botTimestamp, lastUserMessage.timestamp + 100);
                                }
                            }
                            this.botStartTimestamp = botTimestamp;
                            console.log('[Erica] Bot timestamp set:', botTimestamp, 'userSpeechStartTime:', this.userSpeechStartTime, 'inputStartTimestamp:', this.inputStartTimestamp);
                        }
                    }
                    this.currentBotTranscript += message.delta;
                    this.updateBotMessage(message.item_id, this.currentBotTranscript, false, this.botStartTimestamp);
                }
                break;

            case 'conversation.item.output_audio_transcription.completed':
                if (this._oneShot && this._oneShot.suppressFromUI) break;
                // Process bot responses even when mic is off (text input with audio reply)
                if (message.item?.transcript) {
                    // If we don't have a message element yet, create one
                    if (!this.currentBotMessageElement) {
                        this.currentBotItemId = message.item_id || null;
                    }
                    const ts = this.botStartTimestamp || Date.now();
                    // Update the final transcript
                    this.updateBotMessage(message.item_id || `bot-${Date.now()}`, message.item.transcript, true, ts);
                    // Reset for next message
                    this.currentBotMessageElement = null;
                    this.currentBotTranscript = '';
                    this.currentBotItemId = null;
                    this.botStartTimestamp = null;
                }
                break;

            case 'response.output_audio_transcript.delta':
            case 'response.audio_transcript.delta': // beta compat
                // Bot started speaking/typing - hide loader
                if (typeof this.hideLoader === 'function') this.hideLoader();
                if (typeof this.setMicButtonState === 'function') this.setMicButtonState('enabled');
                {
                    const rid = message.response?.id || null;
                    if (rid && this._suppressedResponseIds.has(rid)) break;
                    if (this._oneShot && this._oneShot.suppressFromUI) break;
                }
                // Process bot response transcripts even when mic is off (text input with audio reply)
                // Process response transcripts
                if (message.delta) {
                    // Ensure we have a bot item id from the response
                    if (!this.currentBotItemId && message.response && message.response.id) {
                        this.currentBotItemId = message.response.id;
                    }
                    // Initialize transcript if needed
                    if (!this.currentBotTranscript) {
                        this.currentBotTranscript = '';
                    }
                    // If we still don't have an ID, try to use response ID or create a temporary one
                    if (!this.currentBotItemId) {
                        if (message.response && message.response.id) {
                            this.currentBotItemId = message.response.id;
                        } else {
                            // Create a temporary ID for this response
                            this.currentBotItemId = `bot-temp-${Date.now()}`;
                        }
                    }

                    // Set bot timestamp if not already set, ensuring it's after user messages
                    if (!this.botStartTimestamp) {
                        let botTimestamp = Date.now();

                        // Check if user is currently speaking (use earliest known user timestamp)
                        const userStartTime = this.userSpeechStartTime || this.inputStartTimestamp;

                        if (userStartTime && this.currentUserItemId) {
                            botTimestamp = Math.max(botTimestamp, userStartTime + 100);
                        } else if (userStartTime) {
                            botTimestamp = Math.max(botTimestamp, userStartTime + 100);
                        } else {
                            const userMessages = this.messages.filter(m => m.role === 'user');
                            if (userMessages.length > 0) {
                                const lastUserMessage = userMessages.sort((a, b) => b.timestamp - a.timestamp)[0];
                                botTimestamp = Math.max(botTimestamp, lastUserMessage.timestamp + 100);
                            }
                        }
                        this.botStartTimestamp = botTimestamp;
                    }

                    this.currentBotTranscript += message.delta;
                    this.updateBotMessage(this.currentBotItemId, this.currentBotTranscript, false, this.botStartTimestamp);
                }
                break;

            case 'response.output_audio_transcript.done':
            case 'response.audio_transcript.done': // beta compat
                {
                    const rid = message.response?.id || null;
                    if (rid && this._suppressedResponseIds.has(rid)) break;
                    if (this._oneShot && this._oneShot.suppressFromUI) break;
                }
                // Remove from active audio responses (audio transcript is done)
                if (message.response && message.response.id) {
                    this.activeAudioResponses.delete(message.response.id);
                }

                // Process bot response transcripts even when mic is off (text input with audio reply)
                if (message.transcript) {
                    // Ensure we have a bot item id
                    if (!this.currentBotItemId) {
                        if (message.response && message.response.id) {
                            this.currentBotItemId = message.response.id;
                        } else {
                            // Create a temporary ID if we don't have one
                            this.currentBotItemId = `bot-temp-${Date.now()}`;
                        }
                    }
                    const ts = this.botStartTimestamp || Date.now();
                    // Update the final transcript (use provided transcript or accumulated one)
                    const finalText = message.transcript || this.currentBotTranscript || '';
                    if (finalText) {
                        this.updateBotMessage(this.currentBotItemId, finalText, true, ts);
                    }
                    // Reset for next message
                    this.currentBotMessageElement = null;
                    this.currentBotTranscript = '';
                    this.currentBotItemId = null;
                    this.botStartTimestamp = null;
                }
                break;

            case 'response.created':
                // Ungate audio when bot starts a NEW response
                if (this.audioOutputGate) {
                    // Only ungate if we haven't reached the limit and call mode is active
                    if (this.checkVoiceLimit()) {
                        if (this.isRecording) {
                            // console.log('[Erica Gate] UNGATE: New Bot Response Created (response.created)');
                            this.audioOutputGate = false;
                            this.setCallAudioEnabled(true);
                        } else {
                            // Stay gated when not in call mode (prevents opening line audio in chat)
                            this.setCallAudioEnabled(false);
                        }
                    } else {
                        console.log('[Erica] Keeping audio gated/muted because voice limit is reached.');
                    }
                }

                // Track active response id globally (Realtime only allows one active response at a time)
                if (message.response?.id) {
                    this._activeResponseId = message.response.id;
                }
                if (this._oneShot && this._oneShot.active && !this._oneShot.responseId && message.response?.id) {
                    this._oneShot.responseId = message.response.id;
                    if (this._oneShot.suppressFromUI) {
                        this._suppressedResponseIds.add(message.response.id);
                    }
                    try {
                        if (this._oneShot._resolveStarted && !this._oneShot._startedResolved) {
                            this._oneShot._startedResolved = true;
                            this._oneShot._resolveStarted(true);
                        }
                    } catch (_) { }
                    if (this._oneShot.suppressFromUI) {
                        // Keep chat state clean for preview
                        break;
                    }
                }
                // Track this response ID - always track it, not just when recording
                // This ensures text messages also get their responses processed
                if (message.response && message.response.id) {
                    // Mark this response as valid (created while recording OR from text input)
                    this.pendingResponses.add(message.response.id);

                    // Only track as audio if we're actually recording
                    if (this.isRecording) {
                        this.activeAudioResponses.add(message.response.id); // Track as having potential audio
                    }

                    // Track bot message id and start time for this response
                    this.currentBotItemId = message.response.id;

                    // Ensure bot timestamp is AFTER the user message it's responding to
                    let botTimestamp = Date.now();

                    // Check if user is currently speaking (use earliest known user timestamp)
                    const userStartTime = this.userSpeechStartTime || this.inputStartTimestamp;

                    if (userStartTime && this.currentUserItemId) {
                        botTimestamp = Math.max(botTimestamp, userStartTime + 100);
                    } else if (userStartTime) {
                        botTimestamp = Math.max(botTimestamp, userStartTime + 100);
                    } else {
                        const userMessages = this.messages.filter(m => m.role === 'user');
                        if (userMessages.length > 0) {
                            const lastUserMessage = userMessages.sort((a, b) => b.timestamp - a.timestamp)[0];
                            botTimestamp = Math.max(botTimestamp, lastUserMessage.timestamp + 100);
                        }
                    }
                    this.botStartTimestamp = botTimestamp;
                }

                // Reset bot transcript text for new response but keep currentBotItemId/timestamp
                this.currentBotMessageElement = null;
                this.currentBotTranscript = '';

                // Check if response already failed
                if (message.response && message.response.status === 'failed') {
                    const errorDetails = message.response.status_details;
                    if (errorDetails && errorDetails.error) {
                        this.addMessage('bot', `❌ Error: ${errorDetails.error.message || 'Unknown error'}`);
                    }
                    // Remove from pending
                    if (message.response.id) {
                        this.pendingResponses.delete(message.response.id);
                    }
                }
                break;

            case 'response.output_text.delta':
            case 'response.text.delta': // beta compat
                // Text content arriving - hide loader
                if (typeof this.hideLoader === 'function') this.hideLoader();
                if (typeof this.setMicButtonState === 'function') this.setMicButtonState('enabled');

                if (message.delta) {
                    // Update transcript for text-only responses
                    this.currentBotTranscript = (this.currentBotTranscript || '') + message.delta;
                    // ... (rest of logic handled by updateBotMessage or separate handler if needed)
                    // Note: response.audio_transcript.delta usually handles main content in voice mode,
                    // but text mode uses this.
                    if (this.currentBotItemId) {
                        this.updateBotMessage(this.currentBotItemId, this.currentBotTranscript, false, this.botStartTimestamp);
                    }
                }
                break;

            case 'response.output_item.added': // Re-adding hideLoader here
                // Bot started adding items - hide loader
                if (typeof this.hideLoader === 'function') this.hideLoader();
                if (typeof this.setMicButtonState === 'function') this.setMicButtonState('enabled');

                // Handle function calls that appear in the response output
                if (message.response?.id && this._suppressedResponseIds.has(message.response.id)) {
                    break;
                }
                if (message.item && message.item.type === 'function_call') {
                    const functionCall = message.item;
                    const functionName = functionCall.name;

                    console.log('[Erica] 🔍 Function call detected:', functionName);

                    let functionArgs = {};

                    try {
                        // Parse the arguments JSON string
                        if (functionCall.arguments) {
                            functionArgs = JSON.parse(functionCall.arguments);
                            console.log('[Erica] 🔍 Function arguments:', functionArgs);
                        }
                    } catch (error) {
                        console.error('[Erica] Error parsing function arguments:', error);
                        functionArgs = {};
                    }

                    // Match the response.done handler's guard: only execute when we
                    // have BOTH a valid function name AND non-empty args. Previously
                    // this fired on streaming with args={} (still being generated),
                    // which returned "Empty query" and — because dedup marks the
                    // call_id — swallowed the eventual response.done with real args.
                    // Waiting for response.done is safer and produces identical
                    // behaviour on the good-path where args happen to be complete.
                    if (functionName && Object.keys(functionArgs).length > 0) {
                        if (message.response?.id) {
                            this.pendingFunctionCalls.add(message.response.id);
                        }
                        this.executeFunction(functionName, functionArgs, functionCall.call_id, message.response?.id);
                    } else if (functionName) {
                        // Args not ready yet — response.done will pick this up with complete args
                        console.log('[Erica] 🔍 Function call args not yet complete, deferring to response.done');
                    } else {
                        console.warn('[Erica] ⚠️ Function call missing name:', { functionName, hasArgs: Object.keys(functionArgs).length > 0 });
                    }
                }
                break;

            case 'response.done':
                // Response finished - hide loader (safeguard)
                if (window.uiLayout && typeof window.uiLayout.setWaitingState === 'function') {
                    window.uiLayout.setWaitingState(this, false);
                }
                // Reset 30-minute session inactivity timer on coach response (text mode activity)
                if (!this.isRecording) {
                    this.startSessionInactivityTimer();
                }
                // Check if this response was created while recording or from text input
                const responseId = message.response?.id;
                if (responseId && this._activeResponseId === responseId) {
                    this._activeResponseId = null;
                }
                if (responseId && this._suppressedResponseIds.has(responseId)) {
                    // Suppressed response (e.g., preview) - do not write to chat/history.
                    this._suppressedResponseIds.delete(responseId);
                    this._endOneShot({ responseId });
                    return;
                }
                if (this._oneShot && this._oneShot.responseId && responseId === this._oneShot.responseId) {
                    this._endOneShot({ responseId });
                }
                const wasCreatedWhileRecording = responseId && this.pendingResponses.has(responseId);

                /* console.log('[Erica] response.done received:', {
                    responseId,
                    wasCreatedWhileRecording,
                    status: message.response?.status,
                    hasOutput: !!message.response?.output,
                    outputLength: message.response?.output?.length || 0,
                    isRecording: this.isRecording
                }); */

                // Remove from active audio responses (audio is done)
                if (responseId) {
                    this.activeAudioResponses.delete(responseId);
                }

                // Process if this response was created while recording OR if it has output (text responses)
                // This ensures text message responses are processed even if not in pendingResponses
                if (!wasCreatedWhileRecording && (!message.response?.output || !Array.isArray(message.response.output) || message.response.output.length === 0)) {
                    // Remove from pending if it exists
                    if (responseId) {
                        this.pendingResponses.delete(responseId);
                    }
                    console.log('[Erica] response.done: Skipping response (not in pending and no output)');
                    return;
                }

                // Remove from pending
                if (responseId) {
                    this.pendingResponses.delete(responseId);

                    // Note: Function call outputs will trigger new responses in executeFunction
                    // No need to create a response here to avoid duplicates
                    if (this.pendingFunctionCalls.has(responseId)) {
                        this.pendingFunctionCalls.delete(responseId);
                    }
                }

                // Check if response failed
                if (message.response && message.response.status === 'failed') {
                    const errorDetails = message.response.status_details;
                    if (errorDetails && errorDetails.error) {
                        this.addMessage('bot', `❌ Error: ${errorDetails.error.message || 'Unknown error'}`);
                    }
                } else if (message.response && message.response.status === 'completed') {
                    // Check output for transcript and function calls
                    // console.log('[Erica] response.done: Processing completed response, output:', message.response.output);

                    if (message.response.output && Array.isArray(message.response.output)) {
                        let foundOutput = false;
                        message.response.output.forEach((output, index) => {
                            /* console.log(`[Erica] response.done: Output[${index}]:`, {
                                type: output.type,
                                hasTranscript: !!output.transcript,
                                hasText: !!output.text,
                                hasContent: !!output.content
                            }); */

                            // Handle audio transcript (from voice responses)
                            if (output.type === 'audio_transcript' && output.transcript) {
                                const ts = this.botStartTimestamp || Date.now();
                                // console.log('[Erica] response.done: Processing audio_transcript, length:', output.transcript.length);
                                this.updateBotMessage(this.currentBotItemId || responseId || `bot-${Date.now()}`, output.transcript, true, ts);
                                foundOutput = true;

                                // Analytics: Received from AI Coach
                                // If not recording (chat mode), treat as text receipt even if audio was generated
                                const eventName = this.isRecording ? 'Received from AI Coach Voice' : 'Received from AI Coach text';

                                this.analyticsSession.responseCount++;
                                this.trackCoachEvent(eventName, {
                                    Response: output.transcript,
                                    ResponseLength: output.transcript.length,
                                    ResponseCount: this.analyticsSession.responseCount
                                });
                                // console.log('[Erica] 📊 Analytics Triggered: Received from AI Coach Voice');
                            }
                            // Handle text output (from text message responses)
                            else if (output.type === 'text' && output.text) {
                                const ts = this.botStartTimestamp || Date.now();
                                // console.log('[Erica] response.done: Processing text output, length:', output.text.length);
                                this.updateBotMessage(this.currentBotItemId || responseId || `bot-${Date.now()}`, output.text, true, ts);
                                foundOutput = true;

                                // Analytics: Received from AI Coach (Text content)
                                this.analyticsSession.responseCount++;
                                this.trackCoachEvent('Received from AI Coach text', {
                                    Response: output.text,
                                    ResponseLength: output.text.length,
                                    ResponseCount: this.analyticsSession.responseCount
                                });
                                // console.log('[Erica] 📊 Analytics Triggered: Received from AI Coach text');
                            }
                            // Handle message content (alternative format)
                            else if (output.type === 'message' && output.content) {
                                // Extract text and audio transcript from message content
                                let combinedText = '';
                                let hasAudio = false;

                                if (Array.isArray(output.content)) {
                                    output.content.forEach(content => {
                                        if (content.type === 'text' && content.text) {
                                            combinedText += content.text;
                                        } else if ((content.type === 'audio' || content.type === 'output_audio') && content.transcript) {
                                            combinedText += content.transcript;
                                            hasAudio = true;
                                        }
                                    });
                                }

                                if (combinedText) {
                                    const ts = this.botStartTimestamp || Date.now();
                                    // console.log('[Erica] response.done: Processing message content, length:', combinedText.length);
                                    this.updateBotMessage(this.currentBotItemId || responseId || `bot-${Date.now()}`, combinedText, true, ts);
                                    foundOutput = true;

                                    // Analytics: Received from AI Coach
                                    this.analyticsSession.responseCount++;

                                    // Logic: If explicitly audio content AND recording, then Voice. 
                                    // If strictly text content, then Text.
                                    // If mixed content but NOT recording, strictly Text.
                                    const eventName = (hasAudio && this.isRecording) ? 'Received from AI Coach Voice' : 'Received from AI Coach text';

                                    this.trackCoachEvent(eventName, {
                                        Response: combinedText,
                                        ResponseLength: combinedText.length,
                                        ResponseCount: this.analyticsSession.responseCount
                                    });
                                }
                            } else if (output.type === 'function_call') {
                                // Handle function call from response output
                                const functionCall = output;
                                const functionName = functionCall.name;

                                console.log('[Erica] 🔍 Function call in response.done:', functionName);

                                let functionArgs = {};

                                try {
                                    if (functionCall.arguments) {
                                        functionArgs = JSON.parse(functionCall.arguments);
                                        console.log('[Erica] 🔍 Function arguments:', functionArgs);
                                    }
                                } catch (error) {
                                    console.error('[Erica] Error parsing function arguments:', error);
                                }

                                // Only process if we have valid arguments
                                if (functionName && Object.keys(functionArgs).length > 0) {
                                    // Track this function call
                                    if (responseId) {
                                        this.pendingFunctionCalls.add(responseId);
                                    }

                                    this.executeFunction(functionName, functionArgs, functionCall.call_id, responseId);
                                } else {
                                    console.warn('[Erica] ⚠️ Function call missing name or arguments:', { functionName, hasArgs: Object.keys(functionArgs).length > 0 });
                                }
                            }
                        });

                        if (!foundOutput) {
                            // console.warn('[Erica] response.done: No processable output found in response');
                        } else {
                            // console.log('[Erica] response.done: Successfully processed output');
                        }
                    } else {
                        console.warn('[Erica] response.done: Response has no output array');
                    }
                }

                // Reset bot timing
                this.botStartTimestamp = null;

                // --- Periodic persona nudge ---
                // Every 5 bot responses, inject a coaching-style reminder into the
                // conversation context so the model doesn't drift toward generic advice.
                // Unlike session.update (which re-sends static instructions), this appears
                // IN the conversation timeline as recent context the model actually sees.
                {
                    const finalBotCount = this.messages.filter(m => m.role === 'bot' && m.final).length;
                    if (finalBotCount > 0 && finalBotCount % 5 === 0) {
                        const _persona = this.getEffectiveVoiceProfile() || this.currentVoiceProfile;
                        if (_persona && this.isConnected) {
                            const _style = _persona.coachingStyle?.primaryObjective || _persona.label || '';
                            const nudgeText =
                                `[Coaching style reminder] You are ${_persona.character}. ` +
                                `Your approach is "${_style}". ` +
                                `Stay concise (2-4 sentences). Follow your behavioral guardrails strictly. ` +
                                `Do not give generic step-by-step advice — stay in your unique coaching style.`;
                            this.sendMessage({
                                type: 'conversation.item.create',
                                item: {
                                    type: 'message',
                                    role: 'system',
                                    content: [{ type: 'input_text', text: nudgeText }]
                                }
                            });
                            console.log(`[Erica] 🎯 Persona nudge injected at bot response #${finalBotCount}:`, nudgeText);
                        }
                    }
                }

                break;

            case 'error':
                if (window.uiLayout && typeof window.uiLayout.setWaitingState === 'function') {
                    window.uiLayout.setWaitingState(this, false);
                }
                const errorMsg = message.error?.message || message.message || 'Unknown error';
                const errorCode = message.error?.code || '';

                // Ignore expected errors when stopping recording
                if (errorCode === 'buffer_too_small' ||
                    errorMsg.includes('buffer too small') ||
                    errorMsg.includes('buffer only has') ||
                    errorCode === 'no_active_response' ||
                    errorMsg.includes('no active response') ||
                    errorMsg.includes('Cancellation failed')) {
                    // These are expected when stopping recording - silently ignore
                    return;
                }

                // Only show unexpected errors
                console.error('OpenAI API Error:', errorMsg);
                break;

            default:
            // Unhandled message type - silently ignore
        }
    }

    async handleAudioChunk(base64Audio) {
        if (!this.isCallAudioEnabled) {
            // Do not play synthesized audio when not in call mode
            return;
        }
        try {
            // Decode base64 audio
            const binaryString = atob(base64Audio);
            const audioData = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                audioData[i] = binaryString.charCodeAt(i);
            }

            this.audioQueue.push(audioData);

            if (!this.isPlaying) {
                this.playAudioQueue();
            }
        } catch (error) {
            console.error('Error handling audio chunk:', error);
        }
    }

    async playAudioQueue() {
        if (this.audioQueue.length === 0) {
            this.isPlaying = false;
            return;
        }

        this.isPlaying = true;

        while (this.audioQueue.length > 0) {
            try {
                const audioData = this.audioQueue.shift();
                const audioBuffer = await this.audioContext.decodeAudioData(audioData.buffer);
                const source = this.audioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(this.audioContext.destination);

                await new Promise((resolve) => {
                    source.onended = resolve;
                    source.start(0);
                });
            } catch (error) {
                console.error('Error playing audio:', error);
            }
        }

        this.isPlaying = false;
    }

    async toggleRecording() {
        if (!this.isConnected) {
            return;
        }

        if (!this.isRecording) {
            await this.startRecording();
        } else {
            this.stopRecording();
        }
    }

    setCallAudioEnabled(enabled) {
        this.isCallAudioEnabled = enabled;
        if (this.remoteAudio) {
            // Unmute only if global sound is enabled AND we are in a call (or forcing enabled)
            // AND not gated
            const shouldUnmute = enabled && this.isSoundEnabled && !this.audioOutputGate;

            /* console.log('[Erica Gate] setCallAudioEnabled (Active):', {
                enabled,
                audioOutputGate: this.audioOutputGate,
                shouldUnmute
            }); */
            this.remoteAudio.muted = !shouldUnmute;
            if (shouldUnmute) {
                this.remoteAudio.play().catch(e => console.error('[Erica] Audio play failed:', e));
            } else {
                this.remoteAudio.pause();
            }
        }
    }

    async startRecording() {
        // Voice limit check
        if (!this.checkVoiceLimit()) {
            this.showVoiceLimitAlert();
            throw new Error('Voice limit reached');
        }

        // Auto-reconnect if the session dropped (e.g. after 30-min inactivity timeout)
        if (!this.isConnected) {
            console.log('[Erica] Not connected — reconnecting before starting voice...');
            this.isOnHold = false;
            await this.connect();
            await new Promise(resolve => setTimeout(resolve, 800));
            if (!this.isConnected) {
                console.warn('[Erica] Reconnect did not complete — cannot start recording');
                throw new Error('Reconnect failed');
            }
        }

        // Analytics: fired here so it triggers regardless of how recording is started
        // (mic button click, Android WebView call, URL param voiceMode, etc.)
        if (this.analyticsSession) {
            this.trackCoachEvent('Clicked AI Coach Voice', {});
        }

        try {
            // Lazily request microphone on user click if not already available
            if (!this.localStream) {
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                });
                console.log('[Erica] Microphone access granted, stream:', this.localStream.id);
            }
            this.recordingStartTimestamp = Date.now();

            // Save state: call mode intended
            this.saveCurrentState('call');

            // Sync with UI
            this.isRecording = true;
            this.updateStatus(this.isConnected);

            // Bridge valid references for UI controls (legacy support)
            if (!this.callButton && this.micToggleButton) {
                this.callButton = this.micToggleButton;
            }

            if (this.callButton) {
                this.callButton.classList.add('in-call');
                //this.callButton.title = 'End call';
            }
            this.setMicToggleUI(true);

            // Initialize Gate
            this.audioOutputGate = true;
            this.setCallAudioEnabled(true);

            // Start voice inactivity timer
            this.startVoiceInactivityTimer();

            // Ensure we start unmuted (fresh session)
            this.isSelfMuted = false;
            this.updateCallPanelMicUI();

            // Start audio visualization
            this.startAudioLevelMonitoring();

            // If we are already connected (e.g. text mode / auto-connect), we must attach the new track
            if (this.isConnected && this.pc) {
                const audioTracks = this.localStream.getAudioTracks();
                if (audioTracks.length > 0) {
                    console.log('[Erica] Attaching microphone track to existing connection...');
                    const track = audioTracks[0];
                    track.enabled = true;
                    console.log(`[Erica] Track Info: id=${track.id}, state=${track.readyState}, muted=${track.muted}, enabled=${track.enabled}, label=${track.label}`);

                    // Add track to PeerConnection
                    // Priority: Use the pre-negotiated transceiver sender (this.audioSender)
                    if (this.audioSender) {
                        console.log('[Erica] Replacing audio track on existing sender');
                        await this.audioSender.replaceTrack(track);
                    } else {
                        // Fallback: This creates a NEW transceiver/sender which might require renegotiation
                        // (OpenAI Realtime usually expects a single audio m-line)
                        console.log('[Erica] Adding new audio track (no sender found)');
                        this.pc.addTrack(track, this.localStream);
                    }

                    // Monitor audio packet transmission
                    this.startPacketMonitoring();
                }
            }
            else if (!this.isConnected) {
                // If not connected, connect now (which will use the stream we just got)
                await this.connect();
            }

        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Could not access microphone. Please allow microphone permissions.');
            this.isRecording = false;
            this.setMicToggleUI(false);
        }
    }

    startAudioLevelMonitoring() {
        if (this.audioLevelInterval) {
            clearInterval(this.audioLevelInterval);
        }

        // Reuse context or create new if needed (though usually we don't want to create one just for viz if not needed)
        // But for visualization we need an analyser
        if (!this.analyser) {
            try {
                if (!this.audioContext) {
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                if (this.localStream) {
                    const source = this.audioContext.createMediaStreamSource(this.localStream);
                    this.analyser = this.audioContext.createAnalyser();
                    this.analyser.fftSize = 256;
                    this.analyser.smoothingTimeConstant = 0.8;
                    source.connect(this.analyser);
                }
            } catch (e) {
                console.warn('[Erica] Failed to setup audio analyser:', e);
                return;
            }
        }

        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        const timeDataArray = new Uint8Array(this.analyser.fftSize);

        this.audioLevelInterval = setInterval(() => {
            if (!this.isRecording || !this.analyser) {
                return;
            }

            // Get time domain data (actual audio waveform)
            this.analyser.getByteTimeDomainData(timeDataArray);

            // Calculate RMS
            let sum = 0;
            for (let i = 0; i < timeDataArray.length; i++) {
                const normalized = (timeDataArray[i] - 128) / 128;
                sum += normalized * normalized;
            }
            const rms = Math.sqrt(sum / timeDataArray.length);
            const normalizedLevel = Math.min(1, rms * 5);

            // Also get frequency data 
            this.analyser.getByteFrequencyData(dataArray);

            this.updateWaveVisualization(normalizedLevel, dataArray);

            // Update mic icon pulsation based on voice level
            if (window.uiLayout && typeof window.uiLayout.updateMicLevel === 'function') {
                window.uiLayout.updateMicLevel(this, normalizedLevel);
            }
        }, 50);
    }

    startRemoteAudioLevelMonitoring(stream) {
        if (!stream) return;
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            if (this.remoteAudioSource) {
                try { this.remoteAudioSource.disconnect(); } catch (_) { }
                this.remoteAudioSource = null;
            }
            if (this.remoteAudioGain) {
                try { this.remoteAudioGain.disconnect(); } catch (_) { }
                this.remoteAudioGain = null;
            }

            this.remoteAnalyser = this.audioContext.createAnalyser();
            this.remoteAnalyser.fftSize = 256;
            this.remoteAnalyser.smoothingTimeConstant = 0.8;

            this.remoteAudioSource = this.audioContext.createMediaStreamSource(stream);
            this.remoteAudioGain = this.audioContext.createGain();
            this.remoteAudioGain.gain.value = 0;

            // Connect source -> analyser -> zero gain -> destination (keeps analyzer active without audible double playback)
            this.remoteAudioSource.connect(this.remoteAnalyser);
            this.remoteAnalyser.connect(this.remoteAudioGain);
            this.remoteAudioGain.connect(this.audioContext.destination);

            if (this.remoteLevelInterval) {
                clearInterval(this.remoteLevelInterval);
            }

            const dataArray = new Uint8Array(this.remoteAnalyser.fftSize);
            this.remoteLevelInterval = setInterval(() => {
                if (!this.remoteAnalyser) return;
                if (!this.isSoundEnabled || this.audioOutputGate) {
                    if (window.uiLayout && typeof window.uiLayout.updateSpeakerLevel === 'function') {
                        window.uiLayout.updateSpeakerLevel(this, 0);
                    }
                    return;
                }
                this.remoteAnalyser.getByteTimeDomainData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const normalized = (dataArray[i] - 128) / 128;
                    sum += normalized * normalized;
                }
                const rms = Math.sqrt(sum / dataArray.length);
                const level = Math.min(1, rms * 5); // same scale as mic visualization

                // Debug audio levels occasionally check
                if (level > 0.001) {
                    // console.log(`[Erica Audio Debug] Level: ${level.toFixed(4)}`);
                }

                if (level > 0.04) {
                    this.lastRemoteLevelAt = Date.now();
                }
                if (window.uiLayout && typeof window.uiLayout.updateSpeakerLevel === 'function') {
                    window.uiLayout.updateSpeakerLevel(this, level);
                }
            }, 80);
        } catch (e) {
            console.warn('[Erica] Failed to start remote audio level monitor:', e);
        }
    }

    updateWaveVisualization(level, frequencyData) {
        // UI changed: we keep the mic FAB icon stable and do not morph SVGs during call.
        // (Stop/mute controls live in the call-mode panel now.)
        return;
    }

    startPacketMonitoring() {
        if (this.packetInterval) clearInterval(this.packetInterval);
        // Monitor WebRTC stats to track audio packet transmission
        this.packetInterval = setInterval(async () => {
            if (!this.isConnected || !this.pc) return;
            try {
                const stats = await this.pc.getStats();
                let packetsSent = 0;
                let validReportFound = false;

                stats.forEach(report => {
                    if (report.type === 'outbound-rtp' && report.mediaType === 'audio') {
                        validReportFound = true;
                        if (report.packetsSent) {
                            packetsSent = report.packetsSent;
                        }
                    }
                });

                // Force log even if 0 to confirm check is running
                if (validReportFound) {
                    if (packetsSent !== this.audioPacketsSent || packetsSent === 0) {
                        /* console.log(`[Erica] 🎤 Audio Packets Sent: ${packetsSent}`); */
                    }
                    this.audioPacketsSent = packetsSent;
                } else {
                    console.log('[Erica] Wireless stats: No outbound-rtp audio report found yet.');
                }
            } catch (error) {
                console.error('Error getting stats:', error);
            }
        }, 1000);
    }

    startAudioLevelMonitoring() {
        if (this.audioLevelInterval) {
            clearInterval(this.audioLevelInterval);
        }

        if (!this.analyser) {
            // Analyser not available
            return;
        }

        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        const timeDataArray = new Uint8Array(this.analyser.fftSize);

        this.audioLevelInterval = setInterval(() => {
            if (!this.isRecording || !this.analyser) {
                return;
            }

            // Get time domain data (actual audio waveform)
            this.analyser.getByteTimeDomainData(timeDataArray);

            // Calculate RMS (Root Mean Square) for actual audio level
            let sum = 0;
            for (let i = 0; i < timeDataArray.length; i++) {
                const normalized = (timeDataArray[i] - 128) / 128;
                sum += normalized * normalized;
            }
            const rms = Math.sqrt(sum / timeDataArray.length);
            const normalizedLevel = Math.min(1, rms * 5); // Amplify and clamp

            // Also get frequency data for visualization
            this.analyser.getByteFrequencyData(dataArray);
            this.updateWaveVisualization(normalizedLevel, dataArray);
        }, 50);
    }

    updateWaveVisualization(level, frequencyData) {
        // Visualization updates
    }

    updateAudioStatus(isActive) {
        // Keep the status label stable (agent name). Toggle audio status bar only.
        if (this.audioStatus) {
            this.audioStatus.style.display = isActive && this.isConnected ? 'flex' : 'none';
        }
    }

    async sendAudioToAPI(audioBlob) {
        // With WebRTC, audio is sent directly through the peer connection
        // The MediaRecorder is already streaming to the peer connection
        // This function is kept for compatibility but audio is handled by WebRTC
        // Audio sent via WebRTC
    }

    updateUserMessage(id, text, isFinal = false, timestamp = null) {
        // Track input type for bot reply attribution
        this._lastUserInputType = 'voice';

        let ts = timestamp || Date.now();

        const messageId = id || `user-${Date.now()}`;

        /* console.log('[Erica] updateUserMessage called:', {
            id: messageId,
            textLength: text ? text.length : 0,
            textPreview: text ? text.substring(0, 50) : 'empty',
            isFinal,
            timestamp: ts,
            minNewMessageTimestamp: this.minNewMessageTimestamp
        }); */

        /*this.upsertMessage(messageId, 'user', text, isFinal, ts);*/
        this.upsertMessage(messageId, 'user', text, isFinal, ts, { inputType: 'voice' });

        // Fire analytics for voice/transcription path when final text is available
        if (isFinal) {
            this.emitAskedEricaEvent(text);
        }
    }

    updateBotMessage(id, text, isFinal = false, timestamp = null, meta = {}) {
        // ===== QC TEST HARNESS (remove before deploy) =====
        // Force final bot messages to be problematic so QC can be observed.
        // Cycles through different garbage patterns on each message.
        if (isFinal && !meta.qcChecked && this._qcTestEnabled) {
            const patterns = [
                '{"name": "Erica"}',
                '{"coach": "supportive", "style": "warm"}',
                '{coach: erica}',
                '```json\n{"response": "Hello there!"}\n```',
                '{"voice_response": "I am happy to help you today!"}',
                'Sure! Here is your report: ```\nSome code block content\n```',
            ];
            this._qcTestIndex = ((this._qcTestIndex || 0) % patterns.length);
            const forced = patterns[this._qcTestIndex];
            console.warn('[Erica] QC TEST: forcing message to:', forced);
            text = forced;
            this._qcTestIndex++;
        }
        // ===== END QC TEST HARNESS =====

        let ts = timestamp || Date.now();

        const companionId =
            (this.currentVoiceProfile && this.currentVoiceProfile.companionId) ||
            (this.currentVoiceProfile && this.currentVoiceProfile.character) ||
            this.selectedVoice ||
            null;
        const companionThumb = this.currentVoiceThumbUrl || (this.currentVoiceThumb ? this.currentVoiceThumb.src : null);

        this.upsertMessage(
            id || `bot-${Date.now()}`,
            'bot',
            text,
            isFinal,
            ts,
            {
                companionId,
                companionThumb,
                qcChecked: !!meta.qcChecked,
                inputType: this._lastUserInputType || null
            }
        );

        if (isFinal && !meta.qcChecked) {
            this.queueBotMessageQC(id || `bot-${Date.now()}`, text);
        }
    }

    addMessage(sender, text) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        const p = document.createElement('p');
        p.textContent = text;

        contentDiv.appendChild(p);
        messageDiv.appendChild(contentDiv);
        this.chatMessages.appendChild(messageDiv);

        // Scroll to bottom
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    updateStatus(connected) {
        // Update Internal State
        this.isConnected = connected;

        // Fire connected/disconnected events to parent app (e.g. mobile app via postMessage)
        // Guard with _lastReportedConnected to avoid duplicate events on redundant calls
        try {
            const wasConnected = this._lastReportedConnected;
            const isNowConnected = connected === true;
            const isNowDisconnected = connected === false;

            if (isNowConnected && !wasConnected) {
                this._lastReportedConnected = true;
                // Analytics + iframe (Wix/web)
                this.trackCoachEvent('AI Coach Connected', {});
                // Native bridge (iOS/Android) — keep action format for backward compat
                if (typeof messageToApp === 'function') {
                    messageToApp({
                        action: 'ericaConnected',
                        coach: this.selectedCompanionId || null,
                        userId: this.getUserIdFromURL ? this.getUserIdFromURL() : null
                    });
                }
            } else if (isNowDisconnected && wasConnected) {
                this._lastReportedConnected = false;
                // Analytics + iframe (Wix/web)
                this.trackCoachEvent('AI Coach Disconnected', {});
                // Native bridge (iOS/Android) — keep action format for backward compat
                if (typeof messageToApp === 'function') {
                    messageToApp({
                        action: 'ericaDisconnected',
                        coach: this.selectedCompanionId || null,
                        userId: this.getUserIdFromURL ? this.getUserIdFromURL() : null
                    });
                }
            }
        } catch (_) {
            // Never let event dispatch break the connection flow
        }

        // Delegate to UI Layout
        if (window.uiLayout && typeof window.uiLayout.updateStatusDot === 'function') {
            window.uiLayout.updateStatusDot(this, connected);
        } else {
            // Fallback if uiLayout not ready (legacy)
            if (this.statusDot) {
                if (connected) this.statusDot.classList.add('connected');
                else this.statusDot.classList.remove('connected');
            }
        }

        // Delegate Mic Toggle visibility/state
        if (window.uiLayout && typeof window.uiLayout.updateMicToggleVisibility === 'function') {
            window.uiLayout.updateMicToggleVisibility(this);
        }
    }
}

class PreviewSession {
    constructor(app) {
        this.app = app;
        this.pc = null;
        this.dataChannel = null;
        this.remoteAudio = null;
        this.connected = false;
        this.connecting = false;
        this.connectPromise = null;
        this.pendingResponses = new Set();
        this.oneShot = null;
        this.idleTimer = null;
        this.lastVoice = null;
        this._sessionReady = null;
        this._sessionReadyResolver = null;
    }

    isActive() {
        return !!(this.oneShot && this.oneShot.active);
    }

    async playPreview({ voice, promptText, expectedText = '', estimatedMs = 0, styleInstructions = '', retryCount = 0 }) {
        const text = (promptText || '').trim();
        if (!text) return false;

        // Always start a fresh preview session to ensure voice takes effect.
        if (this.connected || this.pc || this.dataChannel) {
            this.close();
        }
        await this.ensureConnected();
        await this.configureSession(voice, styleInstructions);
        await this._waitForSessionUpdate(2000);

        if (this.isActive()) {
            await this.cancelActivePreview();
        }

        let resolveStarted = null;
        const startedPromise = new Promise((resolve) => { resolveStarted = resolve; });

        this.oneShot = {
            active: true,
            responseId: null,
            expectedText: expectedText || '',
            transcript: '',
            promptText: text,
            voice: voice || 'marin',
            retryCount: retryCount || 0,
            _resolveStarted: resolveStarted,
            _startedResolved: false,
            startedAt: Date.now(),
            restoreDelayMs: Number.isFinite(estimatedMs) ? Math.max(0, estimatedMs) : 0
        };

        this._clearIdleTimer();
        this.lastPreview = {
            voice: voice || 'marin',
            promptText: text,
            expectedText: expectedText || '',
            estimatedMs: Number.isFinite(estimatedMs) ? Math.max(0, estimatedMs) : 0,
            styleInstructions: styleInstructions || '',
            retryCount: retryCount || 0
        };

        this.sendMessage({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text }]
            }
        });
        const responseConfig = {
            type: 'response.create'
        };
        console.log('[Erica Preview] response.create');
        this.sendMessage(responseConfig);
        this._kickAudioPlayback();

        const started = await Promise.race([
            startedPromise,
            this._sleep(15_000).then(() => false)
        ]);

        setTimeout(() => {
            if (this.oneShot && this.oneShot.active && Date.now() - this.oneShot.startedAt > 20_000) {
                this._endOneShot();
            }
        }, 21_000);

        return !!started;
    }

    async cancelActivePreview() {
        if (!this.isActive()) return false;

        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            if (this.oneShot && this.oneShot.responseId) {
                this.sendMessage({
                    type: 'response.cancel',
                    response_id: this.oneShot.responseId
                });
            } else {
                this.sendMessage({ type: 'input_audio_buffer.clear' });
            }
        }

        this._stopAudio();
        this._endOneShot();
        return true;
    }

    async ensureConnected() {
        if (this.connected && this.dataChannel && this.dataChannel.readyState === 'open') return;
        if (this.connected && (!this.dataChannel || this.dataChannel.readyState !== 'open')) {
            this.close();
        }
        if (this.connecting && this.connectPromise) return this.connectPromise;
        this.connecting = true;
        this.connectPromise = this._connect().finally(() => {
            this.connecting = false;
        });
        return this.connectPromise;
    }

    async _connect() {
        try {
            this.pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });

            this.pc.addTransceiver('audio', { direction: 'recvonly' });

            this.remoteAudio = document.createElement('audio');
            this.remoteAudio.autoplay = true;
            this.remoteAudio.volume = 1.0;
            this.remoteAudio.muted = false;
            this.remoteAudio.style.display = 'none';
            document.body.appendChild(this.remoteAudio);

            this.remoteAudio.oncanplay = () => {
                this.remoteAudio.play().catch(() => { });
            };

            this.pc.ontrack = (event) => {
                if (event.track.kind !== 'audio') return;
                const stream = new MediaStream([event.track]);
                if (!this.remoteAudio.srcObject || this.remoteAudio.srcObject !== stream) {
                    this.remoteAudio.srcObject = stream;
                }
                this.remoteAudio.play().catch(() => { });
            };

            this.pc.ondatachannel = (event) => {
                if (event?.channel) {
                    this._setDataChannel(event.channel);
                }
            };

            this._setDataChannel(this.pc.createDataChannel('oai-events'));

            const offer = await this.pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: false
            });
            await this.pc.setLocalDescription(offer);

            // GA API: wait for ICE gathering to complete
            if (this.pc.iceGatheringState !== 'complete') {
                await new Promise((resolve) => {
                    const checkState = () => {
                        if (this.pc.iceGatheringState === 'complete') {
                            this.pc.removeEventListener('icegatheringstatechange', checkState);
                            resolve();
                        }
                    };
                    this.pc.addEventListener('icegatheringstatechange', checkState);
                    setTimeout(() => {
                        this.pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }, 5000);
                });
            }

            const response = await fetch(this.app.apiUrl('/api/proxy/realtime'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/sdp'
                },
                body: this.pc.localDescription.sdp
            });

            if (!response.ok) {
                let errorText = '';
                try {
                    errorText = await response.text();
                } catch (e) {
                    errorText = response.statusText;
                }
                throw new Error(`Preview API Error (${response.status}): ${errorText || response.statusText}`);
            }

            const answerSdp = await response.text();
            await this.pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: answerSdp
            }));

            await this._waitForDataChannelOpen(12_000);
            this.connected = true;
        } catch (err) {
            this.close();
            throw err;
        }
    }

    async configureSession(voice, styleInstructions = '') {
        const nextVoice = String(voice || '').toLowerCase();

        const instructions =
            'You are a preview voice reader. Only read exactly the text provided between <preview> tags. ' +
            'Do not add, remove, or change any words. No extra commentary.' +
            (styleInstructions ? `\n\n${styleInstructions}` : '');

        this._sessionReady = new Promise((resolve) => {
            this._sessionReadyResolver = resolve;
        });

        const payload = {
            type: 'session.update',
            session: {
                type: 'realtime',
                model: 'gpt-realtime',
                instructions,
                output_modalities: ['audio'],
                audio: {
                    input: {
                        transcription: {
                            model: 'whisper-1'
                        },
                        turn_detection: {
                            type: 'server_vad',
                            threshold: 0.95,
                            prefix_padding_ms: 600,
                            silence_duration_ms: 2000
                        }
                    },
                    output: {
                        voice: voice || 'marin'
                    }
                }
            }
        };

        console.log('[Erica Preview] session.update', {
            voice: payload.session.voice,
            hasStyle: !!styleInstructions,
            styleLen: styleInstructions ? styleInstructions.length : 0
        });
        this.sendMessage(payload);
        this.lastVoice = nextVoice;
    }

    sendMessage(payload) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('Preview dataChannel not ready');
        }
        this.dataChannel.send(JSON.stringify(payload));
    }

    _handleMessage(message) {
        if (!message || !message.type) return;
        if (message.type === 'session.updated') {
            console.log('[Erica Preview] session.updated', {
                voice: message?.session?.voice || null,
                modalities: message?.session?.modalities || null
            });
            if (this._sessionReadyResolver) {
                this._sessionReadyResolver(true);
                this._sessionReadyResolver = null;
            }
        } else if (message.type === 'error') {
            console.warn('[Erica Preview] error', message);
        } else if (message.type === 'output_audio_transcription.delta') {
            if (this.oneShot && this.oneShot.active && typeof message.delta === 'string') {
                this.oneShot.transcript = (this.oneShot.transcript || '') + message.delta;
            }
        } else if (message.type === 'output_audio_transcription.completed') {
            if (this.oneShot && this.oneShot.active) {
                const completed = message?.item?.transcript || message?.transcript || null;
                if (completed) {
                    this.oneShot.transcript = completed;
                }
            }
        } else if (message.type === 'response.created') {
            if (this.oneShot && this.oneShot.active && !this.oneShot.responseId && message.response?.id) {
                this.oneShot.responseId = message.response.id;
                this.pendingResponses.add(message.response.id);
                try {
                    if (this.oneShot._resolveStarted && !this.oneShot._startedResolved) {
                        this.oneShot._startedResolved = true;
                        this.oneShot._resolveStarted(true);
                    }
                } catch (_) { }
            }
        } else if (message.type === 'response.done') {
            if (this.oneShot && this.oneShot.responseId && message.response?.id === this.oneShot.responseId) {
                const shouldRetry = this._shouldRetryPreviewTranscript(message);
                this._endOneShot();
                if (shouldRetry) {
                    console.log('[Erica Preview] retrying preview (preface detected)');
                    this._retryLastPreview();
                }
            }
        }
    }

    _shouldRetryPreviewTranscript(message) {
        if (!this.oneShot || !this.oneShot.expectedText) return false;
        if ((this.oneShot.retryCount || 0) >= 1) return false;
        const transcript = this._extractPreviewTranscript(message) || this.oneShot.transcript || '';
        if (!transcript) return false;
        const expected = this.oneShot.expectedText || '';
        const normExpected = this._normalizePreviewText(expected);
        const normTranscript = this._normalizePreviewText(transcript);
        if (!normExpected) return false;
        return !normTranscript.startsWith(normExpected);
    }

    _retryLastPreview() {
        if (!this.lastPreview) return;
        if ((this.lastPreview.retryCount || 0) >= 1) return;
        const nextRetry = (this.lastPreview.retryCount || 0) + 1;
        const nextPrompt = this.lastPreview.promptText;
        const payload = {
            ...this.lastPreview,
            promptText: nextPrompt,
            retryCount: nextRetry
        };
        this.lastPreview = payload;
        setTimeout(() => {
            this.playPreview(payload).catch(() => { });
        }, 150);
    }

    _extractPreviewTranscript(message) {
        const output = message?.response?.output;
        if (!Array.isArray(output)) return null;
        for (const item of output) {
            if (item?.transcript && typeof item.transcript === 'string') {
                return item.transcript;
            }
            if (item?.text && typeof item.text === 'string') {
                return item.text;
            }
            if (Array.isArray(item?.content)) {
                for (const part of item.content) {
                    if (part?.transcript && typeof part.transcript === 'string') return part.transcript;
                    if (part?.text && typeof part.text === 'string') return part.text;
                    if (part?.output_text?.text && typeof part.output_text.text === 'string') return part.output_text.text;
                }
            }
        }
        return null;
    }

    _normalizePreviewText(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    _setDataChannel(channel) {
        if (!channel) return;
        if (this.dataChannel && this.dataChannel !== channel) {
            try {
                this.dataChannel.close();
            } catch (_) { }
        }
        this.dataChannel = channel;
        this.dataChannel.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this._handleMessage(message);
            } catch (_) { }
        };
        this.dataChannel.onopen = () => {
            this.connected = true;
        };
        this.dataChannel.onclose = () => {
            this.connected = false;
        };
        this.dataChannel.onerror = () => {
            this.connected = false;
        };
    }

    _endOneShot() {
        if (!this.oneShot) return;
        const responseId = this.oneShot.responseId;
        try {
            if (this.oneShot._resolveStarted && !this.oneShot._startedResolved) {
                this.oneShot._startedResolved = true;
                this.oneShot._resolveStarted(false);
            }
        } catch (_) { }
        this.oneShot = null;
        if (responseId) {
            this.pendingResponses.delete(responseId);
        }
        this._scheduleIdleClose();
    }

    _scheduleIdleClose() {
        this._clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.close();
        }, 30_000);
    }

    _clearIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    _stopAudio() {
        if (!this.remoteAudio) return;
        try {
            this.remoteAudio.pause();
            this.remoteAudio.currentTime = 0;
        } catch (_) { }
        try {
            this.remoteAudio.srcObject = null;
        } catch (_) { }
    }

    _kickAudioPlayback() {
        if (!this.remoteAudio) return;
        const tryPlay = () => {
            this.remoteAudio.play().catch((error) => {
                if (error && error.name === 'NotAllowedError') {
                    const enableAudio = () => {
                        this.remoteAudio.play().catch(() => { });
                        document.removeEventListener('click', enableAudio);
                    };
                    document.addEventListener('click', enableAudio, { once: true });
                }
            });
        };
        tryPlay();
        setTimeout(tryPlay, 300);
        setTimeout(tryPlay, 800);
    }

    async _waitForSessionUpdate(timeoutMs = 1500) {
        if (!this._sessionReady) return;
        const ready = this._sessionReady;
        this._sessionReady = null;
        await Promise.race([
            ready,
            this._sleep(timeoutMs)
        ]);
        this._sessionReadyResolver = null;
    }

    _waitForDataChannelOpen(timeoutMs = 10_000) {
        const start = Date.now();
        return new Promise((resolve, reject) => {
            const tick = () => {
                if (this.dataChannel && this.dataChannel.readyState === 'open') return resolve();
                if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for preview data channel'));
                setTimeout(tick, 100);
            };
            tick();
        });
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    close() {
        this._clearIdleTimer();
        this._stopAudio();
        if (this.dataChannel) {
            try {
                this.dataChannel.close();
            } catch (_) { }
            this.dataChannel = null;
        }
        if (this.pc) {
            try {
                this.pc.close();
            } catch (_) { }
            this.pc = null;
        }
        if (this.remoteAudio) {
            try {
                this.remoteAudio.remove();
            } catch (_) { }
            this.remoteAudio = null;
        }
        this.connected = false;
        this.connecting = false;
        this.connectPromise = null;
        this.lastVoice = null;
        this.pendingResponses.clear();
        this.oneShot = null;
    }
}

// Initialize the chat bot when the page loads
document.addEventListener('DOMContentLoaded', () => {
    const bot = new VoiceChatBot();
    // Expose for console testing (e.g. window._erica._qcTestEnabled = true)
    window._erica = bot;
});
