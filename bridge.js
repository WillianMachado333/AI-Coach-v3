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
    var VERSION = '2026-08-07T05:15-speaking-clip';
    var IFRAME_SRC = 'https://web-production-2c7ff.up.railway.app/index.html?caller=web';
    var ICON_STILL_SRC = 'https://web-production-2c7ff.up.railway.app/companions/Erica-thumb.png';
    var ICON_IDLE_WEBM = 'https://web-production-2c7ff.up.railway.app/companions/idle/84p/Erica.webm';
    var ICON_SPEAKING_WEBM = 'https://web-production-2c7ff.up.railway.app/companions/speaking/84p/Erica.webm';
    var ICON_WAVING_MP4 = 'https://web-production-2c7ff.up.railway.app/companions/waving/Erica.mp4';
    var ICON_ID = 'ct-bridge-icon';
    var IDLE_VIDEO_ID = 'ct-bridge-icon-video-idle';
    var SPEAKING_VIDEO_ID = 'ct-bridge-icon-video-speaking';
    var WAVING_VIDEO_ID = 'ct-bridge-icon-video-waving';
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
    // Three video layers stacked inside the corner icon:
    //   1. IDLE  — always looping in the background at opacity 1
    //   2. SPEAKING — same-size overlay, fades in when Erica is talking
    //      (crossfade preserves the "she smoothly starts / stops speaking"
    //      feel the previous mini-player had; NOT a mechanical pulse)
    //   3. WAVING — top layer, plays once on demand, hides after 2.5s
    //
    // The previous in-chat mini-player used the same trio (idle + speaking
    // + wave with opacity crossfade + 500ms hide-delay) — this replicates
    // that on the corner icon.
    function setIconAnimation(name) {
        var idleV = document.getElementById(IDLE_VIDEO_ID);
        var speakV = document.getElementById(SPEAKING_VIDEO_ID);
        var waveV = document.getElementById(WAVING_VIDEO_ID);

        if (name === 'waving') {
            if (waveV) {
                waveV.style.display = 'block';
                try { waveV.currentTime = 0; waveV.play().catch(function () {}); } catch (_) {}
            }
            // Hide wave after ~2.5s (typical wave clip length) so we don't
            // leave the frozen last frame stuck on top of idle.
            if (waveV && waveV._ctHideTimer) clearTimeout(waveV._ctHideTimer);
            if (waveV) {
                waveV._ctHideTimer = setTimeout(function () {
                    waveV.style.display = 'none';
                }, 2500);
            }
            return;
        }

        if (name === 'speaking') {
            if (speakV) {
                // Cancel any pending fade-out.
                if (speakV._ctHideTimer) { clearTimeout(speakV._ctHideTimer); speakV._ctHideTimer = null; }
                // Show (was display:none) then fade to opacity 0.95 so the
                // browser has a chance to lay it out before the transition.
                if (speakV.style.display === 'none') {
                    speakV.style.display = 'block';
                    // Force reflow so the opacity transition catches.
                    void speakV.offsetHeight;
                }
                speakV.style.opacity = '0.95';
                try { speakV.play().catch(function () {}); } catch (_) {}
            }
            return;
        }

        // idle / anything else → fade speaking out and hide after 500ms
        // (matches the previous mini-player's fade-tail — avoids choppy
        // toggling during natural speech pauses).
        if (speakV) {
            speakV.style.opacity = '0';
            if (speakV._ctHideTimer) clearTimeout(speakV._ctHideTimer);
            speakV._ctHideTimer = setTimeout(function () {
                if (speakV.style.opacity === '0') speakV.style.display = 'none';
            }, 500);
        }
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

        // Icon: always visible, click TOGGLES expand/collapse. Contains a
        // real <video> playing Erica's idle clip on loop; source is swapped
        // by setIconAnimation on speaking/waving events from the iframe.
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
            background: '#fff center/cover no-repeat url("' + ICON_STILL_SRC + '")',
            'box-shadow': '0 8px 24px rgba(0,0,0,0.3)',
            overflow: 'hidden',
            transition: 'opacity 200ms ease, transform 200ms ease',
            opacity: '1'
        });

        // Three stacked <video> layers inside the icon: idle (bottom,
        // always looping), speaking (mid, fades in on voice), wave (top,
        // pops on demand). Same pattern the previous in-chat mini-player
        // used — replicated here so the corner icon reads as her actually
        // speaking, not a metronomic pulse.
        function makeVideoLayer(id, src, opts) {
            var v = document.createElement('video');
            v.id = id;
            v.muted = true;
            v.autoplay = !!opts.autoplay;
            v.loop = !!opts.loop;
            v.playsInline = true;
            v.setAttribute('playsinline', '');
            v.setAttribute('muted', '');
            v.setAttribute('preload', 'auto');
            v.setAttribute('src', src);
            var style = {
                position: 'absolute',
                inset: '0',
                width: '100%',
                height: '100%',
                'object-fit': 'cover',
                display: opts.display || 'block',
                'pointer-events': 'none',
                'z-index': String(opts.z || 0),
                opacity: opts.opacity != null ? String(opts.opacity) : '1',
                transition: 'opacity 300ms ease'
            };
            applyStyle(v, style);
            v.addEventListener('error', function () { v.style.display = 'none'; });
            return v;
        }

        // Icon needs to be a positioned container for absolute children.
        mergeStyle(icon, { position: 'fixed', overflow: 'hidden' });

        var idleVideo = makeVideoLayer(IDLE_VIDEO_ID, ICON_IDLE_WEBM,
            { autoplay: true, loop: true, z: 10, opacity: 1 });
        var speakingVideo = makeVideoLayer(SPEAKING_VIDEO_ID, ICON_SPEAKING_WEBM,
            { autoplay: true, loop: true, z: 20, opacity: 0, display: 'none' });
        var wavingVideo = makeVideoLayer(WAVING_VIDEO_ID, ICON_WAVING_MP4,
            { autoplay: false, loop: false, z: 30, opacity: 1, display: 'none' });

        icon.appendChild(idleVideo);
        icon.appendChild(speakingVideo);
        icon.appendChild(wavingVideo);

        // Kick off idle playback (some browsers require explicit call).
        try { idleVideo.play().catch(function () {}); } catch (_) {}

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
