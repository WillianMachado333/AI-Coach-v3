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
            if (!data || data.type !== 'request-settings') return;

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

        return {
            start() {
                win.addEventListener('message', handleMessage);
            },
            stop() {
                win.removeEventListener('message', handleMessage);
            },
            sendCleverTapEvent,
            sendToHost: (payload, targetOrigin = '*') => postToParent(payload, targetOrigin, payload?.type || 'custom')
        };
    }

    // Expose globally for non-module usage
    global.createIframeMessaging = createIframeMessaging;
})(typeof window !== 'undefined' ? window : this);
