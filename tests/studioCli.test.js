// The Coach Studio CLI (cli/coach-studio.ps1 on Windows, cli/coach-studio.sh on
// macOS and Linux; nothing to install first): the way Dreamina connects an
// agent, for the Studio. An assistant with a terminal installs a small script
// and a Skill with one pasted command, `login` prints a link and a code, the
// person allows it in the browser where they are signed in to the Studio, and
// the script then calls the Studio's tools. Server side it is the OAuth
// device flow (RFC 8628) on lib/mcpAuth.js: same token families, scopes
// capped by role, revocation and audit as every other connection.
//
// Real HTTP, the real scripts as child processes. The browser leg (the Wix
// sign-in) is a signed Studio cookie, as in tests/mcp.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studiocli-'));
Object.assign(process.env, {
    SESSION_DATA_DIR: path.join(tmp, 'sessions'), AUDIT_DIR: path.join(tmp, 'audit'), SESSION_BOOKMARKS_FILE: path.join(tmp, 'bookmarks.json'),
    INJECTED_DATA_DIR: path.join(tmp, 'injected'), AGENT_HISTORY_DIR: path.join(tmp, 'ah'), CLIPBOARD_DATA_DIR: path.join(tmp, 'clip'),
    SESSION_SECRET: 'test-secret-cli', ERICA_STUDIO_OWNERS: 'willian@tt.com', STORE_MESSAGE_TEXT: 'redacted',
});
fs.mkdirSync(process.env.SESSION_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(tmp, 'studio-access.json'), JSON.stringify({ users: { 'eric@tt.com': { role: 'admin' }, 'varsha@tt.com': { role: 'people' } } }));

const wixBadges = require('../lib/wixBadges');
wixBadges.holdsAdminBadge = async () => ({ ok: true });
const admin = require('../lib/admin');
const auditLog = require('../lib/audit');
const mcpAuth = require('../lib/mcpAuth');
const mcpServer = require('../lib/mcpServer');
const cliAssets = require('../lib/cliAssets');

const root = path.join(__dirname, '..');
let base;
const server = http.createServer(async (req, res) => {
    if (cliAssets.handle(req, res)) return;
    if (await mcpAuth.handle(req, res, { identity: admin.studioIdentity, audit: auditLog, ip: '203.0.113.7' })) return;
    if (await mcpServer.handle(req, res)) return;
    if (await admin.handle(req, res)) return;
    res.writeHead(404); res.end();
});
test.before(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port;
    process.env.PUBLIC_ORIGIN = base;
});
test.after(() => server.close());
test.beforeEach(() => { mcpAuth._internal.reset(); });

const cookie = (email) => { const t = Math.floor(Date.now() / 1000); return 'admin_session=' + admin.signSession({ sub: 'admin', m: 'm-' + email, e: email, n: email, iat: t, exp: t + 3600 }); };
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const CLIENT = mcpAuth.DEVICE_CLIENT_ID;
const GRANT = mcpAuth.DEVICE_GRANT;
const audits = () => auditLog.list({ limit: 300 });
const fastForward = () => { for (const d of mcpAuth._internal.devices.values()) d.lastPollAt = 0; };

async function startDevice(extra = {}) {
    const r = await fetch(base + '/oauth/device_authorization', { method: 'POST', headers: FORM, body: form({ client_id: CLIENT, ...extra }) });
    return { status: r.status, body: await r.json() };
}
async function poll(device_code) {
    const r = await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: GRANT, device_code, client_id: CLIENT }) });
    return { status: r.status, body: await r.json() };
}
// The browser leg: open the link signed in, read the form, post the decision.
async function approve(email, userCode, { scopes = [], decision = 'allow' } = {}) {
    const page = await fetch(base + '/oauth/device?user_code=' + encodeURIComponent(userCode), { headers: { cookie: cookie(email) } });
    const html = await page.text();
    const m = html.match(/name="tx" value="([^"]+)"/);
    if (!m) return { status: page.status, html };
    const body = new URLSearchParams({ user_code: userCode, tx: m[1], decision });
    scopes.forEach((s) => body.append('scope', s));
    const r = await fetch(base + '/oauth/device', { method: 'POST', headers: { ...FORM, cookie: cookie(email) }, body: body.toString() });
    return { status: r.status, html: await r.text(), page: html };
}
async function rpc(token, method, params = {}) {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: r.status, body: await r.json().catch(() => null) };
}

