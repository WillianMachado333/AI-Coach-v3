/**
 * State Manager for AgentErica
 * Handles localStorage-based state persistence across iframe/WebView sessions
 * Supports: iframe, Android WebView, iOS WebView
 */

(function (global) {
    'use strict';

    const STATE_KEY = 'ERICA_SESSION_STATE';
    const STATE_VERSION = 1;

    // Platform-specific TTL (milliseconds)
    const DEFAULT_TTL = {
        'iframe': 24 * 60 * 60 * 1000,           // 24 hours
        'android-webview': 12 * 60 * 60 * 1000,  // 12 hours
        'ios-webview': 8 * 60 * 60 * 1000,       // 8 hours
        'unknown': 24 * 60 * 60 * 1000           // 24 hours (fallback)
    };

    class StateManager {
        constructor() {
            this.platform = this.detectPlatform();
            this.isLocalStorageAvailable = this.validateLocalStorage();
            this.nativeBridge = null;

            /* console.log('[StateManager] Initialized', {
                platform: this.platform,
                localStorageAvailable: this.isLocalStorageAvailable
            }); */
        }

        /**
         * Detect the runtime platform (iframe, Android WebView, iOS WebView)
         */
        detectPlatform() {
            try {
                const ua = navigator.userAgent;

                // Check for iOS WebView
                if (ua.includes('iPhone') || ua.includes('iPad')) {
                    // WKWebView has webkit.messageHandlers
                    if (window.webkit && window.webkit.messageHandlers) {
                        return 'ios-webview';
                    }
                }

                // Check for Android WebView
                // Android WebView typically has 'wv' in user agent or specific patterns
                if (ua.includes('wv') || (ua.includes('Android') && ua.includes('Version/'))) {
                    return 'android-webview';
                }

                // Check if running in iframe
                if (window.self !== window.top) {
                    return 'iframe';
                }

                return 'unknown';
            } catch (error) {
                console.warn('[StateManager] Platform detection failed:', error);
                return 'unknown';
            }
        }

        /**
         * Validate that localStorage is available and working
         * Critical for iOS where localStorage can be unavailable
         */
        validateLocalStorage() {
            try {
                const testKey = '__erica_ls_test__';
                window.localStorage.setItem(testKey, '1');
                const result = window.localStorage.getItem(testKey);
                window.localStorage.removeItem(testKey);
                return result === '1';
            } catch (error) {
                console.warn('[StateManager] localStorage not available:', error);
                return false;
            }
        }

        /**
         * Get platform-specific TTL
         */
        getDefaultTTL() {
            // Check for custom TTL from URL params
            try {
                const urlParams = new URLSearchParams(window.location.search);
                const customTTL = urlParams.get('stateTTL');
                if (customTTL && !isNaN(Number(customTTL))) {
                    return Number(customTTL);
                }
            } catch (_) { }

            // Check for custom TTL from localStorage
            try {
                const storedTTL = window.localStorage?.getItem('ERICA_STATE_TTL');
                if (storedTTL && !isNaN(Number(storedTTL))) {
                    return Number(storedTTL);
                }
            } catch (_) { }

            // Return platform-specific default
            return DEFAULT_TTL[this.platform] || DEFAULT_TTL['unknown'];
        }

        /**
         * Check if state persistence is disabled
         */
        isDisabled() {
            try {
                // Check URL param
                const urlParams = new URLSearchParams(window.location.search);
                if (urlParams.get('resetSession') === '1') {
                    return true;
                }

                // Check localStorage flag
                if (String(window.localStorage?.getItem('DISABLE_STATE_PERSISTENCE') || '') === '1') {
                    return true;
                }
            } catch (_) { }

            return false;
        }

        /**
         * Validate if a state object is still valid
         */
        isStateValid(state) {
            if (!state || typeof state !== 'object') {
                return false;
            }

            // Check version
            if (state.version !== STATE_VERSION) {
                console.log('[StateManager] State version mismatch');
                return false;
            }

            // Check required fields
            if (!state.timestamp || !state.selectedCoach || !state.mode) {
                console.log('[StateManager] State missing required fields');
                return false;
            }

            // Check expiration
            const now = Date.now();
            const age = now - state.timestamp;
            const ttl = this.getDefaultTTL();

            if (age > ttl) {
                console.log('[StateManager] State expired', {
                    age: Math.round(age / 1000 / 60),
                    ttl: Math.round(ttl / 1000 / 60),
                    unit: 'minutes'
                });
                return false;
            }

            return true;
        }

        /**
         * Load session state from localStorage
         */
        loadSessionState() {
            if (!this.isLocalStorageAvailable) {
                console.log('[StateManager] localStorage not available, cannot load state');
                return null;
            }

            if (this.isDisabled()) {
                console.log('[StateManager] State persistence disabled');
                return null;
            }

            try {
                const raw = window.localStorage.getItem(STATE_KEY);
                if (!raw) {
                    console.log('[StateManager] No saved state found');
                    return null;
                }

                const state = JSON.parse(raw);

                if (!this.isStateValid(state)) {
                    // Clear invalid state
                    this.clearSessionState();
                    return null;
                }

                /* console.log('[StateManager] Loaded valid state', {
                    mode: state.mode,
                    coach: state.selectedCoach?.name,
                    age: Math.round((Date.now() - state.timestamp) / 1000 / 60) + ' minutes'
                }); */

                return state;
            } catch (error) {
                console.error('[StateManager] Error loading state:', error);
                this.clearSessionState();
                return null;
            }
        }

        /**
         * Save session state to localStorage
         */
        saveSessionState(state) {
            if (!this.isLocalStorageAvailable) {
                console.log('[StateManager] localStorage not available, cannot save state');
                return false;
            }

            if (this.isDisabled()) {
                return false;
            }

            try {
                const stateToSave = {
                    version: STATE_VERSION,
                    timestamp: Date.now(),
                    platform: this.platform,
                    lastSaveTimestamp: Date.now(),
                    ...state
                };

                window.localStorage.setItem(STATE_KEY, JSON.stringify(stateToSave));

                // Try to notify parent window (iframe host) - but don't fail if unavailable
                try {
                    if (window.parent && window.parent !== window) {
                        window.parent.postMessage(
                            { action: "onAICoachSelect", sessionData: JSON.stringify(stateToSave) },
                            "*"
                        );
                    }
                } catch (err) {
                    // Silently ignore postMessage errors (parent may be inaccessible)
                    // This is expected when iframe is blocked or parent origin doesn't allow communication
                }

                /* console.log('[StateManager] State saved', {
                    mode: state.mode,
                    coach: state.selectedCoach?.name
                }); */

                return true;
            } catch (error) {
                console.error('[StateManager] Error saving state:', error);
                return false;
            }
        }

        /**
         * Clear session state from localStorage
         */
        clearSessionState() {
            if (!this.isLocalStorageAvailable) {
                return;
            }

            try {
                window.localStorage.removeItem(STATE_KEY);
                console.log('[StateManager] State cleared');
            } catch (error) {
                console.error('[StateManager] Error clearing state:', error);
            }
        }

        /**
         * Setup native bridge for WebView state injection (optional)
         * Native apps can call this to inject or restore state
         */
        setupNativeBridge() {
            // Expose methods for native apps
            window.EricaStateBridge = {
                saveState: (state) => {
                    console.log('[StateManager] Native bridge: saveState called');
                    return this.saveSessionState(state);
                },
                loadState: () => {
                    console.log('[StateManager] Native bridge: loadState called');
                    return this.loadSessionState();
                },
                clearState: () => {
                    console.log('[StateManager] Native bridge: clearState called');
                    this.clearSessionState();
                },
                getPlatform: () => this.platform,
                isAvailable: () => this.isLocalStorageAvailable
            };

            // console.log('[StateManager] Native bridge setup complete');
        }
    }

    // Export to global scope
    global.StateManager = StateManager;

})(typeof window !== 'undefined' ? window : this);
