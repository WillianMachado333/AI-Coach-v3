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
    var VERSION = '2026-08-10T03:20-focus-hardened';

    // --- Preview gate ---
    // The bridge can be loaded site-wide via Wix Custom Code without showing
    // Erica to real visitors. Activation rules (any one is enough):
    //   1. URL contains ?erica=preview
    //   2. sessionStorage.ericaPreview === '1' (persists across internal
    //      Wix client-side navigations after the first ?erica=preview)
    //   3. Path ends with /playground (existing behaviour)
    // Once activated via #1, we stamp sessionStorage so the flag survives
    // navigation to a report page etc.
    function isPreviewActivated() {
        try {
            var search = (window.location && window.location.search) || '';
            var path = (window.location && window.location.pathname) || '';
            if (/[?&]erica=preview\b/i.test(search)) {
                try { window.sessionStorage && sessionStorage.setItem('ericaPreview', '1'); } catch (_) {}
                return true;
            }
            if (window.sessionStorage && sessionStorage.getItem('ericaPreview') === '1') return true;
            if (/\/playground(?:$|[\/?#])/i.test(path)) return true;
            return false;
        } catch (_) {
            return false;
        }
    }
    if (!isPreviewActivated()) {
        console.log('[CTBridge] Preview gate closed (no ?erica=preview, no /playground) — skipping injection.');
        return;
    }
    // Base coach URL. When the HOST page is running under the Coach Studio
    // simulator (?simulator=1), forward that flag to the coach iframe so it
    // suppresses CleverTap analytics — otherwise a Wix-embed test would
    // pollute v2 dashboards.
    var _hostSearch = (window.location && window.location.search) || '';
    var _isSimHost = /[?&]simulator=1\b/i.test(_hostSearch);
    var IFRAME_SRC = 'https://web-production-2c7ff.up.railway.app/index.html?caller='
        + (_isSimHost ? 'admin-simulator&simulator=1' : 'web');
    var ICON_STILL_SRC = 'https://web-production-2c7ff.up.railway.app/companions/Erica-thumb.png';
    // 84p is actually the HIGHEST resolution we have for Erica webm clips
    // (base /companions/idle/Erica.webm is smaller than the 84p variant —
    // odd naming). PNG thumb is higher-res than any video and is used as
    // the resting background layer so the icon reads crisp when idle.
    var ICON_IDLE_WEBM = 'https://web-production-2c7ff.up.railway.app/companions/idle/84p/Erica.webm';
    var ICON_SPEAKING_WEBM = 'https://web-production-2c7ff.up.railway.app/companions/speaking/84p/Erica.webm';
    var ICON_WAVING_MP4 = 'https://web-production-2c7ff.up.railway.app/companions/waving/Erica.mp4';
    var ICON_ID = 'ct-bridge-icon';
    var HOVER_PILLS_ID = 'ct-bridge-hover-pills';
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

        // Iframe app responds with the current pill labels — bridge draws
        // them as a hover preview above the corner icon (Bing-style
        // pre-open glimpse).
        if (event.data.type === 'PILL_LABELS' && Array.isArray(event.data.labels)) {
            renderHoverPills(event.data.labels);
            return;
        }

        // Iframe app broadcasts realtime connection state
        // ('connected' | 'connecting' | 'disconnected' | 'onhold').
        // Bridge recolours the ring around the corner icon.
        if (event.data.type === 'CT_CONNECTION_STATE' && typeof event.data.state === 'string') {
            setConnectionState(event.data.state);
            return;
        }

        // Iframe asks parent for the visible text of the current page (so
        // Erica can be aware of what the user is actually looking at).
        // Bridge extracts a compact snapshot: url, title, main text.
        if (event.data.type === 'REQUEST_PAGE_CONTEXT') {
            var snap = capturePageContext();
            try {
                (event.source || null).postMessage(
                    { type: 'PAGE_CONTEXT_RESPONSE', context: snap },
                    event.origin || '*'
                );
            } catch (_) { /* non-fatal */ }
            return;
        }
    });

    // --- Element-level focus bridge ---
    // The coach becomes more useful when she knows what the user is looking at
    // right now — not just the page, but a specific chart row, a definition
    // paragraph, a checkbox they just picked. Two channels feed this:
    //   a) any element carrying `data-erica-hint="short description"` (or plain
    //      data-erica-hint with textContent), when clicked or focused
    //   b) any text the user selects on the page (selectionchange)
    // We post `PAGE_ELEMENT_FOCUS` to the iframe with a compact snapshot.
    // Debounced to avoid flooding during drag-selection.
    var _lastFocusPayload = null;
    var _focusDebounceTimer = null;
    function postElementFocus(payload) {
        if (!payload) return;
        // Skip identical repeats.
        var serialized = payload.kind + '|' + (payload.hint || '') + '|' + (payload.text || '').slice(0, 200);
        if (serialized === _lastFocusPayload) return;
        _lastFocusPayload = serialized;
        var iframe = document.getElementById(IFRAME_ID);
        if (!iframe || !iframe.contentWindow) return;
        try {
            iframe.contentWindow.postMessage(
                Object.assign({ type: 'PAGE_ELEMENT_FOCUS' }, payload),
                '*'
            );
            console.log('[CTBridge] PAGE_ELEMENT_FOCUS →', payload.kind, (payload.hint || payload.text || '').slice(0, 60));
        } catch (_) { /* non-fatal */ }
    }
    function debouncedPostFocus(payload) {
        if (_focusDebounceTimer) clearTimeout(_focusDebounceTimer);
        _focusDebounceTimer = setTimeout(function () { postElementFocus(payload); }, 180);
    }
    function extractHint(el) {
        if (!el || !el.getAttribute) return null;
        var hint = el.getAttribute('data-erica-hint');
        if (hint == null) return null;
        return {
            hint: (hint || '').trim(),
            text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
            tag: (el.tagName || '').toLowerCase(),
            role: el.getAttribute('role') || null
        };
    }
    function attachElementFocusListeners() {
        // Guard against double-attachment (script re-injected by Wix editor
        // preview reloads, live-reload during dev, etc). Capture-phase
        // listeners stack cleanly and every event would fire twice.
        if (window.__ctBridgeFocusAttached) return;
        window.__ctBridgeFocusAttached = true;

        // Global click — pick the nearest ancestor carrying data-erica-hint.
        document.addEventListener('click', function (e) {
            var el = e.target && e.target.closest ? e.target.closest('[data-erica-hint]') : null;
            var info = extractHint(el);
            if (!info) return;
            debouncedPostFocus(Object.assign({ kind: 'click' }, info));
        }, true);
        // Global focusin — same probe. Bail on inputs/textareas so we don't
        // treat "user tabbed into a form field" as a focus intent event.
        document.addEventListener('focusin', function (e) {
            var t = e.target;
            if (t && t.matches && t.matches('input,textarea,[contenteditable="true"]')) return;
            var el = t && t.closest ? t.closest('[data-erica-hint]') : null;
            var info = extractHint(el);
            if (!info) return;
            debouncedPostFocus(Object.assign({ kind: 'focus' }, info));
        }, true);
        // Text selection — anywhere on the page. Sends the selected text so
        // Erica can react to "what did I just highlight?". Fires only when
        // the selection stabilises (debounced) and is non-trivial. Explicitly
        // skips selections that live inside an input/textarea/contenteditable
        // — that's the user drafting text into a form (Wix search box,
        // signup, etc.) and posting it out would be a privacy leak.
        document.addEventListener('selectionchange', function () {
            var sel = null;
            try { sel = window.getSelection && window.getSelection(); } catch (_) {}
            if (!sel || sel.isCollapsed) return;
            var anchor = sel.anchorNode;
            var host = anchor && anchor.nodeType === 1 ? anchor : (anchor && anchor.parentElement);
            if (host && host.closest && host.closest('input,textarea,[contenteditable="true"]')) return;
            var text = (sel.toString() || '').replace(/\s+/g, ' ').trim();
            if (text.length < 6) return; // ignore accidental micro-selections
            debouncedPostFocus({
                kind: 'selection',
                hint: 'selection',
                text: text.slice(0, 500),
                tag: null,
                role: null
            });
        });

        // Reset the dedup fingerprint every ~15s so the same click twice
        // (deliberate follow-up on the same row) fires PAGE_ELEMENT_FOCUS
        // both times instead of silently dropping the second.
        setInterval(function () { _lastFocusPayload = null; }, 15000);
    }

    // Capture a compact snapshot of the current page. Prefers <main>/<article>
    // for content-first pages (report / journey / quiz result pages); falls
    // back to body innerText. Caps at ~8 KB so the postMessage stays small.
    function capturePageContext() {
        var out = {
            url: (window.location && window.location.href) || '',
            title: (document && document.title) || '',
            text: '',
            headings: []
        };
        try {
            var scope = document.querySelector('main')
                || document.querySelector('article')
                || document.querySelector('[data-erica-context]')
                || document.body;
            if (scope) {
                // Collect visible headings so Erica knows the outline.
                out.headings = Array.prototype.slice
                    .call(scope.querySelectorAll('h1,h2,h3'))
                    .map(function (h) { return (h.innerText || '').trim(); })
                    .filter(Boolean)
                    .slice(0, 30);
                var t = (scope.innerText || '').replace(/\s+/g, ' ').trim();
                out.text = t.slice(0, 8000);
            }
        } catch (_) { /* non-fatal */ }
        return out;
    }

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

    // Colour the ring around the corner icon to reflect connection state.
    // green = ready, amber = connecting, red = disconnected, blue = onhold.
    function setConnectionState(s) {
        var icon = document.getElementById(ICON_ID);
        if (!icon) return;
        var colour;
        switch (s) {
            case 'connected': colour = '#22c55e'; break;
            case 'connecting': colour = '#f59e0b'; break;
            case 'disconnected': colour = '#ef4444'; break;
            case 'onhold': colour = '#6b7280'; break;
            default: colour = '#f59e0b';
        }
        mergeStyle(icon, {
            'box-shadow': '0 0 0 3px ' + colour + ', 0 6px 18px rgba(0,0,0,0.18)'
        });
    }

    // --- Hover-glimpse pills ---
    // On icon hover (while minimised) we ask the iframe for its current
    // pill labels and render them as floating hints stacked above the
    // icon. Clicking a hint expands the chat AND sends that pill's text
    // to the iframe so the coach starts on that thread immediately.
    var hoverHideTimer = null;
    function requestPillsFromIframe() {
        var iframe = document.getElementById(IFRAME_ID);
        if (!iframe || !iframe.contentWindow) return;
        try { iframe.contentWindow.postMessage({ type: 'GET_PILL_LABELS' }, '*'); } catch (_) {}
    }
    function ensureHoverContainer() {
        var existing = document.getElementById(HOVER_PILLS_ID);
        if (existing) return existing;
        var box = document.createElement('div');
        box.id = HOVER_PILLS_ID;
        applyStyle(box, {
            position: 'fixed',
            right: '20px',
            // Sit just above the icon (icon bottom:20 + h:72 + gap:12 = 104).
            bottom: '104px',
            'max-width': '260px',
            'z-index': '9997',
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            'align-items': 'flex-end',
            'pointer-events': 'auto',
            opacity: '0',
            transform: 'translateY(4px)',
            transition: 'opacity 160ms ease, transform 160ms ease'
        });
        document.body.appendChild(box);
        // Keep pills visible while the cursor is on them.
        box.addEventListener('mouseenter', function () {
            if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
        });
        box.addEventListener('mouseleave', hideHoverPills);
        return box;
    }
    function renderHoverPills(labels) {
        if (state !== 'icon') return; // only in minimised state
        var box = ensureHoverContainer();
        // Rebuild pills each time so we always reflect the current set.
        box.innerHTML = '';
        var visibleLabels = (labels || []).filter(function (l) { return typeof l === 'string' && l.trim(); }).slice(0, 3);
        if (visibleLabels.length === 0) {
            hideHoverPills();
            return;
        }
        visibleLabels.forEach(function (label, i) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            applyStyle(btn, {
                background: '#fff',
                border: '1px solid rgba(20, 184, 166, 0.4)',
                color: '#1f2937',
                'border-radius': '18px',
                padding: '10px 14px',
                'font-size': '13px',
                'text-align': 'right',
                'max-width': '260px',
                cursor: 'pointer',
                'box-shadow': '0 4px 12px rgba(0,0,0,0.12)',
                'line-height': '1.35'
            });
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                // Tell iframe to send this pill's text as a user message.
                var iframe = document.getElementById(IFRAME_ID);
                try {
                    iframe && iframe.contentWindow && iframe.contentWindow.postMessage(
                        { type: 'SEND_PILL_INDEX', index: i, label: label }, '*'
                    );
                } catch (_) {}
                expandToChat();
                hideHoverPills();
            });
            box.appendChild(btn);
        });
        // Force reflow + fade in.
        void box.offsetHeight;
        mergeStyle(box, { opacity: '1', transform: 'translateY(0)', 'pointer-events': 'auto' });
    }
    function hideHoverPills() {
        var box = document.getElementById(HOVER_PILLS_ID);
        if (!box) return;
        mergeStyle(box, { opacity: '0', transform: 'translateY(4px)', 'pointer-events': 'none' });
        if (hoverHideTimer) clearTimeout(hoverHideTimer);
        hoverHideTimer = setTimeout(function () {
            if (box && box.parentNode) box.parentNode.removeChild(box);
        }, 200);
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
        // Container floats ABOVE the persistent corner icon. Semi-transparent
        // background with a backdrop-blur so the parent page reads through
        // in gutter areas — the coach is contextual to what you're
        // reading, not a wall on top of it. The iframe itself sets its
        // body to transparent so this glass effect comes through.
        applyStyle(container, {
            position: 'fixed',
            right: '20px',
            bottom: '108px',
            width: '420px',
            height: '640px',
            'max-width': 'calc(100vw - 40px)',
            'max-height': 'calc(100vh - 128px)',
            'z-index': '9998',
            background: 'rgba(255,255,255,0.72)',
            'backdrop-filter': 'blur(16px) saturate(140%)',
            '-webkit-backdrop-filter': 'blur(16px) saturate(140%)',
            'border-radius': '18px',
            'box-shadow': '0 12px 40px rgba(0,0,0,0.18)',
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
        // Iframe fills the container — the container is what enforces the
        // 420×640 target size PLUS the viewport caps (max-width: 100vw-40, max-height: 100vh-128).
        // Older code pinned the iframe to a literal 420×640, which meant on a
        // short viewport the container's overflow:hidden cropped the coach's
        // composer at the bottom, leaving the user with no way to type. Now
        // the iframe follows the container size and the coach's internal
        // flex layout reflows correctly (chat area shrinks, composer stays
        // pinned to the bottom via its position:fixed).
        applyStyle(iframe, {
            width: '100%',
            height: '100%',
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
            width: '72px',
            height: '72px',
            'border-radius': '50%',
            'z-index': '9999',
            border: 'none',
            outline: 'none',
            padding: '0',
            cursor: 'pointer',
            background: '#e5e7eb center/cover no-repeat url("' + ICON_STILL_SRC + '")',
            // Two-part box-shadow: inner ring encodes connection state
            // (green connected / amber connecting / grey offline), outer
            // shadow is the elevation. Starts amber ("connecting").
            'box-shadow': '0 0 0 3px #f59e0b, 0 6px 18px rgba(0,0,0,0.18)',
            overflow: 'hidden',
            transition: 'opacity 200ms ease, transform 200ms ease, box-shadow 300ms ease',
            opacity: '1',
            // Hint to the browser to render pixel-perfect over the video —
            // marginal but visible at retina 72px on top of 84p source.
            'image-rendering': '-webkit-optimize-contrast'
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
                // Slight upscale (10%) hides the letterbox band the source
                // clips carry (character centred on a small black frame).
                // Combined with the icon's overflow:hidden this crops the
                // black edge without visibly shrinking the character.
                transform: 'scale(1.1)',
                'transform-origin': 'center 40%',
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
        // Hover-to-glimpse: while minimised, hovering the icon requests the
        // current pill labels from the iframe and renders them as floating
        // hints above the icon.
        icon.addEventListener('mouseenter', function () {
            if (state !== 'icon') return;
            if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
            requestPillsFromIframe();
        });
        icon.addEventListener('mouseleave', function () {
            // Delay hide so cursor can move onto the pills.
            if (hoverHideTimer) clearTimeout(hoverHideTimer);
            hoverHideTimer = setTimeout(hideHoverPills, 220);
        });
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
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(injectUI, 500);
            attachElementFocusListeners();
        });
    } else {
        setTimeout(injectUI, 500);
        attachElementFocusListeners();
    }

    console.log('[CTBridge] Loaded (version ' + VERSION + ')');
})();
