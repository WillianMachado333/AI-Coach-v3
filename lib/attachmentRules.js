/* Safe, dependency-free attachment rules shared by the browser and tests. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.attachmentRules = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const MAX_ATTACHMENTS = 3;
    const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
    const MAX_TEXT_BYTES = 1 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
    const MAX_TEXT_CHARS = 120000;
    const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
    const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
    const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json']);

    function extensionOf(name) {
        const value = String(name || '').toLowerCase();
        const dot = value.lastIndexOf('.');
        return dot >= 0 ? value.slice(dot) : '';
    }

    function kindForFile(file) {
        const type = String(file?.type || '').toLowerCase();
        if (IMAGE_TYPES.has(type)) return 'image';
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
            return { ok: false, code: 'type', error: 'Use a PNG, JPG, TXT, Markdown, CSV, or JSON file.' };
        }
        const size = Number(file.size) || 0;
        const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
        if (size <= 0 || size > maxBytes) {
            const limit = kind === 'image' ? '4 MB' : '1 MB';
            return { ok: false, code: 'size', error: `${kind === 'image' ? 'Images' : 'Text files'} must be ${limit} or smaller.` };
        }
        if (currentBytes + size > MAX_TOTAL_BYTES) {
            return { ok: false, code: 'total_size', error: 'Attachments must total 8 MB or less.' };
        }
        return { ok: true, kind, size };
    }

    function truncateText(value) {
        const text = String(value || '');
        if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
        return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
    }

    return {
        MAX_ATTACHMENTS,
        MAX_IMAGE_BYTES,
        MAX_TEXT_BYTES,
        MAX_TOTAL_BYTES,
        MAX_TEXT_CHARS,
        kindForFile,
        validateFile,
        truncateText
    };
});
