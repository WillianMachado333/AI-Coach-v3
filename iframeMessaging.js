(function (global) {
    /**
     * Simple helper to manage iframe <-> parent postMessage communication.
     * Exposes start/stop so callers can control the listener lifecycle.
     */
    function createIframeMessaging({ windowObj, getPayload, logger = console, onLog = null }) {
        const win = windowObj || (typeof window !== 'undefined' ? window : null);
        const log = logger || console;
        const logCb = typeof onLog === 'function' ? onLog : null;

        if (!win || typeof win.addEventListener !== 'function') {
            log.warn('[iframeMessaging] window object not available; messaging disabled');
            return { start: () => { }, stop: () => { } };
        }

        const safeGetPayload = () => {
            try {
                const payload = typeof getPayload === 'function' ? getPayload() : null;
                return payload || { message: 'No session config yet' };
            } catch (err) {
                log.warn('[iframeMessaging] getPayload threw error:', err);
                return { message: 'No session config yet' };
            }
        };

        const handleMessage = (event) => {
            const data = event.data;
            if (!data) return;

            // Parent responding with the CleverTap ID (Fase C.2 bridge).
            // Store on window so subsequent /api/erica-preparation calls can
            // include it as objectId for guest users.
            if (data.type === 'CLEVERTAP_ID_RESPONSE' && typeof data.cleverTapId === 'string' && data.cleverTapId) {
                try {
                    win.__ttCleverTapId = data.cleverTapId;
                    log.log('[Erica] CleverTap ID received from parent:', data.cleverTapId.slice(0, 24) + '…');
                    if (logCb) {
                        logCb({
                            direction: 'inbound',
                            type: data.type,
                            origin: event.origin,
                            note: 'CleverTap ID stored on window.__ttCleverTapId',
                            payloadPreview: { cleverTapId: data.cleverTapId.slice(0, 24) + '…' }
                        });
                    }
                } catch (e) {
                    log.warn('[Erica] Failed to store CleverTap ID:', e);
                }
                return;
            }

            if (data.type !== 'request-settings') return;

            log.log('[Erica] Received request-settings from parent. Responding with lastSessionConfig.');
            if (logCb) {
                logCb({
                    direction: 'inbound',
                    type: data.type,
                    origin: event.origin,
                    note: 'request-settings',
                    payloadPreview: null
                });
            }
            const payload = safeGetPayload();
            try {
                const targetOrigin = event.origin || '*';
                event.source?.postMessage({ type: 'settings', payload }, targetOrigin);
                if (logCb) {
                    logCb({
                        direction: 'outbound',
                        type: 'settings',
                        origin: targetOrigin,
                        note: 'responding with lastSessionConfig',
                        payloadPreview: payload
                    });
                }
            } catch (e) {
                log.warn('Failed to post settings to parent:', e);
            }
        };

        const postToParent = (payload, targetOrigin = '*', note = '') => {
            if (!win || !win.parent) {
                console.warn('[iframeMessaging] Skipping postToParent: window.parent not available');
                return;
            }
            try {
                // DEBUG: Confirm we are about to call postMessage
                console.log('[iframeMessaging] postToParent calling win.parent.postMessage with:', payload, 'targetOrigin:', targetOrigin);
                win.parent.postMessage(payload, targetOrigin);
                if (logCb) {
                    logCb({
                        direction: 'outbound',
                        type: payload?.type || 'custom',
                        origin: targetOrigin,
                        note,
                        payloadPreview: payload
                    });
                }
            } catch (err) {
                log.warn('[iframeMessaging] Failed to postMessage to parent:', err);
            }
        };

        const sendCleverTapEvent = (eventName, properties = {}, targetOrigin = '*') => {
            log.log('[Erica] Sending CleverTap event to parent:', {
                event: eventName,
                targetOrigin,
                propsPreview: properties
            });
            postToParent(
                {
                    clevertapEvent: eventName,
                    clevertapProperties: properties
                },
                targetOrigin,
                `clevertap event: ${eventName}`
            );
        };

        // Ask the parent page for the current CleverTap object ID (Fase C.2).
        // Idempotent — safe to call repeatedly. Parent's handler in the Wix
        // "AI coach Monitor" custom code responds with:
        //   { type: 'CLEVERTAP_ID_RESPONSE', cleverTapId: '...' }
        // which handleMessage stores on win.__ttCleverTapId.
        const requestCleverTapId = () => {
            postToParent({ type: 'REQUEST_CLEVERTAP_ID' }, '*', 'requesting CleverTap ID for guest activity');
        };

        return {
            start() {
                win.addEventListener('message', handleMessage);
                // Fire the CleverTap ID request shortly after startup so the
                // ID is on window before the first /api/erica-preparation call.
                // 250ms lets the parent's listener attach if it hasn't yet.
                setTimeout(requestCleverTapId, 250);
                // Also retry once after 2s in case the parent SDK wasn't ready.
                setTimeout(() => {
                    if (!win.__ttCleverTapId) requestCleverTapId();
                }, 2000);
            },
            stop() {
                win.removeEventListener('message', handleMessage);
            },
            sendCleverTapEvent,
            requestCleverTapId,
            sendToHost: (payload, targetOrigin = '*') => postToParent(payload, targetOrigin, payload?.type || 'custom')
        };
    }

    // Expose globally for non-module usage
    global.createIframeMessaging = createIframeMessaging;
})(typeof window !== 'undefined' ? window : this);