// ---- the server's device flow -------------------------------------------------

test('discovery advertises the device flow, and starting it returns a link, a short code and the polling rules', async () => {
    const meta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.equal(meta.device_authorization_endpoint, base + '/oauth/device_authorization');
    assert.ok(meta.grant_types_supported.includes(GRANT));
    assert.ok(meta.grant_types_supported.includes('authorization_code'), 'Claude and ChatGPT are unaffected');

    const bad = await fetch(base + '/oauth/device_authorization', { method: 'POST', headers: FORM, body: form({ client_id: 'someone-else' }) });
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).error, 'invalid_client');

    const d = await startDevice({ device_name: 'DESKTOP-ERICA <b>x</b>' });
    assert.equal(d.status, 200);
    assert.match(d.body.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/, 'no vowels, no look-alikes');
    assert.match(d.body.device_code, /^csd_[A-Za-z0-9_-]{40,}$/);
    assert.equal(d.body.verification_uri, base + '/oauth/device');
    assert.equal(d.body.verification_uri_complete, base + '/oauth/device?user_code=' + d.body.user_code);
    assert.deepEqual([d.body.expires_in, d.body.interval], [600, 5]);
    const codes = new Set();
    for (let i = 0; i < 6; i++) codes.add((await startDevice()).body.user_code);
    assert.equal(codes.size, 6, 'every start gets its own code');
});

test('not signed in → the Studio login and back; a person not on the allowlist is refused; the entry page asks for the code', async () => {
    const d = (await startDevice()).body;
    const r = await fetch(base + '/oauth/device?user_code=' + d.user_code, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/admin/login?next=' + encodeURIComponent('/oauth/device?user_code=' + d.user_code));
    const stranger = await fetch(base + '/oauth/device?user_code=' + d.user_code, { headers: { cookie: cookie('nobody@tt.com') } });
    assert.equal(stranger.status, 403);
    assert.match(await stranger.text(), /Not allowed/);
    const entry = await fetch(base + '/oauth/device', { headers: { cookie: cookie('eric@tt.com') } });
    assert.equal(entry.status, 200);
    assert.match(await entry.text(), /data-device-entry/);
});

test('allowing: the page shows the code and only the permissions the role allows; the poll goes pending → slow_down → token; the code works once', async () => {
    const d = (await startDevice({ device_name: 'DESKTOP-ERICA' })).body;
    assert.deepEqual((await poll(d.device_code)).body.error, 'authorization_pending');
    const tooFast = await poll(d.device_code);
    assert.equal(tooFast.status, 400);
    assert.equal(tooFast.body.error, 'slow_down', 'polling inside the interval is told to slow down');
    assert.match(tooFast.body.error_description, /10 seconds/);

    // The person types the code in lower case, no hyphen: it is the same code.
    const typed = d.user_code.replace('-', '').toLowerCase();
    const a = await approve('eric@tt.com', typed, { scopes: ['read:people', 'write:content'] });
    assert.equal(a.status, 200);
    assert.ok(a.page.includes(`data-device-code="${d.user_code}"`), 'the page shows the code to compare');
    assert.match(a.page, /calls itself “DESKTOP-ERICA”/);
    assert.ok(!a.page.includes('value="read:people"'), 'an admin is not offered read:people');
    assert.match(a.html, /Coach Studio is connected/);

    fastForward();
    const t = await poll(d.device_code);
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.token_type, 'Bearer');
    assert.equal(t.body.scope, 'read:ops write:content', 'read:ops always; what was ticked; capped by the role');
    assert.match(t.body.access_token, /^csa_/);
    assert.match(t.body.refresh_token, /^csr_/);

    const again = await poll(d.device_code);
    assert.equal(again.body.error, 'expired_token', 'the device code is single use');

    const tools = await rpc(t.body.access_token, 'tools/list');
    assert.equal(tools.status, 200);
    assert.ok(tools.body.result.tools.some((x) => x.name === 'health'));

    const fam = mcpAuth.listFamilies().find((f) => f.clientName === 'Coach Studio CLI (DESKTOP-ERICA)');
    assert.ok(fam && fam.email === 'eric@tt.com' && fam.active, 'listed on the AI apps page, as the person who allowed it');
    const log = audits();
    assert.ok(log.some((e) => e.action === 'mcp.consent.allow' && e.actor === 'eric@tt.com' && e.meta && e.meta.flow === 'device'));
    assert.ok(log.some((e) => e.action === 'mcp.token.issue' && e.meta && e.meta.flow === 'device'));

    const refreshed = await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: CLIENT }) });
    assert.equal(refreshed.status, 200, 'a device connection refreshes like any other');

    assert.ok(mcpAuth.revokeFamily(fam.id, 'eric@tt.com'));
    assert.equal((await rpc(t.body.access_token, 'tools/list')).status, 401, 'revoking in the Studio stops it at the next call');
});

