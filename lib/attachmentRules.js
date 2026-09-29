/* Safe, dependency-free attachment rules shared by the browser and tests. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.attachmentRules = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const MAX_ATTACHMENTS = 3;
    // Source-file cap for photos. Images are re-encoded in the browser before
    // sending, so this only bounds decode memory — phone camera photos
    // (12–48 MP, often 4–12 MB) must pass it.
    const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
    const MAX_TEXT_BYTES = 1 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
    const MAX_TEXT_CHARS = 120000;
    // Everything a message carries travels in ONE data-channel message, and
    // WebRTC caps that at the SCTP max-message-size (256 KiB in Chrome/Safari
    // against OpenAI). Three re-encoded photos at this budget plus text fit.
    const DEFAULT_MAX_MESSAGE_BYTES = 262144;
    const IMAGE_DATAURL_BUDGET = 75000;
    const MAX_IMAGE_SIDE = 1280;
    const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif']);
    const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
    const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json']);

    function extensionOf(name) {
        const value = String(name || '').toLowerCase();
        const dot = value.lastIndexOf('.');
        return dot >= 0 ? value.slice(dot) : '';
    }

    function kindForFile(file) {
        const type = String(file?.type || '').toLowerCase();
        if (type === 'image/svg+xml') return null;
        if (type.startsWith('image/') || (!type && IMAGE_EXTENSIONS.has(extensionOf(file?.name)))) return 'image';
        if (TEXT_TYPES.has(type) || TEXT_EXTENSIONS.has(extensionOf(file?.name))) return 'text';
        return null;
    }

    function validateFile(file, currentCount = 0, currentBytes = 0) {
        if (!file) return { ok: false, code: 'missing', error: 'Choose a file to attach.' };
        if (currentCount >= MAX_ATTACHMENTS) {
            return { ok: false, code: 'too_many', error: `You can attach up to ${MAX_ATTACHMENTS} files.` };
        }
        const kind = kindForFile(file);
        if (!kind) {
            return { ok: false, code: 'type', error: 'Use a photo, or a TXT, Markdown, CSV, or JSON file.' };
        }
        const size = Number(file.size) || 0;
        const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
        if (size <= 0 || size > maxBytes) {
            const limit = kind === 'image' ? '25 MB' : '1 MB';
            return { ok: false, code: 'size', error: `${kind === 'image' ? 'Photos' : 'Text files'} must be ${limit} or smaller.` };
        }
        // Photos are re-encoded to a small fixed budget, so only text counts
        // toward the running total at pick time.
        if (kind === 'text' && currentBytes + size > MAX_TOTAL_BYTES) {
            return { ok: false, code: 'total_size', error: 'Attachments must total 8 MB or less.' };
        }
        return { ok: true, kind, size };
    }

    function truncateText(value) {
        const text = String(value || '');
        if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
        return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
    }

    // Largest width/height within maxSide on the long edge, aspect preserved,
    // never upscaled.
    function fitWithin(width, height, maxSide) {
        const w = Math.max(1, Math.round(Number(width) || 1));
        const h = Math.max(1, Math.round(Number(height) || 1));
        const scale = Math.min(1, maxSide / Math.max(w, h));
        return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
    }

    function byteLength(value) {
        const text = String(value || '');
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
        return Buffer.byteLength(text, 'utf8');
    }

    // Whether a serialized data-channel message fits the negotiated cap,
    // with a little headroom for framing.
    function messageFits(serialized, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {
        const limit = (Number(maxMessageBytes) || DEFAULT_MAX_MESSAGE_BYTES) - 1024;
        return byteLength(serialized) <= limit;
    }

    // Per-photo data-URL budget so a full set of photos plus text still fits
    // the negotiated cap — smaller when a browser negotiates less than 256 KiB.
    function imageBudgetFor(maxMessageBytes) {
        const max = Number(maxMessageBytes) || DEFAULT_MAX_MESSAGE_BYTES;
        if (!Number.isFinite(max)) return IMAGE_DATAURL_BUDGET;
        return Math.max(8000, Math.min(IMAGE_DATAURL_BUDGET, Math.floor((max - 16384) / MAX_ATTACHMENTS)));
    }

    return {
        MAX_ATTACHMENTS,
        MAX_IMAGE_BYTES,
        MAX_TEXT_BYTES,
        MAX_TOTAL_BYTES,
        MAX_TEXT_CHARS,
        DEFAULT_MAX_MESSAGE_BYTES,
        IMAGE_DATAURL_BUDGET,
        MAX_IMAGE_SIDE,
        kindForFile,
        validateFile,
        truncateText,
        fitWithin,
        byteLength,
        messageFits,
        imageBudgetFor
    };
});
