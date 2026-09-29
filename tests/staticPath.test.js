const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { resolvePublicPath, looksLikeProbe, PUBLIC_FILES } = require('../lib/staticPath');

const root = path.join(__dirname, '..');

test('serves what the client loads', () => {
    for (const url of [
        '/', '/index.html', '/app.js?v=20260929b', '/uiLayout.js', '/bridge.js', '/styles.css?v=1',
        '/lib/coachUiRules.js', '/lib/attachmentRules.js', '/voiceProfiles.json', '/navigatorData.json',
        '/companions/Erica-thumb.png', '/companions/idle/84p/Erica.webm',
        '/studio-assets/login-hero-bg.webp', '/simulator-host/index.html', '/simulator-host/_shared.css',
        '/maintenance.html', '/spinningLoader.gif'
    ]) {
        const resolved = resolvePublicPath(url, root);
        assert.ok(resolved, `${url} should be served`);
        assert.ok(resolved.startsWith(root + path.sep), `${url} must stay inside the app root`);
    }
    assert.equal(resolvePublicPath('/', root), path.join(root, 'index.html'));
});

test('every allowlisted root file exists (a rename must not silently 404 the app)', () => {
    for (const rel of PUBLIC_FILES) assert.ok(fs.existsSync(path.join(root, rel)), rel);
});

// Regression: '.' + req.url served these, including /../etc/os-release
// through Railway's proxy — and so /proc/self/environ.
test('refuses traversal, encoded traversal, absolute paths, dotfiles and server files', () => {
    for (const url of [
        '/../etc/passwd', '/../../etc/os-release', '/companions/../server.js', '/companions/../../etc/passwd',
        '/%2e%2e/etc/passwd', '/%2E%2E/%2E%2E/etc/passwd', '/%2e%2e%2fetc%2fpasswd', '/companions/%2e%2e/server.js',
        '/..%2fserver.js', '/%252e%252e/server.js',
        '//etc/passwd', '///proc/self/environ', '/proc/self/environ', '/C:/Windows/win.ini', '/c:%5cwindows%5cwin.ini',
        '/companions\\..\\server.js', '/index.html%00.png', '/%00',
        '/.env', '/.env.local', '/.git/config', '/companions/.hidden.png', '/.claude/settings.json',
        '/server.js', '/package.json', '/package-lock.json', '/agentEricaRoutes-dev.js',
        '/lib/admin.js', '/lib/wixOauth.js', '/lib/staticPath.js',
        '/tests/health.test.js', '/node_modules/openai/package.json', '/scripts/init-frameworks-store.js',
        '/knowledge-base/frameworks/Supportive.md', '/README.md', '/ericaPreparationFallBack.txt',
        '/companions/notes.json', '/companions/x.js.map', '/simulator-host/', '/companions',
        '/%E0%A4%A', '/companions//Erica-thumb.png'
    ]) {
        assert.equal(resolvePublicPath(url, root), null, `${url} must be refused`);
    }
});

test('probing requests are recognised for logging; ordinary misses are not', () => {
    for (const url of ['/../etc/passwd', '/%2e%2e/x', '/proc/self/environ', '/server.js', '/.env', '/lib/admin.js']) {
        assert.equal(looksLikeProbe(url), true, url);
    }
    for (const url of ['/favicon.ico', '/companions/missing.png', '/lib/coachUiRules.js']) {
        assert.equal(looksLikeProbe(url), false, url);
    }
});
