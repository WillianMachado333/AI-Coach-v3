// The Coach Studio mark as icons, in one place: the files (rendered by
// scripts/build-brand-icons.py), the <link> tags our pages carry, and the
// MCP serverInfo.icons.
//
// Who reads what (2026-10-09): claude.ai stores a custom connector's icon when
// it is added, as Google's favicon service for the last two labels of the MCP
// host (so *.up.railway.app shows Railway's logo: anthropics/claude-ai-mcp#838);
// it ignores serverInfo.icons (#152) and our favicons. Browsers, Codex, VS Code
// and PSL-aware favicon resolvers do read them, and a claude.ai fix for either
// issue would pick them up with no change here. The durable fix for claude.ai
// is serving /mcp from a domain we own (PUBLIC_ORIGIN).
'use strict';

// Served at these exact paths (lib/staticPath.js), cached for a day (lib/staticCache.js).
const FILES = Object.freeze([
    'favicon.ico',
    'favicon.svg',
    'apple-touch-icon.png',
    'studio-assets/coach-studio-48.png',
    'studio-assets/coach-studio-96.png',
    'studio-assets/coach-studio-192.png',
    'studio-assets/coach-studio-512.png',
    'studio-assets/coach-studio-app-icon.png',
]);
const FILE_SET = new Set(FILES);

// For every page's <head>. Root-relative: each page is served from this origin.
const HEAD_LINKS = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'
    + '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">'
    + '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';

// MCP 2025-11-25 Icon objects (SEP-973): same-origin https URLs, no data: URIs
// (a client may refuse them, and #474 saw claude.ai drop a session with one).
function mcpIcons(origin) {
    const base = String(origin || '').replace(/\/+$/, '');
    if (!base) return [];
    const png = (size) => ({ src: `${base}/studio-assets/coach-studio-${size}.png`, mimeType: 'image/png', sizes: [`${size}x${size}`] });
    return [png(48), png(96), png(192), { src: `${base}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }];
}

function isBrandIcon(rel) { return FILE_SET.has(rel); }

module.exports = { FILES, HEAD_LINKS, mcpIcons, isBrandIcon };
