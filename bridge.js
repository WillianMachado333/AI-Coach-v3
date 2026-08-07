/*
 * AI-Coach-v3 Wix Bridge — hosted on Railway, loaded from Wix Custom Code.
 *
 * How Willian consumes this:
 *   Paste ONCE into Wix Custom Code (scoped to the test/playground page):
 *
 *     <script src="https://web-production-2c7ff.up.railway.app/bridge.js" async></script>
 *
 * After that, ALL changes to bridge behaviour happen here — just push, deploy,
 * next page load picks it up. Zero Wix editor round-trips.
 *
 * Architecture (v2 — corner-icon-first):
 *   - Resting state is a small circular icon in the corner (60px). Iframe
 *     sits INSIDE a container that is scaled down to 0×0 by default but
 *     remains in the render tree — so the coach app boots, connects to the
 *     Realtime API, syncs activity, pre-loads pills silently in the background.
 *   - Click the icon → container scales up to 420×640 with a bubble animation
 *     from the icon's corner (transform-origin at bottom-right). Icon fades
 *     out. The coach is instantly interactive because the session is already
 *     alive.
 *   - The coach app can request minimisation via postMessage
 *     { type: 'MINIMIZE_TO_ICON' } — the container reverses the animation.
 *   - A close (×) button is overlaid by the bridge on top of the container's
 *     top-right; clicking it also collapses to the icon.
 */