test('deny, a forged form, a used code, an expired code, and wrong codes: all refused, and wrong codes are limited', async () => {
    const d1 = (await startDevice()).body;
    const denied = await approve('eric@tt.com', d1.user_code, { decision: 'deny' });
    assert.match(denied.html, /You denied it/);
    fastForward();
    assert.equal((await poll(d1.device_code)).body.error, 'access_denied');
    assert.ok(audits().some((e) => e.action === 'mcp.consent.deny' && e.meta && e.meta.flow === 'device'));

    const d2 = (await startDevice()).body;
    const forged = await fetch(base + '/oauth/device', { method: 'POST', headers: { ...FORM, cookie: cookie('eric@tt.com') }, body: form({ user_code: d2.user_code, tx: 'x'.repeat(43), decision: 'allow' }) });
    assert.equal(forged.status, 400);
    assert.match(await forged.text(), /Expired form/);
    // A form made for one person does not work for another.
    const page = await (await fetch(base + '/oauth/device?user_code=' + d2.user_code, { headers: { cookie: cookie('eric@tt.com') } })).text();
    const tx = page.match(/name="tx" value="([^"]+)"/)[1];
    const other = await fetch(base + '/oauth/device', { method: 'POST', headers: { ...FORM, cookie: cookie('willian@tt.com') }, body: form({ user_code: d2.user_code, tx, decision: 'allow' }) });
    assert.equal(other.status, 400);
    fastForward();
    assert.equal((await poll(d2.device_code)).body.error, 'authorization_pending', 'nothing was allowed');

    const ok = await approve('eric@tt.com', d2.user_code);
    assert.equal(ok.status, 200);
    const used = await fetch(base + '/oauth/device?user_code=' + d2.user_code, { headers: { cookie: cookie('eric@tt.com') } });
    assert.equal(used.status, 400);
    assert.match(await used.text(), /Code already used/);

    const d3 = (await startDevice()).body;
    mcpAuth._internal.devices.forEach((rec) => { if (rec.userCode === d3.user_code.replace('-', '')) rec.exp = Date.now() - 1; });
    assert.equal((await poll(d3.device_code)).body.error, 'expired_token');
    assert.equal((await fetch(base + '/oauth/device?user_code=' + d3.user_code, { headers: { cookie: cookie('eric@tt.com') } })).status, 400);

    let last;
    for (let i = 0; i < 12; i++) last = await fetch(base + '/oauth/device?user_code=BBBB-CCCC', { headers: { cookie: cookie('varsha@tt.com') } });
    assert.equal(last.status, 429, 'guessing codes is limited per person');
});

