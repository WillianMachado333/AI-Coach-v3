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
    var VERSION = '2026-08-07T04:15-icon-toggle';
    var IFRAME_SRC = 'https://web-production-2c7ff.up.railway.app/index.html?caller=web';
    var ICON_SRC = 'https://web-production-2c7ff.up.railway.app/companions/Erica-thumb.png';
    var ICON_ID = 'ct-bridge-icon';
    var CONTAINER_ID = 'ct-bridge-container';
    var IFRAME_ID = 'ct-bridge-iframe';

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

        // Iframe app announces avatar animation state (speaking / waving /
        // clapping / idle). Bridge swaps the persistent corner-icon sprite
        // so Erica visibly reacts even without opening the chat.
        if (event.data.type === 'CT_ICON_ANIMATION' && typeof event.data.name === 'string') {
            setIconAnimation(event.data.name);
            return;
        }
    });

    // Wix (the parent page in production) has CSSOM/layout behaviour that
    // causes multi-step `element.style.setProperty(..., 'important')` calls
    // to silently fail to affect layout for width/height even though the
    // inline attribute reports the value with `important` priority. Setting
    // the whole `style` attribute in ONE atomic call sidesteps whatever
    // observer/mixed-in behaviour Wix imposes and reliably applies.
    // Every layout write goes through this helper.
    function applyStyle(el, props) {
        if (!el) return;
        // props is a plain object; convert to a single style string with
        // !important on each declaration.
        var out = '';
        for (var k in props) {
            if (Object.prototype.hasOwnProperty.call(props, k)) {
                out += k + ':' + props[k] + ' !important;';
            }
        }
        el.setAttribute('style', out);
    }
    function mergeStyle(el, props) {
        if (!el) return;
        // Preserve existing style but overwrite specific properties.
        var current = {};
        var existing = el.getAttribute('style') || '';
        existing.split(';').forEach(function (decl) {
            var idx = decl.indexOf(':');
            if (idx < 0) return;
            var k = decl.slice(0, idx).trim();
            var v = decl.slice(idx + 1).replace(/!important/gi, '').trim();
            if (k) current[k] = v;
        });
        for (var k in props) {
            if (Object.prototype.hasOwnProperty.call(props, k)) {
                current[k] = props[k];
            }
        }
        applyStyle(el, current);
    }

    // --- State transitions ---
    // The corner icon (bottom-right, 64×64) is Erica's persistent visual
    // anchor. It stays visible in BOTH states — it's the same avatar the
    // user sees animating during voice mode. Clicking the icon toggles
    // between icon and expanded (no separate close button — user's instinct
    // is to click Erica to dismiss the chat).
    //
    // Width/height animation is not used — Wix pins those properties on
    // fixed children of body. transform: scale is layout-free and safe.
    function expandToChat() {
        if (state === 'expanded') return;
        state = 'expanded';
        var container = document.getElementById(CONTAINER_ID);
        mergeStyle(container, {
            transform: 'scale(1)',
            opacity: '1',
            'pointer-events': 'auto'
        });
        var iframe = document.getElementById(IFRAME_ID);
        try {
            iframe && iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'CT_BRIDGE_EXPANDED' }, '*');
        } catch (_) { /* non-fatal */ }
    }

    function collapseToIcon() {
        if (state === 'icon') return;
        state = 'icon';
        var container = document.getElementById(CONTAINER_ID);
        mergeStyle(container, {
            transform: 'scale(0)',
            opacity: '0',
            'pointer-events': 'none'
        });
        var iframe = document.getElementById(IFRAME_ID);
        try {
            iframe && iframe.contentWindow && iframe.contentWindow.postMessage({ type: 'CT_BRIDGE_COLLAPSED' }, '*');
        } catch (_) { /* non-fatal */ }
    }

    function toggleChat() {
        if (state === 'expanded') collapseToIcon();
        else expandToChat();
    }

    // --- Icon animation ---
    // The iframe app dispatches CT_ICON_ANIMATION postMessages to signal
    // what the coach is doing (speaking, waving, idle). MP4 avatar clips
    // exist on disk but can't be applied via `background: url(...)`. For
    // v2 the icon uses CSS keyframe animations to communicate the state
    // (subtle pulse for speaking, tilt for waving). Real video swap in
    // the corner icon can come later — the CSS animations already read
    // clearly as "she is doing something".
    function ensureIconKeyframes() {
        if (document.getElementById('ct-bridge-keyframes')) return;
        var s = document.createElement('style');
        s.id = 'ct-bridge-keyframes';
        s.textContent = [
            '@keyframes ctBridgePulse {',
            '  0%,100% { transform: scale(1); }',
            '  50%    { transform: scale(1.08); }',
            '}',
            '@keyframes ctBridgeWave {',
            '  0%,100% { transform: rotate(0); }',
            '  25%    { transform: rotate(-14deg); }',
            '  75%    { transform: rotate(14deg); }',
            '}',
            '#' + ICON_ID + '.ct-anim-speaking { animation: ctBridgePulse 900ms ease-in-out infinite; }',
            '#' + ICON_ID + '.ct-anim-waving   { animation: ctBridgeWave 700ms ease-in-out 3; }'
        ].join('');
        document.head.appendChild(s);
    }
    function setIconAnimation(name) {
        var icon = document.getElementById(ICON_ID);
        if (!icon) return;
        ensureIconKeyframes();
        icon.classList.remove('ct-anim-speaking', 'ct-anim-waving');
        if (name === 'speaking') icon.classList.add('ct-anim-speaking');
        else if (name === 'waving') icon.classList.add('ct-anim-waving');
        // 'idle' / 'clapping' / anything else → no animation class → still.
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
        // Container floats ABOVE the persistent corner icon. Bottom offset
        // = icon size (64) + margin below (20) + gap (16) = 100px. That
        // way the icon stays fully visible below the chat while expanded.
        applyStyle(container, {
            position: 'fixed',
            right: '20px',
            bottom: '100px',
            width: '420px',
            height: '640px',
            'max-width': 'calc(100vw - 40px)',
            'max-height': 'calc(100vh - 120px)',
            'z-index': '9998',
            background: '#fff',
            'border-radius': '18px',
            'box-shadow': '0 12px 40px rgba(0,0,0,0.25)',
            overflow: 'hidden',
            opacity: '0',
            'pointer-events': 'none',
            transform: 'scale(0)',
            'transform-origin': '100% 100%',
            transition: 'transform 260ms cubic-bezier(0.2,0.9,0.3,1), opacity 200ms ease'
        });

        var iframe = document.createElement('iframe');
        iframe.id = IFRAME_ID;
        iframe.src = IFRAME_SRC;
        iframe.setAttribute('allow', 'microphone; autoplay; fullscreen');
        iframe.setAttribute('allowfullscreen', '');
        // Iframe stays at 420×640 regardless of container size so the coach
        // app doesn't reflow when we expand/collapse. Container clips it.
        applyStyle(iframe, {
            width: '420px',
            height: '640px',
            border: '0',
            display: 'block'
        });
        container.appendChild(iframe);
        document.body.appendChild(container);

        // Icon: always visible, click TOGGLES expand/collapse. No separate
        // close button — user's natural instinct is to click the icon to
        // dismiss. This also makes Erica the single point of interaction,
        // which reinforces her as a presence rather than a UI element.
        var icon = document.createElement('button');
        icon.id = ICON_ID;
        icon.type = 'button';
        icon.setAttribute('aria-label', 'Toggle coach chat');
        applyStyle(icon, {
            position: 'fixed',
            right: '20px',
            bottom: '20px',
            width: '64px',
            height: '64px',
            'border-radius': '50%',
            'z-index': '9999',
            border: '2px solid #fff',
            padding: '0',
            cursor: 'pointer',
            background: '#fff center/cover no-repeat url("' + ICON_SRC + '")',
            'box-shadow': '0 8px 24px rgba(0,0,0,0.3)',
            transition: 'opacity 200ms ease, transform 200ms ease',
            opacity: '1'
        });
        icon.addEventListener('click', toggleChat);
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
    window.__ctBridgeToggle = toggleChat;

    // --- Boot ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(injectUI, 500); });
    } else {
        setTimeout(injectUI, 500);
    }

    console.log('[CTBridge] Loaded (version ' + VERSION + ')');
})();