(function () {
    'use strict';

    // --- Config ---
    var VERSION = '2026-08-07T02:00-corner-icon';
    var IFRAME_SRC = 'https://web-production-2c7ff.up.railway.app/index.html?caller=web';
    var ICON_SRC = 'https://web-production-2c7ff.up.railway.app/companions/Erica-thumb.png';
    var ICON_ID = 'ct-bridge-icon';
    var CONTAINER_ID = 'ct-bridge-container';
    var IFRAME_ID = 'ct-bridge-iframe';
    var CLOSE_BTN_ID = 'ct-bridge-close';

    var state = 'icon'; // 'icon' | 'expanded'

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

    // --- Message bridge: iframe ↔ parent page ---
    window.addEventListener('message', function (event) {
        if (!event.data) return;

        if (event.data.type === 'REQUEST_CLEVERTAP_ID') {
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
            return;
        }

        // Iframe app can ask the parent to shrink back to the icon.
        if (event.data.type === 'MINIMIZE_TO_ICON') {
            collapseToIcon();
            return;
        }

        // Iframe app can ask to expand programmatically (e.g. after a
        // proactive nudge). Useful for future "corner icon that grabs
        // attention" behaviour.
        if (event.data.type === 'EXPAND_TO_CHAT') {
            expandToChat();
            return;
        }
    });

    // --- State transitions ---
    function expandToChat() {
        if (state === 'expanded') return;
        state = 'expanded';
        var icon = document.getElementById(ICON_ID);
        var container = document.getElementById(CONTAINER_ID);
        var closeBtn = document.getElementById(CLOSE_BTN_ID);
        if (icon) {
            icon.style.opacity = '0';
            icon.style.transform = 'scale(0.4)';
            icon.style.pointerEvents = 'none';
        }
        if (container) {
            container.style.width = '420px';
            container.style.height = '640px';
            container.style.opacity = '1';
            container.style.pointerEvents = 'auto';
            container.style.borderRadius = '18px';
        }
        if (closeBtn) {
            closeBtn.style.opacity = '1';
            closeBtn.style.pointerEvents = 'auto';
        }
        // Notify iframe app in case it wants to react (e.g. focus the input).
        var iframe = document.getElementById(IFRAME_ID);
        try {
            iframe && iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'CT_BRIDGE_EXPANDED' }, '*');
        } catch (_) { /* non-fatal */ }
    }

    function collapseToIcon() {
        if (state === 'icon') return;
        state = 'icon';
        var icon = document.getElementById(ICON_ID);
        var container = document.getElementById(CONTAINER_ID);
        var closeBtn = document.getElementById(CLOSE_BTN_ID);
        if (container) {
            container.style.width = '0';
            container.style.height = '0';
            container.style.opacity = '0';
            container.style.pointerEvents = 'none';
            container.style.borderRadius = '60px';
        }
        if (closeBtn) {
            closeBtn.style.opacity = '0';
            closeBtn.style.pointerEvents = 'none';
        }
        if (icon) {
            // Slight delay so the icon reappears after the container has
            // started shrinking, not on top of it.
            setTimeout(function () {
                if (state !== 'icon') return;
                icon.style.opacity = '1';
                icon.style.transform = 'scale(1)';
                icon.style.pointerEvents = 'auto';
            }, 120);
        }
        var iframe = document.getElementById(IFRAME_ID);
        try {
            iframe && iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'CT_BRIDGE_COLLAPSED' }, '*');
        } catch (_) { /* non-fatal */ }
    }

    // --- UI injection ---
    function injectUI() {
        if (document.getElementById(ICON_ID)) return;
        if (!document.body) {
            setTimeout(injectUI, 100);
            return;
        }

        // Chat container (renders full-size iframe, clipped to 0×0 while in
        // 'icon' state so the coach app keeps pre-warming in the background).
        var container = document.createElement('div');
        container.id = CONTAINER_ID;
        container.style.cssText = [
            'position: fixed',
            'right: 20px',
            'bottom: 20px',
            'width: 0',
            'height: 0',
            'max-width: calc(100vw - 40px)',
            'max-height: calc(100vh - 40px)',
            'z-index: 9998',
            'background: #fff',
            'border-radius: 60px',
            'box-shadow: 0 12px 40px rgba(0,0,0,0.25)',
            'overflow: hidden',
            'opacity: 0',
            'pointer-events: none',
            'transform-origin: 100% 100%',
            'transition: width 260ms cubic-bezier(0.2,0.9,0.3,1), height 260ms cubic-bezier(0.2,0.9,0.3,1), opacity 200ms ease, border-radius 260ms ease'
        ].join(';');

        var iframe = document.createElement('iframe');
        iframe.id = IFRAME_ID;
        iframe.src = IFRAME_SRC;
        iframe.setAttribute('allow', 'microphone; autoplay; fullscreen');
        iframe.setAttribute('allowfullscreen', '');
        // Iframe stays at 420×640 regardless of container size so the coach
        // app doesn't reflow when we expand/collapse. Container clips it.
        iframe.style.cssText = 'width:420px; height:640px; border:0; display:block';
        container.appendChild(iframe);
        document.body.appendChild(container);

        // Close (×) button — parent-side overlay, always the same on-screen
        // spot when the container is expanded. Cleaner than requiring the
        // iframe app to render its own close.
        var closeBtn = document.createElement('button');
        closeBtn.id = CLOSE_BTN_ID;
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Minimise coach');
        closeBtn.innerHTML = '×'; // ×
        closeBtn.style.cssText = [
            'position: fixed',
            'right: 30px',
            'bottom: 640px', // top of the expanded container (adjusted-ish)
            'width: 28px',
            'height: 28px',
            'border-radius: 50%',
            'background: rgba(0,0,0,0.65)',
            'color: #fff',
            'border: none',
            'font-size: 20px',
            'line-height: 26px',
            'text-align: center',
            'cursor: pointer',
            'z-index: 10000',
            'opacity: 0',
            'pointer-events: none',
            'transition: opacity 200ms ease',
            'padding: 0'
        ].join(';');
        closeBtn.addEventListener('click', collapseToIcon);
        document.body.appendChild(closeBtn);
        // Re-position close btn to be inside the top-right of the container
        // when expanded. We compute this dynamically because container size
        // may hit the viewport max.
        function positionCloseBtn() {
            var c = document.getElementById(CONTAINER_ID);
            if (!c) return;
            var rect = c.getBoundingClientRect();
            if (rect.width < 200) return; // in icon state, keep hidden
            closeBtn.style.right = (window.innerWidth - rect.right + 10) + 'px';
            closeBtn.style.bottom = (window.innerHeight - rect.top - 10) + 'px';
        }
        window.addEventListener('resize', positionCloseBtn);
        // Also reposition after transitions finish so close btn snaps to top-right.
        container.addEventListener('transitionend', positionCloseBtn);
        positionCloseBtn();

        // Icon (visible resting state). Rendered above the container so the
        // click target is always crisp regardless of container z-index.
        var icon = document.createElement('button');
        icon.id = ICON_ID;
        icon.type = 'button';
        icon.setAttribute('aria-label', 'Open coach');
        icon.style.cssText = [
            'position: fixed',
            'right: 20px',
            'bottom: 20px',
            'width: 64px',
            'height: 64px',
            'border-radius: 50%',
            'z-index: 9999',
            'border: 2px solid #fff',
            'padding: 0',
            'cursor: pointer',
            'background: #fff center/cover no-repeat url("' + ICON_SRC + '")',
            'box-shadow: 0 8px 24px rgba(0,0,0,0.3)',
            'transition: opacity 200ms ease, transform 200ms ease',
            'opacity: 1'
        ].join(';');
        icon.addEventListener('click', expandToChat);
        document.body.appendChild(icon);

        console.log('[CTBridge] UI injected (corner-icon-first). Iframe pre-warming at:', IFRAME_SRC);
    }

    // --- Debug helper (window.__ctBridgeStatus()) ---
    window.__ctBridgeStatus = function () {
        return {
            version: VERSION,
            state: state,
            cleverTapLoaded: typeof window.clevertap !== 'undefined',
            cleverTapId: readCleverTapId(),
            iconInjected: !!document.getElementById(ICON_ID),
            containerInjected: !!document.getElementById(CONTAINER_ID),
            iframeInjected: !!document.getElementById(IFRAME_ID),
            iframeSrc: IFRAME_SRC
        };
    };
    // Programmatic expand/collapse from the console for testing.
    window.__ctBridgeExpand = expandToChat;
    window.__ctBridgeCollapse = collapseToIcon;

    // --- Boot ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(injectUI, 500); });
    } else {
        setTimeout(injectUI, 500);
    }

    console.log('[CTBridge] Loaded (version ' + VERSION + ')');
})();