test('starts are limited per address and pending sign-ins are capped; a device code from another client is refused', async () => {
    let r;
    for (let i = 0; i < 11; i++) r = await startDevice();
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'slow_down');
    const wrong = await fetch(base + '/oauth/token', { method: 'POST', headers: FORM, body: form({ grant_type: GRANT, device_code: 'csd_x', client_id: 'cs-other' }) });
    assert.equal(wrong.status, 401);
});

// Willian, 13 Nov, on staging: not signed in, he opened the link, signed in with Wix and landed on the
// dashboard. The login only remembered the MCP consent screen, not this code page.
test('not signed in: the link goes to the Studio login, and after the Wix sign-in comes back to the code page (not the dashboard)', async () => {
    const wixOauth = require('../lib/wixOauth');
    const d = (await startDevice()).body;
    const target = '/oauth/device?user_code=' + d.user_code;
    const link = await fetch(base + target, { redirect: 'manual' });
    const loginUrl = link.headers.get('location');
    assert.equal(loginUrl, '/admin/login?next=' + encodeURIComponent(target));
    // The login page remembers where to go back to.
    const login = await fetch(base + loginUrl);
    assert.equal(login.status, 200);
    const remembered = login.headers.get('set-cookie');
    assert.match(remembered, /^cs_next=%2Foauth%2Fdevice%3Fuser_code%3D[B-Z]{4}-[B-Z]{4};/);
    // The Wix sign-in completes (stubbed: Wix is the one thing a test cannot do) and the person lands on the code page.
    const real = { complete: wixOauth.completeLogin, read: wixOauth.readPkce };
    wixOauth.completeLogin = async () => ({ memberId: 'm-eric', email: 'eric@tt.com', name: 'Eric' });
    wixOauth.readPkce = () => ({ ok: true });
    try {
        const done = await fetch(base + '/auth/wix/complete', { method: 'POST', headers: { ...FORM, cookie: remembered.split(';')[0] + '; cs_wix_pkce=x' }, body: form({ code: 'c', state: 's' }), redirect: 'manual' });
        assert.equal(done.status, 302);
        assert.equal(done.headers.get('location'), target, 'back to the code page, not /admin/');
        const cookies = done.headers.getSetCookie().map((c) => c.split(';')[0]);
        assert.ok(cookies.includes('cs_next='), 'the bookmark is used once');
        const session = cookies.find((c) => c.startsWith('admin_session='));
        assert.ok(session, 'signed in');
        const page = await fetch(base + target, { headers: { cookie: session } });
        assert.ok((await page.text()).includes(`data-device-code="${d.user_code}"`), 'the code is there to allow');
    } finally { wixOauth.completeLogin = real.complete; wixOauth.readPkce = real.read; }
});

test('the login only goes back to the consent screen and the CLI code page on this site: nothing else, never another site', async () => {
    const cookieFor = async (next) => (await fetch(base + '/admin/login?next=' + encodeURIComponent(next))).headers.get('set-cookie') || '';
    for (const ok of ['/oauth/device', '/oauth/device?user_code=ABCD-EFGH', '/oauth/authorize?client_id=x&state=y']) assert.match(await cookieFor(ok), /^cs_next=/, ok);
    for (const bad of ['https://evil.example/', '//evil.example/oauth/device', '/oauth/device/../../admin', '/oauth/deviceX', '/oauth/devices?x=1', '/admin/', '/oauth/device?x=1 2', '/oauth/token']) {
        assert.doesNotMatch(await cookieFor(bad), /cs_next=/, bad);
    }
});

