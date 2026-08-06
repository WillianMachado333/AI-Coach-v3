/*
 * AI-Coach-v3 Wix Bridge — hosted on Railway, loaded from Wix Custom Code.
 *
 * How Willian consumes this:
 *   Paste ONCE into Wix Custom Code (scoped to the test/playground page):
 *
 *     <script src="https://web-production-2c7ff.up.railway.app/bridge.js" async></script>
 *
 * After that, ALL changes to bridge behaviour happen here — just push to
 * origin/main, Railway auto-serves the new version, next page load picks it
 * up. Zero Wix editor round-trips.
 *
 * What this script does today:
 *   1. Responds to iframe REQUEST_CLEVERTAP_ID messages with the current
 *      CleverTap anonymous / authenticated ID (so the server can query
 *      guest activity from CleverTap Cloud API).
 *   2. Injects the AI Coach iframe directly into document.body as a
 *      fixed-positioned floating container (bypasses Wix HtmlComponent
 *      wrapping which double-nests iframes and breaks postMessage).
 *   3. Exposes window.__ctBridgeStatus() as a debug helper.
 */
(function () {
    'use strict';

    // --- Config (kept as constants so a version bump is a real diff, not
    //     configuration drift by string editing) ---
    var VERSION = '2026-08-06T20:00';
    var IFRAME_SRC = 'https://web-production-2c7ff.up.railway.app/index.html?caller=web';
    var CONTAINER_ID = 'ct-bridge-container';
    var IFRAME_ID = 'ct-bridge-iframe';

    // --- CleverTap ID reader ---
    function readCleverTapId() {
        try {
            if (window.clevertap && typeof window.clevertap.getCleverTapID === 'function') {
                return window.clevertap.getCleverTapID();
            }
        } catch (e) {
            console.warn('[CTBridge] getCleverTapID threw:', e);
        }
        return null;
    }

    // --- Message bridge: iframe asks, we answer with the CleverTap ID ---
    window.addEventListener('message', function (event) {
        if (!event.data || event.data.type !== 'REQUEST_CLEVERTAP_ID') return;
        var ctid = readCleverTapId();
        if (!ctid) {
            console.warn('[CTBridge] CleverTap ID not available yet — SDK may still be initialising');
            return;
        }
        try {
            event.source.postMessage(
                { type: 'CLEVERTAP_ID_RESPONSE', cleverTapId: ctid },
                event.origin || '*'
            );
            console.log('[CTBridge] Sent CleverTap ID to iframe:', ctid.slice(0, 24) + '…');
        } catch (e) {
            console.warn('[CTBridge] postMessage failed:', e);
        }
    });

    // --- Iframe injection directly into <body>, no Wix wrapper ---
    function injectIframe() {
        if (document.getElementById(IFRAME_ID)) return;
        if (!document.body) {
            setTimeout(injectIframe, 100);
            return;
        }

        var container = document.createElement('div');
        container.id = CONTAINER_ID;
        container.style.cssText = [
            'position: fixed',
            'right: 20px',
            'bottom: 20px',
            'width: 420px',
            'height: 640px',
            'max-width: calc(100vw - 40px)',
            'max-height: calc(100vh - 40px)',
            'z-index: 9999',
            'background: #fff',
            'border-radius: 14px',
            'box-shadow: 0 10px 40px rgba(0,0,0,0.25)',
            'overflow: hidden'
        ].join(';');

        var iframe = document.createElement('iframe');
        iframe.id = IFRAME_ID;
        iframe.src = IFRAME_SRC;
        iframe.setAttribute('allow', 'microphone; autoplay; fullscreen');
        iframe.setAttribute('allowfullscreen', '');
        iframe.style.cssText = 'width:100%; height:100%; border:0; display:block';

        container.appendChild(iframe);
        document.body.appendChild(container);

        console.log('[CTBridge] Iframe injected direct into body:', IFRAME_SRC);
        console.log('[CTBridge] CleverTap state at injection:', {
            loaded: typeof window.clevertap !== 'undefined',
            id: readCleverTapId()
        });
    }

    // --- Debug helper (window.__ctBridgeStatus()) ---
    window.__ctBridgeStatus = function () {
        return {
            version: VERSION,
            cleverTapLoaded: typeof window.clevertap !== 'undefined',
            cleverTapId: readCleverTapId(),
            iframeInjected: !!document.getElementById(IFRAME_ID),
            containerVisible: !!document.getElementById(CONTAINER_ID),
            iframeSrc: IFRAME_SRC
        };
    };

    // --- Boot ---
    // 500ms head start for CleverTap SDK. iframe's first REQUEST_CLEVERTAP_ID
    // fires 250ms after iframe load with a retry at 2s, so this is generous.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(injectIframe, 500); });
    } else {
        setTimeout(injectIframe, 500);
    }

    console.log('[CTBridge] Loaded (version ' + VERSION + ')');
})();
