// Maps a request URL to a file the browser is allowed to load, or null.
//
// The static handler used to read '.' + req.url: ".." was never normalized,
// so /../etc/os-release returned 200 through Railway's proxy (and with it
// /proc/self/environ, i.e. every secret in the environment), and server
// source such as /server.js and /lib/admin.js was served to anyone. This is
// an allowlist of what the client actually loads (recorded from the app,
// a call, Coach Studio login, and the simulator host pages), not a denylist:
// anything not listed is a 404.
const path = require('path');

const PUBLIC_FILES = new Set([
    'index.html',
    'app.js',
    'uiLayout.js',
    'stateManager.js',
    'iframeMessaging.js',
    'identity.js',
    'navigator.js',
    'bridge.js',
    'styles.css',
    'maintenance.html',
    'spinningLoader.gif',
    'underConstruction.gif',
    'underConstruction.mp4',
    'underConstruction.webm',
    'voiceProfiles.json',
    'navigatorData.json',
    // lib/ is mostly server code; only these are browser modules.
    'lib/coachUiRules.js',
    'lib/attachmentRules.js',
    'lib/liveReasoning.js'
]);

const PUBLIC_DIRS = ['companions/', 'studio-assets/', 'simulator-host/'];

const ASSET_EXTENSIONS = new Set([
    '.html', '.js', '.css',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
    '.webm', '.mp4', '.mp3', '.wav',
    '.woff', '.woff2', '.ttf', '.otf'
]);

function publicRelativePath(rawUrl) {
    const pathname = String(rawUrl || '/').split('?')[0].split('#')[0];
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch (_) {
        return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;
    const rel = decoded === '/' ? 'index.html' : decoded.slice(1);
    const segments = rel.split('/');
    // Traversal, empty segments, and dotfiles (.env, .git, ...).
    if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return null;
    if (path.posix.normalize(rel) !== rel) return null;
    if (PUBLIC_FILES.has(rel)) return rel;
    if (PUBLIC_DIRS.some((dir) => rel.startsWith(dir)) && ASSET_EXTENSIONS.has(path.posix.extname(rel).toLowerCase())) return rel;
    return null;
}

function resolvePublicPath(rawUrl, root) {
    const rel = publicRelativePath(rawUrl);
    if (!rel) return null;
    const base = path.resolve(root);
    const absolute = path.resolve(base, ...rel.split('/'));
    // Belt and braces: whatever the checks above missed, never leave root.
    if (!absolute.startsWith(base + path.sep)) return null;
    return absolute;
}

// Worth a log line: someone probing for files, not a stale link.
function looksLikeProbe(rawUrl) {
    const value = String(rawUrl || '').toLowerCase();
    return /\.\.|%2e|%00|\\|\/\.|environ|\/proc\/|server\.js|package(-lock)?\.json|\/lib\/(?!coachuirules|attachmentrules|livereasoning)/.test(value);
}

module.exports = { resolvePublicPath, publicRelativePath, looksLikeProbe, PUBLIC_FILES, PUBLIC_DIRS };