// ---- the program, as a child process -------------------------------------------
// Two scripts, nothing to install first: PowerShell on Windows, bash + curl on
// macOS and Linux. Each runs the same scenarios where it can run.

const HOME = path.join(tmp, 'home');
function exec(command, args, { input, env = {} } = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            env: { ...process.env, COACH_STUDIO_HOME: HOME, COACH_STUDIO_URL: base, ...env }, cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = ''; let err = '';
        const timer = setTimeout(() => child.kill(), 90000);
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
        if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
}
function bashAvailable() { const r = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }); return r.status === 0; }

const psDriver = {
    name: 'PowerShell',
    credFile: 'credentials.json', pendingFile: 'pending.json',
    run: (args, o) => exec('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'cli', 'coach-studio.ps1'), ...args], o),
    tokens: (home) => { const c = JSON.parse(fs.readFileSync(path.join(home, 'credentials.json'), 'utf8')); return { access: c.access_token, refresh: c.refresh_token }; },
    expireAccess: (home) => { const f = path.join(home, 'credentials.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.access_exp = 1; fs.writeFileSync(f, JSON.stringify(c)); },
};
const kv = (file, key) => ((fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(key + '=')) || '').slice(key.length + 1));
const shDriver = {
    name: 'bash',
    credFile: 'credentials', pendingFile: 'pending',
    run: (args, o) => exec('bash', [path.join(root, 'cli', 'coach-studio.sh'), ...args], o),
    tokens: (home) => ({ access: kv(path.join(home, 'credentials'), 'access_token'), refresh: kv(path.join(home, 'credentials'), 'refresh_token') }),
    expireAccess: (home) => { const f = path.join(home, 'credentials'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^access_exp=.*$/m, 'access_exp=1')); },
};
const drivers = [];
if (process.platform === 'win32') drivers.push(psDriver);
if (bashAvailable()) drivers.push(shDriver);

const codeFrom = (out) => out.match(/user_code=([A-Z]{4}-[A-Z]{4})/)[1];
const noSecrets = (text) => assert.doesNotMatch(text, /cs[adr]_[A-Za-z0-9_-]{20,}/, 'a token or device code was printed');

test('at least one script can run here (PowerShell on Windows, bash + curl elsewhere)', () => {
    assert.ok(drivers.length >= 1, 'neither PowerShell nor bash with curl is available: the CLI scripts are not being tested');
});

for (const d of drivers) {
    test(`${d.name}: end to end: login prints the link and code, waits, connects once allowed; status, tools and call work; a refresh and a logout too`, async () => {
        const home = HOME;
        fs.rmSync(home, { recursive: true, force: true });

        const before = await d.run(['status']);
        assert.equal(before.code, 1);
        assert.match(before.err, /STATUS: not connected/);

        // 1. Start: link and code, ends waiting (exit 2), nothing connected yet.
        const start = await d.run(['login', '--no-wait', '--device-name', 'qa-box']);
        assert.equal(start.code, 2, start.out + start.err);
        assert.match(start.out, /Open this link in the browser where you are signed in to Coach Studio/);
        assert.ok(start.out.includes(base + '/oauth/device?user_code='), start.out);
        assert.match(start.out, /STATUS: waiting/);
        const userCode = codeFrom(start.out);
        assert.ok(start.out.includes('The page must show the code ' + userCode));
        assert.ok(!fs.existsSync(path.join(home, d.credFile)));
        noSecrets(start.out + start.err);

        // 2. Waiting without being allowed: exit 2, say how to go on.
        const idle = await d.run(['login', '--check']);
        assert.equal(idle.code, 2, idle.out + idle.err);
        assert.match(idle.out, /STATUS: waiting/);

        // 3. The person allows it in the browser; the next check connects.
        const a = await approve('eric@tt.com', userCode, { scopes: ['write:content'] });
        assert.match(a.html, /connected/i);
        fastForward();
        const done = await d.run(['login', '--check']);
        assert.equal(done.code, 0, done.out + done.err);
        assert.match(done.out, /STATUS: connected/);
        assert.match(done.out, /Permissions: read:ops write:content/);
        assert.ok(!fs.existsSync(path.join(home, d.pendingFile)), 'the pending sign-in is gone');
        noSecrets(done.out + done.err);

        // 4. Using it.
        const st = await d.run(['status']);
        assert.equal(st.code, 0, st.out + st.err);
        assert.match(st.out, /STATUS: connected/);
        assert.match(st.out, /Tools available: \d+/);
        noSecrets(st.out);
        const tl = await d.run(['tools']);
        assert.match(tl.out, /^health {2}\[read\]/m, tl.out + tl.err);
        assert.match(tl.out, /^edit_injected_data {2}\[WRITE\]/m);
        const h = await d.run(['call', 'health']);
        assert.equal(h.code, 0, h.out + h.err);
        assert.doesNotThrow(() => JSON.parse(h.out), 'the answer is JSON');
        assert.match(h.out, /uptime|deployed|build|status/i);
        const viaStdin = await d.run(['call', 'read_config', '--stdin'], { input: '{"what":"injected"}' });
        assert.equal(viaStdin.code, 0, viaStdin.out + viaStdin.err);
        const argsFile = path.join(tmp, 'args.json');
        fs.writeFileSync(argsFile, '{"what":"injected"}');
        const viaFile = await d.run(['call', 'read_config', '--args-file', argsFile]);
        assert.equal(viaFile.code, 0, viaFile.out + viaFile.err);
        assert.equal(viaFile.out.trim(), viaStdin.out.trim(), 'the same answer by stdin and by file');
        const badJson = await d.run(['call', 'read_config', '{what:injected}']);
        assert.equal(badJson.code, 1, badJson.out + badJson.err);
        assert.match(badJson.err, /not valid JSON.*--args-file/s);
        const noScope = await d.run(['call', 'read_session', '{"sessionId":"s-vTEST1"}']);
        assert.equal(noScope.code, 1, 'a tool the connection has no permission for is an error, not silence');
        assert.match(noScope.out, /needs the read:people permission/);
        noSecrets(h.out + viaStdin.out + noScope.out + badJson.err);

        // 5. An access token past its hour is refreshed by itself (the refresh token rotates).
        const t0 = d.tokens(home);
        d.expireAccess(home);
        const refreshed = await d.run(['status']);
        assert.equal(refreshed.code, 0, refreshed.out + refreshed.err);
        const t1 = d.tokens(home);
        assert.notEqual(t1.access, t0.access);
        assert.notEqual(t1.refresh, t0.refresh);

        // 6. Revoked in the Studio: it says it is signed out, and what to do.
        const fam = mcpAuth.listFamilies().find((f) => f.clientName === 'Coach Studio CLI (qa-box)');
        assert.ok(fam, 'listed as Coach Studio CLI (qa-box)');
        mcpAuth.revokeFamily(fam.id, 'eric@tt.com');
        const revoked = await d.run(['status']);
        assert.equal(revoked.code, 1, revoked.out + revoked.err);
        assert.match(revoked.err, /STATUS: signed out/);
        assert.match(revoked.err, /Run `login` again/);

        // 7. logout forgets it.
        const out = await d.run(['logout']);
        assert.match(out.out, /STATUS: signed out/);
        assert.ok(!fs.existsSync(path.join(home, d.credFile)));
    });

    test(`${d.name}: login --wait: allowed while it waits, it connects by itself; denied says denied; an expired code says expired`, async () => {
        const home = HOME;
        fs.rmSync(home, { recursive: true, force: true });
        mcpAuth._internal.reset();

        // Allowed during the wait.
        const waiting = d.run(['login', '--wait', '40']);
        const seen = await new Promise((resolve) => {
            const t = setInterval(() => { const dev = [...mcpAuth._internal.devices.values()][0]; if (dev) { clearInterval(t); resolve(dev.userCode); } }, 50);
        });
        await approve('eric@tt.com', seen.slice(0, 4) + '-' + seen.slice(4));
        const r = await waiting;
        assert.equal(r.code, 0, r.out + r.err);
        assert.match(r.out, /STATUS: connected/);
        noSecrets(r.out + r.err);
        // Read-only: a tool that writes is not even listed.
        const readOnly = await d.run(['tools']);
        assert.match(readOnly.out, /^health {2}\[read\]/m);
        assert.doesNotMatch(readOnly.out, /\[WRITE\]/);

        // Denied.
        fs.rmSync(home, { recursive: true, force: true });
        mcpAuth._internal.reset();
        const s2 = await d.run(['login', '--no-wait']);
        await approve('eric@tt.com', codeFrom(s2.out), { decision: 'deny' });
        fastForward();
        const den = await d.run(['login', '--check']);
        assert.equal(den.code, 1, den.out + den.err);
        assert.match(den.out, /STATUS: denied/);

        // Expired.
        mcpAuth._internal.reset();
        const s3 = await d.run(['login', '--no-wait']);
        assert.equal(s3.code, 2);
        mcpAuth._internal.devices.forEach((rec) => { rec.exp = Date.now() - 1; });
        const exp = await d.run(['login', '--check']);
        assert.equal(exp.code, 1, exp.out + exp.err);
        assert.match(exp.out, /STATUS: expired/);
    });

    test(`${d.name}: without a server address it says so; help lists the commands; an unknown command is an error`, async () => {
        const empty = { COACH_STUDIO_URL: '', COACH_STUDIO_HOME: path.join(tmp, 'empty-home-' + d.name) };
        const lonely = await d.run(['login', '--no-wait'], { env: empty });
        assert.equal(lonely.code, 1, lonely.out + lonely.err);
        assert.match(lonely.err, /No server address/);
        const h = await d.run(['--help'], { env: empty });
        assert.equal(h.code, 0);
        for (const word of ['login', 'status', 'tools', 'call', 'logout']) assert.ok(h.out.includes(word), word);
        const u = await d.run(['frobnicate'], { env: empty });
        assert.equal(u.code, 1);
        assert.match(u.err, /Unknown command/);
    });
}

// ---- what the Studio serves, and what it shows ------------------------------

test('/cli/* serves the scripts, the Skill and both installers with this Studio\'s own address in them, LF only and plain ASCII', async () => {
    for (const f of ['coach-studio.ps1', 'coach-studio.sh', 'SKILL.md', 'install.sh', 'install.ps1']) {
        const r = await fetch(base + '/cli/' + f);
        assert.equal(r.status, 200, f);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        const text = await r.text();
        assert.ok(!text.includes('__ORIGIN__'), f + ' still has the placeholder');
        assert.ok(!text.includes('\r'), f + ' has Windows line endings (bash would choke on them)');
        // Windows PowerShell 5.1 reads a file with no byte-order mark as the local code page: one fancy character would be garbled.
        assert.match(text, /^[\x00-\x7F]*$/, f + ' has a character outside ASCII');
        if (f !== 'SKILL.md') assert.ok(text.includes(base), f + ' does not carry the address');
    }
    assert.match(await (await fetch(base + '/cli/SKILL.md')).text(), /^---\nname: coach-studio\ndescription: /);
    assert.equal((await fetch(base + '/cli/install.sh', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/cli/server.js')).status, 404, 'only these files');
    assert.equal((await fetch(base + '/cli/coach-studio.mjs')).status, 404, 'there is no Node program: nothing to install first');
    assert.equal((await fetch(base + '/cli/..%2Flib%2Fadmin.js')).status, 404);
});

test('the AI apps page carries the text to paste into an assistant, with this address, and a Copy button', async () => {
    const r = await fetch(base + '/admin/connected-apps', { headers: { cookie: cookie('willian@tt.com') } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /data-cli-connect/);
    assert.ok(html.includes(`curl -fsSL ${base}/cli/install.sh | bash`));
    assert.ok(html.includes(`irm ${base}/cli/install.ps1 | iex`));
    assert.match(html, /read the Skill and guide me through sign-in and authorization/);
    assert.match(html, /onclick="navigator\.clipboard\.writeText\(document\.getElementById\('cli-prompt'\)\.innerText\)/);
    assert.match(html, /Nothing to install first: it uses PowerShell on Windows, and bash and curl on macOS and Linux/);
    assert.doesNotMatch(html, /Node\.js/, 'no Node.js requirement for the person');
});

// Async on purpose: the Studio under test runs in THIS process, and a spawnSync would stop it from answering the installer.
function run(command, args, env) { return exec(command, args, { env }).then((r) => ({ status: r.code, stdout: r.out, stderr: r.err })); }

test('install.sh: the pasted command downloads the script and the Skill, writes the address, and puts the Skill where Claude Code looks', { skip: !bashAvailable() && 'bash or curl missing' }, async () => {
    const home = path.join(tmp, 'sh-home');
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const r = await run('bash', ['-c', `curl -fsSL ${base}/cli/install.sh | bash`], { HOME: home, COACH_STUDIO_HOME: '' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const dir = path.join(home, '.coach-studio');
    assert.ok(fs.existsSync(path.join(dir, 'coach-studio.sh')));
    assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));
    assert.equal(fs.readFileSync(path.join(dir, 'config'), 'utf8').trim(), 'server=' + base);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'coach-studio', 'SKILL.md')), 'the Skill for Claude Code');
    assert.match(r.stdout, /Coach Studio CLI installed/);
    assert.doesNotMatch(r.stdout + r.stderr, /node/i, 'no Node anywhere');
    // The installed copy knows the address from its config alone, and runs.
    const installed = await run('bash', [path.join(dir, 'coach-studio.sh'), 'status'], { COACH_STUDIO_URL: '', COACH_STUDIO_HOME: dir });
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /STATUS: not connected/);
    // Without Claude Code's folder it installs the script and the Skill file, and nothing else.
    const bare = path.join(tmp, 'sh-home-bare');
    fs.rmSync(bare, { recursive: true, force: true });
    fs.mkdirSync(bare, { recursive: true });
    const r2 = await run('bash', ['-c', `curl -fsSL ${base}/cli/install.sh | bash`], { HOME: bare, COACH_STUDIO_HOME: '' });
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(!fs.existsSync(path.join(bare, '.claude')), 'does not create .claude');
});

// The script is fetched from this Studio and run with -File. The one-liner `irm <url> | iex` itself is
// not spawned here: this environment refuses a process whose command line pipes a download into iex.
test('install.ps1: the PowerShell installer does the same on Windows', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    const home = path.join(tmp, 'ps-home');
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const script = path.join(tmp, 'install-from-studio.ps1');
    fs.writeFileSync(script, await (await fetch(base + '/cli/install.ps1')).text());
    const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { USERPROFILE: home, HOME: home, COACH_STUDIO_HOME: '' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const dir = path.join(home, '.coach-studio');
    assert.ok(fs.existsSync(path.join(dir, 'coach-studio.ps1')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { server: base });
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'coach-studio', 'SKILL.md')));
    assert.match(r.stdout, /Coach Studio CLI installed/);
    assert.doesNotMatch(r.stdout + r.stderr, /node/i, 'no Node anywhere');
    const installed = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'coach-studio.ps1'), 'status'], { COACH_STUDIO_URL: '', COACH_STUDIO_HOME: dir, USERPROFILE: home, HOME: home });
    assert.equal(installed.status, 1, installed.stdout + installed.stderr);
    assert.match(installed.stderr, /STATUS: not connected/);
});
